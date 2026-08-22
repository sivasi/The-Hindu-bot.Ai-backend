import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { MAX_DECOMPOSED_QUERIES } from "../config.js";

const DECOMPOSE_SYSTEM = `You prepare newspaper-archive vector-search queries.

The index stores headline-style chunks (Title Case names, newsroom wording). Rewrite for embedding cosine similarity, not for chatting with a user.

Step 1 — Decompose
- If the question asks about two or more unrelated topics, emit one object per topic.
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

Return ONLY JSON of the form {"queries":[{"search":"...","vague":false}]} with no markdown.

Examples:
User: What was the employment growth in the power sector, and what did the ground report say about the Wayanad landslide?
JSON: {"queries":[{"search":"Power sector employment growth","vague":false},{"search":"Wayanad landslide ground report","vague":false}]}

User: jobs at the electricity company
JSON: {"queries":[{"search":"Power sector employment","vague":false}]}

User: A man was shooting the animal in Kaziranga
JSON: {"queries":[{"search":"Kaziranga hunting","vague":false}]}

User: Why did the building falling down happen in Delhi?
JSON: {"queries":[{"search":"Delhi building collapse","vague":false}]}

User: What did that 2019 economics paper say about farm loans?
JSON: {"queries":[{"search":"2019 economics paper farm loans","vague":false}]}

User: What did that paper say about flooding after the Assam rains?
JSON: {"queries":[{"search":"Assam flood paper","vague":false}]}

User: What did that paper say about natural disasters?
JSON: {"queries":[{"search":"natural disaster paper","vague":true}]}

User: What did that paper say?
JSON: {"queries":[{"search":"that paper","vague":true}]}

User: summarize the whole page 7?
JSON: {"queries":[{"search":"summarize the whole page 7?","vague":false}]}`;

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

/**
 * Split a compound question and rewrite each part for embedding search.
 * Vague topics are flagged so retrieval can run HyDE instead of embedding `search`.
 */
export async function decomposeQuestion(question, llm) {
  const original = String(question || "").trim();
  if (!original) return fallbackTopics(original);

  let topics = fallbackTopics(original);
  try {
    const result = await llm.generate([
      [new SystemMessage(DECOMPOSE_SYSTEM), new HumanMessage(original)],
    ]);
    const raw = result.generations?.[0]?.[0]?.message;
    if (!raw) {
      console.warn("[query-decomposition] empty model output; using original");
    } else {
      const parsed = extractJsonObject(messageText(raw));
      if (Array.isArray(parsed?.queries)) {
        topics = normalizeQueries(parsed.queries, original);
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

  logTopics(topics);
  return topics;
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
