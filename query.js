import "dotenv/config";
import { askQuestion } from "./services/rag.js";

async function main() {
  const question =
    process.argv.slice(2).join(" ").trim() ||
    "how much growth of employment in power sector?";

  console.log(`\nQuestion: ${question}\n`);

  const result = await askQuestion({ question, k: 3 });

  console.log(`Retriever context (${result.sources.length} chunks):\n`);
  result.sources.forEach((src, i) => {
    console.log(`--- chunk ${i + 1} ---`);
    console.log(src.pageContent);
    if (src.metadata && Object.keys(src.metadata).length) {
      console.log("metadata:", src.metadata);
    }
    console.log();
  });

  console.log("\nAnswer:\n");
  console.log(result.answer);
}

main().catch(console.error);
