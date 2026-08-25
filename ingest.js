import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { Document } from "@langchain/core/documents";
import { VertexAIEmbeddings } from "@langchain/google-vertexai";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { ChromaClient } from "chromadb";
import { SemanticChunker } from "@chonkiejs/core";

import {
  openPdfDocument,
  extractArticlesFromLoadedPage,
} from "./layoutArticles.js";
import { piecesFromSemanticChunks, formatChunk } from "./chunkText.js";
import {
  PDF_DIR,
  CALENDAR_START,
  INGEST_UNTIL,
  EMBEDDING_MODEL,
  CHROMA_URL,
  CHROMA_COLLECTION,
  LEGACY_CHROMA_COLLECTION,
  INGEST_FILE_BATCH,
  EMBED_BATCH_SIZE,
  EMBED_MAX_RETRIES,
  EMBED_RETRY_BASE_MS,
  EMBED_BATCH_PAUSE_MS,
  SEMANTIC_THRESHOLD,
  SEMANTIC_CHUNK_SIZE,
  SEMANTIC_SIMILARITY_WINDOW,
  SEMANTIC_MIN_SENTENCES_PER_CHUNK,
  SEMANTIC_MIN_CHARS_PER_SENTENCE,
  SEMANTIC_PAGE_WINDOW,
  MAX_CHUNK_WORDS,
  CHUNK_OVERLAP_WORDS,
  HEADLINE_MIN_SIZE,
  BODY_MIN_SIZE,
  BODY_MAX_SIZE,
  getVertexAuth,
  getLocation,
  getChromaClientOptions,
} from "./config.js";
import {
  dateParts,
  filesToIngest,
  isISODate,
  markFile,
  nextFileBatch,
  parseDateFromFilename,
  presentFilesComplete,
  progressSummary,
  resetPresentFiles,
  saveProgress,
  syncProgress,
} from "./services/ingestCalendar.js";

const CHUNKING_MODE = "semantic-layout-v6";

const vertexAuth = getVertexAuth();
const location = getLocation();

function printHelp() {
  const batchNote = INGEST_FILE_BATCH > 0
    ? `Each run processes at most ${INGEST_FILE_BATCH} present files, then stops.`
    : `Each run continues until ${INGEST_UNTIL} (no file-count cap).`;
  console.log(`
Ingest dated newspaper PDFs into Chroma (vectors only).
Walks the calendar from ${CALENDAR_START} through ${INGEST_UNTIL}. Missing dates are marked and skipped.
${batchNote}

Usage:
  node ingest.js
  node ingest.js --date 2026-08-23
  node ingest.js --from 2026-08-01 --to 2026-08-23
  node ingest.js path/to/The-Hindu-24-08-2026.pdf
  node ingest.js --force --date 2026-01-15
  node ingest.js --force-all

Options:
  --date YYYY-MM-DD     Ingest one issue (ignores the file-count cap)
  --from / --to         Inclusive date range (default --to ${INGEST_UNTIL})
  --force, -f           Re-ingest the selected date (requires --date or a file)
  --force-all           Reset the NEW collection only, then ingest through ${INGEST_UNTIL}
  --help,  -h           Show this help

Collection:  ${CHROMA_COLLECTION}
Chroma URL:  ${CHROMA_URL}
Legacy (kept): ${LEGACY_CHROMA_COLLECTION}

This API talks to the same stack as RAG/8.2026-data:
  Chroma :8001 (rag-newspapers-chroma), lexical host :8002
  Start that stack from RAG/8.2026-data: npm run chroma:up
`);
}

