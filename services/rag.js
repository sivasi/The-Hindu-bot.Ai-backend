import { VertexAIEmbeddings, ChatVertexAI } from "@langchain/google-vertexai";
import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
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
import { getDocumentsByFilter, openVectorStore } from "./chroma.js";
import { parsePageFilter } from "./selfQuery.js";
import { decomposeQuestion, dedupeDocuments } from "./queryDecomposition.js";
import { generateHydePassage } from "./hyde.js";
import { hybridRetrieve } from "./hybrid.js";
import { logger } from "./logger.js";

let readyPromise = null;
let vectorStore = null;
let embeddings = null;

export const MODES = {
  NORMAL: "normal",
  TURBO_SHORT: "turbo_short",
  TURBO_RESEARCH: "turbo_research",
};

const CHAT_AGENT_PREAMBLE = `You are a helpful chat agent for a newspaper archive Q&A assistant.
Continue the conversation naturally like ChatGPT/Gemini: resolve follow-ups, pronouns, and references using the prior user questions when present.
Answer ONLY using the provided retrieved context below. Do not invent facts outside that context.
Each chunk is labeled with its page number and section. If the user asked about a specific page or section, those chunks are already filtered — summarize the article text. Do not refuse just because the body does not repeat the page or section.
If the question has more than one topic, answer each topic from the retrieved context.
If two topics are unrelated, say that clearly, then still summarise what the archive has on each topic. Do not omit a retrieved person or event just because they are not in the same article as the other topic.
If the context is insufficient, say what is missing clearly.`;

const DOCUMENT_PROMPT = PromptTemplate.fromTemplate(
  "page {pageNumber} | section {section}\n{page_content}"
);

const NORMAL_SYSTEM_PROMPT = `${CHAT_AGENT_PREAMBLE}

Be concise and direct. Prefer a short, clear answer.

Retrieved context:

{context}`;

const TURBO_SHORT_SYSTEM_PROMPT = `${CHAT_AGENT_PREAMBLE}

Write a very short turbo answer of about 30–50 words (hard upper bound ~50 words):
- One or two tight sentences only.
- Lead with the direct answer; include only the most essential fact(s).
- No preamble, no bullet lists, no closing summary.

Retrieved context:

{context}`;

const TURBO_RESEARCH_SYSTEM_PROMPT = `${CHAT_AGENT_PREAMBLE}

You are also a research-style chat agent. Write a research-style answer of up to 300 words maximum (never exceed 300 words; do not pad with filler):
- Open with a clear direct answer to the current user message.
- Use prior conversation only to interpret what the user means (topics, entities, follow-ups).
- Synthesize evidence from multiple retrieved chunks/articles when available.
- Include supporting detail, figures, names, dates, and short quotes from the context.
- Connect related points; note nuances or caveats if the context shows them.
- Close with a brief synthesis of what the sources collectively show.
Use well-structured paragraphs. Stay within 300 words.

Retrieved context:

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

/**
 * Combine prior user questions + current question into one string.
 * This combined text is embedded for vector retrieval.
 */
export function buildCombinedRetrievalQuery(previousQuestions, currentQuestion) {
  const current = String(currentQuestion || "").trim();
  const prev = (previousQuestions || [])
    .map((q) => String(q || "").trim())
    .filter(Boolean);
  if (!prev.length) return current;
  // Join as continuous sentences so the embedding captures full conversational intent.
  return [...prev, current].join(" ");
}

/**
 * Human message for the chat agent: prior turns + current question.
 */
export function buildChatAgentInput(priorTurns, currentQuestion) {
  const current = String(currentQuestion || "").trim();
  const turns = (priorTurns || []).filter(
    (t) => t?.content && (t.role === "user" || t.role === "assistant")
  );
  if (!turns.length) return current;

  const history = turns
    .map((t) =>
      t.role === "user"
        ? `User: ${t.content}`
        : `Assistant: ${t.content}`
    )
    .join("\n");

  return `Conversation so far:
${history}

Current user message:
${current}

