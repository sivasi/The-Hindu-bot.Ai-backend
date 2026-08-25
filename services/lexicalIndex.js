import {
  CHROMA_COLLECTION,
  LEXICAL_INDEX_URL,
  LEXICAL_INDEX_VERSION,
  LEXICAL_RARE_DF_RATIO,
  getLexicalIndexOrigin,
} from "../config.js";
import {
  getAllDocuments,
  getDocumentsByFilter,
  clearDocumentsCache,
  dateRangeWhere,
} from "./chroma.js";
import { buildInvertedIndex, pruneToRareTokens } from "./keyword.js";

let cachedIndex = null;
let loadPromise = null;

const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

function invertedIndexToJson(index, extra = {}) {
  return {
    version: LEXICAL_INDEX_VERSION,
    collection: extra.collection || CHROMA_COLLECTION,
    vectorCount: index.n,
    chunking: extra.chunking || null,
    dateFrom: extra.dateFrom || extra.date || null,
    dateTo: extra.dateTo || extra.date || null,
    date: extra.date || null,
    rareRatio: extra.rareRatio ?? LEXICAL_RARE_DF_RATIO,
    tokenCount: index.df.size,
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
    dateFrom: raw.dateFrom || null,
    dateTo: raw.dateTo || null,
    rareRatio: raw.rareRatio,
    n: raw.n,
    avgLength: raw.avgLength,
    docs: raw.docs || [],
    df: new Map(Object.entries(raw.df || {})),
    postings: new Map(Object.entries(raw.postings || {})),
  };
}

function mismatchReason(raw) {
  if (raw?.version !== LEXICAL_INDEX_VERSION) {
    return `index version ${raw?.version} ≠ ${LEXICAL_INDEX_VERSION}`;
  }
  if (raw.collection !== CHROMA_COLLECTION) {
    return `collection "${raw.collection}" ≠ "${CHROMA_COLLECTION}"`;
  }
  return null;
}

function lexicalHostError(err) {
  return new Error(
    `Cannot reach lexical-index host at ${getLexicalIndexOrigin()}. ` +
      `Start rag-newspapers-lexical from RAG/8.2026-data (npm run chroma:up).\nOriginal error: ${err.message}`
  );
}

export async function assertLexicalHostUp() {
  try {
    const res = await fetch(`${getLexicalIndexOrigin()}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    throw lexicalHostError(err);
  }
}

export async function saveLexicalIndex(docs, extra = {}) {
  await assertLexicalHostUp();
  const ratio = extra.rareRatio ?? LEXICAL_RARE_DF_RATIO;
  const full = buildInvertedIndex(docs);
  const index = pruneToRareTokens(full, ratio);
  console.log(
    `[lexical-index] ${full.n} chunks, ${full.df.size} types → ${index.df.size} rare (df/N < ${(ratio * 100).toFixed(1)}%)`
  );
  const payload = invertedIndexToJson(index, extra);
  const body = JSON.stringify(payload);
  let res;
  try {
    res = await fetch(LEXICAL_INDEX_URL, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw lexicalHostError(err);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `lexical-index PUT failed (${res.status}): ${text.slice(0, 300)}`
    );
  }
  cachedIndex = invertedIndexFromJson(payload);
  loadPromise = Promise.resolve(cachedIndex);
  return cachedIndex;
}

/**
 * Replace the hosted BM25 index from Chroma chunks in an optional date range.
 * Only tokens with df/N < rareRatio are stored. PUT overwrites the previous file.
 */
export async function rebuildLexicalIndexFromChroma(extra = {}) {
  await assertLexicalHostUp();
  clearDocumentsCache();

  const filter = dateRangeWhere({
    date: extra.date,
    from: extra.dateFrom,
    to: extra.dateTo,
  });
  const docs = filter
    ? await getDocumentsByFilter(filter)
    : await getAllDocuments();

  if (!docs.length) {
    console.log("[lexical-index] no chunks in Chroma for that range; skipped");
    return null;
  }

  const ratio = extra.rareRatio ?? LEXICAL_RARE_DF_RATIO;
  const index = await saveLexicalIndex(docs, {
    collection: extra.collection || CHROMA_COLLECTION,
    chunking: extra.chunking || null,
    date: extra.date || null,
    dateFrom: extra.dateFrom || extra.date || null,
    dateTo: extra.dateTo || extra.date || null,
    rareRatio: ratio,
  });
  console.log(
    `[lexical-index] ${index.n} chunks, ${index.df.size} rare tokens (<${(ratio * 100).toFixed(1)}% df) → ${LEXICAL_INDEX_URL}`
  );
  return index;
}

async function readLexicalIndexFile() {
  await assertLexicalHostUp();
  let res;
  try {
    res = await fetch(LEXICAL_INDEX_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw lexicalHostError(err);
  }

  if (res.status === 404) {
    console.log(
      `[lexical-index] missing ${LEXICAL_INDEX_URL}. Run: node ingest-lexical.js --from YYYY-MM-DD --to YYYY-MM-DD`
    );
    return null;
  }
  if (!res.ok) {
    throw new Error(`lexical-index GET failed (${res.status})`);
  }

  const raw = await res.json();
  const why = mismatchReason(raw);
  if (why) {
    console.warn(
      `[lexical-index] stale (${why}). Re-run: node ingest-lexical.js --from YYYY-MM-DD --to YYYY-MM-DD`
    );
    return null;
  }

  const index = invertedIndexFromJson(raw);
  const range =
    index.dateFrom || index.dateTo
      ? ` ${index.dateFrom || "…"}→${index.dateTo || "…"}`
      : "";
  console.log(
    `[lexical-index] loaded ${index.n} chunks, ${index.df.size} rare terms${range} from ${LEXICAL_INDEX_URL}`
  );
  return index;
}

/** Load the hosted inverted index once per process. */
export async function loadLexicalIndex() {
  if (cachedIndex) return cachedIndex;
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
