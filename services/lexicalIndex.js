import fs from "fs/promises";
import path from "path";

import {
  CHROMA_COLLECTION,
  LEXICAL_INDEX_PATH,
  LEXICAL_INDEX_VERSION,
} from "../config.js";
import { readProgress } from "./chroma.js";
import { buildInvertedIndex } from "./keyword.js";

let cachedIndex = null;
let loadPromise = null;

function invertedIndexToJson(index, extra = {}) {
  return {
    version: LEXICAL_INDEX_VERSION,
    collection: extra.collection || CHROMA_COLLECTION,
    vectorCount: index.n,
    chunking: extra.chunking || null,
    avgLength: index.avgLength,
    n: index.n,
    docs: index.docs,
    df: Object.fromEntries(index.df),
    postings: Object.fromEntries(index.postings),
    builtAt: extra.builtAt || new Date().toISOString(),
  };
}

function invertedIndexFromJson(raw) {
  return {
    version: raw.version,
    collection: raw.collection,
    chunking: raw.chunking,
    vectorCount: raw.vectorCount,
    n: raw.n,
    avgLength: raw.avgLength,
    docs: raw.docs || [],
    df: new Map(Object.entries(raw.df || {})),
    postings: new Map(Object.entries(raw.postings || {})),
  };
}

function mismatchReason(raw, progress) {
  if (raw?.version !== LEXICAL_INDEX_VERSION) {
    return `index version ${raw?.version} ≠ ${LEXICAL_INDEX_VERSION}`;
  }
  if (raw.collection !== CHROMA_COLLECTION) {
    return `collection "${raw.collection}" ≠ "${CHROMA_COLLECTION}"`;
  }
  if (!progress?.complete) {
    return "PDF ingest is not complete";
  }
  if (raw.vectorCount !== progress.vectorCount) {
    return `vectorCount ${raw.vectorCount} ≠ ingest ${progress.vectorCount}`;
  }
  if (progress.chunking && raw.chunking !== progress.chunking) {
    return `chunking "${raw.chunking}" ≠ "${progress.chunking}"`;
  }
  return null;
}

async function writeAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, contents, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (err?.code === "EEXIST" || err?.code === "EPERM") {
      await fs.unlink(filePath);
      await fs.rename(tmpPath, filePath);
    } else {
      throw err;
    }
  }
}

export async function saveLexicalIndex(docs, extra = {}) {
  const index = buildInvertedIndex(docs);
  const payload = invertedIndexToJson(index, extra);
  await writeAtomic(LEXICAL_INDEX_PATH, JSON.stringify(payload));
  cachedIndex = invertedIndexFromJson(payload);
  loadPromise = Promise.resolve(cachedIndex);
  return cachedIndex;
}

async function readLexicalIndexFile() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(LEXICAL_INDEX_PATH, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      console.log(
        `[lexical-index] missing ${LEXICAL_INDEX_PATH}. Run: node ingest-lexical.js`
      );
      return null;
    }
    throw err;
  }

  const progress = await readProgress();
  const why = mismatchReason(raw, progress);
  if (why) {
    console.warn(
      `[lexical-index] stale (${why}). Run: node ingest-lexical.js`
    );
    return null;
  }

  const index = invertedIndexFromJson(raw);
  console.log(
    `[lexical-index] loaded ${index.n} chunks, ${index.df.size} terms from ${LEXICAL_INDEX_PATH}`
  );
  return index;
}

/** Load the on-disk inverted index once per process. */
export async function loadLexicalIndex() {
  if (cachedIndex) {
    console.log(
      `[lexical-index] RAM hit (${cachedIndex.n} chunks, ${cachedIndex.df.size} terms)`
    );
    return cachedIndex;
  }
  if (!loadPromise) {
    loadPromise = readLexicalIndexFile().then((index) => {
      cachedIndex = index;
      return index;
    });
  }
  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    throw err;
  }
}