function requireISO(label, value) {
  if (!isISODate(value)) {
    console.error(`${label} must be YYYY-MM-DD, got: ${value}`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv) {
  let force = false;
  let forceAll = false;
  let date = null;
  let from = null;
  let to = null;
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--force-all") {
      forceAll = true;
      continue;
    }
    if (arg === "--force" || arg === "-f") {
      force = true;
      continue;
    }
    if (arg === "--date") {
      date = requireISO("--date", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--from") {
      from = requireISO("--from", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--to") {
      to = requireISO("--to", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
    positional.push(arg);
  }

  if (force && !forceAll && !date && !positional[0]) {
    console.error("Use --force --date YYYY-MM-DD (or a PDF path), or --force-all.");
    process.exit(1);
  }

  return {
    force,
    forceAll,
    date,
    from,
    to: date || positional[0] ? to : to || INGEST_UNTIL,
    extraFile: positional[0] || null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err) {
  const parts = [
    err?.message,
    err?.cause?.message ? `cause: ${err.cause.message}` : null,
    err?.code ? `code: ${err.code}` : null,
    err?.status ? `status: ${err.status}` : null,
  ].filter(Boolean);
  return parts.join(" | ").slice(0, 400) || String(err);
}

function isRetryableError(err) {
  const code = err?.code || err?.error?.code || err?.cause?.code;
  const status = err?.status || err?.response?.status;
  const message = String(err?.message || "");
  const causeMessage = String(err?.cause?.message || "");

  return (
    code === "ECONNABORTED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /ECONNABORTED|ECONNRESET|ETIMEDOUT|fetch failed|network|Too Many Requests|429|503|socket hang up|Headers Timeout|Body Timeout/i.test(
      `${message} ${causeMessage}`
    )
  );
}

async function withRetries(fn, label) {
  let lastError;

  for (let attempt = 1; attempt <= EMBED_MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === EMBED_MAX_RETRIES) {
        throw err;
      }

      const waitMs = EMBED_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `${label} failed (attempt ${attempt}/${EMBED_MAX_RETRIES}): ${formatError(err)}`
      );
      console.warn(`Retrying in ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

/** Vertex rejects / times out huge single embed payloads; Chonkie can send thousands. */
async function embedDocumentsBatched(embeddings, texts, label) {
  if (texts.length === 0) return [];

  const out = [];
  const totalBatches = Math.ceil(texts.length / EMBED_BATCH_SIZE);

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batchIndex = Math.floor(i / EMBED_BATCH_SIZE) + 1;
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await withRetries(
      () => embeddings.embedDocuments(batch),
      `${label} (${batchIndex}/${totalBatches}, size ${batch.length})`
    );
    out.push(...vectors);

    if (i + EMBED_BATCH_SIZE < texts.length) {
      await sleep(EMBED_BATCH_PAUSE_MS);
    }
  }

  return out;
}

async function assertChromaUp() {
  const client = new ChromaClient(getChromaClientOptions());
  try {
    await client.heartbeat();
  } catch (err) {
    throw new Error(
      `Cannot reach Chroma at ${CHROMA_URL}. Start rag-newspapers-chroma from RAG/8.2026-data (npm run chroma:up).\n` +
        `Original error: ${err.message}`
    );
  }
  return client;
}

function assertSafeCollection() {
  if (CHROMA_COLLECTION === LEGACY_CHROMA_COLLECTION) {
    throw new Error(
      `Refusing to write to legacy collection "${LEGACY_CHROMA_COLLECTION}". ` +
        `Set CHROMA_COLLECTION=newspapers_2026`
    );
  }
}

async function resetNewCollection(client) {
  assertSafeCollection();
  try {
    await client.deleteCollection({ name: CHROMA_COLLECTION });
    console.log(`Deleted collection "${CHROMA_COLLECTION}" (legacy "${LEGACY_CHROMA_COLLECTION}" kept)`);
  } catch {
    // Collection may not exist yet.
  }
}

async function deleteDateVectors(client, date) {
  assertSafeCollection();
  try {
    const collection = await client.getCollection({
      name: CHROMA_COLLECTION,
      embeddingFunction: null,
    });
    await collection.delete({ where: { date: { $eq: date } } });
    console.log(`Removed existing vectors for ${date} from "${CHROMA_COLLECTION}"`);
  } catch {
    // Collection or date may not exist yet.
  }
}

async function createChromaStore(embeddings, client) {
  const store = new Chroma(embeddings, {
    index: client,
    collectionName: CHROMA_COLLECTION,
    collectionMetadata: {
      "hnsw:space": "cosine",
    },
  });
  await store.ensureCollection();
  return store;
}

async function collectionCount(vectorStore) {
  const collection = await vectorStore.ensureCollection();
  return collection.count();
}

async function embedBatch(vectorStore, batch, label) {
  if (batch.length === 0) return;

  const docs = batch.splice(0, batch.length);
  const ids = docs.map((doc) => doc.id || randomUUID());
  await withRetries(
    () => vectorStore.addDocuments(docs, { ids }),
    label
  );
  await sleep(EMBED_BATCH_PAUSE_MS);
}

async function* streamPdfArticles(pdfPath, startPage = 1) {
  await new Promise((resolve, reject) => {
    const probe = fs.createReadStream(pdfPath, { start: 0, end: 0 });
    probe.once("error", reject);
    probe.once("readable", () => {
      probe.destroy();
      resolve();
    });
  });

  const doc = await openPdfDocument(path.resolve(pdfPath));
  try {
    const totalPages = doc.numPages;
    console.log(
      `PDF has ${totalPages} pages (layout articles from page ${startPage})`
    );

    const layoutOptions = {
      headlineMinSize: HEADLINE_MIN_SIZE,
      bodyMinSize: BODY_MIN_SIZE,
      bodyMaxSize: BODY_MAX_SIZE,
    };

    for (let pageNumber = startPage; pageNumber <= totalPages; pageNumber += 1) {
      const articles = await extractArticlesFromLoadedPage(
        doc,
        pageNumber,
        layoutOptions
      );

      yield {
        pageNumber,
        totalPages,
        articles,
        metadata: {
          source: pdfPath,
          pageNumber,
          totalPages,
        },
      };
    }
  } finally {
    await doc.destroy();
  }
}

function printCalendar(progress, skipped) {
  const { counts, missing } = progressSummary(progress);
  console.log(
    `Calendar ${progress.calendarStart} → ${progress.calendarEnd}  ` +
      `complete=${counts.complete} pending=${counts.pending} ` +
      `in_progress=${counts.in_progress} stale=${counts.stale} missing=${counts.missing}`
  );
  if (missing.length) {
    const preview = missing.length > 12
      ? `${missing.slice(0, 12).join(", ")} … +${missing.length - 12}`
      : missing.join(", ");
    console.log(`Missing dates: ${preview}`);
  }
  if (skipped.length) {
    console.warn(`Skipped ${skipped.length} PDF(s) with no parseable date: ${skipped.join(", ")}`);
  }
}

async function indexIssue({
  vectorStore,
  semanticChunker,
  progress,
  entry,
  forceDate,
  client,
}) {
  if (!fs.existsSync(entry.source)) {
    throw new Error(`PDF not found: ${entry.source}`);
  }

  const parts = dateParts(entry.date);
  const restart = forceDate || entry.status === "stale" || entry.status === "pending";
  if (restart && (forceDate || entry.status === "stale" || entry.vectorCount > 0)) {
    await deleteDateVectors(client, entry.date);
    markFile(progress, entry.date, {
      status: "pending",
      nextPage: 1,
      vectorCount: 0,
      totalPages: null,
    });
    await saveProgress(progress);
  }

  const startPage =
    !restart && entry.status === "in_progress" && Number(entry.nextPage) > 1
      ? Number(entry.nextPage)
      : 1;

  if (startPage > 1) {
    console.log(
      `\nResuming ${entry.date} from page ${startPage}/${entry.totalPages || "?"} (${entry.source})`
    );
  } else {
    console.log(`\nIngesting ${entry.date}  ${entry.source}`);
  }

  let pending = [];
  let fileChunks = startPage > 1 ? Number(entry.vectorCount) || 0 : 0;
  let totalPages = entry.totalPages ?? null;
  let pagesProcessed = 0;
  let batchNumber = 0;
  let pageWindow = [];

  async function pushChunk(piece, metadata, logLabel) {
    pending.push(
      new Document({
        id: randomUUID(),
        pageContent: piece,
        metadata,
      })
    );
    if (pending.length >= EMBED_BATCH_SIZE) {
      batchNumber += 1;
      const size = pending.length;
      await embedBatch(vectorStore, pending, `Embedding batch ${batchNumber}`);
      fileChunks += size;
      console.log(`${logLabel} — ${fileChunks} vectors for ${entry.date}`);
    }
  }

  async function flushPageWindow() {
    if (pageWindow.length === 0) return;

    const lastPage = pageWindow[pageWindow.length - 1];

    for (const page of pageWindow) {
      console.log(
        `${entry.date} page ${page.pageNumber}/${page.totalPages}: ${page.articles.length} heading articles`
      );

      for (const article of page.articles) {
        const metadata = {
          source: entry.source,
          date: parts.date,
          dateInt: parts.dateInt,
          year: parts.year,
          month: parts.month,
          day: parts.day,
          pageNumber: page.pageNumber,
          pageStart: page.pageNumber,
          pageEnd: page.pageNumber,
          totalPages: page.totalPages,
          section: article.section || "",
          heading: (article.heading || "").slice(0, 350),
          chunking: CHUNKING_MODE,
        };

        const bodyText = (article.body || "").trim() || article.text;
        const semanticChunks = await semanticChunker.chunk(bodyText);
        const pieces = piecesFromSemanticChunks(
          bodyText,
          semanticChunks,
          MAX_CHUNK_WORDS,
          CHUNK_OVERLAP_WORDS
        );

        for (let ci = 0; ci < pieces.length; ci += 1) {
          await pushChunk(
            formatChunk(
              article.heading,
              pieces[ci],
              ci + 1,
              pieces.length,
              parts.date
            ),
            {
              ...metadata,
              chunkIndex: ci + 1,
              chunkTotal: pieces.length,
            },
            `${entry.date} p${page.pageNumber} / ${(article.heading || "").slice(0, 48)}`
          );
        }
      }
    }

    markFile(progress, entry.date, {
      status: "in_progress",
      totalPages: lastPage.totalPages,
      nextPage: lastPage.pageNumber + 1,
      vectorCount: fileChunks,
      chunking: CHUNKING_MODE,
    });
    await saveProgress(progress);
    pageWindow = [];
  }

  for await (const page of streamPdfArticles(entry.source, startPage)) {
    totalPages = page.totalPages;
    pagesProcessed += 1;
    pageWindow.push(page);

    const isLastPage = page.pageNumber === page.totalPages;
    if (pageWindow.length >= SEMANTIC_PAGE_WINDOW || isLastPage) {
      await flushPageWindow();
    }

    if (pagesProcessed % 25 === 0 || isLastPage) {
      const count = await collectionCount(vectorStore);
      console.log(
        `Progress: ${entry.date} page ${page.pageNumber}/${page.totalPages}, chroma_count=${count}`
      );
    }
  }

  if (pending.length > 0) {
    batchNumber += 1;
    const size = pending.length;
    await embedBatch(vectorStore, pending, `Embedding batch ${batchNumber}`);
    fileChunks += size;
  }

  markFile(progress, entry.date, {
    status: "complete",
    totalPages,
    nextPage: (totalPages ?? 0) + 1,
    vectorCount: fileChunks,
    chunking: CHUNKING_MODE,
  });
  await saveProgress(progress);
  console.log(`Finished ${entry.date}: ${fileChunks} vectors, ${totalPages} pages`);
}

async function indexNewspapers(embeddings, options) {
  assertSafeCollection();
  const { progress, skipped } = await syncProgress({
    extraFile: options.extraFile,
    chunking: CHUNKING_MODE,
  });
  printCalendar(progress, skipped);

  if (options.extraFile) {
    const extraDate = parseDateFromFilename(options.extraFile);
    options.date = extraDate;
    if (options.force) {
      markFile(progress, extraDate, { status: "stale" });
      await saveProgress(progress);
    }
  } else if (options.force && options.date) {
    const entry = progress.files[options.date];
    if (!entry || entry.status === "missing") {
      throw new Error(`No PDF on disk for ${options.date}`);
    }
    markFile(progress, options.date, { status: "stale" });
    await saveProgress(progress);
  }

  let queue;
  let remaining = 0;
  let due = 0;

  function takeBatch() {
    const batch = nextFileBatch(progress, {
      date: options.date,
      from: options.from,
      to: options.to,
      limit: INGEST_FILE_BATCH,
    });
    queue = batch.queue;
    remaining = batch.remaining;
    due = batch.due;
  }

  takeBatch();

  if (options.forceAll) {
    const client = await assertChromaUp();
    console.log("Force-all: resetting the new collection only...");
    await resetNewCollection(client);
    resetPresentFiles(progress);
    await saveProgress(progress);
    takeBatch();
  }

  if (queue.length === 0) {
    console.log(
      `Nothing to ingest in "${CHROMA_COLLECTION}". ` +
        `Drop a missing/future The-Hindu-DD-MM-YYYY.pdf into ${PDF_DIR} and re-run.`
    );
    return progress;
  }

  const first = queue[0].date;
  const last = queue[queue.length - 1].date;
  console.log(
    `This run: ${queue.length} present file(s) ${first} → ${last}` +
      (remaining
        ? ` (${remaining} more after this batch of ${INGEST_FILE_BATCH})`
        : ` (${due} due through ${options.to || INGEST_UNTIL})`) +
      ` → Chroma "${CHROMA_COLLECTION}" at ${CHROMA_URL}`
  );

  const client = await assertChromaUp();
  const vectorStore = await createChromaStore(embeddings, client);
  const semanticChunker = await SemanticChunker.create({
    embeddings: async (texts) => {
      console.log(`Semantic embed request: ${texts.length} texts`);
      return embedDocumentsBatched(
        embeddings,
        texts,
        "Semantic chunk embedding"
      );
    },
    threshold: SEMANTIC_THRESHOLD,
    chunkSize: SEMANTIC_CHUNK_SIZE,
    similarityWindow: SEMANTIC_SIMILARITY_WINDOW,
    minSentencesPerChunk: SEMANTIC_MIN_SENTENCES_PER_CHUNK,
    minCharactersPerSentence: SEMANTIC_MIN_CHARS_PER_SENTENCE,
  });

  for (const queued of queue) {
    const entry = progress.files[queued.date];
    await indexIssue({
      vectorStore,
      semanticChunker,
      progress,
      entry,
      forceDate: options.force && options.date === entry.date,
      client,
    });
  }

  const finalCount = await collectionCount(vectorStore);
  const saved = await saveProgress({
    ...progress,
    chunking: CHUNKING_MODE,
  });
  const { counts } = progressSummary(saved);
  console.log(
    `Done. ${finalCount} vectors in "${CHROMA_COLLECTION}" ` +
      `(complete=${counts.complete}, missing=${counts.missing}, pending=${counts.pending})`
  );
  return saved;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const embeddings = new VertexAIEmbeddings({
    model: EMBEDDING_MODEL,
    location,
    authOptions: vertexAuth,
  });

  console.log(`Newspaper folder: ${path.resolve(PDF_DIR)}`);
  console.log(`Collection: ${CHROMA_COLLECTION} (legacy ${LEGACY_CHROMA_COLLECTION} kept)`);
  console.log(
    `Walk ${CALENDAR_START} → ${options.to || INGEST_UNTIL}; missing dates skipped` +
      (INGEST_FILE_BATCH > 0
        ? `; ${INGEST_FILE_BATCH} present files per run`
        : "; no file-count cap")
  );
  const saved = await indexNewspapers(embeddings, options);
  if (presentFilesComplete(saved)) {
    console.log("\nAll present files ingested.");
    console.log("Next: node ingest-lexical.js --from 2026-01-01 --to 2026-01-31");
    console.log('Then:  node query.js "your question"');
  } else if (saved) {
    const due = filesToIngest(saved);
    const next = due[0];
    console.log(
      `\nBatch complete. ${due.length} present file(s) still pending` +
        (next ? `; next is ${next.date}` : "") +
        ".\nRe-run: node ingest.js"
    );
    console.log(
      "BM25 (replaces previous index): node ingest-lexical.js --from YYYY-MM-DD --to YYYY-MM-DD"
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
