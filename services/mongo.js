import mongoose from "mongoose";
import { MONGODB_URI } from "../config.js";

let connecting = null;

export function isMongoConfigured() {
  return Boolean(MONGODB_URI);
}

export function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

/** Connect once at process start. Safe to call repeatedly. */
export async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn("[mongo] MONGODB_URI not set — user records will not be persisted");
    return false;
  }
  if (isMongoReady()) return true;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    })
    .then(() => {
      console.log("[mongo] connected");
      return true;
    })
    .catch((err) => {
      connecting = null;
      console.error("[mongo] connection failed:", err?.message || err);
      throw err;
    });

  return connecting;
}
