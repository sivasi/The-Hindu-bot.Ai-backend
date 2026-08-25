import path from "path";

/** Folder of The-Hindu-DD-MM-YYYY.pdf issues (same as RAG/8.2026-data). */
export const PDF_DIR = process.env.PDF_DIR || path.join("data", "pdf");
export const CALENDAR_START = process.env.CALENDAR_START || "2026-01-01";
/** Inclusive end date for a default `node ingest.js` run. */
export const INGEST_UNTIL = process.env.INGEST_UNTIL || "2026-08-24";
/**
 * Present PDFs processed per `node ingest.js` run.
 * 0 = no cap (ingest every due file through INGEST_UNTIL).
 */
export const INGEST_FILE_BATCH = Number(process.env.INGEST_FILE_BATCH || 0);
export const PROGRESS_PATH = path.join("cache", "ingest.progress.json");
export const EMBEDDING_MODEL = "text-embedding-005";
/**
 * Local default: same Chroma as RAG/8.2026-data (`rag-newspapers-chroma` :8001).
 * Production may override CHROMA_URL to the cluster Chroma service.
 */
export const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8001";
/** Legacy single-PDF collection — ingest never deletes or overwrites it. */
export const LEGACY_CHROMA_COLLECTION = "manual4_pdf";
export const CHROMA_COLLECTION =
  process.env.CHROMA_COLLECTION || "newspapers_2026";
export const EXAM_PDF_PATH =
  process.env.EXAM_PDF_PATH || path.join("data", "THE HINDU today.pdf");
/** Public GCS bucket for newspaper PDFs (local and GKE). */
export const GCS_PDF_BUCKET =
  process.env.GCS_PDF_BUCKET || "hindu-bot-pdfs-b23f08c8";

export function hinduPdfFilename(iso) {
  const [year, month, day] = String(iso).split("-");
  return `The-Hindu-${day}-${month}-${year}.pdf`;
}

/** Basename that works for Windows paths even when the API runs on Linux. */
export function pdfBasename(source) {
  const name = String(source || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  return name || "";
}

export function apiManualPath(date) {
  return date ? `/api/manual?date=${date}` : "/api/manual";
}

export function gcsPdfPublicUrl(objectName) {
  if (!GCS_PDF_BUCKET || !objectName) return null;
  return `https://storage.googleapis.com/${GCS_PDF_BUCKET}/${encodeURIComponent(objectName)}`;
}

export const TODAY_PDF_OBJECT =
  pdfBasename(EXAM_PDF_PATH) || "THE HINDU today.pdf";
/** Comma-separated Google emails allowed to upload newspaper PDFs. */
export const PUBLISHER_EMAILS = String(
  process.env.PUBLISHER_EMAILS || "adityasivasi@gmail.com"
)
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export function isPublisherEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return Boolean(normalized && PUBLISHER_EMAILS.includes(normalized));
}
export const EXAM_PROGRESS_PATH = path.join("cache", "exam-ingest.progress.json");
/** Pause between page curate calls (0 = max speed). */
export const EXAM_CURATE_PAUSE_MS = Number(process.env.EXAM_CURATE_PAUSE_MS) || 0;
/** Retries for a single page curate call. */
export const EXAM_CURATE_MAX_RETRIES =
  Number(process.env.EXAM_CURATE_MAX_RETRIES) || 3;
export const EXAM_CURATE_RETRY_BASE_MS =
  Number(process.env.EXAM_CURATE_RETRY_BASE_MS) || 2000;

export const PORT = Number(process.env.PORT) || 3001;
/** Comma-separated origins, or "*" for any (local FE). */
export const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
export const DEFAULT_RETRIEVER_K = Number(process.env.RETRIEVER_K) || 3;
/** Retriever k when frontend sends turbo: true */
export const TURBO_RETRIEVER_K = Number(process.env.TURBO_RETRIEVER_K) || 10;

export const LEXICAL_INDEX_FILE = "lexical-index.json";
export const LEXICAL_INDEX_URL =
  process.env.LEXICAL_INDEX_URL || `http://localhost:8002/${LEXICAL_INDEX_FILE}`;
export const LEXICAL_INDEX_VERSION = 3;
/** Cap how many single-topic searches a decomposed question can spawn. */
export const MAX_DECOMPOSED_QUERIES = 3;
/** Rolling chat-memory size stored on ChatSession.summary. */
export const CONVERSATION_SUMMARY_MAX_CHARS = 1600;

