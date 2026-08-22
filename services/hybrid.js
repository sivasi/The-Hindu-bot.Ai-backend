import { Document } from "@langchain/core/documents";

import {
  DEFAULT_RETRIEVER_K,
  HYBRID_CANDIDATE_K,
  HYBRID_RRF_C,
} from "../config.js";
import { documentKey } from "./queryDecomposition.js";
import { fillPageContent } from "./chroma.js";
import { keywordSearchFromIndex, lexicalQueryTokens } from "./keyword.js";
import { inspectLexicalGate, logLexicalTokenMatch, fusionWeightsFromRarity } from "./lexicalGate.js";
import { loadLexicalIndex } from "./lexicalIndex.js";
import { logger } from "./logger.js";

function clip(text, max = 80) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function chunkLabel(doc) {
  const meta = doc?.metadata || {};
  const heading = clip(meta.heading || "(untitled)");
  const page = meta.pageNumber ?? "?";
  const chunk =
    meta.chunkIndex != null ? `${meta.chunkIndex}/${meta.chunkTotal || "?"}` : "?";
  return `p${page} chunk ${chunk} | ${heading}`;
}

function rankLabel(rank) {
  return rank == null ? "—" : `#${rank}`;
}

function logPool(name, docs) {
  console.log(`[hybrid] ${name} pool (${docs.length}):`);
  if (!docs.length) {
    console.log(`[hybrid]   (empty)`);
    return;
  }
  docs.forEach((doc, i) => {
    const bm25 = doc.metadata?.bm25Score;
    const extra =
      typeof bm25 === "number" ? ` bm25=${bm25.toFixed(4)}` : "";
    console.log(`[hybrid]   ${i + 1}. ${chunkLabel(doc)}${extra}`);
  });
}

function logFusion(ranksByList, ranked, selected, k) {
  const [semanticRanks, lexicalRanks] = ranksByList;
  const both = [...semanticRanks.keys()].filter((key) => lexicalRanks.has(key));
  console.log(
    `[hybrid] overlap: ${both.length} in both lists, ${semanticRanks.size} semantic, ${lexicalRanks.size} lexical`
  );
  console.log(`[hybrid] RRF fused top ${k} (score = Σ w / (${HYBRID_RRF_C} + rank)):`);
  selected.forEach(([key, score], i) => {
    console.log(
      `[hybrid]   ${i + 1}. rrf=${score.toFixed(6)}  sem=${rankLabel(semanticRanks.get(key))} lex=${rankLabel(lexicalRanks.get(key))}  ${chunkLabel(ranked.get(key))}`
    );
  });
}

function rrfFuse(rankedLists, k) {
  const scores = new Map();
  const byKey = new Map();
  const ranksByList = rankedLists.map(() => new Map());

  rankedLists.forEach(({ docs, weight }, listIdx) => {
    docs.forEach((doc, index) => {
      const key = documentKey(doc);
      const rank = index + 1;
      ranksByList[listIdx].set(key, rank);
      if (!byKey.has(key)) byKey.set(key, doc);
      scores.set(key, (scores.get(key) || 0) + weight / (HYBRID_RRF_C + rank));
    });
  });

  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const selected = ordered.slice(0, k);
  logFusion(ranksByList, byKey, selected, k);

  return selected.map(([key, hybridScore]) => {
    const doc = byKey.get(key);
    const [semanticRanks, lexicalRanks] = ranksByList;
    return new Document({
      id: doc.id,
      pageContent: doc.pageContent,
      metadata: {
        ...doc.metadata,
        hybridScore,
        semanticRank: semanticRanks.get(key) ?? null,
        lexicalRank: lexicalRanks.get(key) ?? null,
      },
    });
  });
}

/**
 * Dense cosine always. BM25 only when a query token is rare in this
 * collection (df/N < 1% and df ≥ 1). The inverted index is loaded from
 * cache/lexical-index.json (built by ingest-lexical.js).
 */
