/**
 * Sentence-safe article chunking helpers shared by ingest + debug scripts.
 * - Never cut mid-sentence
 * - Overlap next chunk with complete trailing sentences (~CHUNK_OVERLAP_WORDS)
 * - Rejoin Chonkie pieces that were cut mid-word/mid-sentence
 */

export function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function isCompleteSentence(text) {
  return /[.!?]["”']?\s*$/.test(String(text || "").trim());
}

/** Split into sentences without dropping punctuation. */
export function splitIntoSentences(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const parts = cleaned.match(/[^.!?]+(?:[.!?]+(?:["”']+)?\s*|$)/g);
  return (parts || [cleaned]).map((s) => s.trim()).filter(Boolean);
}

/** Take trailing complete sentences totaling about `overlapWords` words. */
export function takeOverlapSentences(sentences, overlapWords) {
  if (!sentences.length || overlapWords <= 0) return [];
  // Only overlap complete sentences so the next chunk never starts mid-thought.
  const complete = sentences.filter((s) => isCompleteSentence(s));
  const source = complete.length ? complete : sentences;
  const out = [];
  let words = 0;
  for (let i = source.length - 1; i >= 0; i -= 1) {
    if (out.length > 0 && words >= overlapWords) break;
    out.unshift(source[i]);
    words += wordCount(source[i]);
  }
  return out;
}

/**
 * Rejoin Chonkie chunk texts, fixing mid-word cuts
 * (e.g. "In an an" + "other step" → "In an another step").
 */
export function joinSemanticChunkTexts(semanticChunks) {
  let out = "";
  for (const chunk of semanticChunks) {
    const t = String(chunk?.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) continue;
    if (!out) {
      out = t;
      continue;
    }
    if (/[A-Za-z0-9]$/.test(out) && /^[a-z0-9]/.test(t)) {
      out += t; // mid-word join, no space
    } else {
      out += ` ${t}`;
    }
  }
  return out.trim();
}

/**
 * Split text near `maxWords`, never cutting mid-sentence.
 * Consecutive chunks share ~`overlapWords` of trailing complete sentences.
 * Each chunk (except possibly a trailing fragment with no terminator in source)
 * ends on a complete sentence when possible.
 */
export function splitByMaxWords(text, maxWords, overlapWords) {
  const sentences = splitIntoSentences(text);
  if (!sentences.length) return [];
  if (wordCount(sentences.join(" ")) <= maxWords) {
    return [sentences.join(" ")];
  }

  const chunks = [];
  let bucket = [];
  let bucketWords = 0;

  const flush = () => {
    if (!bucket.length) return;

    // Prefer ending the stored chunk on a complete sentence.
    let end = bucket.length;
    while (end > 1 && !isCompleteSentence(bucket[end - 1])) end -= 1;

    const head = bucket.slice(0, end);
    const rest = bucket.slice(end);
    if (!head.length) return;

    chunks.push(head.join(" "));
    const overlap = takeOverlapSentences(head, overlapWords);
    bucket = [...overlap, ...rest];
    bucketWords = wordCount(bucket.join(" "));
  };

  for (const sentence of sentences) {
    const sw = wordCount(sentence);

    if (sw > maxWords && bucket.length === 0) {
      // Oversized single sentence: keep whole (never mid-cut).
      chunks.push(sentence);
      bucket = isCompleteSentence(sentence)
        ? takeOverlapSentences([sentence], overlapWords)
        : [];
      bucketWords = wordCount(bucket.join(" "));
      continue;
    }

    if (bucketWords + sw > maxWords && bucket.length > 0) {
      flush();
      if (bucketWords + sw > maxWords) {
        // Drop overlap if it still cannot fit this sentence.
        bucket = [];
        bucketWords = 0;
      }
    }

    bucket.push(sentence);
    bucketWords += sw;
  }

  if (bucket.length) {
    const trailing = bucket.join(" ");
    const prev = chunks[chunks.length - 1];
    if (!prev || trailing !== prev) chunks.push(trailing);
  }

  return chunks;
}

/**
 * Format a stored chunk as:
 *   heading - {title}
 *   chunk {i}/{n}
 *
 *   {body}
 */
export function formatChunk(heading, body, chunkIndex, chunkTotal) {
  const h = String(heading || "").trim() || "(untitled)";
  let b = String(body || "").trim();
  // Strip a bare title prefix if present so it isn't duplicated under the schema lines.
  if (b === h) b = "";
  else if (b.startsWith(`${h}\n\n`)) b = b.slice(h.length).trim();
  else if (b.startsWith(`${h}\n`)) b = b.slice(h.length).trim();
  else if (b.startsWith(`${h} `)) b = b.slice(h.length).trim();

  const i = Math.max(1, Number(chunkIndex) || 1);
  const n = Math.max(i, Number(chunkTotal) || i);
  const header = `heading - ${h}\nchunk ${i}/${n}`;
  return b ? `${header}\n\n${b}` : header;
}

/** @deprecated use formatChunk — kept for call sites that only need title+body */
export function attachHeading(heading, body) {
  return formatChunk(heading, body, 1, 1);
}

/**
 * Build final pieces for an article body after Chonkie.
 * Rejoins semantic pieces then packs by complete sentences + overlap.
 */
export function piecesFromSemanticChunks(
  bodyText,
  semanticChunks,
  maxWords,
  overlapWords
) {
  const body = String(bodyText || "").trim();
  if (!semanticChunks?.length) {
    return splitByMaxWords(body, maxWords, overlapWords);
  }

  const joined = joinSemanticChunkTexts(semanticChunks);
  // Prefer original body when join lost too much (safer sentence boundaries).
  const source =
    wordCount(joined) >= Math.max(1, wordCount(body) * 0.85) ? joined : body;
  return splitByMaxWords(source, maxWords, overlapWords);
}
