import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";

import {
  PORT,
  CORS_ORIGIN,
  EXAM_PDF_PATH,
  GOOGLE_CLIENT_ID,
  AUTH_REQUIRED,
} from "./config.js";
import {
  installConsoleCapture,
  logger,
  runWithLogContext,
  createRequestId,
  flushLogs,
} from "./services/logger.js";
import { getHealth, readProgress } from "./services/chroma.js";
import { isISODate, listPresentIssues, resolveIssuePdf } from "./services/ingestCalendar.js";
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
import {
  listSessions,
  createSession,
  getSessionWithMessages,
  renameSession,
  deleteSession,
  appendTurn,
  getSessionSummary,
} from "./services/chats.js";
import { scheduleConversationSummaryRefresh } from "./services/conversationSummary.js";
import { requireUserId, resolveUserId } from "./middleware/user.js";
import {
  listExamSections,
  listExamArticles,
  getExamArticleById,
  getDiscoverHome,
  getDiscoverSection,
} from "./services/examArticles.js";
import { EXAM_SECTIONS } from "./models/ExamArticle.js";
import { AppLog } from "./models/AppLog.js";

installConsoleCapture();

const app = express();
const EXAM_PDF_ABS = path.resolve(EXAM_PDF_PATH);

async function resolveManualPdf(dateQuery) {
  const date = String(dateQuery || "").trim();
  if (date) {
    if (!isISODate(date)) {
      const err = new Error("date must be YYYY-MM-DD");
      err.status = 400;
      throw err;
    }
    const issue = await resolveIssuePdf(date);
    if (!issue) {
      const err = new Error(`No newspaper PDF for ${date}`);
      err.status = 404;
      throw err;
    }
    return issue;
  }

  if (fs.existsSync(EXAM_PDF_ABS)) {
    return {
      path: EXAM_PDF_ABS,
      date: null,
      totalPages: null,
      filename: path.basename(EXAM_PDF_ABS),
    };
  }
  const err = new Error("PDF not found");
  err.status = 404;
  throw err;
}

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
    methods: ["GET", "HEAD", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Needed so browsers on https://the-hindu-bot.netlify.app can read SSE/stream responses.
    exposedHeaders: ["Content-Type", "Cache-Control"],
  })
);
app.use(express.json({ limit: "512kb" }));

app.use((req, res, next) => {
  const requestId = createRequestId();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  const started = Date.now();
  runWithLogContext(
    {
      requestId,
      method: req.method,
      path: req.path,
    },
    () => {
      res.on("finish", () => {
        if (req.path === "/api/live") return;
        logger.info(
          "http",
          `${req.method} ${req.path} ${res.statusCode}`,
          {
            status: res.statusCode,
            ms: Date.now() - started,
          }
        );
      });
      next();
    }
  );
});

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
      "GET  /api/chats",
      "POST /api/chats",
      "GET  /api/chats/:id",
      "PATCH /api/chats/:id",
      "DELETE /api/chats/:id",
      "GET  /api/manual",
      "GET  /api/manual/info",
      "GET  /api/archive",
      "GET  /api/discover",
      "GET  /api/discover/section/:section",
      "GET  /api/exam/sections",
      "GET  /api/exam/articles",
      "GET  /api/exam/articles/:id",
      "POST /api/query",
      "POST /api/query/stream",
      "GET  /api/logs",
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

/**
 * Chat history (ChatGPT-style):
 * - Each session = one sidebar "box" / conversation
 * - Messages inside a session = that conversation thread
 * - Different sessions = different boxes for the same user
 */
app.get("/api/chats", requireAuth, async (req, res) => {
  try {
    const userId = requireUserId(req);
    const sessions = await listSessions(userId, {
      limit: Number(req.query.limit) || 50,
    });
    res.json({ sessions });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || "Failed to list chats" });
  }
});

app.post("/api/chats", requireAuth, async (req, res) => {
  try {
    const userId = requireUserId(req);
    const session = await createSession(userId, { title: req.body?.title });
    res.status(201).json({ session });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || "Failed to create chat" });
  }
});

app.get("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    const userId = requireUserId(req);
    const data = await getSessionWithMessages(req.params.id, userId);
    res.json(data);
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || "Failed to load chat" });
  }
});

app.patch("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    const userId = requireUserId(req);
    const session = await renameSession(req.params.id, userId, req.body?.title);
    res.json({ session });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || "Failed to rename chat" });
  }
});

app.delete("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    const userId = requireUserId(req);
    await deleteSession(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err?.status || 500).json({ error: err?.message || "Failed to delete chat" });
  }
});

/**
 * Discover home: all section names (+ counts) and Front Page articles.
 * GET /api/discover
 *   { sections: [{ section, count }], frontPage: { section, count, articles } }
 *
 * On-demand section articles:
 * GET /api/discover/section/:section
 *   { section, count, articles }
 * Example: /api/discover/section/National
 */
app.get("/api/discover", async (_req, res) => {
  try {
    const data = await getDiscoverHome();
    res.json(data);
  } catch (err) {
    res.status(err?.status || 500).json({
      error: err?.message || "Failed to load discover feed",
    });
  }
});

