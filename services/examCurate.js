import { ChatVertexAI } from "@langchain/google-vertexai";
import { getChatLocation, getVertexAuth } from "../config.js";
import { EXAM_SECTIONS } from "../models/ExamArticle.js";

const PAGE_CURATE_SYSTEM = `You are a senior UPSC/State-PSC editor curating The Hindu for exam prep.

You receive ALL layout-detected articles from ONE newspaper page.
For EACH article (by index): keep/drop, assign ONE The Hindu section, and when kept produce a clean exam-ready rewrite.

BIAS: when unsure, KEEP if the piece has any polity / economy / IR / science / environment / social-issue value. Missing a GS-relevant story is worse than keeping a borderline one.

ALWAYS KEEP (examRelevance high or medium) when the article covers any of:
- Centre–state politics, parties, Parliament, Bills/Acts, federalism, fiscal autonomy
- Judiciary / SC / HC / constitutional questions / rights / UAPA / sanctions
- Defence, border, China/Pakistan/neighbourhood, strategic affairs
- Economy: inflation, forex, RBI, trade, tariffs, markets, corporate results with macro angle
- Schemes, Census, reports/indices, education/exam reforms, governance
- Disasters, infrastructure safety, aviation safety (Air India/Airbus etc.) with policy lessons
- Climate, environment, water bodies, wildlife, S&T, health policy, AI/data-centre policy → prefer Science when science/env is the core
- Analytical Edit / Op-Ed / signed commentary on public policy
- Substantive social/cultural features with GS hooks (religion+society, youth movements, gender in sport, Partition memory, etc.)
- Nationally notable sports (India Tests, Olympics, major tournaments, sport policy/diversity)
- Page-1 / lead hard news of national importance → Front Page ONLY if it is a true lead; otherwise National/Business/Foreign by topic

STILL DROP (keep=false) ONLY when mainly:
- Ads, obituaries, horoscope, crossword, pure entertainment/gossip
- Tiny local crime/city colour with ZERO policy, polity, economy, or GS angle
- Score-only sports briefs with no India/national significance
- Letters-to-editor scrap bundles, pure OCR junk, "Page N other text", empty teasers
- Exact duplicate of a stronger article already kept on this page (drop the weaker OCR fragment)

SECTION — exactly ONE of:
${EXAM_SECTIONS.map((s) => `- ${s}`).join("\n")}

Section rules (topic beats vague layout labels like News/States):
- Front Page = true page-1 lead / national flagship story only (usually 1–3 per paper, not every p1 item)
- National = India-wide politics, Centre, courts, parties, national policy (even if layout says States/News)
- Regional = primarily state/city administration or local development WITHOUT strong national federal/policy core
- Edit = unsigned editorial voice of the paper
- Op-Ed = signed opinion / guest commentary
- Business = markets, trade, tariffs, inflation, forex, corporate+macro
- Foreign = events primarily abroad / other countries' politics (India angle OK)
- Sports = sport desk
- Science = science, technology, climate, environment, ecology, health-science

refinedBody requirements when keep=true:
- Clean prose for students (not OCR garbage)
- Preserve names, dates, figures, institutions, Bill/Act names, places
- Aim for dense factual coverage; expand thin OCR into coherent 2–5 short paragraphs when source has enough facts
- Do NOT invent facts; if source is thin, still keep if GS-relevant but note only what is supported

Return STRICT JSON only (no markdown):
{
  "articles": [
    {
      "index": 0,
      "keep": true,
      "section": "National",
      "examRelevance": "high",
      "title": "Clean headline",
      "summary": "2-3 sentence exam-focused summary with key facts",
      "refinedBody": "Clean multi-paragraph body with facts, names, dates, figures.",
      "examTags": ["polity", "federalism"],
      "reason": "short reason"
    }
  ]
}

Rules:
- Include every input index exactly once.
- Dropped items: keep=false; summary/refinedBody may be "".
- Prefer keep=true + medium over drop for substantive national/IR/economy/science pieces.
- Merge obvious OCR duplicates: keep the richer version only.`;

function extractJson(text) {
  const raw = String(text || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : raw;
  const startObj = body.indexOf("{");
  const startArr = body.indexOf("[");
  let start = startObj;
  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
    start = startArr;
  }
  const endObj = body.lastIndexOf("}");
  const endArr = body.lastIndexOf("]");
  const end = Math.max(endObj, endArr);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response was not JSON");
  }
  return JSON.parse(body.slice(start, end + 1));
}

function messageText(raw) {
  if (typeof raw === "string") return raw;
  if (typeof raw?.content === "string") return raw.content;
  if (Array.isArray(raw?.content)) {
    return raw.content.map((p) => p?.text || p?.content || "").join("");
  }
  return String(raw ?? "");
}

/** Map any AI / layout label onto exact The Hindu section names. */
export function normalizeSection(section, fallback = "National") {
  const raw = String(section || "").trim();
  if (EXAM_SECTIONS.includes(raw)) return raw;

  const s = raw.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  const aliases = {
    "front page": "Front Page",
    frontpage: "Front Page",
    front: "Front Page",
    main: "Front Page",
    "main page": "Front Page",
    national: "National",
    india: "National",
    news: "National",
    regional: "Regional",
    states: "Regional",
    state: "Regional",
    city: "Regional",
    delhi: "Regional",
    telangana: "Regional",
    chennai: "Regional",
    edit: "Edit",
    editorial: "Edit",
    editorials: "Edit",
    "op ed": "Op-Ed",
    oped: "Op-Ed",
    "op-ed": "Op-Ed",
    opinion: "Op-Ed",
    opinions: "Op-Ed",
    viewpoint: "Op-Ed",
    business: "Business",
    economy: "Business",
    economics: "Business",
    investor: "Business",
    foreign: "Foreign",
    world: "Foreign",
    international: "Foreign",
    sports: "Sports",
    sport: "Sports",
    science: "Science",
    "science technology": "Science",
    education: "National",
    environment: "Science",
    climate: "Science",
    ecology: "Science",
    technology: "Science",
    faith: "Regional",
  };

  return aliases[s] || fallback;
}

