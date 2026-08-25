import "dotenv/config";

import {
  CHROMA_COLLECTION,
  CHROMA_URL,
  LEXICAL_INDEX_URL,
  LEXICAL_RARE_DF_RATIO,
} from "./config.js";
import { isISODate } from "./services/ingestCalendar.js";
import { rebuildLexicalIndexFromChroma } from "./services/lexicalIndex.js";

function printHelp() {
  console.log(`
Rebuild BM25 from Chroma for a date range. Replaces the previous lexical-index.json.
Stores only rare tokens (df/N < ${(LEXICAL_RARE_DF_RATIO * 100).toFixed(0)}%).
Does not re-embed.

Usage:
  node ingest-lexical.js --from 2026-01-01 --to 2026-01-31
  node ingest-lexical.js --date 2026-01-15
  node ingest-lexical.js

Options:
  --from YYYY-MM-DD   Inclusive start (ISO date on chunk metadata)
  --to YYYY-MM-DD     Inclusive end
  --date YYYY-MM-DD   Single day
  --help, -h

No range = every chunk currently in Chroma.
Running again deletes/overwrites the previous index.

Collection:     ${CHROMA_COLLECTION}
Chroma URL:     ${CHROMA_URL}
Lexical host:   ${LEXICAL_INDEX_URL}
`);
}

function requireISO(label, value) {
  if (!isISODate(value)) {
    console.error(`${label} must be YYYY-MM-DD, got: ${value}`);
    process.exit(1);
  }
  return value;
}

function parseArgs(argv) {
  let date = null;
  let from = null;
  let to = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--date") {
      date = requireISO("--date", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--from") {
      from = requireISO("--from", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--to") {
      to = requireISO("--to", argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }
    console.error(`Unexpected argument: ${arg}`);
    printHelp();
    process.exit(1);
  }

  if (from && to && from > to) {
    console.error(`--from ${from} is after --to ${to}`);
    process.exit(1);
  }

  return { date, from, to };
}

async function main() {
  const { date, from, to } = parseArgs(process.argv.slice(2));
  const range = date
    ? date
    : from || to
      ? `${from || "…"} → ${to || "…"}`
      : "all dates in Chroma";

  console.log(
    `Replacing lexical index from Chroma "${CHROMA_COLLECTION}" (${range}, rare < ${(LEXICAL_RARE_DF_RATIO * 100).toFixed(0)}%)`
  );

  const started = Date.now();
  const index = await rebuildLexicalIndexFromChroma({
    collection: CHROMA_COLLECTION,
    date,
    dateFrom: date ? null : from,
    dateTo: date ? null : to,
  });
  const ms = Date.now() - started;
  if (!index) {
    throw new Error("No chunks in Chroma for that range. Run: node ingest.js");
  }
  console.log(
    `Done in ${ms}ms. ${index.n} chunks, ${index.df.size} rare terms` +
      (index.dateFrom ? ` [${index.dateFrom} → ${index.dateTo}]` : "")
  );
  console.log('\nNext: node query.js "your question"');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