app.get("/api/discover/section/:section", async (req, res) => {
  try {
    const section = decodeURIComponent(req.params.section || "");
    const data = await getDiscoverSection(section);
    res.json(data);
  } catch (err) {
    res.status(err?.status || 500).json({
      error: err?.message || "Failed to load section articles",
    });
  }
});

/**
 * Exam-prep curated newspaper viewer helpers.
 */
app.get("/api/exam/sections", requireAuth, async (_req, res) => {
  try {
    const sections = await listExamSections();
    res.json({ sections, all: EXAM_SECTIONS });
  } catch (err) {
    res.status(err?.status || 500).json({
      error: err?.message || "Failed to list exam sections",
    });
  }
});

app.get("/api/exam/articles", requireAuth, async (req, res) => {
  try {
    const data = await listExamArticles({
      section: req.query.section,
      relevance: req.query.relevance,
      limit: req.query.limit,
      skip: req.query.skip,
      q: req.query.q,
    });
    res.json(data);
  } catch (err) {
    res.status(err?.status || 500).json({
      error: err?.message || "Failed to list exam articles",
    });
  }
});

app.get("/api/exam/articles/:id", requireAuth, async (req, res) => {
  try {
    const article = await getExamArticleById(req.params.id);
    res.json({ article });
  } catch (err) {
    res.status(err?.status || 500).json({
      error: err?.message || "Failed to load exam article",
    });
  }
});

/** Public catalog of dated newspaper issues. */
app.get("/api/archive", async (_req, res) => {
  try {
    const catalog = await listPresentIssues();
    res.json({
      ok: true,
      calendarStart: catalog.calendarStart,
      calendarEnd: catalog.calendarEnd,
      count: catalog.issues.length,
      issues: catalog.issues,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to list archive",
    });
  }
});

/** JSON metadata for the archived PDF (public). */
app.get("/api/manual/info", async (req, res) => {
  try {
    const issue = await resolveManualPdf(req.query.date);
    const stat = fs.statSync(issue.path);
    const progress = await readProgress();
    const totalPages = issue.date
      ? progress?.files?.[issue.date]?.totalPages ?? issue.totalPages
      : progress?.totalPages ?? issue.totalPages;
    res.json({
      url: issue.date ? `/api/manual?date=${issue.date}` : "/api/manual",
      filename: issue.filename,
      date: issue.date,
      sizeBytes: stat.size,
      totalPages: totalPages ?? null,
      source: issue.filename,
    });
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({
      error: err?.message || "Failed to read PDF info",
      ...(status === 404 ? { path: EXAM_PDF_PATH } : {}),
    });
  }
});

/**
 * Serve the newspaper PDF for in-browser viewing (iframe / PDF.js / object).
 * Query: ?date=YYYY-MM-DD for a dated issue; omit date for the exam/today PDF.
 * Supports Range requests so the file can stream.
 */
app.get("/api/manual", async (req, res) => {
  try {
    const issue = await resolveManualPdf(req.query.date);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${issue.filename}"`
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Accept-Ranges", "bytes");

    res.sendFile(issue.path, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: err.message || "Failed to send PDF" });
      }
    });
  } catch (err) {
    const status = err?.status || 500;
    res.status(status).json({
      error: err?.message || "Failed to send PDF",
      ...(status === 404 ? { path: EXAM_PDF_PATH } : {}),
    });
  }
});

/** Rolling session summary for follow-up rewrite in query decomposition. */
async function loadChatContinuity(sessionId, userId) {
  if (!sessionId || !userId) return { conversationSummary: "" };
  try {
    const conversationSummary = await getSessionSummary(sessionId, userId);
    return { conversationSummary };
  } catch (err) {
    console.warn("[chat continuity]", err?.message || err);
    return { conversationSummary: "" };
  }
}

function queueSummaryRefresh({
  chat,
  userId,
  previousSummary,
  question,
  answer,
}) {
  if (!chat?.session?.id || !userId || answer == null) return;
  scheduleConversationSummaryRefresh({
    sessionId: chat.session.id,
    userId,
    previousSummary,
    question,
    answer,
    messageCount: chat.session.messageCount,
  });
}

app.post("/api/query", requireAuth, async (req, res) => {
  try {
    const { question, k, mode, turbo, sessionId, saveHistory } = req.body || {};
    const userId = resolveUserId(req);
    logger.info("query", "POST /api/query", {
      question: String(question || "").slice(0, 240),
      mode: mode || null,
      k: k ?? null,
      turbo: turbo ?? null,
      sessionId: sessionId || null,
    });
    const { conversationSummary } = await loadChatContinuity(
      sessionId,
      userId
    );

    const result = await askQuestion({
      question,
      k,
      mode,
      turbo,
      conversationSummary,
    });

    logger.info("query", "query answered", {
      mode: result?.meta?.mode,
      k: result?.meta?.k,
      sources: result?.sources?.length ?? 0,
      answerChars: String(result?.answer || "").length,
    });

    let chat = null;
    const shouldSave = saveHistory !== false;
    if (shouldSave && userId && question) {
      try {
        chat = await appendTurn({
          userId,
          sessionId: sessionId || null,
          question,
          answer: result?.answer,
          sources: result?.sources,
          meta: result?.meta,
        });
        queueSummaryRefresh({
          chat,
          userId,
          previousSummary: conversationSummary,
          question,
          answer: result?.answer,
        });
      } catch (histErr) {
        console.warn("[query] chat save skipped:", histErr?.message || histErr);
      }
    }

    res.json({
      ...result,
      sessionId: chat?.session?.id || sessionId || null,
      session: chat?.session || undefined,
      chatCreated: chat?.created || false,
    });
  } catch (err) {
    const status = err?.status || 500;
    logger.error("query", err?.message || "Query failed", { status });
    res.status(status).json({
      error: err?.message || "Query failed",
    });
  }
});

