import mongoose from "mongoose";
import { ChatSession } from "../models/ChatSession.js";
import { ChatMessage } from "../models/ChatMessage.js";
import { isMongoConfigured, isMongoReady, connectMongo } from "./mongo.js";

async function ensureMongo() {
  if (!isMongoConfigured()) {
    throw Object.assign(new Error("MongoDB is not configured"), { status: 503 });
  }
  if (!isMongoReady()) await connectMongo();
}

function titleFromQuestion(question) {
  const q = String(question || "").replace(/\s+/g, " ").trim();
  if (!q) return "New chat";
  return q.length > 60 ? `${q.slice(0, 57)}…` : q;
}

function compactSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 20).map((s) => ({
    heading: s?.heading || s?.metadata?.heading || null,
    chunkIndex: s?.chunkIndex ?? s?.metadata?.chunkIndex ?? null,
    chunkTotal: s?.chunkTotal ?? s?.metadata?.chunkTotal ?? null,
    pageNumber: s?.pageNumber ?? s?.metadata?.pageNumber ?? null,
    date: s?.date || s?.metadata?.date || null,
    section: s?.section ?? s?.metadata?.section ?? null,
    excerpt: String(s?.excerpt || s?.pageContent || "").slice(0, 400),
  }));
}

export function toPublicSession(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    title: doc.title || "New chat",
    preview: doc.preview || "",
    messageCount: doc.messageCount || 0,
    lastMessageAt: doc.lastMessageAt || doc.updatedAt || doc.createdAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function toPublicMessage(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    sessionId: String(doc.sessionId),
    role: doc.role,
    content: doc.content,
    sources: doc.sources || undefined,
    meta: doc.meta || undefined,
    createdAt: doc.createdAt,
  };
}

export async function listSessions(userId, { limit = 50 } = {}) {
  await ensureMongo();
  const uid = new mongoose.Types.ObjectId(userId);
  const rows = await ChatSession.find({ userId: uid })
    .sort({ lastMessageAt: -1 })
    .limit(Math.min(Number(limit) || 50, 100))
    .lean();
  return rows.map(toPublicSession);
}

export async function createSession(userId, { title } = {}) {
  await ensureMongo();
  const doc = await ChatSession.create({
    userId,
    title: title?.trim() || "New chat",
    preview: "",
    messageCount: 0,
    lastMessageAt: new Date(),
  });
  return toPublicSession(doc);
}

export async function getSessionForUser(sessionId, userId) {
  await ensureMongo();
  if (!mongoose.isValidObjectId(sessionId)) {
    throw Object.assign(new Error("Invalid session id"), { status: 400 });
  }
  const doc = await ChatSession.findOne({
    _id: sessionId,
    userId,
  }).lean();
  if (!doc) {
    throw Object.assign(new Error("Chat session not found"), { status: 404 });
  }
  return doc;
}

export async function getSessionWithMessages(sessionId, userId) {
  const session = await getSessionForUser(sessionId, userId);
  const messages = await ChatMessage.find({
    sessionId: session._id,
    userId,
  })
    .sort({ createdAt: 1 })
    .lean();
  return {
    session: toPublicSession(session),
    messages: messages.map(toPublicMessage),
  };
}

/** Rolling conversation memory used to resolve follow-ups. Empty on new chats. */
export async function getSessionSummary(sessionId, userId) {
  if (!sessionId || !userId) return "";
  const session = await getSessionForUser(sessionId, userId);
  return String(session.summary || "").trim();
}

/**
 * Write a newer rolling summary. Ignores the write if a later turn already saved.
 */
export async function saveSessionSummary({
  sessionId,
  userId,
  summary,
  messageCount,
}) {
  await ensureMongo();
  const text = String(summary || "").trim();
  if (!sessionId || !userId || !text) return false;
  const count = Number(messageCount) || 0;
  const result = await ChatSession.updateOne(
    {
      _id: sessionId,
      userId,
      $or: [
        { summaryAtCount: { $exists: false } },
        { summaryAtCount: null },
        { summaryAtCount: { $lt: count } },
      ],
    },
    { $set: { summary: text.slice(0, 2000), summaryAtCount: count } }
  );
  return (result.modifiedCount || 0) > 0;
}

export async function renameSession(sessionId, userId, title) {
  const trimmed = String(title || "").trim();
  if (!trimmed) {
    throw Object.assign(new Error("Title is required"), { status: 400 });
  }
  await getSessionForUser(sessionId, userId);
  const doc = await ChatSession.findOneAndUpdate(
    { _id: sessionId, userId },
    { $set: { title: trimmed.slice(0, 120) } },
    { returnDocument: "after" }
  ).lean();
  return toPublicSession(doc);
}

export async function deleteSession(sessionId, userId) {
  await getSessionForUser(sessionId, userId);
  await ChatMessage.deleteMany({ sessionId, userId });
  await ChatSession.deleteOne({ _id: sessionId, userId });
  return { ok: true };
}

/**
 * Append a user+assistant turn to a session (or create session).
 * Returns { session, userMessage, assistantMessage, created }.
 */
export async function appendTurn({
  userId,
  sessionId,
  question,
  answer,
  sources,
  meta,
}) {
  await ensureMongo();
  if (!userId) {
    throw Object.assign(new Error("User id required to save chat"), {
      status: 401,
    });
  }
  if (!question?.trim()) {
    throw Object.assign(new Error("Question is required"), { status: 400 });
  }

  let session;
  let created = false;

  if (sessionId) {
    session = await ChatSession.findOne({ _id: sessionId, userId });
    if (!session) {
      throw Object.assign(new Error("Chat session not found"), { status: 404 });
    }
  } else {
    session = await ChatSession.create({
      userId,
      title: titleFromQuestion(question),
      preview: "",
      messageCount: 0,
      lastMessageAt: new Date(),
    });
    created = true;
  }

  const userMsg = await ChatMessage.create({
    sessionId: session._id,
    userId,
    role: "user",
    content: String(question).trim(),
  });

  const assistantMsg = await ChatMessage.create({
    sessionId: session._id,
    userId,
    role: "assistant",
    content: String(answer || "").trim() || "(No answer)",
    sources: compactSources(sources),
    meta: meta || undefined,
  });

  const wasEmpty = (session.messageCount || 0) === 0;
  if (wasEmpty || session.title === "New chat") {
    session.title = titleFromQuestion(question);
  }
  session.preview = String(answer || question).replace(/\s+/g, " ").trim().slice(0, 200);
  session.messageCount = (session.messageCount || 0) + 2;
  session.lastMessageAt = new Date();
  await session.save();

  return {
    created,
    session: toPublicSession(session),
    userMessage: toPublicMessage(userMsg),
    assistantMessage: toPublicMessage(assistantMsg),
  };
}
