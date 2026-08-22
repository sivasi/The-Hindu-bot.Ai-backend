import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { isMongoReady } from "./mongo.js";

const logContext = new AsyncLocalStorage();
const SECRET_KEY =
  /^(authorization|idtoken|accesstoken|refreshtoken|password|secret|cookie|jwt|credential)$/i;

const orig = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug || console.log).bind(console),
};

let queue = [];
let timer = null;
let capturing = false;
const MAX_QUEUE = 2000;
const MAX_MESSAGE = 4000;
const MAX_META_JSON = 24_000;

function getContext() {
  return logContext.getStore() || {};
}

export function runWithLogContext(ctx, fn) {
  const parent = getContext();
  return logContext.run({ ...parent, ...ctx }, fn);
}

export function getLogContext() {
  return { ...getContext() };
}

export function setLogContext(patch) {
  const store = logContext.getStore();
  if (store && patch && typeof patch === "object") Object.assign(store, patch);
}

export function createRequestId() {
  return randomUUID();
}

function clipString(value, max = MAX_MESSAGE) {
  const s = String(value ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function sanitizeMeta(meta, depth = 0) {
  if (meta == null) return undefined;
  if (depth > 4) return "[…]";
  if (Array.isArray(meta)) {
    return meta.slice(0, 40).map((item) => sanitizeMeta(item, depth + 1));
  }
  if (typeof meta !== "object") {
    if (typeof meta === "string") return clipString(meta, 500);
    return meta;
  }
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizeMeta(value, depth + 1);
  }
  const encoded = JSON.stringify(out);
  if (encoded && encoded.length > MAX_META_JSON) {
    return { truncated: true, preview: encoded.slice(0, 400) };
  }
  return out;
}

function parseConsoleSource(args) {
  const first = args.find((a) => typeof a === "string") || "";
  const tagged = first.match(/^\[([a-z0-9._/-]+)\]/i);
  if (tagged) return tagged[1];
  if (/^API listening/i.test(first)) return "server";
  if (/^RAG ready/i.test(first)) return "rag";
  return "console";
}

function formatConsoleArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return arg.stack || arg.message;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function enqueue(level, source, message, meta) {
  const ctx = getContext();
  const entry = {
    level,
    source: clipString(source || "app", 80),
    message: clipString(message),
    requestId: ctx.requestId || null,
    method: ctx.method || null,
    path: ctx.path || null,
    userId: ctx.userId || null,
    meta: sanitizeMeta(meta),
    createdAt: new Date(),
  };
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(entry);
  if (!timer) timer = setTimeout(flushLogs, 250);
}

export async function flushLogs() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.length || !isMongoReady()) return 0;

  let AppLog;
  try {
    ({ AppLog } = await import("../models/AppLog.js"));
  } catch {
    return 0;
  }

  const batch = queue;
  queue = [];
  try {
    await AppLog.insertMany(batch, { ordered: false });
    return batch.length;
  } catch (err) {
    orig.warn("[logger] persist failed:", err?.message || err);
    if (queue.length < MAX_QUEUE) {
      queue = [...batch, ...queue].slice(-MAX_QUEUE);
    }
    return 0;
  }
}

function write(level, source, message, meta) {
  const line = source ? `[${source}] ${message}` : message;
  if (level === "error") orig.error(line);
  else if (level === "warn") orig.warn(line);
  else orig.log(line);
  enqueue(level, source, message, meta);
}

export const logger = {
  debug: (source, message, meta) => write("debug", source, message, meta),
  info: (source, message, meta) => write("info", source, message, meta),
  warn: (source, message, meta) => write("warn", source, message, meta),
  error: (source, message, meta) => write("error", source, message, meta),
};

function capture(level) {
  return (...args) => {
    orig[level](...args);
    const message = formatConsoleArgs(args);
    if (!message || message.startsWith("[logger]")) return;
    enqueue(
      level === "debug" ? "debug" : level === "warn" ? "warn" : level === "error" ? "error" : "info",
      parseConsoleSource(args),
      message
    );
  };
}

/** Persist existing console.log / warn / error across the backend. */
export function installConsoleCapture() {
  if (capturing) return;
  capturing = true;
  console.log = capture("log");
  console.warn = capture("warn");
  console.error = capture("error");
  console.debug = capture("debug");
}

process.once("beforeExit", () => {
  flushLogs().catch(() => {});
});
