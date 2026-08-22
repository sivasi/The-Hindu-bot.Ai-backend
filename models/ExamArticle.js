import mongoose from "mongoose";

/** Section names as used by The Hindu (Today's Paper / print). */
export const EXAM_SECTIONS = [
  "Front Page",
  "National",
  "Regional",
  "Edit",
  "Op-Ed",
  "Business",
  "Foreign",
  "Sports",
  "Science",
];

const examArticleSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, index: true },
    pageNumber: { type: Number, default: null, index: true },
    originalHeading: { type: String, default: "" },
    originalSection: { type: String, default: "" },
    title: { type: String, required: true, trim: true },
    section: {
      type: String,
      enum: EXAM_SECTIONS,
      required: true,
      index: true,
    },
    examRelevance: {
      type: String,
      enum: ["high", "medium", "low"],
      default: "medium",
      index: true,
    },
    summary: { type: String, default: "" },
    refinedBody: { type: String, required: true },
    examTags: { type: [String], default: [] },
    wordCount: { type: Number, default: 0 },
    keptReason: { type: String, default: "" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

examArticleSchema.index({ section: 1, examRelevance: -1, createdAt: -1 });
examArticleSchema.index({ source: 1, pageNumber: 1, title: 1 });

export const ExamArticle =
  mongoose.models.ExamArticle ||
  mongoose.model("ExamArticle", examArticleSchema);
