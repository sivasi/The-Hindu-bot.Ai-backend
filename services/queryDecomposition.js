import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { MAX_DECOMPOSED_QUERIES } from "../config.js";
import { logger } from "./logger.js";

const DECOMPOSE_SYSTEM = `You prepare newspaper-archive vector-search queries.

The index stores headline-style chunks (Title Case names, newsroom wording). Rewrite for embedding cosine similarity, not for chatting with a user.

Step 0 — Resolve follow-ups from conversation summary
- The human message may include a conversation summary plus the current user message.
- If the current message uses pronouns, "it", "that", "the court", "he", or other follow-ups, rewrite it into a standalone question using ONLY entities from the summary.
- Do not pull extra topics from the summary that the user did not ask about now.
- If there is no summary, or the current message is already self-contained, keep its meaning.
- Put that standalone question in \`standalone\`. This is what the answer model will see.

Step 1 — Decompose
- Split \`standalone\` (not the raw follow-up) if it asks about two or more unrelated topics; emit one object per topic.
- If it is already a single topic, emit exactly one object.
- Keep page / section / "whole" hints on the query they belong to. Do not rewrite those filter phrases.
- Do not invent topics or add extra questions.

Step 2 — Rewrite each object's \`search\` for retrieval
- Proper names (people, places, organisations, events): treat them as names. Write them in Title Case (wayanad → Wayanad, modi → Modi).
- Replace slang, abbreviations, and vague words with standard news/industry terms (jobs → employment, electricity/power company → power sector, "what happened" → the concrete event noun).
- If a word is misspelled, made-up, or not a dictionary term, infer what the user means and replace it with the newsroom word (earthquack → earthquake, collison → collision). Do not keep the broken spelling in \`search\`.
- If the user describes an event in plain or informal words, even when each word is in the dictionary, replace the whole phrase with the one formal news/industry noun (Man shooting the animal → hunting; building falling down → collapse). Do not leave those descriptive phrases in \`search\`.
- Prefer a short headline-like noun phrase over a full question. Drop "what was", "what did … say", "tell me about".
- Keep the original meaning. Keep the topic the same.

Step 3 — Flag vague searches
- Judge the rewritten \`search\`, not the original question.
- "vague": false only when the topic name is strict and searchable: a specific event noun like a particular ind v Aus cricket match, a named-company case study , a specific place, a named person/organisation, or a narrow subject (farm loans, power sector employment) — even if the journal title is missing. The word "paper" or "study" alone does not make it vague.
- "vague": true when the topic is only an umbrella/category that could be many events (sports, general football match, finance, Bank finance, political news, election story, international news, war , calamity, accident, climate event, crisis) or when almost nothing concrete remains ("that paper", "public health paper").
- Do not invent a specific disaster type in \`search\` if the user only said "natural disaster". Leave the umbrella term and set "vague": true so HyDE can run.
- Filter-only queries such as "summarize the whole page 7?" are never vague.

Return ONLY JSON of the form {"standalone":"...","queries":[{"search":"...","vague":false}]} with no markdown.

Examples:
Conversation summary: (none)
User: What was the employment growth in the power sector, and what did the ground report say about the Wayanad landslide?
JSON: {"standalone":"What was the employment growth in the power sector, and what did the ground report say about the Wayanad landslide?","queries":[{"search":"Power sector employment growth","vague":false},{"search":"Wayanad landslide ground report","vague":false}]}

Conversation summary: User asked about Manipur ethnic violence; assistant summarised the ground report.
User: what did the court say?
JSON: {"standalone":"What did the court say about the Manipur ethnic violence?","queries":[{"search":"Manipur ethnic violence court","vague":false}]}

Conversation summary: (none)
User: jobs at the electricity company
JSON: {"standalone":"What is employment like at the electricity company?","queries":[{"search":"Power sector employment","vague":false}]}

User: A man was shooting the animal in Kaziranga
JSON: {"standalone":"What happened when a man was shooting the animal in Kaziranga?","queries":[{"search":"Kaziranga hunting","vague":false}]}

User: Why did the building falling down happen in Delhi?
JSON: {"standalone":"Why did the building collapse in Delhi?","queries":[{"search":"Delhi building collapse","vague":false}]}

User: What did that 2019 economics paper say about farm loans?
JSON: {"standalone":"What did that 2019 economics paper say about farm loans?","queries":[{"search":"2019 economics paper farm loans","vague":false}]}

User: What did that paper say about flooding after the Assam rains?
JSON: {"standalone":"What did that paper say about flooding after the Assam rains?","queries":[{"search":"Assam flood paper","vague":false}]}

User: What did that paper say about natural disasters?
JSON: {"standalone":"What did that paper say about natural disasters?","queries":[{"search":"natural disaster paper","vague":true}]}

User: What did that paper say?
JSON: {"standalone":"What did that paper say?","queries":[{"search":"that paper","vague":true}]}

User: summarize the whole page 7?
JSON: {"standalone":"summarize the whole page 7?","queries":[{"search":"summarize the whole page 7?","vague":false}]}`;

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTopic(item) {
  if (typeof item === "string") {
    const search = cleanText(item);
    return search ? { search, vague: false } : null;
  }
  if (item && typeof item === "object") {
    const search = cleanText(item.search ?? item.query ?? "");
    if (!search) return null;
    return { search, vague: Boolean(item.vague) };
  }
  return null;
}

