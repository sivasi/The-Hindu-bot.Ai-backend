import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

import {
  CHROMA_COLLECTION,
  CHROMA_URL,
  LEXICAL_INDEX_PATH,
} from "./config.js";
import { getAllDocuments, readProgress } from "./services/chroma.js";
import { saveLexicalIndex } from "./services/lexicalIndex.js";

function printHelp() {
  console.log(`
Build a BM25 inverted index from the existing Chroma collection.
Does not re-embed. Writes ${LEXICAL_INDEX_PATH} (postings, df, ids —
not chunk text; query fetches pageContent from Chroma by id).

Usage:
  node ingest-lexical.js
  npm run ingest:lexical

Requires a completed PDF ingest (node ingest.js) and a running Chroma:

  npm run chroma:up

Collection:  ${CHROMA_COLLECTION}
Chroma URL:  ${CHROMA_URL}
`);
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
}

export async function runLexicalIngest() {
  const progress = await readProgress();
  if (!progress?.complete) {
    throw new Error("PDF ingest is not complete. Run: node ingest.js");
  }

  console.log(
    `Building lexical index from Chroma collection "${CHROMA_COLLECTION}" (${progress.vectorCount} vectors)`
  );

  const started = Date.now();
  const docs = await getAllDocuments();
  if (docs.length !== progress.vectorCount) {
    console.warn(
      `[ingest-lexical] Chroma returned ${docs.length} docs, ingest progress says ${progress.vectorCount}`
    );
  }

  const index = await saveLexicalIndex(docs, {
    collection: CHROMA_COLLECTION,
    chunking: progress.chunking || null,
  });

  const ms = Date.now() - started;
  console.log(
    `Done. ${index.n} chunks, ${index.df.size} terms → ${LEXICAL_INDEX_PATH} (${ms}ms)`
  );
  return index;
}

async function main() {
  parseArgs(process.argv.slice(2));
  await runLexicalIngest();
  console.log('\nNext: node query.js "your question"');
}

const isCli =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
