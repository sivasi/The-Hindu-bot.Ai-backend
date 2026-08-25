import fs from "fs/promises";
import path from "path";

import {
  PDF_DIR,
  CALENDAR_START,
  INGEST_FILE_BATCH,
  PROGRESS_PATH,
  EMBEDDING_MODEL,
  CHROMA_URL,
  CHROMA_COLLECTION,
  apiManualPath,
  gcsPdfPublicUrl,
  hinduPdfFilename,
  pdfBasename,
} from "../config.js";

export const PROGRESS_VERSION = 2;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value) {
  if (!ISO_RE.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day;
}

export function todayISO() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateParts(iso) {
  if (!isISODate(iso)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }
  const [year, month, day] = iso.split("-").map(Number);
  return {
    date: iso,
    year,
    month,
    day,
    dateInt: year * 10000 + month * 100 + day,
  };
}

export function addDaysISO(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().slice(0, 10);
}

export function eachISODate(start, end) {
  if (!isISODate(start) || !isISODate(end) || start > end) return [];
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDaysISO(cursor, 1)) {
    out.push(cursor);
  }
  return out;
}

/**
 * Parse a newspaper filename date.
 * Preferred: The-Hindu-DD-MM-YYYY.pdf
 * Also: YYYY-MM-DD.pdf / The-Hindu-YYYY-MM-DD.pdf
 */
export function parseDateFromFilename(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(filePath));
  const iso = base.match(/(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})$/);
  if (iso && isISODate(`${iso[1]}-${iso[2]}-${iso[3]}`)) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const dmy = base.match(/(?:^|[^0-9])(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) {
    const candidate = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    if (isISODate(candidate)) return candidate;
  }
  return null;
}

export async function discoverIssues(dir = PDF_DIR) {
  const byDate = new Map();
  const skipped = [];
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `PDF folder not found: ${dir}\nPlace The-Hindu-DD-MM-YYYY.pdf files there.`
      );
    }
    throw err;
  }

  for (const name of names) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const source = path.join(dir, name);
    const date = parseDateFromFilename(name);
    if (!date) {
      skipped.push(name);
      continue;
    }
    const stat = await fs.stat(source);
    if (byDate.has(date)) {
      console.warn(
        `[ingest] duplicate date ${date}: keeping ${name}, was ${path.basename(byDate.get(date).source)}`
      );
    }
    byDate.set(date, {
      date,
      source,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
    });
  }

  return { byDate, skipped };
}

function missingEntry(date) {
  return { date, status: "missing" };
}

function pendingEntry(found) {
  return {
    date: found.date,
    source: found.source,
    sourceMtimeMs: found.sourceMtimeMs,
    sourceSize: found.sourceSize,
    status: "pending",
    totalPages: null,
    nextPage: 1,
    vectorCount: 0,
  };
}

function sameSource(entry, found) {
  return (
    path.basename(entry?.source || "") === path.basename(found.source) &&
    entry?.sourceMtimeMs === found.sourceMtimeMs &&
    entry?.sourceSize === found.sourceSize
  );
}

export function presentFilesComplete(progress) {
  const files = progress?.files || {};
  const present = Object.values(files).filter((entry) => entry.status !== "missing");
  if (!present.length) return false;
  return present.every((entry) => entry.status === "complete");
}

export function countByStatus(progress) {
  const counts = {
    missing: 0,
    pending: 0,
    in_progress: 0,
    complete: 0,
    stale: 0,
  };
  for (const entry of Object.values(progress?.files || {})) {
    counts[entry.status] = (counts[entry.status] || 0) + 1;
  }
  return counts;
}

export function sumFileVectors(progress) {
  let total = 0;
  for (const entry of Object.values(progress?.files || {})) {
    total += Number(entry.vectorCount) || 0;
  }
  return total;
}