/** Wider pool per retriever before Reciprocal Rank Fusion. */
export const HYBRID_CANDIDATE_K = 20;
/** RRF lexical weight when the rarest token matches at most this many chunks. */
export const HYBRID_LEXICAL_WEIGHT_MAX = 0.75;
export const HYBRID_LEXICAL_UNIQUE_MAX_CHUNKS = 3;
/** RRF semantic weight when the rarest token is at the 1% gate cutoff. */
export const HYBRID_SEMANTIC_AT_CUTOFF = 0.75;
/** Steepness of the semantic ramp after UNIQUE_MAX_CHUNKS (higher = faster). */
export const HYBRID_WEIGHT_EXP_K = 8;
/** Lower than the textbook 60 so a strong semantic #1 beats weak dual-list mid ranks. */
export const HYBRID_RRF_C = 10;
/** BM25 runs only if a query token appears in fewer than this share of chunks. */
export const LEXICAL_RARE_DF_RATIO = Number(process.env.LEXICAL_RARE_DF_RATIO || 0.01);

/** Google OAuth 2.0 / OpenID (GIS) — no Passport, no sessions. */
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
/** Redirect URI registered in Google Cloud Console (auth-code flow only). */
export const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/api/auth/google/callback";
/** HMAC secret for app JWTs issued after Google sign-in. */
export const JWT_SECRET = process.env.JWT_SECRET || "";
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
/** MongoDB connection string (users collection for Google sign-in). */
/** Local default. Production sets MONGODB_URI to the cluster Mongo service. */
export const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/rag_users";
/**
 * When true, /api/query* and /api/manual* require Bearer JWT.
 * Defaults to true if GOOGLE_CLIENT_ID is set.
 */
export const AUTH_REQUIRED =
  process.env.AUTH_REQUIRED != null
    ? !["0", "false", "no"].includes(String(process.env.AUTH_REQUIRED).toLowerCase())
    : Boolean(GOOGLE_CLIENT_ID);

// Conservative Vertex pacing to avoid 429 quota / QPM limits.
export const EMBED_BATCH_SIZE = 24;
export const EMBED_MAX_RETRIES = 12;
export const EMBED_RETRY_BASE_MS = 8000;
export const EMBED_BATCH_PAUSE_MS = 2000;

// @chonkiejs/core SemanticChunker options
// Character tokenizer: ~5–6 chars/word → 1000 ≈ ~200 words soft target.
export const SEMANTIC_THRESHOLD = 0.8;
export const SEMANTIC_CHUNK_SIZE = 1000; // soft cap in chars (Chonkie tokenizer)
/** Soft word target for stored chunks; splits never cut mid-sentence. */
export const MAX_CHUNK_WORDS = 200;
/** Overlap prior chunk by ~this many words (complete sentences) into the next. */
export const CHUNK_OVERLAP_WORDS = 20;
export const SEMANTIC_SIMILARITY_WINDOW = 1;
export const SEMANTIC_MIN_SENTENCES_PER_CHUNK = 1;
/** Merge tiny PDF fragments so pass-1 embed count stays manageable. */
export const SEMANTIC_MIN_CHARS_PER_SENTENCE = 100;
/** Accumulate this many PDF pages before running semantic chunking. */
export const SEMANTIC_PAGE_WINDOW = 1;

// Layout-aware article split (before semantic chunking)
// 13.5 catches front-page teaser titles (~13.9) as well as large headlines.
export const HEADLINE_MIN_SIZE = 12.8;
export const BODY_MIN_SIZE = 7.5;
export const BODY_MAX_SIZE = 10.2;

export function getVertexAuth() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    throw new Error(
      "Set GOOGLE_CLOUD_PROJECT in your environment. Auth uses Application Default Credentials (run: gcloud auth application-default login)."
    );
  }
  return { projectId: project };
}

export function getLocation() {
  return process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
}

/** Chat model for /api/query (may differ from embed region). */
export function getChatModel() {
  return process.env.CHAT_MODEL || "gemini-2.5-flash";
}

export function getChatLocation() {
  return process.env.CHAT_LOCATION || getLocation();
}

/** Parse CHROMA_URL into host/port/ssl for the modern ChromaClient API. */
export function getChromaClientOptions() {
  const parsed = new URL(CHROMA_URL);
  return {
    host: parsed.hostname || "localhost",
    port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 8000,
    ssl: parsed.protocol === "https:",
  };
}

/** Origin of the lexical-index host (health checks). */
export function getLexicalIndexOrigin() {
  return new URL(LEXICAL_INDEX_URL).origin;
}
