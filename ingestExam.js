import "dotenv/config";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

import {
  openPdfDocument,
  extractArticlesFromLoadedPage,
} from "./layoutArticles.js";
import { buildCurateLlm, curatePageForExam } from "./services/examCurate.js";
import { connectMongo, isMongoConfigured } from "./services/mongo.js";
import {
  clearExamArticles,
  saveExamArticle,
  listExamArticlesBySource,
  deleteExamArticlesFromPage,
} from "./services/examArticles.js";
import {
  EXAM_PDF_PATH,
  EXAM_PROGRESS_PATH,
  EXAM_CURATE_PAUSE_MS,
  EXAM_CURATE_MAX_RETRIES,
  EXAM_CURATE_RETRY_BASE_MS,
  HEADLINE_MIN_SIZE,
} from "./config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  console.log(...args);
}

function logWarn(...args) {
  console.warn(...args);
}

function resolvePdfPath() {
  if (fs.existsSync(EXAM_PDF_PATH)) return EXAM_PDF_PATH;
  throw new Error(
    `PDF not found. Place newspaper at ${EXAM_PDF_PATH} (or set EXAM_PDF_PATH).`
  );
}

function formatError(err) {
  return String(err?.message || err).slice(0, 400);
}

function isRetryableError(err) {
  const status = err?.status || err?.response?.status;
  const message = String(err?.message || "");
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /429|Too Many Requests|fetch failed|ECONNRESET|ETIMEDOUT|Empty AI|not JSON/i.test(
      message
    )
  );
}

async function withRetries(
  fn,
  label,
  { maxRetries = EXAM_CURATE_MAX_RETRIES, retryBaseMs = EXAM_CURATE_RETRY_BASE_MS } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === maxRetries) throw err;
      const waitMs = retryBaseMs * 2 ** (attempt - 1);
      console.warn(
        `${label} failed (attempt ${attempt}/${maxRetries}): ${formatError(err)}`
      );
      console.warn(`Retrying in ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function saveProgress(fields) {
  await fsPromises.mkdir(path.dirname(EXAM_PROGRESS_PATH), { recursive: true });
  await fsPromises.writeFile(
    EXAM_PROGRESS_PATH,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        store: "mongo:examarticles",
        ...fields,
      },
      null,
      2
    )
  );
}

async function main() {
  const pdfPath = resolvePdfPath();
  const model = process.env.EXAM_CHAT_MODEL || "gemini-3.5-flash";
  const location =
    process.env.EXAM_CHAT_LOCATION ||
    (model.startsWith("gemini-3") ? "global" : process.env.CHAT_LOCATION || "us-central1");

  log(`Exam-curation ingest from: ${pdfPath}`);
  log(`Store: Mongo examarticles only (no Chroma)`);
  log(`Mode: 1 LLM call per page | model=${model} | location=${location}`);

  if (!isMongoConfigured()) {
    throw new Error("MONGODB_URI is required for exam article storage");
  }
  await connectMongo();

  const absSource = path.resolve(pdfPath);
  const doc = await openPdfDocument(pdfPath);
  const totalPages = doc.numPages;
  const llm = buildCurateLlm();

  let curated = [];
  let rawCount = 0;
  let dropped = 0;

  const resume =
    ["1", "true", "yes"].includes(
      String(process.env.EXAM_RESUME || "").toLowerCase()
    ) || Boolean(process.env.EXAM_START_PAGE);

  let startPage = Number(process.env.EXAM_START_PAGE) || 1;
  if (resume && !process.env.EXAM_START_PAGE && fs.existsSync(EXAM_PROGRESS_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(EXAM_PROGRESS_PATH, "utf8"));
      if (prev?.nextPage) startPage = Number(prev.nextPage) || 1;
      rawCount = Number(prev.rawCount) || 0;
      dropped = Number(prev.dropped) || 0;
    } catch {
      // ignore bad progress file
    }
  }
  const endPage = Number(process.env.EXAM_END_PAGE) || totalPages;

  if (resume && startPage > 1) {
    await deleteExamArticlesFromPage(absSource, startPage);
    curated = await listExamArticlesBySource(absSource);
    log(
      `Resume from page ${startPage}/${totalPages} (already kept ${curated.length})`
    );
  } else {
    await clearExamArticles(absSource);
    startPage = Number(process.env.EXAM_START_PAGE) || 1;
    log(`Fresh run from page ${startPage}/${totalPages}`);
  }

  for (let page = startPage; page <= Math.min(endPage, totalPages); page += 1) {
    const articles = await extractArticlesFromLoadedPage(doc, page, {
      headlineMinSize: HEADLINE_MIN_SIZE,
    });
    log(
      `Page ${page}/${totalPages}: ${articles.length} layout articles → 1 LLM call`
    );
    rawCount += articles.length;

    try {
      const kept = await withRetries(
        () => curatePageForExam(llm, articles, { pageNumber: page }),
        `curate page ${page}`,
        {
          maxRetries: EXAM_CURATE_MAX_RETRIES,
          retryBaseMs: EXAM_CURATE_RETRY_BASE_MS,
        }
      );

      dropped += Math.max(0, articles.length - kept.length);

      for (const curatedArticle of kept) {
        const saved = await saveExamArticle({
          ...curatedArticle,
          source: absSource,
        });
        curated.push(saved);
        log(
          `  ✓ [${saved.section}/${saved.examRelevance}] ${saved.title.slice(0, 70)}`
        );
      }
      if (!kept.length) {
        log(`  (no exam-worthy articles on page ${page})`);
      }
    } catch (err) {
      dropped += articles.length;
      logWarn(`  ✗ page ${page} failed: ${formatError(err)}`);
    }

    if (EXAM_CURATE_PAUSE_MS > 0) await sleep(EXAM_CURATE_PAUSE_MS);

    await saveProgress({
      source: absSource,
      totalPages,
      nextPage: page + 1,
      rawCount,
      kept: curated.length,
      dropped,
      complete: false,
    });
  }

  await saveProgress({
    source: absSource,
    totalPages,
    nextPage: totalPages + 1,
    rawCount,
    kept: curated.length,
    dropped,
    complete: true,
  });

  const bySection = curated.reduce((acc, a) => {
    acc[a.section] = (acc[a.section] || 0) + 1;
    return acc;
  }, {});

  log("Done.");
  log(`  Raw layout articles: ${rawCount}`);
  log(`  Kept for exam viewers (Mongo): ${curated.length}`);
  log(`  Dropped/irrelevant: ${dropped}`);
  log(`  By section:`, bySection);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