export function filesToIngest(progress, { date, from, to } = {}) {
  return Object.values(progress.files || {})
    .filter((entry) => {
      if (entry.status === "missing") return false;
      if (date && entry.date !== date) return false;
      if (from && entry.date < from) return false;
      if (to && entry.date > to) return false;
      return (
        entry.status === "pending" ||
        entry.status === "in_progress" ||
        entry.status === "stale"
      );
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Next present PDFs to process, walking the calendar from 1 Jan.
 * Missing dates are skipped and do not count toward `limit`.
 */
export function nextFileBatch(
  progress,
  { date, from, to, limit = INGEST_FILE_BATCH } = {}
) {
  const all = filesToIngest(progress, { date, from, to });
  const applyLimit = !date && Number.isFinite(limit) && limit > 0;
  const queue = applyLimit ? all.slice(0, limit) : all;
  return {
    queue,
    due: all.length,
    remaining: Math.max(0, all.length - queue.length),
    limit: applyLimit ? limit : null,
  };
}

export async function loadProgress() {
  try {
    const raw = JSON.parse(await fs.readFile(PROGRESS_PATH, "utf8"));
    if (!raw || raw.version !== PROGRESS_VERSION || !raw.files) return null;
    return raw;
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function saveProgress(progress) {
  const payload = {
    ...progress,
    version: PROGRESS_VERSION,
    complete: presentFilesComplete(progress),
    vectorCount: sumFileVectors(progress),
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  const tmpPath = `${PROGRESS_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2));
  try {
    await fs.rename(tmpPath, PROGRESS_PATH);
  } catch (err) {
    if (err?.code === "EEXIST" || err?.code === "EPERM") {
      await fs.unlink(PROGRESS_PATH);
      await fs.rename(tmpPath, PROGRESS_PATH);
    } else {
      throw err;
    }
  }
  return payload;
}

function mergeFile(existing, found) {
  if (!found) {
    return missingEntry(existing.date);
  }
  if (!existing || existing.status === "missing") {
    return pendingEntry(found);
  }
  if (!sameSource(existing, found)) {
    return {
      ...pendingEntry(found),
      status: existing.status === "complete" || existing.status === "in_progress"
        ? "stale"
        : "pending",
    };
  }
  return {
    ...existing,
    source: found.source,
    sourceMtimeMs: found.sourceMtimeMs,
    sourceSize: found.sourceSize,
  };
}

/**
 * Scan PDF_DIR, fill Jan 1 → max(today, latest file), mark missing dates.
 * Extra files (positional path) are merged in so future drops work.
 */
export async function syncProgress({ extraFile, chunking } = {}) {
  const { byDate, skipped } = await discoverIssues(PDF_DIR);
  if (extraFile) {
    const date = parseDateFromFilename(extraFile);
    if (!date) {
      throw new Error(
        `Cannot parse a newspaper date from: ${extraFile}\nUse The-Hindu-DD-MM-YYYY.pdf`
      );
    }
    const stat = await fs.stat(extraFile);
    byDate.set(date, {
      date,
      source: extraFile,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
    });
  }

  for (const date of [...byDate.keys()]) {
    if (date < CALENDAR_START) {
      console.warn(`[ingest] ignoring ${date} (before ${CALENDAR_START})`);
      byDate.delete(date);
    }
  }

  const discoveredDates = [...byDate.keys()].sort();
  const calendarStart = CALENDAR_START;
  const calendarEnd = [todayISO(), ...discoveredDates].sort().at(-1);
  if (calendarStart > calendarEnd) {
    throw new Error(
      `CALENDAR_START ${calendarStart} is after calendar end ${calendarEnd}`
    );
  }

  const previous = await loadProgress();
  const files = {};
  for (const date of eachISODate(calendarStart, calendarEnd)) {
    const found = byDate.get(date) || null;
    const prior = previous?.files?.[date];
    if (prior && prior.status !== "missing" && !found) {
      console.warn(
        `[ingest] ${date} was ${prior.status}, PDF is gone; marked missing (vectors left in Chroma)`
      );
    }
    files[date] = found ? mergeFile(prior, found) : missingEntry(date);
  }

  const progress = await saveProgress({
    sourceDir: PDF_DIR,
    model: EMBEDDING_MODEL,
    collection: CHROMA_COLLECTION,
    chromaUrl: CHROMA_URL,
    chunking: chunking || previous?.chunking || null,
    createdAt: previous?.createdAt || new Date().toISOString(),
    calendarStart,
    calendarEnd,
    files,
  });

  return { progress, skipped };
}

export function markFile(progress, date, fields) {
  const current = progress.files[date];
  if (!current) {
    throw new Error(`Date ${date} is not in the ingest calendar`);
  }
  progress.files[date] = {
    ...current,
    ...fields,
    date,
    updatedAt: new Date().toISOString(),
  };
  return progress.files[date];
}

export function resetPresentFiles(progress) {
  for (const [date, entry] of Object.entries(progress.files || {})) {
    if (entry.status === "missing") continue;
    progress.files[date] = {
      ...entry,
      status: "pending",
      totalPages: null,
      nextPage: 1,
      vectorCount: 0,
      updatedAt: new Date().toISOString(),
    };
  }
  return progress;
}

export function progressSummary(progress) {
  const counts = countByStatus(progress);
  const missing = Object.values(progress.files || {})
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.date);
  return { counts, missing };
}

/**
 * Dated issues that were ingested (newest first).
 * `url` is the backend API path; /api/manual 302s to GCS.
 */
export async function listPresentIssues() {
  const progress = await loadProgress();
  const files = progress?.files || {};
  const issues = [];

  for (const date of Object.keys(files).sort().reverse()) {
    const entry = files[date];
    if (entry?.status === "missing") continue;
    const filename = pdfBasename(entry?.source) || hinduPdfFilename(date);
    if (!filename) continue;
    issues.push({
      date,
      filename,
      totalPages: entry?.totalPages ?? null,
      url: apiManualPath(date),
    });
  }

  return {
    calendarStart: progress?.calendarStart || CALENDAR_START,
    calendarEnd: progress?.calendarEnd || null,
    issues,
  };
}

function issueMeta(date, filename, extra = {}) {
  return {
    date,
    filename,
    totalPages: extra.totalPages ?? null,
    sizeBytes: extra.sizeBytes ?? null,
    url: apiManualPath(date),
    remoteUrl: gcsPdfPublicUrl(filename),
  };
}

/** Resolve a dated newspaper PDF to its public GCS object (no disk I/O). */
export async function resolveIssuePdf(date) {
  if (!isISODate(date)) return null;

  const progress = await loadProgress();
  const entry = progress?.files?.[date];
  if (entry?.status === "missing") return null;
  const filename = pdfBasename(entry?.source) || hinduPdfFilename(date);
  if (!filename || !gcsPdfPublicUrl(filename)) return null;
  return issueMeta(date, filename, {
    totalPages: entry?.totalPages ?? null,
    sizeBytes: entry?.sourceSize ?? null,
  });
}
