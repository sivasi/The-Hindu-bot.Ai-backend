import fs from "fs/promises";
import { ChromaClient } from "chromadb";
import { Chroma } from "@langchain/community/vectorstores/chroma";
import { Document } from "@langchain/core/documents";

import {
  PROGRESS_PATH,
  CHROMA_URL,
  CHROMA_COLLECTION,
  getChromaClientOptions,
} from "../config.js";

export async function readProgress() {
  try {
    return JSON.parse(await fs.readFile(PROGRESS_PATH, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function getHealth() {
  const client = new ChromaClient(getChromaClientOptions());
  let chromaOk = false;
  try {
    await client.heartbeat();
    chromaOk = true;
  } catch {
    return {
      ok: false,
      chromaOk: false,
      indexReady: false,
      vectorCount: 0,
      collection: CHROMA_COLLECTION,
      chromaUrl: CHROMA_URL,
      error: `Cannot reach Chroma at ${CHROMA_URL}`,
    };
  }

  const progress = await readProgress();
  if (!progress) {
    return {
      ok: false,
      chromaOk,
      indexReady: false,
      vectorCount: 0,
      collection: CHROMA_COLLECTION,
      chromaUrl: CHROMA_URL,
      error: "No ingest progress. Run: node ingest.js",
    };
  }

  if (!progress.complete) {
    return {
      ok: false,
      chromaOk,
      indexReady: false,
      vectorCount: progress.vectorCount || 0,
      collection: CHROMA_COLLECTION,
      chromaUrl: CHROMA_URL,
      progress: {
        nextPage: progress.nextPage,
        totalPages: progress.totalPages,
        complete: false,
      },
      error: `Ingest incomplete (page ${progress.nextPage}/${progress.totalPages})`,
    };
  }

  let vectorCount = 0;
  try {
    const collection = await client.getCollection({
      name: CHROMA_COLLECTION,
      embeddingFunction: null,
    });
    vectorCount = await collection.count();
  } catch {
    return {
      ok: false,
      chromaOk,
      indexReady: false,
      vectorCount: 0,
      collection: CHROMA_COLLECTION,
      chromaUrl: CHROMA_URL,
      error: `Collection "${CHROMA_COLLECTION}" not found`,
    };
  }

  if (!vectorCount) {
    return {
      ok: false,
      chromaOk,
      indexReady: false,
      vectorCount: 0,
      collection: CHROMA_COLLECTION,
      chromaUrl: CHROMA_URL,
      error: `Collection "${CHROMA_COLLECTION}" is empty`,
    };
  }

  return {
    ok: true,
    chromaOk,
    indexReady: true,
    vectorCount,
    collection: CHROMA_COLLECTION,
    chromaUrl: CHROMA_URL,
    chunking: progress.chunking || null,
    source: progress.source || null,
  };
}

/** Throws if Chroma / ingest is not ready; returns a ChromaClient. */
export async function assertIndexReady() {
  const health = await getHealth();
  if (!health.ok) {
    throw new Error(health.error || "Index not ready");
  }
  return new ChromaClient(getChromaClientOptions());
}

export async function openVectorStore(embeddings) {
  const client = await assertIndexReady();
  return Chroma.fromExistingCollection(embeddings, {
    index: client,
    collectionName: CHROMA_COLLECTION,
  });
}

let allDocsCache = null;

function rowsToDocuments(result) {
  return result.rows().map(
    (row) =>
      new Document({
        id: row.id,
        pageContent: row.document || "",
        metadata: row.metadata || {},
      })
  );
}

function sortByLayout(docs) {
  return [...docs].sort((a, b) => {
    const page =
      (Number(a.metadata.pageNumber) || 0) - (Number(b.metadata.pageNumber) || 0);
    if (page) return page;
    const heading = String(a.metadata.heading || "").localeCompare(
      String(b.metadata.heading || "")
    );
    if (heading) return heading;
    return (
      (Number(a.metadata.chunkIndex) || 0) - (Number(b.metadata.chunkIndex) || 0)
    );
  });
}

/** Match Chroma where clauses produced by parsePageFilter ($eq / $in / $and). */
export function matchesChromaWhere(metadata, filter) {
  if (!filter) return true;
  if (filter.$and) {
    return filter.$and.every((clause) => matchesChromaWhere(metadata, clause));
  }
  if (filter.$or) {
    return filter.$or.some((clause) => matchesChromaWhere(metadata, clause));
  }

  const meta = metadata || {};
  for (const [key, cond] of Object.entries(filter)) {
    const value = meta[key];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$eq" in cond && value !== cond.$eq) return false;
      if ("$in" in cond && !cond.$in.includes(value)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

async function fetchCollectionDocuments(filter) {
  const client = await assertIndexReady();
  const collection = await client.getCollection({
    name: CHROMA_COLLECTION,
    embeddingFunction: null,
  });
  const result = await collection.get({
    ...(filter ? { where: filter } : {}),
    include: ["documents", "metadatas"],
  });
  return rowsToDocuments(result);
}

/** Fetch stored text for a small set of chunk ids (BM25 hits without pageContent). */
export async function getDocumentsByIds(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];

  const client = await assertIndexReady();
  const collection = await client.getCollection({
    name: CHROMA_COLLECTION,
    embeddingFunction: null,
  });
  const result = await collection.get({
    ids: unique,
    include: ["documents", "metadatas"],
  });
  return rowsToDocuments(result);
}

/**
 * Fill empty pageContent from Chroma. Cosine hits already have text;
 * lexical-only fused hits need a point lookup.
 */
export async function fillPageContent(docs) {
  const need = (docs || []).filter((doc) => doc?.id && !doc.pageContent);
  if (!need.length) return docs || [];

  const fetched = await getDocumentsByIds(need.map((doc) => doc.id));
  const byId = new Map(fetched.map((doc) => [doc.id, doc]));
  const missing = need.filter((doc) => !byId.has(doc.id));
  if (missing.length) {
    console.warn(
      `[chroma] get({ ids }) missed ${missing.length}: ${missing.map((d) => d.id).join(", ")}`
    );
  } else {
    console.log(`[chroma] get({ ids }) filled ${need.length} lexical chunk(s)`);
  }

  return docs.map((doc) => {
    if (doc.pageContent) return doc;
    const full = byId.get(doc.id);
    if (!full) return doc;
    return new Document({
      id: doc.id,
      pageContent: full.pageContent,
      metadata: { ...full.metadata, ...doc.metadata },
    });
  });
}

/** All chunks in the collection (cached after first load). */
export async function getAllDocuments() {
  if (!allDocsCache) {
    allDocsCache = await fetchCollectionDocuments();
  }
  return allDocsCache;
}

/** Fetch every chunk matching a metadata filter (no similarity / top-k). */
export async function getDocumentsByFilter(filter) {
  if (!filter) {
    throw new Error("getDocumentsByFilter requires a metadata filter");
  }

  const docs = allDocsCache
    ? allDocsCache.filter((doc) => matchesChromaWhere(doc.metadata, filter))
    : await fetchCollectionDocuments(filter);

  return sortByLayout(docs);
}
