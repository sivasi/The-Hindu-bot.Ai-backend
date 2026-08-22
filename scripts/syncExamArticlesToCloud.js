/**
 * Copy local Mongo `examarticles` → cloud Mongo (via kubectl port-forward).
 *
 * Usage:
 *   1) kubectl port-forward -n default svc/mongo 27018:27017
 *   2) node scripts/syncExamArticlesToCloud.js
 *
 * Env:
 *   LOCAL_MONGODB_URI  (default mongodb://127.0.0.1:27017/rag_users)
 *   CLOUD_MONGODB_URI  (default mongodb://127.0.0.1:27018/rag_users)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { ExamArticle } from "../models/ExamArticle.js";

const LOCAL_URI =
  process.env.LOCAL_MONGODB_URI ||
  process.env.MONGODB_URI ||
  "mongodb://127.0.0.1:27017/rag_users";
const CLOUD_URI =
  process.env.CLOUD_MONGODB_URI || "mongodb://127.0.0.1:27018/rag_users";

async function main() {
  console.log(`Local:  ${LOCAL_URI}`);
  console.log(`Cloud:  ${CLOUD_URI}`);

  const local = await mongoose.createConnection(LOCAL_URI).asPromise();
  const cloud = await mongoose.createConnection(CLOUD_URI).asPromise();

  const LocalExam = local.model("ExamArticle", ExamArticle.schema);
  const CloudExam = cloud.model("ExamArticle", ExamArticle.schema);

  const docs = await LocalExam.find({}).lean();
  console.log(`Local examarticles: ${docs.length}`);
  if (!docs.length) {
    throw new Error("No local examarticles to sync");
  }

  const del = await CloudExam.deleteMany({});
  console.log(`Cleared cloud examarticles: ${del.deletedCount || 0}`);

  // Preserve _ids so article URLs stay stable if FE cached any.
  const payload = docs.map((d) => {
    const { __v, ...rest } = d;
    return rest;
  });
  await CloudExam.insertMany(payload, { ordered: false });

  const cloudCount = await CloudExam.countDocuments();
  const bySection = await CloudExam.aggregate([
    { $group: { _id: "$section", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  console.log(`Cloud examarticles: ${cloudCount}`);
  console.log(
    "By section:",
    Object.fromEntries(bySection.map((r) => [r._id, r.count]))
  );

  await local.close();
  await cloud.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
