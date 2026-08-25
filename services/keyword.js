import { Document } from "@langchain/core/documents";

import { matchesChromaWhere } from "./chroma.js";

const YEAR_RE = /^(?:19|20)\d{2}$/;

/** Newsroom / query filler that drowns BM25. Years are handled separately. */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "in",
  "on",
  "for",
  "to",
  "from",
  "by",
  "as",
  "at",
  "is",
  "was",
  "were",
  "be",
  "been",
  "are",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "with",
  "about",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "why",
  "when",
  "where",
  "did",
  "does",
  "do",
  "not",
  "no",
  "but",
  "if",
  "so",
  "than",
  "then",
  "also",
  "into",
  "over",
  "after",
  "before",
  "can",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "has",
  "had",
  "have",
  "their",
  "they",
  "them",
  "his",
  "her",
  "our",
  "your",
  "say",
  "says",
  "said",
  "telling",
  "tell",
  "told",
  "paper",
  "papers",
  "study",
  "studies",
  "chunk",
  "heading",
]);

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const HEADING_REPEAT = 2;

const corpusCache = new WeakMap();

function normalizeNumberToken(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/₹/g, "")
    .replace(/\brs\.?/g, "")
    .replace(/\binr\b/g, "")
    .replace(/\$/g, "")
    .replace(/\s+/g, "");
}

function isGroupedNumber(token) {
  return /^\d{1,3}(?:,\d{2,3})+(?:\.\d+)?%?$/.test(token) || /^\d+(?:\.\d+)?%$/.test(token);
}

export function tokenize(text) {
  const re =
    /(?:₹|rs\.?|inr|\$)\s*\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d{1,3}(?:,\d{2,3})+(?:\.\d+)?%?|\d+(?:\.\d+)?%|\w+/gi;
  const matches = String(text || "").match(re) || [];
  return matches.map((part) => normalizeNumberToken(part)).filter(Boolean);
}

function isYear(token) {
  return YEAR_RE.test(token);
}

function termFreq(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return tf;
}

/**
 * Content tokens for the rarity gate. No fake plurals (those have df=0
 * and would always look "rare").
 */
export function gateQueryTokens(query) {
  const raw = tokenize(query).filter((token) => !STOPWORDS.has(token));
  const content = raw.filter((token) => !isYear(token));
  const base = content.length ? content : raw.filter(isYear);
  return [...new Set(base)];
}

/**
 * Drop paper/study/stopwords. Keep a year only when it is the query
 * (no other content tokens left) — otherwise dates match half the archive.
 * Add a simple plural (`landslide` → `landslides`) so token match still recalls headlines.
 */
export function lexicalQueryTokens(query) {
  const base = gateQueryTokens(query);
  const tokens = new Set(base);
  for (const token of base) {
    if (
      token.length > 3 &&
      !token.endsWith("s") &&
      !isYear(token) &&
      !isGroupedNumber(token)
    ) {
      tokens.add(`${token}s`);
    }
  }
  return [...tokens];
}

function parseHeadingBody(doc) {
  const pageContent = String(doc?.pageContent || "");
  const meta = doc?.metadata || {};
  const lines = pageContent.split("\n");

  let heading = String(meta.heading || "").trim();
  let bodyStart = 0;

  if (lines[0]?.startsWith("heading - ")) {
    heading = lines[0].slice("heading - ".length).trim() || heading;
    bodyStart = 1;
  }
  if (lines[bodyStart]?.match(/^chunk\s+\d+\s*\/\s*\d+\s*$/i)) {
    bodyStart += 1;
  }
  while (lines[bodyStart] === "") bodyStart += 1;

  const body = lines.slice(bodyStart).join("\n").trim();
  return { heading: heading || "", body };
}

function isWeakHeading(heading) {
  const h = String(heading || "").trim();
  if (!h || h === "(untitled)") return true;
  return /^page\s+\d+\s+other\s+text$/i.test(h);
}

/** Headline + article body only — not the stored `heading -` / `chunk i/n` wrapper. */
export function lexicalText(doc) {
  const { heading, body } = parseHeadingBody(doc);
  const parts = [];
  if (heading && !isWeakHeading(heading)) {
    for (let i = 0; i < HEADING_REPEAT; i += 1) parts.push(heading);
  } else if (heading) {
    parts.push(heading);
  }
  if (body) parts.push(body);
  return parts.join("\n");
}

