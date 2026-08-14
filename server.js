import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";

import {
  PORT,
  CORS_ORIGIN,
  PDF_PATH,
  GOOGLE_CLIENT_ID,
  AUTH_REQUIRED,
} from "./config.js";
import { getHealth, readProgress } from "./services/chroma.js";
import { askQuestion, warmRag } from "./services/rag.js";
import {
  verifyGoogleIdToken,
  signAppJwt,
} from "./services/auth.js";
import { requireAuth } from "./middleware/auth.js";
import { connectMongo, isMongoConfigured, isMongoReady } from "./services/mongo.js";
import {
  upsertUserFromGoogle,
  findUserByGoogleId,
  findUserById,
} from "./services/users.js";

const app = express();
const PDF_ABS = path.resolve(PDF_PATH);
const PDF_FILENAME = path.basename(PDF_ABS);

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
    methods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Needed so browsers on https://the-hindu-bot.netlify.app can read SSE/stream responses.
    exposedHeaders: ["Content-Type", "Cache-Control"],
  })
);
app.use(express.json({ limit: "64kb" }));

function writeSse(res, payload) {
  return new Promise((resolve, reject) => {
    if (res.writableEnded || res.destroyed) {
      resolve(false);
      return;
    }
    const ok = res.write(`data: ${JSON.stringify(payload)}\n\n`, "utf8", (err) => {
      if (err) reject(err);
    });
    if (typeof res.flush === "function") res.flush();
    if (ok) resolve(true);
    else res.once("drain", () => resolve(true));
  });
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "rag-api",
    authRequired: AUTH_REQUIRED,
    endpoints: [
      "GET  /api/live",
      "GET  /api/health",
      "GET  /api/auth/config",
      "POST /api/auth/google",
      "GET  /api/auth/me",
      "POST /api/auth/logout",
      "GET  /api/manual",
      "GET  /api/manual/info",
      "POST /api/query",
      "POST /api/query/stream",
    ],
  });
});

/** Process up (for K8s liveness/readiness). Does not require Chroma/index. */
app.get("/api/live", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/health", async (_req, res) => {
  try {
    const health = await getHealth();
    res.status(health.ok ? 200 : 503).json({
      ...health,
      authRequired: AUTH_REQUIRED,
      mongoConfigured: isMongoConfigured(),
      mongoOk: isMongoReady(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "Health check failed",
    });
  }
});

/**
 * Google Sign-In — GIS ID token only (recommended).
 *   POST /api/auth/google  { "idToken": "<Google credential>" }
 *
 * No backend redirect URI required (Google rejects IP NodePort URLs).
 * Auth-code /callback routes remain for local experimentation only.
 */
app.get("/api/auth/config", (_req, res) => {
  res.json({
    mode: "gis",
    clientId: GOOGLE_CLIENT_ID || null,
    authRequired: AUTH_REQUIRED,
  });
});

app.get("/api/auth/google/url", (_req, res) => {
  res.status(400).json({
    error:
      "Auth-code redirect flow is disabled for cloud. Use Google Identity Services (GIS) and POST /api/auth/google with idToken.",
    mode: "gis",
    clientId: GOOGLE_CLIENT_ID || null,
  });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const body = req.body || {};
    const idToken = body.idToken || body.credential || body.id_token;

    if (!idToken) {
      return res.status(400).json({
        error:
          "Provide Google idToken/credential from Google Identity Services (GIS Sign-In button).",
        hint: "Do not use OAuth redirect to the GKE NodePort IP — Google rejects IP redirect URIs.",
      });
    }

    const googleUser = await verifyGoogleIdToken(idToken);

    // Create user in MongoDB if new; update lastLogin on returning sign-in.
    const { user, created } = await upsertUserFromGoogle(googleUser);
    const token = signAppJwt(user);
    res.json({
      token,
      tokenType: "Bearer",
      expiresIn: process.env.JWT_EXPIRES_IN || "7d",
      created,
      user,
    });
  } catch (err) {
    const status = err?.status || 401;
    console.error("[auth/google]", err?.message || err);
    res.status(status).json({ error: err?.message || "Google sign-in failed" });
  }
});

