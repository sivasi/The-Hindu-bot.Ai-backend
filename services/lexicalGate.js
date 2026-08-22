import {
  LEXICAL_RARE_DF_RATIO,
  HYBRID_LEXICAL_WEIGHT_MAX,
  HYBRID_LEXICAL_UNIQUE_MAX_CHUNKS,
  HYBRID_SEMANTIC_AT_CUTOFF,
  HYBRID_WEIGHT_EXP_K,
} from "../config.js";
import { gateQueryTokens } from "./keyword.js";

function pct(frac) {
  return (frac * 100).toFixed(2);
}

function classifyToken(token, df, n, ratio) {
  const frac = n ? df / n : 0;
  let status;
  if (df <= 0) status = "no-match";
  else if (frac < ratio) status = "selected";
  else status = "common";
  return { token, df, n, pct: pct(frac), status };
}

/**
 * Open BM25 only when a query token already occurs in this collection
 * and in fewer than LEXICAL_RARE_DF_RATIO of chunks (default 0.5%).
 * Unseen tokens (df=0) do not count — there is nothing to match.
 */
export function inspectLexicalGate(
  query,
  corpus,
  ratio = LEXICAL_RARE_DF_RATIO
) {
  const n = corpus?.n || 0;
  const dfMap = corpus?.df;
  const tokens = gateQueryTokens(query);

  if (!n || !dfMap) {
    return {
      run: false,
      reasons: [],
      hits: { rare: [] },
      tokens: tokens.map((token) => classifyToken(token, 0, 0, ratio)),
    };
  }

  const inspected = tokens.map((token) =>
    classifyToken(token, dfMap.get(token) || 0, n, ratio)
  );
  const rare = inspected.filter((item) => item.status === "selected");

  return {
    run: rare.length > 0,
    reasons: rare.length ? ["rare"] : [],
    hits: { rare },
    tokens: inspected,
  };
}

export function logLexicalTokenMatch(gate, ratio = LEXICAL_RARE_DF_RATIO) {
  const n = gate.tokens[0]?.n || 0;
  const selected = gate.tokens.filter((item) => item.status === "selected");
  const common = gate.tokens.filter((item) => item.status === "common");
  const missing = gate.tokens.filter((item) => item.status === "no-match");

  console.log(
    `[lexical-gate] ${gate.tokens.length} query tokens vs ${n} chunks | threshold < ${(ratio * 100).toFixed(1)}% | selected ${selected.length}/${gate.tokens.length}`
  );

  if (!gate.tokens.length) {
    console.log("[lexical-gate]   (no content tokens after stopword/year strip)");
    return;
  }

  for (const item of gate.tokens) {
    const tag =
      item.status === "selected"
        ? "SELECTED"
        : item.status === "common"
          ? "common  "
          : "no-match";
    console.log(
      `[lexical-gate]   ${tag}  ${item.token}  match=${item.df}/${item.n} chunks (${item.pct}%)`
    );
  }

  if (selected.length) {
    console.log(
      `[lexical-gate] lexical search tokens: [${selected.map((item) => item.token).join(", ")}]`
    );
  } else {
    const why = [];
    if (common.length) why.push(`${common.length} too common`);
    if (missing.length) why.push(`${missing.length} not in collection`);
    console.log(
      `[lexical-gate] none selected${why.length ? ` (${why.join(", ")})` : ""}`
    );
  }
}

/**
 * ≤3 matching chunks: keep lexical at 0.75.
 * More than 3: semantic ramps exponentially to 0.75 at the 1% gate.
 */
export function fusionWeightsFromRarity(
  rareHits,
  ratio = LEXICAL_RARE_DF_RATIO
) {
  const lexUnique = HYBRID_LEXICAL_WEIGHT_MAX;
  const semUnique = 1 - lexUnique;
  const semCutoff = HYBRID_SEMANTIC_AT_CUTOFF;
  const uniqueMax = HYBRID_LEXICAL_UNIQUE_MAX_CHUNKS;
  const kExp = HYBRID_WEIGHT_EXP_K;

  if (!rareHits?.length) {
    return { semantic: semCutoff, lexical: 1 - semCutoff, rarest: null };
  }

  const rarest = rareHits.reduce((best, item) =>
    item.df / item.n < best.df / best.n ? item : best
  );
  const df = rarest.df;
  const n = rarest.n || 1;
  const cutoffChunks = ratio * n;

  if (df <= uniqueMax || cutoffChunks <= uniqueMax) {
    return { semantic: semUnique, lexical: lexUnique, rarest, t: 0 };
  }

  const x = Math.min(1, Math.max(0, (df - uniqueMax) / (cutoffChunks - uniqueMax)));
  const denom = 1 - Math.exp(-kExp);
  const ease = denom > 0 ? (1 - Math.exp(-kExp * x)) / denom : x;
  const semantic = semUnique + (semCutoff - semUnique) * ease;
  return {
    semantic,
    lexical: 1 - semantic,
    rarest,
    t: x,
  };
}