function fallbackTopics(original) {
  return [{ search: original, vague: false }];
}

function normalizeQueries(queries, original) {
  if (!Array.isArray(queries)) return fallbackTopics(original);

  const topics = [];
  const seen = new Set();
  for (const item of queries) {
    const topic = normalizeTopic(item);
    if (!topic) continue;
    const key = topic.search.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= MAX_DECOMPOSED_QUERIES) break;
  }
  return topics.length ? topics : fallbackTopics(original);
}

function messageText(raw) {
  if (typeof raw === "string") return raw;
  const content = raw?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return String(raw ?? "");
}

function logTopics(topics) {
  if (topics.length === 1 && !topics[0].vague) {
    console.log("[query-decomposition] 1 query (no split)");
    return;
  }
  console.log(`[query-decomposition] ${topics.length} quer${topics.length === 1 ? "y" : "ies"}:`);
  topics.forEach((topic, i) => {
    const flag = topic.vague ? " [vague → hyde]" : "";
    console.log(`  ${i + 1}. ${topic.search}${flag}`);
  });
}

function buildHumanMessage(question, conversationSummary) {
  const summary = cleanText(conversationSummary) || "(none)";
  return `Conversation summary:\n${summary}\n\nCurrent user message:\n${question}`;
}

/**
 * Resolve follow-ups from conversation summary, then split/rewrite for retrieval.
 * Vague topics are flagged so retrieval can run HyDE instead of embedding `search`.
 * @returns {{ topics: Array<{search: string, vague: boolean}>, standalone: string }}
 */
export async function decomposeQuestion(question, llm, { conversationSummary } = {}) {
  const original = String(question || "").trim();
  if (!original) {
    return { topics: fallbackTopics(original), standalone: original };
  }

  let topics = fallbackTopics(original);
  let standalone = original;
  try {
    const human = buildHumanMessage(original, conversationSummary);
    logger.info(
      "query-decomposition",
      `llm input ${JSON.stringify({
        question: original,
        summary: String(conversationSummary || "").trim() || "(none)",
      })}`
    );
    const result = await llm.generate([
      [new SystemMessage(DECOMPOSE_SYSTEM), new HumanMessage(human)],
    ]);
    const raw = result.generations?.[0]?.[0]?.message;
    if (!raw) {
      console.warn("[query-decomposition] empty model output; using original");
    } else {
      const parsed = extractJsonObject(messageText(raw));
      logger.info(
        "query-decomposition",
        parsed
          ? `llm json ${JSON.stringify(parsed)}`
          : `llm json (unparsed) ${messageText(raw)}`
      );
      if (Array.isArray(parsed?.queries)) {
        topics = normalizeQueries(parsed.queries, original);
        const resolved = cleanText(parsed.standalone);
        if (resolved) standalone = resolved;
      } else {
        console.warn("[query-decomposition] invalid LLM JSON; using original");
      }
    }
  } catch (err) {
    console.warn(
      "[query-decomposition] failed; using original:",
      err?.message || err
    );
  }

  if (standalone !== original) {
    console.log(`[query-decomposition] standalone: ${standalone}`);
  }
  logTopics(topics);
  return { topics, standalone };
}

export function documentKey(doc) {
  if (doc?.id) return `id:${doc.id}`;
  const meta = doc?.metadata || {};
  if (meta.pageNumber != null && meta.heading && meta.chunkIndex != null) {
    return `${meta.pageNumber}|${meta.heading}|${meta.chunkIndex}`;
  }
  return String(doc?.pageContent || "").slice(0, 240);
}

export function dedupeDocuments(docs) {
  const seen = new Set();
  const out = [];
  for (const doc of docs) {
    const key = documentKey(doc);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }
  return out;
}
