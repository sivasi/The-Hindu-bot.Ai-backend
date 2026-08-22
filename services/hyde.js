import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const HYDE_SYSTEM = `You write a hypothetical The Hindu article fragment used only for embedding search.

The archive is an Indian newspaper. Country is India. Write in The Hindu print style: formal newsroom English, Indian places, States, institutions, and datelines — not a U.S. or generic global blog.

- One topic only. Same subject as the search query.
- First line: a The Hindu-style article headline (plain, specific, not clickbait). Then a blank line, then the body.
- Body: 4–8 sentences. Optional bureau dateline (NEW DELHI, KALPETTA, THIRUVANANTHAPURAM, etc.) if it fits.
- If the query is a vague "paper" or "study", write it as a cited journal study with concrete Indian newsroom nouns (forest cover, land use, plantations, Forest Department, Western Ghats) — not urban parks, community programmes, or generic green-space health.
- Proper names in Title Case. Do not invent a second topic.
- Return plain text only. No JSON, no markdown fences.`;

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

function cleanPassage(text) {
  return String(text || "")
    .replace(/```(?:\w+)?\s*([\s\S]*?)```/g, "$1")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Hypothetical document for embedding when the rewritten search is too vague.
 * Returns "" on failure so the caller can fall back to the search string.
 */
export async function generateHydePassage(searchQuery, llm) {
  const query = String(searchQuery || "").trim();
  if (!query) return "";

  try {
    const result = await llm.generate([
      [new SystemMessage(HYDE_SYSTEM), new HumanMessage(query)],
    ]);
    const passage = cleanPassage(messageText(result.generations?.[0]?.[0]?.message));
    if (!passage) {
      console.warn("[hyde] empty model output; falling back to search query");
      return "";
    }
    console.log("[hyde] generated hypothetical chunk (search only, not written to Chroma):");
    console.log(passage);
    return passage;
  } catch (err) {
    console.warn("[hyde] failed; falling back to search query:", err?.message || err);
    return "";
  }
}
