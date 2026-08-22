const PAGE_RE = /\b(?:on\s+)?page(?:Number)?\s*[:=]?\s*(\d+)\b/i;
const WHOLE_RE =
  /\b(?:the\s+)?(?:whole|entire|full)(?:\s+(?:page|section))?\b|\ball\s+of\s+(?:the\s+)?(?:page)?\b/i;

const SECTIONS = [
  "news",
  "sport",
  "sports",
  "business",
  "states",
  "world",
  "editorial",
  "opinion",
  "national",
  "international",
  "delhi",
  "telangana",
  "faith",
  "science",
  "education",
  "investor",
];

const SECTION_NAMES = SECTIONS.join("|");
// Require "section" so "the news about …" is not treated as section=news.
const SECTION_RE = new RegExp(
  String.raw`\b(?:in\s+(?:the\s+)?)?(${SECTION_NAMES})\s+section\b|\bsection\s*[:=]?\s*(${SECTION_NAMES})\b`,
  "i"
);

function chromaSectionFilter(section) {
  const lower = String(section).trim().toLowerCase();
  const canonical = lower === "sports" ? "sport" : lower;
  const names = canonical === "sport" ? ["sport", "sports"] : [canonical];
  const variants = [];
  for (const name of names) {
    variants.push(
      name,
      name.toUpperCase(),
      name[0].toUpperCase() + name.slice(1).toLowerCase()
    );
  }
  return { section: { $in: [...new Set(variants)] } };
}

function toChromaFilter({ pageNumber, section }) {
  const clauses = [];
  if (pageNumber != null) clauses.push({ pageNumber: { $eq: pageNumber } });
  if (section) clauses.push(chromaSectionFilter(section));
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

/** Pull page / section filters out of the question, e.g. "business on page 5". */
export function parsePageFilter(question) {
  const original = String(question || "").trim();
  let query = original;
  let pageNumber = null;
  let section = null;
  let whole = false;

  const pageMatch = query.match(PAGE_RE);
  if (pageMatch) {
    pageNumber = Number(pageMatch[1]);
    query = query.replace(pageMatch[0], " ");
  }

  const sectionMatch = query.match(SECTION_RE);
  if (sectionMatch) {
    section = (sectionMatch[1] || sectionMatch[2]).trim();
    query = query.replace(sectionMatch[0], " ");
  }

  const wholeMatch = query.match(WHOLE_RE);
  if (wholeMatch) {
    whole = true;
    query = query.replace(wholeMatch[0], " ");
  }

  query = query.replace(/\s+/g, " ").trim() || original;
  const filter = toChromaFilter({ pageNumber, section });

  console.log(
    "[self-query]",
    JSON.stringify(
      {
        question: original,
        searchQuery: query,
        pageNumber,
        section,
        whole,
        filter: filter || null,
      },
      null,
      2
    )
  );

  return { query, pageNumber, section, whole, filter };
}
