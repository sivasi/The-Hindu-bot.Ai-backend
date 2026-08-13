import { VertexAIEmbeddings, ChatVertexAI } from "@langchain/google-vertexai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { createStuffDocumentsChain } from "@langchain/classic/chains/combine_documents";

import {
  EMBEDDING_MODEL,
  CHROMA_COLLECTION,
  getVertexAuth,
  getLocation,
  getChatModel,
  getChatLocation,
  DEFAULT_RETRIEVER_K,
  TURBO_RETRIEVER_K,
} from "../config.js";
import { openVectorStore } from "./chroma.js";

let readyPromise = null;
let vectorStore = null;
let embeddings = null;

export const MODES = {
  NORMAL: "normal",
  TURBO_SHORT: "turbo_short",
  TURBO_RESEARCH: "turbo_research",
};

const NORMAL_SYSTEM_PROMPT = `Answer ONLY using the provided context.
Be concise and direct. Prefer a short, clear answer.
If the context is insufficient, say what is missing.

Context:

{context}`;

const TURBO_SHORT_SYSTEM_PROMPT = `Answer ONLY using the provided context. Do not invent facts.

Write a very short turbo answer of about 30–50 words (hard upper bound ~50 words):
- One or two tight sentences only.
- Lead with the direct answer; include only the most essential fact(s).
- No preamble, no bullet lists, no closing summary.
- If the context is insufficient, say so briefly.

Context:

{context}`;

const TURBO_RESEARCH_SYSTEM_PROMPT = `You are a research assistant answering from archived newspaper context only.
Answer ONLY using the provided context. Do not invent facts outside it.

Do research across the provided sources and write a research-style answer of up to 300 words maximum (never exceed 300 words; do not pad with filler):
- Open with a clear direct answer to the question.
- Synthesize evidence from multiple retrieved chunks/articles when available.
- Include supporting detail, figures, names, dates, and short quotes from the context.
- Connect related points; note nuances or caveats if the context shows them.
- Close with a brief synthesis of what the sources collectively show.
- If something is not in the context, say it is not covered rather than guessing.
Use well-structured paragraphs. Stay within 300 words.

Context:

{context}`;

/**
 * Resolve answer mode from payload.
 * Preferred: mode = "normal" | "turbo_short" | "turbo_research"
 * Compat: turbo true/"research" → turbo_research; turbo "short" → turbo_short
 */
