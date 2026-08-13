import "dotenv/config";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

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
  PDF_PATH,
  PROGRESS_PATH,
  EMBEDDING_MODEL,
  CHROMA_URL,
  CHROMA_COLLECTION,
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

const CHUNKING_MODE = "semantic-layout-v6";

const vertexAuth = getVertexAuth();
const location = getLocation();

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
      `Cannot reach Chroma at ${CHROMA_URL}. Start it with: docker compose up -d\n` +
        `Original error: ${err.message}`
    );
  }
  return client;
}

async function saveProgress(pdfPath, fields) {
  const pdfStat = await fsPromises.stat(pdfPath);
  const payload = {
    source: pdfPath,
    sourceMtimeMs: pdfStat.mtimeMs,
    sourceSize: pdfStat.size,
    model: EMBEDDING_MODEL,
    collection: CHROMA_COLLECTION,
    chromaUrl: CHROMA_URL,
    chunking: CHUNKING_MODE,
    createdAt: new Date().toISOString(),
    ...fields,
  };

  await fsPromises.mkdir(path.dirname(PROGRESS_PATH), { recursive: true });
  await fsPromises.writeFile(PROGRESS_PATH, JSON.stringify(payload, null, 2));
}

async function loadProgress(pdfPath) {
  try {
    const raw = await fsPromises.readFile(PROGRESS_PATH, "utf8");
    if (!raw.trim()) {
      return { stale: false, progress: null };
    }
    const progress = JSON.parse(raw);
    const pdfStat = await fsPromises.stat(pdfPath);

    if (
      progress.source !== pdfPath ||
      progress.sourceMtimeMs !== pdfStat.mtimeMs ||
      progress.sourceSize !== pdfStat.size ||
      progress.model !== EMBEDDING_MODEL ||
      progress.collection !== CHROMA_COLLECTION ||
      progress.chunking !== CHUNKING_MODE
    ) {
      return { stale: true, progress };
    }

    return { stale: false, progress };
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) {
      return { stale: false, progress: null };
    }
    throw err;
  }
}

async function resetCollection(client) {
  try {
    await client.deleteCollection({ name: CHROMA_COLLECTION });
    console.log(`Deleted stale collection "${CHROMA_COLLECTION}"`);
  } catch {
    // Collection may not exist yet.
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

  await withRetries(() => vectorStore.addDocuments(batch), label);
  batch.length = 0;
  await sleep(EMBED_BATCH_PAUSE_MS);
}

/**
 * Open the PDF once and yield layout-split articles page by page.
 */
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

async function indexPdfIntoChroma(embeddings) {
  const client = await assertChromaUp();
  const { stale, progress } = await loadProgress(PDF_PATH);

  if (progress?.complete && !stale) {
    const count = await (async () => {
      try {
        const collection = await client.getCollection({
          name: CHROMA_COLLECTION,
          embeddingFunction: null,
        });
        return collection.count();
      } catch {
        return 0;
      }
    })();

    if (count > 0) {
      console.log(
        `Index already complete in Chroma collection "${CHROMA_COLLECTION}" (${count} vectors). Nothing to do.`
      );
      return;
    }
  }

  const canResume =
    !stale &&
    progress &&
    !progress.complete &&
    Number(progress.nextPage) > 1;

  const startPage = canResume ? progress.nextPage : 1;

  if (canResume) {
    console.log(
      `Resuming ingest from page ${startPage}/${progress.totalPages}`
    );
  } else {
    if (stale) {
      console.log("PDF or settings changed; resetting Chroma collection...");
    }
    await resetCollection(client);
  }

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

  let pending = [];
  let totalChunks = startPage > 1 ? await collectionCount(vectorStore) : 0;
  let totalPages = progress?.totalPages ?? null;
  let pagesProcessed = 0;
  let batchNumber = 0;
  let pageWindow = [];

  console.log(
    `Streaming PDF → heading articles → semantic chunks → Chroma "${CHROMA_COLLECTION}" at ${CHROMA_URL} (batch ${EMBED_BATCH_SIZE}, window ${SEMANTIC_PAGE_WINDOW} pages)...`
  );

  async function pushChunk(piece, metadata, logLabel) {
    pending.push(
      new Document({
        pageContent: piece,
        metadata,
      })
    );
    if (pending.length >= EMBED_BATCH_SIZE) {
      batchNumber += 1;
      const size = pending.length;
      await embedBatch(vectorStore, pending, `Embedding batch ${batchNumber}`);
      totalChunks += size;
      console.log(`${logLabel} — ${totalChunks} vectors in Chroma`);
    }
  }

  async function flushPageWindow() {
    if (pageWindow.length === 0) return;

    const firstPage = pageWindow[0];
    const lastPage = pageWindow[pageWindow.length - 1];

    for (const page of pageWindow) {
      console.log(
        `Page ${page.pageNumber}/${page.totalPages}: ${page.articles.length} heading articles`
      );

      for (const article of page.articles) {
        const metadata = {
          source: firstPage.metadata.source,
          pageNumber: page.pageNumber,
          pageStart: page.pageNumber,
          pageEnd: page.pageNumber,
          totalPages: page.totalPages,
          section: article.section || "",
          heading: (article.heading || "").slice(0, 350),
          chunking: CHUNKING_MODE,
        };

        // Semantic chunk, rejoin mid-word cuts, then sentence-pack with overlap.
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
              pieces.length
            ),
            {
              ...metadata,
              chunkIndex: ci + 1,
              chunkTotal: pieces.length,
            },
            `Page ${page.pageNumber} / ${(article.heading || "").slice(0, 48)}`
          );
        }
      }
    }

    await saveProgress(PDF_PATH, {
      totalPages: lastPage.totalPages,
      nextPage: lastPage.pageNumber + 1,
      complete: false,
      vectorCount: totalChunks,
      chunking: CHUNKING_MODE,
    });

    pageWindow = [];
  }

  for await (const page of streamPdfArticles(PDF_PATH, startPage)) {
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
        `Progress: page ${page.pageNumber}/${page.totalPages}, chroma_count=${count}`
      );
    }
  }

  if (pending.length > 0) {
    batchNumber += 1;
    const size = pending.length;
    await embedBatch(vectorStore, pending, `Embedding batch ${batchNumber}`);
    totalChunks += size;
  }

  const finalCount = await collectionCount(vectorStore);
  await saveProgress(PDF_PATH, {
    totalPages,
    nextPage: (totalPages ?? 0) + 1,
    complete: true,
    vectorCount: finalCount,
    chunking: CHUNKING_MODE,
  });

  console.log(
    `Done. ${finalCount} vectors stored in Chroma collection "${CHROMA_COLLECTION}"`
  );
}

async function main() {
  const embeddings = new VertexAIEmbeddings({
    model: EMBEDDING_MODEL,
    location,
    authOptions: vertexAuth,
  });

  await indexPdfIntoChroma(embeddings);
  console.log('\nNext: node query.js "your question"');
}

main().catch(console.error);
