import mongoose from "mongoose";

const sourceSchema = new mongoose.Schema(
  {
    heading: String,
    chunkIndex: Number,
    chunkTotal: Number,
    pageNumber: Number,
    section: String,
    excerpt: String,
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatSession",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    /** Assistant-only RAG citations (compact). */
    sources: {
      type: [sourceSchema],
      default: undefined,
    },
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

chatMessageSchema.index({ sessionId: 1, createdAt: 1 });

export const ChatMessage =
  mongoose.models.ChatMessage ||
  mongoose.model("ChatMessage", chatMessageSchema);
