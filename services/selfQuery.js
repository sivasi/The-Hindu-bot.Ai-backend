import { dateParts, isISODate } from "./ingestCalendar.js";

const SECTION_SET = new Set([
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
]);

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

function toChromaFilter({ pageNumber, section, date, dateFrom, dateTo }) {
  const clauses = [];
  if (date) clauses.push({ date: { $eq: date } });
  if (!date && (dateFrom || dateTo)) {
    const range = [];
    if (dateFrom) range.push({ dateInt: { $gte: dateParts(dateFrom).dateInt } });
    if (dateTo) range.push({ dateInt: { $lte: dateParts(dateTo).dateInt } });
    if (range.length === 1) clauses.push(range[0]);
    else if (range.length === 2) clauses.push({ $and: range });
  }
  if (pageNumber != null) clauses.push({ pageNumber: { $eq: pageNumber } });
  if (section) clauses.push(chromaSectionFilter(section));
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

export function emptyFilters() {
  return {
    date: null,
    dateFrom: null,
    dateTo: null,
    pageNumber: null,
    section: null,
    whole: false,
  };
}

function coerceIsoDate(value) {
  const text = String(value || "").trim();
  if (!text || text === "null") return null;
  return isISODate(text) ? text : null;
}

function coercePageNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function coerceSection(value) {
  const lower = String(value || "")
    .trim()
    .toLowerCase();
  if (!lower || !SECTION_SET.has(lower)) return null;
  return lower === "sports" ? "sport" : lower;
}

function coerceWhole(value) {
  return value === true || value === "true";
}

/** Normalize LLM filter JSON. Dates must already be YYYY-MM-DD. */
export function coerceMetadataFilters(raw) {
  const empty = emptyFilters();
  if (!raw || typeof raw !== "object") return empty;

  const date = coerceIsoDate(raw.date);
  let dateFrom = coerceIsoDate(raw.dateFrom);
  let dateTo = coerceIsoDate(raw.dateTo);
  if (dateFrom && dateTo && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }
  if (dateFrom && dateTo && dateFrom === dateTo) {
    return {
      ...empty,
      date: dateFrom,
      pageNumber: coercePageNumber(raw.pageNumber),
      section: coerceSection(raw.section),
      whole: coerceWhole(raw.whole),
    };
  }

  return {
    date: date || null,
    dateFrom: date ? null : dateFrom,
    dateTo: date ? null : dateTo,
    pageNumber: coercePageNumber(raw.pageNumber),
    section: coerceSection(raw.section),
    whole: coerceWhole(raw.whole),
  };
}

/**
 * Filters come only from the decompose LLM. `search` is embedding / BM25 text.
 */
export function buildParsedQuery({ original, search, llmFilters } = {}) {
  const question = String(original || "").trim();
  const query = String(search || question).trim() || question;
  const filters = coerceMetadataFilters(llmFilters);
  const filter = toChromaFilter(filters);
  const parsed = {
    question,
    query,
    ...filters,
    filter,
  };
  console.log(
    "[self-query]",
    JSON.stringify(
      {
        source: "llm",
        question: parsed.question,
        searchQuery: parsed.query,
        date: parsed.date,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        pageNumber: parsed.pageNumber,
        section: parsed.section,
        whole: parsed.whole,
        filter: parsed.filter || null,
      },
      null,
      2
    )
  );
  return parsed;
}