export async function hybridRetrieve({
  vectorStore,
  semanticQuery,
  lexicalQuery,
  k = DEFAULT_RETRIEVER_K,
  filter,
} = {}) {
  const candidateK = Math.max(k, HYBRID_CANDIDATE_K);

  console.log(`[hybrid] semantic query: "${clip(semanticQuery, 160)}"`);
  if (filter) {
    console.log(`[hybrid] filter: ${JSON.stringify(filter)}`);
  }

  const [semanticDocs, index] = await Promise.all([
    vectorStore.similaritySearch(
      semanticQuery,
      candidateK,
      filter || undefined
    ),
    loadLexicalIndex(),
  ]);

  const gate = inspectLexicalGate(lexicalQuery, index);
  logLexicalTokenMatch(gate);
  logPool("semantic (cosine)", semanticDocs);

  if (!index || !gate.run) {
    console.log("[hybrid] lexical skipped — cosine only");
    logger.info("hybrid", "cosine only", {
      reason: !index ? "no-lexical-index" : "gate-not-rare",
      lexicalQuery: clip(lexicalQuery, 160),
      k,
      semanticHits: semanticDocs.length,
      selectedTokens: gate.hits?.rare?.map((t) => t.token) || [],
    });
    return { docs: semanticDocs.slice(0, k), lexicalUsed: false };
  }

  console.log(`[hybrid] lexical query:  "${clip(lexicalQuery, 160)}"`);
  console.log(
    `[hybrid] BM25 also expands plurals: [${lexicalQueryTokens(lexicalQuery).join(", ") || "—"}]`
  );

  const mix = fusionWeightsFromRarity(gate.hits.rare);
  const rarest = mix.rarest;
  console.log(
    `[hybrid] RRF weights from rarest "${rarest?.token}" match=${rarest?.df}/${rarest?.n} (${rarest?.pct}%) → w_sem=${mix.semantic.toFixed(2)} w_lex=${mix.lexical.toFixed(2)} (≤3 chunks: lex 0.75; >3: semantic ramps exp to 0.75 at 1%)`
  );
  console.log(
    `[hybrid] cosine + BM25 → RRF  c=${HYBRID_RRF_C} pool=${candidateK} k=${k}`
  );

  const lexicalDocsRanked = keywordSearchFromIndex(
    index,
    lexicalQuery,
    candidateK,
    filter
  );
  logPool("lexical (BM25)", lexicalDocsRanked);

  if (!lexicalDocsRanked.length) {
    logger.info("hybrid", "BM25 empty — cosine only", {
      lexicalQuery: clip(lexicalQuery, 160),
      k,
    });
    return { docs: semanticDocs.slice(0, k), lexicalUsed: false };
  }

  const fused = rrfFuse(
    [
      { docs: semanticDocs, weight: mix.semantic },
      { docs: lexicalDocsRanked, weight: mix.lexical },
    ],
    k
  );

  logger.info("hybrid", "RRF fusion", {
    lexicalQuery: clip(lexicalQuery, 160),
    semanticQuery: clip(semanticQuery, 160),
    k,
    candidateK,
    wSemantic: Number(mix.semantic.toFixed(2)),
    wLexical: Number(mix.lexical.toFixed(2)),
    rarest: rarest ? { token: rarest.token, df: rarest.df, n: rarest.n, pct: rarest.pct } : null,
    bm25Hits: lexicalDocsRanked.length,
    fused: fused.map((doc) => ({
      heading: clip(doc.metadata?.heading, 80),
      page: doc.metadata?.pageNumber ?? null,
      hybridScore: doc.metadata?.hybridScore ?? null,
      semanticRank: doc.metadata?.semanticRank ?? null,
      lexicalRank: doc.metadata?.lexicalRank ?? null,
    })),
  });

  return {
    docs: await fillPageContent(fused),
    lexicalUsed: true,
  };
}