function getCorpus(docs) {
  let corpus = corpusCache.get(docs);
  if (corpus) return corpus;

  const entries = docs.map((doc) => {
    const tokens = tokenize(lexicalText(doc));
    return { doc, tf: termFreq(tokens), length: Math.max(tokens.length, 1) };
  });
  const avgLength =
    entries.reduce((sum, item) => sum + item.length, 0) / Math.max(entries.length, 1);
  const df = new Map();
  for (const item of entries) {
    for (const token of item.tf.keys()) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  corpus = { entries, avgLength, df, n: entries.length };
  corpusCache.set(docs, corpus);
  return corpus;
}

export function getLexicalCorpusStats(docs) {
  if (!docs?.length) {
    return { entries: [], avgLength: 1, df: new Map(), n: 0 };
  }
  return getCorpus(docs);
}

function hitsFromScored(scored) {
  return scored.map(
    (item) =>
      new Document({
        id: item.doc.id,
        pageContent: item.doc.pageContent || "",
        metadata: {
          ...item.doc.metadata,
          bm25Score: item.score,
        },
      })
  );
}

export function keywordSearchFromCorpus(corpus, query, k) {
  const queryTokens = lexicalQueryTokens(query);
  const n = corpus?.n || 0;
  if (!queryTokens.length || !n || k <= 0) {
    console.log(
      `[keyword] BM25 skipped (tokens=[${queryTokens.join(", ")}] corpus=${n} k=${k})`
    );
    return [];
  }

  const take = Math.min(k, n);
  const { entries, avgLength, df } = corpus;
  const scored = entries
    .map((item) => ({
      doc: item.doc,
      score: bm25Score(item.tf, item.length, avgLength, queryTokens, n, df),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, take);

  const rawTokens = tokenize(query);
  const stripped = rawTokens.filter((token) => !queryTokens.includes(token));
  console.log(
    `[keyword] BM25 tokens=[${queryTokens.join(", ")}] stripped=[${stripped.join(", ") || "—"}] scored ${n} chunks → ${scored.length} hits (k=${take})`
  );

  return hitsFromScored(scored);
}

function idf(token, n, df) {
  const found = df.get(token) || 0;
  return Math.log((n - found + 0.5) / (found + 0.5) + 1);
}

function bm25Score(tfMap, length, avgLength, queryTokens, n, df) {
  let score = 0;
  for (const token of queryTokens) {
    const freq = tfMap.get(token) || 0;
    if (!freq) continue;
    const denom =
      freq + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgLength);
    score += (idf(token, n, df) * (freq * (BM25_K1 + 1))) / denom;
  }
  return score;
}

/**
 * Lexical (keyword) search: token BM25 over heading + body.
 */
export function keywordSearch(docs, query, k) {
  return keywordSearchFromCorpus(getLexicalCorpusStats(docs), query, k);
}

/**
 * Inverted index in RAM: postings[token] = [[docIndex, tf], ...].
 */
export function buildInvertedIndex(docs) {
  const entries = docs.map((doc) => {
    const tokens = tokenize(lexicalText(doc));
    const tf = termFreq(tokens);
    return {
      id: doc.id,
      metadata: doc.metadata || {},
      tf,
      length: Math.max(tokens.length, 1),
    };
  });
  const n = entries.length;
  const avgLength =
    entries.reduce((sum, item) => sum + item.length, 0) / Math.max(n, 1);
  const df = new Map();
  const postings = new Map();
  entries.forEach((item, docIndex) => {
    for (const [token, freq] of item.tf.entries()) {
      df.set(token, (df.get(token) || 0) + 1);
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push([docIndex, freq]);
    }
  });
  return {
    n,
    avgLength,
    df,
    postings,
    docs: entries.map(({ id, metadata, length }) => ({
      id,
      metadata,
      length,
    })),
  };
}

/**
 * Drop df/postings for tokens in ≥ `ratio` of chunks.
 * Unseen and common both mean "do not BM25-fetch".
 */
export function pruneToRareTokens(index, ratio) {
  const n = index?.n || 0;
  if (!n || !(ratio > 0)) return index;
  const df = new Map();
  const postings = new Map();
  for (const [token, count] of index.df || []) {
    if (count / n < ratio) {
      df.set(token, count);
      const list = index.postings.get(token);
      if (list) postings.set(token, list);
    }
  }
  return { ...index, df, postings };
}

/** BM25 over inverted postings only — not every chunk. */
export function keywordSearchFromIndex(index, query, k, filter) {
  const queryTokens = lexicalQueryTokens(query);
  const n = index?.n || 0;
  if (!queryTokens.length || !n || k <= 0) {
    console.log(
      `[keyword] BM25 skipped (tokens=[${queryTokens.join(", ")}] corpus=${n} k=${k})`
    );
    return [];
  }

  const { docs, avgLength, df, postings } = index;
  const candidates = new Map();

  for (const token of queryTokens) {
    const list = postings.get(token);
    if (!list) continue;
    for (const [docIndex, freq] of list) {
      const rec = docs[docIndex];
      if (!rec) continue;
      if (filter && !matchesChromaWhere(rec.metadata, filter)) continue;
      let tfMap = candidates.get(docIndex);
      if (!tfMap) {
        tfMap = new Map();
        candidates.set(docIndex, tfMap);
      }
      tfMap.set(token, freq);
    }
  }

  const take = Math.min(k, candidates.size || n);
  const scored = [];
  for (const [docIndex, tfMap] of candidates) {
    const rec = docs[docIndex];
    const score = bm25Score(tfMap, rec.length, avgLength, queryTokens, n, df);
    if (score > 0) scored.push({ doc: rec, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, take);

  const rawTokens = tokenize(query);
  const stripped = rawTokens.filter((token) => !queryTokens.includes(token));
  console.log(
    `[keyword] BM25 tokens=[${queryTokens.join(", ")}] stripped=[${stripped.join(", ") || "—"}] posting-candidates=${candidates.size}/${n} → ${top.length} hits (k=${take})`
  );

  return hitsFromScored(top);
}
