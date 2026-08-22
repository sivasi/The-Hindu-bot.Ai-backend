import mongoose from "mongoose";

const appLogSchema = new mongoose.Schema(
  {
    level: {
      type: String,
      enum: ["debug", "info", "warn", "error"],
      default: "info",
      index: true,
    },
    source: {
      type: String,
      default: "app",
      index: true,
    },
    message: {
      type: String,
      required: true,
    },
    requestId: {
      type: String,
      default: null,
      index: true,
    },
    method: { type: String, default: null },
    path: { type: String, default: null },
    userId: { type: String, default: null },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

appLogSchema.index({ createdAt: -1 });
appLogSchema.index({ source: 1, createdAt: -1 });
/** Drop logs after 14 days. */
appLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

export const AppLog =
  mongoose.models.AppLog || mongoose.model("AppLog", appLogSchema);