export function mapLayoutSection(layoutSection) {
  return normalizeSection(layoutSection, "National");
}

export function buildCurateLlm() {
  // Gemini 3.5 Flash (Vertex) — available on location "global".
  const model = process.env.EXAM_CHAT_MODEL || "gemini-3.5-flash";
  const location =
    process.env.EXAM_CHAT_LOCATION ||
    (model.startsWith("gemini-3") ? "global" : getChatLocation());
  return new ChatVertexAI({
    model,
    temperature: 0.2,
    maxOutputTokens: Number(process.env.EXAM_CURATE_MAX_TOKENS) || 16384,
    location,
    authOptions: getVertexAuth(),
  });
}

function preparePageArticles(articles) {
  return articles
    .map((article, index) => {
      const heading = String(article?.heading || "").trim();
      const body = String(article?.text || "")
        .replace(heading, "")
        .replace(/\s+/g, " ")
        .trim();
      const layoutSection = String(article?.section || "").trim();
      const junkHeading =
        /^page\s*\d+\s+other text$/i.test(heading) ||
        /^letters?\s+to\s+the\s+editor$/i.test(heading);
      // Let the model see thinner but real articles; junk headings skipped.
      return {
        index,
        heading,
        layoutSection,
        body,
        eligible: !junkHeading && Boolean(heading) && body.length >= 50,
      };
    })
    .filter((a) => a.eligible);
}

function normalizeKeptArticle(parsed, source, pageNumber) {
  const relevance = String(parsed.examRelevance || "medium").toLowerCase();
  if (!parsed?.keep || relevance === "none") {
    return null;
  }
  // Allow "low" only when model still marked keep=true and body is substantive.
  if (relevance === "low" && String(parsed.refinedBody || "").trim().length < 200) {
    return null;
  }

  const refinedBody = String(parsed.refinedBody || "").trim();
  if (refinedBody.length < 80) return null;

  const section = normalizeSection(
    parsed.section,
    mapLayoutSection(source.layoutSection)
  );

  const examRelevance = ["high", "medium", "low"].includes(relevance)
    ? relevance === "low"
      ? "medium"
      : relevance
    : "medium";

  return {
    originalHeading: source.heading,
    originalSection: source.layoutSection,
    title: String(parsed.title || source.heading).trim().slice(0, 240),
    section,
    examRelevance,
    summary: String(parsed.summary || "").trim().slice(0, 800),
    refinedBody,
    examTags: Array.isArray(parsed.examTags)
      ? parsed.examTags
          .map((t) => String(t).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 12)
      : [],
    keptReason: String(parsed.reason || "").trim().slice(0, 300),
    pageNumber: pageNumber ?? null,
    wordCount: refinedBody.split(/\s+/).filter(Boolean).length,
  };
}

/**
 * AI-curate an entire newspaper page in ONE LLM call.
 * Returns curated articles (dropped items omitted).
 */
export async function curatePageForExam(llm, articles, { pageNumber } = {}) {
  const prepared = preparePageArticles(articles);
  if (!prepared.length) return [];

  const payload = prepared.map((a) => ({
    index: a.index,
    layoutSection: a.layoutSection || "(none)",
    headline: a.heading,
    text: a.body.slice(0, 4200),
  }));

  const human = `Newspaper page: ${pageNumber ?? "?"}
Article count: ${payload.length}

Bias: KEEP exam-relevant National / Foreign / Business / Science / Edit / Op-Ed content.
Drop only clear junk/local fluff/duplicates.
Return JSON with an "articles" array covering each index.

${JSON.stringify(payload, null, 2)}`;

  const raw = await llm.invoke([
    { role: "system", content: PAGE_CURATE_SYSTEM },
    { role: "user", content: human },
  ]);

  const text = messageText(raw);
  if (!text.trim()) {
    throw new Error("Empty AI page-curate response");
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (err) {
    throw new Error(
      `AI page response was not JSON: ${String(err?.message || err).slice(0, 120)}`
    );
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.articles)
      ? parsed.articles
      : null;
  if (!rows) {
    throw new Error("AI page JSON missing articles array");
  }

  const byIndex = new Map(prepared.map((a) => [a.index, a]));
  const kept = [];

  for (const row of rows) {
    const idx = Number(row?.index);
    const source = byIndex.get(idx);
    if (!source) continue;
    const article = normalizeKeptArticle(row, source, pageNumber);
    if (article) kept.push(article);
  }

  return kept;
}

/**
 * AI-curate one layout article for exam viewers.
 * Returns null when dropped / irrelevant.
 * @deprecated Prefer curatePageForExam (one call per page).
 */
export async function curateArticleForExam(llm, article, { pageNumber } = {}) {
  const kept = await curatePageForExam(llm, [article], { pageNumber });
  return kept[0] || null;
}
