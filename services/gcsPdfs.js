import { Storage } from "@google-cloud/storage";

import {
  GCS_PDF_BUCKET,
  apiManualPath,
  gcsPdfPublicUrl,
  getVertexAuth,
  hinduPdfFilename,
} from "../config.js";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isISODate(value) {
  if (!ISO_RE.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const SIGN_TTL_MS = 15 * 60 * 1000;

function getStorage() {
  const { projectId } = getVertexAuth();
  if (!GCS_PDF_BUCKET) {
    throw Object.assign(new Error("GCS_PDF_BUCKET is not configured"), {
      status: 503,
    });
  }
  return new Storage({ projectId });
}

function bucket() {
  return getStorage().bucket(GCS_PDF_BUCKET);
}

function dateFromObjectName(objectName) {
  const base = String(objectName || "").split("/").pop() || "";
  const stem = base.replace(/\.pdf$/i, "");
  const iso = stem.match(/(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (isISODate(candidate)) return candidate;
  }
  const dmy = stem.match(/(?:^|[^0-9])(\d{2})-(\d{2})-(\d{4})$/);
  if (dmy) {
    const candidate = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    if (isISODate(candidate)) return candidate;
  }
  return null;
}

function issuePayload(date, filename, extra = {}) {
  return {
    date,
    filename,
    sizeBytes: extra.sizeBytes ?? null,
    url: apiManualPath(date),
    publicUrl: gcsPdfPublicUrl(filename),
  };
}

export function assertNewspaperDate(value) {
  const date = String(value || "").trim();
  if (!isISODate(date)) {
    throw Object.assign(new Error("date must be YYYY-MM-DD"), { status: 400 });
  }
  return date;
}

export function assertPdfBuffer(buffer, declaredType = "") {
  if (!buffer?.length) {
    throw Object.assign(new Error("PDF file is required"), { status: 400 });
  }
  if (buffer.length > MAX_PDF_BYTES) {
    throw Object.assign(
      new Error(`PDF is too large (max ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB)`),
      { status: 413 }
    );
  }
  const magic = buffer.subarray(0, 4).toString("utf8");
  const type = String(declaredType || "").toLowerCase();
  if (magic !== "%PDF" && type !== "application/pdf") {
    throw Object.assign(new Error("File must be a PDF"), { status: 400 });
  }
}

export async function createNewspaperUploadUrl(date) {
  const iso = assertNewspaperDate(date);
  const filename = hinduPdfFilename(iso);
  const [uploadUrl] = await bucket()
    .file(filename)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + SIGN_TTL_MS,
      contentType: "application/pdf",
    });
  return {
    ...issuePayload(iso, filename),
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    expiresInSec: SIGN_TTL_MS / 1000,
  };
}

export async function uploadNewspaperPdf(date, buffer, contentType) {
  const iso = assertNewspaperDate(date);
  assertPdfBuffer(buffer, contentType);
  const filename = hinduPdfFilename(iso);
  await bucket()
    .file(filename)
    .save(buffer, {
      resumable: false,
      contentType: "application/pdf",
      metadata: {
        cacheControl: "public, max-age=86400",
        contentDisposition: `inline; filename="${filename}"`,
      },
    });
  return issuePayload(iso, filename, { sizeBytes: buffer.length });
}

export async function confirmNewspaperPdf(date) {
  const iso = assertNewspaperDate(date);
  const filename = hinduPdfFilename(iso);
  const file = bucket().file(filename);
  const [exists] = await file.exists();
  if (!exists) {
    throw Object.assign(new Error(`No PDF in GCS for ${iso}`), { status: 404 });
  }
  const [metadata] = await file.getMetadata();
  return issuePayload(iso, filename, {
    sizeBytes: Number(metadata.size) || null,
  });
}

export async function listNewspaperPdfs() {
  if (!GCS_PDF_BUCKET) return [];
  const [files] = await bucket().getFiles();
  const byDate = new Map();
  for (const file of files) {
    const date = dateFromObjectName(file.name);
    if (!date) continue;
    const filename = String(file.name).split("/").pop();
    byDate.set(date, {
      date,
      filename,
      sizeBytes: Number(file.metadata?.size) || null,
    });
  }
  return [...byDate.values()];
}
