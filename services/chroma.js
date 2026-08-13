import fs from "fs/promises";
import { ChromaClient } from "chromadb";
import { Chroma } from "@langchain/community/vectorstores/chroma";

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
