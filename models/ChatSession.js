import mongoose from "mongoose";

const chatSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** Sidebar label (ChatGPT-style) — usually first question, editable. */
    title: {
      type: String,
      default: "New chat",
      trim: true,
      maxlength: 120,
    },
    /** Short preview under the title in the sidebar. */
    preview: {
      type: String,
      default: "",
      trim: true,
      maxlength: 200,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    /** Rolling memory for follow-up rewrite (not shown to the frontend). */
    summary: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2000,
    },
    /** messageCount when summary was last written (stale-job guard). */
    summaryAtCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

chatSessionSchema.index({ userId: 1, lastMessageAt: -1 });

export const ChatSession =
  mongoose.models.ChatSession ||
  mongoose.model("ChatSession", chatSessionSchema);
