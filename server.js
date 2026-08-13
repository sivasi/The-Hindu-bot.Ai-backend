import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";

import { PORT, CORS_ORIGIN, PDF_PATH } from "./config.js";
import { getHealth, readProgress } from "./services/chroma.js";
import { askQuestion, warmRag } from "./services/rag.js";

const app = express();
const PDF_ABS = path.resolve(PDF_PATH);
const PDF_FILENAME = path.basename(PDF_ABS);

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
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

/** Process up (for K8s liveness/readiness). Does not require Chroma/index. */
app.get("/api/live", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/health", async (_req, res) => {
  try {
    const health = await getHealth();
    res.status(health.ok ? 200 : 503).json(health);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "Health check failed",
    });
  }
});

/** JSON metadata for the archived PDF (for FE viewer chrome). */
app.get("/api/manual/info", async (_req, res) => {
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
app.get("/api/manual", (req, res) => {
  if (!fs.existsSync(PDF_ABS)) {
    return res.status(404).json({ error: "PDF not found", path: PDF_PATH });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${PDF_FILENAME}"`
  );
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  res.sendFile(PDF_ABS, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: err.message || "Failed to send PDF" });
    }
  });
});

app.post("/api/query", async (req, res) => {
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
app.post("/api/query/stream", async (req, res) => {
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
  try {
    await warmRag();
  } catch (err) {
    console.warn(
      `RAG warm-up skipped (will retry on first query): ${err?.message || err}`
    );
  }

  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
    console.log(`  GET  /api/live`);
    console.log(`  GET  /api/health`);
    console.log(`  GET  /api/manual        (PDF inline)`);
    console.log(`  GET  /api/manual/info`);
    console.log(`  POST /api/query         { "question": "...", "mode": "..." }`);
    console.log(`  POST /api/query/stream  SSE pipeline status events`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
