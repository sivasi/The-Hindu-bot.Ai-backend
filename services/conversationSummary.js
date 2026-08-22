import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatVertexAI } from "@langchain/google-vertexai";

import {
  CONVERSATION_SUMMARY_MAX_CHARS,
  getChatModel,
  getChatLocation,
  getVertexAuth,
} from "../config.js";
import { saveSessionSummary } from "./chats.js";

const SUMMARY_SYSTEM = `You maintain a short rolling memory of a newspaper-archive Q&A chat.
The next turn will use this summary only to resolve pronouns and follow-ups (it, he, that case, the court).

Keep: people, places, organisations, events, page/section filters, unresolved topics.
Drop: citations, quotes, filler, full answers.
Plain text only. About 80–120 words. No markdown.`;

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

function messageText(raw) {
  if (typeof raw === "string") return raw;
  const content = raw?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return String(raw ?? "");
}

function buildLlm() {
  return new ChatVertexAI({
    model: getChatModel(),
    temperature: 0,
    maxOutputTokens: 512,
    thinkingBudget: 0,
    location: getChatLocation(),
    authOptions: getVertexAuth(),
  });
}

export async function generateConversationSummary({
  previousSummary,
  question,
  answer,
}) {
  const prev = clip(previousSummary, CONVERSATION_SUMMARY_MAX_CHARS) || "(none)";
  const llm = buildLlm();
  const result = await llm.generate([
    [
      new SystemMessage(SUMMARY_SYSTEM),
      new HumanMessage(
        `Previous summary:\n${prev}\n\nNew user message:\n${clip(question, 800)}\n\nNew assistant answer:\n${clip(answer, 1200)}\n\nWrite the updated summary.`
      ),
    ],
  ]);
  const text = clip(
    messageText(result.generations?.[0]?.[0]?.message),
    CONVERSATION_SUMMARY_MAX_CHARS
  );
  if (!text) {
    throw new Error("empty conversation summary");
  }
  return text;
}

/**
 * Refresh ChatSession.summary after the API has already responded.
 * Never await this on the request path.
 */
export function scheduleConversationSummaryRefresh({
  sessionId,
  userId,
  previousSummary,
  question,
  answer,
  messageCount,
}) {
  if (!sessionId || !userId || !question) return;

  setImmediate(() => {
    generateConversationSummary({ previousSummary, question, answer })
      .then((summary) =>
        saveSessionSummary({
          sessionId,
          userId,
          summary,
          messageCount,
        })
      )
      .then((wrote) => {
        if (wrote) {
          console.log(
            `[chat-summary] updated session ${sessionId} at count ${messageCount}`
          );
        }
      })
      .catch((err) => {
        console.warn("[chat-summary]", err?.message || err);
      });
  });
}
