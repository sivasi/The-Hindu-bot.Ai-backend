import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { CALENDAR_START, MAX_DECOMPOSED_QUERIES } from "../config.js";
import { emptyFilters } from "./selfQuery.js";
import { logger } from "./logger.js";

const ARCHIVE_YEAR = String(CALENDAR_START).slice(0, 4) || "2026";

const DECOMPOSE_SYSTEM = `You prepare newspaper-archive retrieval.

The archive is dated newspaper issues (metadata: date YYYY-MM-DD, pageNumber, section). Rewrite for embedding search, and extract Chroma filters from the USER QUESTION — not from your rewritten search.

Step 0 — Resolve follow-ups from conversation summary
- The human message may include a conversation summary plus the current user message.
- If the current message uses pronouns, "it", "that", "the court", "he", or other follow-ups, rewrite it into a standalone question using ONLY entities from the summary.
- Do not pull extra topics from the summary that the user did not ask about now.
- If there is no summary, or the current message is already self-contained, keep its meaning.
- Put that standalone question in \`standalone\`. This is what the answer model will see.

Step 1 — Extract filters from the standalone question
- date: one calendar day as YYYY-MM-DD, else null.
- dateFrom / dateTo: inclusive range as YYYY-MM-DD, else null. Use a range only when the user asked for more than one day (from/to, a whole month). If they named one day, set date and leave dateFrom/dateTo null.
- Indian DMY (17-01-2026, 17/01/2026), "17 jan 2026", "17 January 2026", "Jan 17, 2026" all become ISO.
- If the year is omitted, assume ${ARCHIVE_YEAR}.
- pageNumber: integer from "page 1", "p.1", "on the page 1". Else null.
- section: one of news, sport, business, states, world, editorial, opinion, national, international, delhi, telangana, faith, science, education, investor. Only if they named a newspaper section. Else null.
- whole: true only if they asked to summarize/list the entire page or section (not a specific person or event on that page).
- Do not invent dates, pages, or sections that are not in the question.

Step 2 — Decompose topics
- Split \`standalone\` (not the raw follow-up) if it asks about two or more unrelated topics; emit one object per topic.
- If it is already a single topic, emit exactly one object.
- Do not invent topics or add extra questions.

Step 3 — Rewrite each object's \`search\` for retrieval
- This is the embedding/BM25 text ONLY. Strip date, page, section, and "whole/summarize the page" phrases — those belong in filters.
- Proper names: Title Case (modi → Modi, pm → Prime Minister).
- Replace slang and vague words with newsroom terms.
- Fix spelling (earthquack → earthquake).
- Prefer a short headline-like noun phrase. Drop "what was", "what did … say".

Step 4 — Flag vague searches
- Judge the rewritten \`search\` plus filters.
- vague: false when the topic is a named person, place, organisation, event, or narrow subject — even if short ("Prime Minister statements").
- vague: false for filter-only questions ("summarize the whole page 7").
- vague: true only for an umbrella category with no specific entity (sports, war, climate event).

Return ONLY JSON (no markdown):
{"standalone":"...","filters":{"date":null,"dateFrom":null,"dateTo":null,"pageNumber":null,"section":null,"whole":false},"queries":[{"search":"...","vague":false}]}

Examples:
Conversation summary: (none)
User: what does PM says on the page 1 on date 17 jan 2026
JSON: {"standalone":"What did the Prime Minister say on page 1 on 17 January 2026?","filters":{"date":"2026-01-17","dateFrom":null,"dateTo":null,"pageNumber":1,"section":null,"whole":false},"queries":[{"search":"Prime Minister statements","vague":false}]}

Conversation summary: (none)
User: summarize the whole page 7 on 2 February 2026
JSON: {"standalone":"Summarize the whole page 7 on 2 February 2026.","filters":{"date":"2026-02-02","dateFrom":null,"dateTo":null,"pageNumber":7,"section":null,"whole":true},"queries":[{"search":"page 7","vague":false}]}

Conversation summary: (none)
User: from 2026-01-15 to 2026-02-02 Wayanad landslide
JSON: {"standalone":"What was reported about the Wayanad landslide from 15 January 2026 to 2 February 2026?","filters":{"date":null,"dateFrom":"2026-01-15","dateTo":"2026-02-02","pageNumber":null,"section":null,"whole":false},"queries":[{"search":"Wayanad landslide","vague":false}]}

Conversation summary: (none)
User: What was the employment growth in the power sector, and what did the ground report say about the Wayanad landslide?
JSON: {"standalone":"What was the employment growth in the power sector, and what did the ground report say about the Wayanad landslide?","filters":{"date":null,"dateFrom":null,"dateTo":null,"pageNumber":null,"section":null,"whole":false},"queries":[{"search":"Power sector employment growth","vague":false},{"search":"Wayanad landslide ground report","vague":false}]}

Conversation summary: User asked about Manipur ethnic violence; assistant summarised the ground report.
User: what did the court say?
JSON: {"standalone":"What did the court say about the Manipur ethnic violence?","filters":{"date":null,"dateFrom":null,"dateTo":null,"pageNumber":null,"section":null,"whole":false},"queries":[{"search":"Manipur ethnic violence court","vague":false}]}

Conversation summary: (none)
User: summarize the whole page 7?
JSON: {"standalone":"summarize the whole page 7?","filters":{"date":null,"dateFrom":null,"dateTo":null,"pageNumber":7,"section":null,"whole":true},"queries":[{"search":"page 7","vague":false}]}`;

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

function filtersFromLlmJson(parsed) {
  if (parsed?.filters && typeof parsed.filters === "object") {
    return parsed.filters;
  }
  const first = Array.isArray(parsed?.queries) ? parsed.queries[0] : null;
  if (first && typeof first === "object") {
    return {
      date: first.date,
      dateFrom: first.dateFrom,
      dateTo: first.dateTo,
      pageNumber: first.pageNumber,
      section: first.section,
      whole: first.whole,
    };
  }
  return emptyFilters();
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
 * @returns {{ topics: Array<{search: string, vague: boolean}>, standalone: string, filters: object }}
 */
export async function decomposeQuestion(question, llm, { conversationSummary } = {}) {
  const original = String(question || "").trim();
  if (!original) {
    return {
      topics: fallbackTopics(original),
      standalone: original,
      filters: emptyFilters(),
    };
  }

  let topics = fallbackTopics(original);
  let standalone = original;
  let filters = emptyFilters();
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
        filters = filtersFromLlmJson(parsed);
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
  return { topics, standalone, filters };
}

export function documentKey(doc) {
  if (doc?.id) return `id:${doc.id}`;
  const meta = doc?.metadata || {};
  if (meta.pageNumber != null && meta.heading && meta.chunkIndex != null) {
    return `${meta.date || ""}|${meta.pageNumber}|${meta.heading}|${meta.chunkIndex}`;
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