/**
 * SSE: pipeline journey events always.
 * LLM token stream only for mode=turbo_research ({ type: "token", text }).
 * Pass sessionId to continue a chat box (summary resolves follow-ups in query decomposition).
 */
app.post("/api/query/stream", requireAuth, async (req, res) => {
  const { question, k, mode, turbo, sessionId, saveHistory } = req.body || {};
  const userId = resolveUserId(req);
  logger.info("query", "POST /api/query/stream", {
    question: String(question || "").slice(0, 240),
    mode: mode || null,
    k: k ?? null,
    sessionId: sessionId || null,
  });
  const { conversationSummary } = await loadChatContinuity(
    sessionId,
    userId
  );

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
    let finalResult = null;
    await askQuestion({
      question,
      k,
      mode,
      turbo,
      conversationSummary,
      onEvent: async (event) => {
        if (event?.type === "result") {
          finalResult = event;
          await send(event);
          return;
        }
        if (event?.type === "done") {
          const shouldSave = saveHistory !== false;
          if (shouldSave && userId && question && finalResult?.answer != null) {
            try {
              const chat = await appendTurn({
                userId,
                sessionId: sessionId || null,
                question,
                answer: finalResult.answer,
                sources: finalResult.sources,
                meta: finalResult.meta,
              });
              queueSummaryRefresh({
                chat,
                userId,
                previousSummary: conversationSummary,
                question,
                answer: finalResult.answer,
              });
              await send({
                type: "session",
                sessionId: chat.session.id,
                session: chat.session,
                created: chat.created,
              });
            } catch (histErr) {
              console.warn(
                "[query/stream] chat save skipped:",
                histErr?.message || histErr
              );
            }
          }
          await send(event);
          return;
        }
        await send(event);
      },
    });
  } catch (err) {
    const message =
      (typeof err?.message === "string" && err.message) ||
      (typeof err === "string" && err) ||
      "Query failed";
    console.error("[query/stream]", message, err?.stack || err);
    logger.error("query", message, { stream: true });
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

app.get("/api/logs", requireAuth, async (req, res) => {
  try {
    await flushLogs();
    const filter = {};
    if (req.query.source) filter.source = String(req.query.source);
    if (req.query.level) filter.level = String(req.query.level);
    if (req.query.requestId) filter.requestId = String(req.query.requestId);
    if (req.query.q) {
      filter.message = { $regex: String(req.query.q), $options: "i" };
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 300);
    const logs = await AppLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({
      count: logs.length,
      logs: logs.map((row) => ({
        id: String(row._id),
        createdAt: row.createdAt,
        level: row.level,
        source: row.source,
        message: row.message,
        requestId: row.requestId,
        method: row.method,
        path: row.path,
        userId: row.userId,
        meta: row.meta,
      })),
    });
  } catch (err) {
    res.status(err?.status || 500).json({
      error: err?.message || "Failed to load logs",
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

async function start() {
  if (isMongoConfigured()) {
    try {
      await connectMongo();
      await flushLogs();
      logger.info("server", "mongo connected");
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
    logger.info("server", `API listening on http://localhost:${PORT}`);
    logger.info("server", `Auth: Google GIS idToken → app JWT (required=${AUTH_REQUIRED})`);
    logger.info("server", `MongoDB users: ${isMongoConfigured() ? (isMongoReady() ? "connected" : "configured") : "disabled"}`);
    logger.info("server", "GET /api/live");
    logger.info("server", "GET /api/health");
    logger.info("server", "GET /api/auth/config");
    logger.info("server", "POST /api/auth/google { idToken }");
    logger.info("server", "GET /api/auth/me");
    logger.info("server", "GET /api/chats");
    logger.info("server", "POST /api/chats");
    logger.info("server", "GET /api/chats/:id");
    logger.info("server", "GET /api/discover (public) sections + Front Page articles");
    logger.info("server", "GET /api/discover/section/:section (public)");
    logger.info("server", "GET /api/archive (public) dated issues");
    logger.info("server", "GET /api/manual (public) ?date=YYYY-MM-DD");
    logger.info("server", "POST /api/query { question, mode, sessionId? }");
    logger.info("server", "POST /api/query/stream SSE + optional session save");
    logger.info("server", "GET /api/logs persisted Mongo logs");
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