/** Optional local-only callback (not used in cloud GIS flow). */
app.get("/api/auth/google/callback", (_req, res) => {
  res.status(400).json({
    error:
      "OAuth redirect callback is not used. Sign in with GIS on the frontend, then POST /api/auth/google { idToken }.",
  });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ authenticated: false, user: null });
    }

    let user = null;
    if (req.user.id) user = await findUserById(req.user.id);
    if (!user && req.user.sub) user = await findUserByGoogleId(req.user.sub);

    res.json({
      authenticated: true,
      user: user || req.user,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to load user" });
  }
});

/** Stateless logout — client discards JWT; nothing to clear server-side. */
app.post("/api/auth/logout", (_req, res) => {
  res.json({ ok: true });
});

/** JSON metadata for the archived PDF (for FE viewer chrome). */
app.get("/api/manual/info", requireAuth, async (_req, res) => {
  try {
    if (!fs.existsSync(PDF_ABS)) {
      return res.status(404).json({ error: "PDF not found", path: PDF_PATH });
    }
    const stat = fs.statSync(PDF_ABS);
    const progress = await readProgress();
    res.json({
      url: "/api/manual",
      filename: PDF_FILENAME,
      sizeBytes: stat.size,
      totalPages: progress?.totalPages ?? null,
      source: progress?.source ?? PDF_PATH,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to read PDF info" });
  }
});

/**
 * Serve the newspaper PDF for in-browser viewing (iframe / PDF.js / object).
 * Supports Range requests so the large file can stream.
 */
app.get("/api/manual", requireAuth, (req, res) => {
  if (!fs.existsSync(PDF_ABS)) {
    return res.status(404).json({ error: "PDF not found", path: PDF_PATH });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${PDF_FILENAME}"`
  );
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  res.sendFile(PDF_ABS, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: err.message || "Failed to send PDF" });
    }
  });
});

app.post("/api/query", requireAuth, async (req, res) => {
  try {
    const { question, k, mode, turbo } = req.body || {};
    const result = await askQuestion({ question, k, mode, turbo });
    res.json(result);
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({
      error: err?.message || "Query failed",
    });
  }
});

/**
 * SSE: pipeline journey events always.
 * LLM token stream only for mode=turbo_research ({ type: "token", text }).
 */
app.post("/api/query/stream", requireAuth, async (req, res) => {
  const { question, k, mode, turbo } = req.body || {};

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }

  let aborted = false;
  req.on("aborted", () => {
    aborted = true;
  });

  const heartbeat = setInterval(() => {
    if (!aborted && !res.writableEnded) res.write(`: ping\n\n`);
  }, 10000);

  const send = async (payload) => {
    if (aborted || res.writableEnded || res.destroyed) return;
    await writeSse(res, payload);
  };

  try {
    await askQuestion({
      question,
      k,
      mode,
      turbo,
      onEvent: async (event) => {
        await send(event);
      },
    });
  } catch (err) {
    const message =
      (typeof err?.message === "string" && err.message) ||
      (typeof err === "string" && err) ||
      "Query failed";
    console.error("[query/stream]", message, err?.stack || err);
    await send({
      type: "error",
      message,
    });
    await send({ type: "done" });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

async function start() {
  if (isMongoConfigured()) {
    try {
      await connectMongo();
    } catch (err) {
      console.warn(
        `[mongo] startup connect failed (sign-in will retry): ${err?.message || err}`
      );
    }
  }

  try {
    await warmRag();
  } catch (err) {
    console.warn(
      `RAG warm-up skipped (will retry on first query): ${err?.message || err}`
    );
  }

  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
    console.log(`  Auth: Google GIS idToken → app JWT (required=${AUTH_REQUIRED})`);
    console.log(`  MongoDB users: ${isMongoConfigured() ? (isMongoReady() ? "connected" : "configured") : "disabled"}`);
    console.log(`  GET  /api/live`);
    console.log(`  GET  /api/health`);
    console.log(`  GET  /api/auth/config`);
    console.log(`  POST /api/auth/google   { idToken }`);
    console.log(`  GET  /api/auth/me`);
    console.log(`  GET  /api/manual        (PDF inline, auth)`);
    console.log(`  GET  /api/manual/info`);
    console.log(`  POST /api/query         { "question": "...", "mode": "..." }`);
    console.log(`  POST /api/query/stream  SSE pipeline status events`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