export function resolveAnswerMode({ mode, turbo } = {}) {
  const raw = String(mode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");

  if (
    raw === MODES.TURBO_SHORT ||
    raw === "short" ||
    raw === "turbo_and_short"
  ) {
    return MODES.TURBO_SHORT;
  }
  if (
    raw === MODES.TURBO_RESEARCH ||
    raw === "research" ||
    raw === "turbo_and_research"
  ) {
    return MODES.TURBO_RESEARCH;
  }
  if (raw === MODES.NORMAL || raw === "default") {
    return MODES.NORMAL;
  }

  // Legacy turbo field
  if (turbo === true || turbo === "research" || turbo === "turbo_research") {
    return MODES.TURBO_RESEARCH;
  }
  if (turbo === "short" || turbo === "turbo_short") {
    return MODES.TURBO_SHORT;
  }

  return MODES.NORMAL;
}

function excerptFromBody(body, max = 220) {
  const text = String(body || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

/** Parse stored pageContent schema: heading / chunk i/n / body */
export function parseStoredChunk(doc) {
  const pageContent = String(doc?.pageContent || "");
  const meta = doc?.metadata || {};
  const lines = pageContent.split("\n");

  let heading = String(meta.heading || "").trim();
  let chunkIndex = Number(meta.chunkIndex) || null;
  let chunkTotal = Number(meta.chunkTotal) || null;
  let bodyStart = 0;

  if (lines[0]?.startsWith("heading - ")) {
    heading = lines[0].slice("heading - ".length).trim() || heading;
    bodyStart = 1;
  }
  if (lines[bodyStart]?.match(/^chunk\s+(\d+)\s*\/\s*(\d+)\s*$/i)) {
    const m = lines[bodyStart].match(/^chunk\s+(\d+)\s*\/\s*(\d+)\s*$/i);
    chunkIndex = Number(m[1]);
    chunkTotal = Number(m[2]);
    bodyStart += 1;
  }
  while (lines[bodyStart] === "") bodyStart += 1;

  const body = lines.slice(bodyStart).join("\n").trim();

  return {
    heading: heading || "(untitled)",
    chunkIndex,
    chunkTotal,
    pageNumber: meta.pageNumber ?? null,
    section: meta.section || "",
    excerpt: excerptFromBody(body),
    pageContent,
    metadata: meta,
  };
}

async function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const vertexAuth = getVertexAuth();
      const embedLocation = getLocation();

      embeddings = new VertexAIEmbeddings({
        model: EMBEDDING_MODEL,
        location: embedLocation,
        authOptions: vertexAuth,
      });

      vectorStore = await openVectorStore(embeddings);
      console.log(
        `RAG ready: collection "${CHROMA_COLLECTION}" (embed=${embedLocation}, chat=${getChatLocation()})`
      );
      return true;
    })().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

function modeConfig(answerMode) {
  if (answerMode === MODES.TURBO_SHORT) {
    return {
      isTurbo: true,
      streamAnswer: false, // never stream tokens in short mode
      topKDefault: TURBO_RETRIEVER_K,
      wordTarget: "30-50",
      // Keep headroom: gemini-2.5 may use thinking tokens; too-low caps
      // can yield empty candidates and crash LangChain parsers.
      maxOutputTokens: 1024,
      temperature: 0.2,
      systemPrompt: TURBO_SHORT_SYSTEM_PROMPT,
      searchMessage: "Searching deeply about the content",
      llmMessage: "Preparing a short turbo answer with the LLM",
    };
  }
  if (answerMode === MODES.TURBO_RESEARCH) {
    return {
      isTurbo: true,
      streamAnswer: true,
      topKDefault: TURBO_RETRIEVER_K,
      wordTarget: "up-to-300",
      maxOutputTokens: 2048,
      temperature: 0.35,
      systemPrompt: TURBO_RESEARCH_SYSTEM_PROMPT,
      searchMessage: "Searching deeply about the content",
      llmMessage: "Preparing a research answer with the LLM",
    };
  }
  return {
    isTurbo: false,
    streamAnswer: false,
    topKDefault: DEFAULT_RETRIEVER_K,
    wordTarget: null,
    maxOutputTokens: 1024,
    temperature: 0.2,
    systemPrompt: NORMAL_SYSTEM_PROMPT,
    searchMessage: "Searching about the content",
    llmMessage: "Giving content to the LLM",
  };
}

function buildLlm({ temperature, maxOutputTokens }) {
  return new ChatVertexAI({
    model: getChatModel(),
    temperature,
    maxOutputTokens,
    location: getChatLocation(),
    authOptions: getVertexAuth(),
  });
}

function resolveRequest({ question, k, mode, turbo }) {
  const q = String(question || "").trim();
  if (!q) {
    const err = new Error("question is required");
    err.status = 400;
    throw err;
  }

  const answerMode = resolveAnswerMode({ mode, turbo });
  const cfg = modeConfig(answerMode);
  // Turbo modes always use k=10; normal may allow optional k override.
  const topK = cfg.isTurbo
    ? TURBO_RETRIEVER_K
    : Math.min(
        Math.max(
          k == null || k === "" ? cfg.topKDefault : Number(k) || cfg.topKDefault,
          1
        ),
        20
      );

  return { q, topK, answerMode, cfg };
}

/**
 * Retrieve + answer. Optional onEvent emits RAG pipeline journey events.
 * For turbo_research only, also streams LLM tokens as:
 *   { type: "token", text: "..." }
 * then a final { type: "result", answer, sources, meta }.
 *
 * mode:
 *   - "normal"         → k=3, concise (no token stream)
 *   - "turbo_short"    → k=10, ~30–50 words (no token stream)
 *   - "turbo_research" → k=10, up to ~300 words + token stream
 */
export async function askQuestion({
  question,
  k,
  mode,
  turbo,
  onEvent,
} = {}) {
  const emit = async (event) => {
    if (typeof onEvent === "function") await onEvent(event);
  };

  const { q, topK, answerMode, cfg } = resolveRequest({
    question,
    k,
    mode,
    turbo,
  });

  await emit({
    type: "status",
    step: "searching",
    message: cfg.searchMessage,
  });

  await ensureReady();

  const retriever = vectorStore.asRetriever({ k: topK });
  const retrievedDocs = await retriever.invoke(q);
  const sources = retrievedDocs.map(parseStoredChunk);

  await emit({
    type: "status",
    step: "found",
    message: "Found the content",
    count: sources.length,
  });

  await emit({
    type: "status",
    step: "llm",
    message: cfg.llmMessage,
  });

  const llm = buildLlm(cfg);
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", cfg.systemPrompt],
    ["human", "{input}"],
  ]);

  const combineDocsChain = await createStuffDocumentsChain({ llm, prompt });

  let answer = "";
  if (cfg.streamAnswer && answerMode === MODES.TURBO_RESEARCH) {
    await emit({
      type: "status",
      step: "answering",
      message: "Streaming the research answer",
    });

    const stream = await combineDocsChain.stream({
      input: q,
      context: retrievedDocs,
    });

    for await (const chunk of stream) {
      const text =
        typeof chunk === "string"
          ? chunk
          : typeof chunk?.content === "string"
            ? chunk.content
            : Array.isArray(chunk?.content)
              ? chunk.content.map((p) => p?.text || "").join("")
              : String(chunk ?? "");
      if (!text) continue;
      answer += text;
      await emit({ type: "token", text });
    }
  } else {
    // normal + turbo_short: blocking invoke only (no token stream)
    const raw = await combineDocsChain.invoke({
      input: q,
      context: retrievedDocs,
    });
    answer = typeof raw === "string" ? raw : String(raw ?? "");
  }

  const result = {
    answer,
    sources,
    meta: {
      k: topK,
      mode: answerMode,
      turbo: cfg.isTurbo,
      streamAnswer: Boolean(cfg.streamAnswer),
      wordTarget: cfg.wordTarget,
      model: getChatModel(),
      collection: CHROMA_COLLECTION,
    },
  };

  await emit({ type: "result", ...result });
  await emit({ type: "done" });

  return result;
}

/** Warm Chroma + embeddings at server startup (optional). */
export async function warmRag() {
  await ensureReady();
}
