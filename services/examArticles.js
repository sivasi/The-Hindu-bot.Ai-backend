import { ExamArticle, EXAM_SECTIONS } from "../models/ExamArticle.js";
import { isMongoConfigured, isMongoReady, connectMongo } from "./mongo.js";

async function ensureMongo() {
  if (!isMongoConfigured()) {
    throw Object.assign(new Error("MongoDB is not configured"), { status: 503 });
  }
  if (!isMongoReady()) await connectMongo();
}

export function toPublicExamArticle(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    title: doc.title,
    section: doc.section,
    examRelevance: doc.examRelevance,
    summary: doc.summary || "",
    refinedBody: doc.refinedBody,
    examTags: doc.examTags || [],
    pageNumber: doc.pageNumber,
    wordCount: doc.wordCount || 0,
    source: doc.source,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function replaceExamArticlesForSource(source, articles) {
  await ensureMongo();
  await ExamArticle.deleteMany({ source });
  if (!articles.length) return [];
  const docs = await ExamArticle.insertMany(
    articles.map((a) => ({
      ...a,
      source,
    }))
  );
  return docs.map(toPublicExamArticle);
}

export async function saveExamArticle(article) {
  await ensureMongo();
  const doc = await ExamArticle.create(article);
  return toPublicExamArticle(doc);
}

export async function listExamArticlesBySource(source) {
  await ensureMongo();
  const items = await ExamArticle.find(source ? { source } : {})
    .sort({ pageNumber: 1, createdAt: 1 })
    .lean();
  return items.map(toPublicExamArticle);
}

export async function deleteExamArticlesFromPage(source, fromPage) {
  await ensureMongo();
  const result = await ExamArticle.deleteMany({
    source,
    pageNumber: { $gte: fromPage },
  });
  return { deleted: result.deletedCount || 0 };
}

export async function listExamSections() {
  await ensureMongo();
  const rows = await ExamArticle.aggregate([
    { $group: { _id: "$section", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  return EXAM_SECTIONS.map((section) => ({
    section,
    count: byId[section] || 0,
  })).filter((s) => s.count > 0);
}

export async function listExamArticles({
  section,
  relevance,
  limit = 50,
  skip = 0,
  q,
} = {}) {
  await ensureMongo();
  const filter = {};
  if (section) filter.section = section;
  if (relevance) filter.examRelevance = relevance;
  if (q?.trim()) {
    filter.$or = [
      { title: { $regex: q.trim(), $options: "i" } },
      { summary: { $regex: q.trim(), $options: "i" } },
      { examTags: { $regex: q.trim(), $options: "i" } },
    ];
  }

  const [items, total] = await Promise.all([
    ExamArticle.find(filter)
      .sort({ examRelevance: -1, pageNumber: 1, createdAt: -1 })
      .skip(Math.max(0, Number(skip) || 0))
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
      .lean(),
    ExamArticle.countDocuments(filter),
  ]);

  return {
    total,
    sections: EXAM_SECTIONS,
    articles: items.map(toPublicExamArticle),
  };
}

/**
 * Discover home:
 * - sections: [{ section, count }] for every non-empty section (Hindu order)
 * - frontPage: { section: "Front Page", count, articles: [...] }
 *   Uses section="Front Page" when present; otherwise page-1 leads as home feed.
 */
export async function getDiscoverHome() {
  await ensureMongo();

  const [sectionRows, frontPageDocs, pageOneLeads] = await Promise.all([
    ExamArticle.aggregate([
      { $group: { _id: "$section", count: { $sum: 1 } } },
    ]),
    ExamArticle.find({ section: "Front Page" })
      .sort({ examRelevance: -1, pageNumber: 1, createdAt: -1 })
      .lean(),
    ExamArticle.find({
      pageNumber: 1,
      examRelevance: { $in: ["high", "medium"] },
    })
      .sort({ examRelevance: -1, createdAt: -1 })
      .lean(),
  ]);

  const byId = Object.fromEntries(sectionRows.map((r) => [r._id, r.count]));
  const sections = EXAM_SECTIONS.map((section) => ({
    section,
    count: byId[section] || 0,
  })).filter((s) => s.count > 0 || s.section === "Front Page");

  const frontSource =
    frontPageDocs.length > 0 ? frontPageDocs : pageOneLeads;
  const frontPageArticles = frontSource.map(toPublicExamArticle);

  return {
    sections,
    frontPage: {
      section: "Front Page",
      count: frontPageArticles.length,
      articles: frontPageArticles,
    },
  };
}

/**
 * On-demand: all articles for one The Hindu section.
 */
export async function getDiscoverSection(sectionName) {
  await ensureMongo();

  const section = String(sectionName || "").trim();
  if (!EXAM_SECTIONS.includes(section)) {
    throw Object.assign(
      new Error(
        `Invalid section. Use one of: ${EXAM_SECTIONS.join(", ")}`
      ),
      { status: 400 }
    );
  }

  const items = await ExamArticle.find({ section })
    .sort({ examRelevance: -1, pageNumber: 1, createdAt: -1 })
    .lean();

  return {
    section,
    count: items.length,
    articles: items.map(toPublicExamArticle),
  };
}

export async function getExamArticleById(id) {
  await ensureMongo();
  const doc = await ExamArticle.findById(id).lean();
  if (!doc) {
    throw Object.assign(new Error("Exam article not found"), { status: 404 });
  }
  return toPublicExamArticle(doc);
}

export async function clearExamArticles(source) {
  await ensureMongo();
  const filter = source ? { source } : {};
  const result = await ExamArticle.deleteMany(filter);
  return { deleted: result.deletedCount || 0 };
}