Respond as the chat agent to the current user message. Use the conversation for follow-up meaning; use retrieved context for facts.`;
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

function buildLlm({ temperature, maxOutputTokens, ...overrides } = {}) {
  return new ChatVertexAI({
    model: getChatModel(),
    temperature,
    maxOutputTokens,
    location: getChatLocation(),
    authOptions: getVertexAuth(),
    ...overrides,
  });
}

async function retrieveForQuery(topic, llm, topK) {
  const search = typeof topic === "string" ? topic : topic.search;
  const vague = Boolean(topic?.vague);
  const parsed = parsePageFilter(search);
  let retrieveMode = "similarity";
  let docs;
  let hydePassage = "";

  if (parsed.whole && parsed.filter) {
    retrieveMode = "get";
    docs = await getDocumentsByFilter(parsed.filter);
    if (vague) {
      console.log("[hyde] skipped: whole page/section uses get(), not embeddings");
    }
    console.log(
      `[retrieve] get() ${docs.length} chunks for filter ${JSON.stringify(parsed.filter)}`
    );
  } else {
    if (parsed.whole && !parsed.filter) {
      console.warn(
        '[self-query] "whole" ignored: add a page or section so get() is bounded'
      );
    }
    let embedText = parsed.query;
    if (vague) {
      console.log(`[hyde] vague search → generate hypothetical chunk for "${parsed.query}"`);
      hydePassage = await generateHydePassage(parsed.query, llm);
      if (hydePassage) {
        embedText = hydePassage;
        retrieveMode = "hyde";
      } else {
        console.log("[hyde] no passage; embedding rewritten search instead");
      }
    }
    const usedHyde = retrieveMode === "hyde";
    const retrieved = await hybridRetrieve({
      vectorStore,
      semanticQuery: embedText,
      lexicalQuery: parsed.query,
      k: topK,
      filter: parsed.filter,
    });
    docs = retrieved.docs;
    retrieveMode = usedHyde
      ? retrieved.lexicalUsed
        ? "hyde+hybrid"
        : "hyde"
      : retrieved.lexicalUsed
        ? "hybrid"
        : "similarity";
    if (retrieveMode === "hyde+hybrid") {
      console.log(
        `[retrieve] hyde+hybrid k=${topK} → ${docs.length} chunks (semantic=hypothetical chunk, lexical="${parsed.query}")`
      );
    } else if (retrieveMode === "hyde") {
      console.log(
        `[retrieve] hyde k=${topK} → ${docs.length} chunks (cosine only)`
      );
    } else if (retrieveMode === "hybrid") {
      console.log(
        `[retrieve] hybrid k=${topK} → ${docs.length} chunks for "${parsed.query}"`
      );
    } else {
      console.log(
        `[retrieve] similarity k=${topK} → ${docs.length} chunks for "${parsed.query}"`
      );
    }
  }

  return { docs, parsed, retrieveMode, hydePassage };
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
 * Chat continuity (same sessionId):
 *   - previousQuestions → combined with current question → embedded for retrieval
 *   - priorTurns → included in the chat-agent human prompt
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
  previousQuestions = [],
  priorTurns = [],
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

  const retrievalQuery = buildCombinedRetrievalQuery(previousQuestions, q);
  const agentInput = buildChatAgentInput(priorTurns, q);

  await emit({
    type: "status",
    step: "searching",
    message: previousQuestions?.length
      ? "Searching with prior chat questions + current question"
      : cfg.searchMessage,
  });

  await ensureReady();

  const decomposer = buildLlm({
    temperature: 0,
    maxOutputTokens: 1024,
    thinkingBudget: 0,
  });
  const hydeLlm = buildLlm({
    temperature: 0.2,
    maxOutputTokens: 1024,
    thinkingBudget: 0,
  });
  const topics = await decomposeQuestion(retrievalQuery, decomposer);
  logger.info("rag", "decomposed question", {
    question: q.slice(0, 240),
    topK,
    mode: answerMode,
    topics: topics.map((t) => ({
      search: t.search,
      vague: Boolean(t.vague),
    })),
  });
  const retrievals = await Promise.all(
    topics.map((topic) => retrieveForQuery(topic, hydeLlm, topK))
  );
  const retrieved = retrievals.flatMap((item) => item.docs);
  const retrievedDocs = dedupeDocuments(retrieved);
  if (retrieved.length !== retrievedDocs.length) {
    console.log(
      `[query-decomposition] merged ${retrieved.length} → ${retrievedDocs.length} unique chunks`
    );
  }
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

  const combineDocsChain = await createStuffDocumentsChain({
    llm,
    prompt,
    documentPrompt: DOCUMENT_PROMPT,
  });

  let answer = "";
  if (cfg.streamAnswer && answerMode === MODES.TURBO_RESEARCH) {
    await emit({
      type: "status",
      step: "answering",
      message: "Streaming the research answer",
    });

    const stream = await combineDocsChain.stream({
      input: agentInput,
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
      input: agentInput,
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
      chatAgent: true,
      priorQuestionCount: (previousQuestions || []).length,
      retrievalQueryPreview: retrievalQuery.slice(0, 240),
    },
  };

  logger.info("rag", "answer ready", {
    mode: answerMode,
    k: topK,
    sources: sources.length,
    retrieveModes: retrievals.map((item) => item.retrieveMode),
    answerChars: answer.length,
  });

  await emit({ type: "result", ...result });
  await emit({ type: "done" });

  return result;
}

/** Warm Chroma + embeddings at server startup (optional). */
export async function warmRag() {
  await ensureReady();
}
