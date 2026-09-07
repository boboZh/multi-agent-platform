import {
  isAIMessage,
  isHumanMessage,
  isToolMessage,
  SystemMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createChatModel } from "@/lib/agent-runtime/llm";

function contentToText(message: BaseMessage) {
  const { content } = message;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("")
    .trim();
}

function clip(text: string, max = 800) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function lastWindow(messages: BaseMessage[], keepRounds: number) {
  const keep = Math.max(0, Math.floor(keepRounds));
  const humanIdx: number[] = [];
  messages.forEach((message, index) => {
    if (isHumanMessage(message)) humanIdx.push(index);
  });

  if (keep === 0 || humanIdx.length <= keep) {
    return { older: [] as BaseMessage[], kept: messages };
  }

  let start = humanIdx[humanIdx.length - keep];
  while (start > 0 && isToolMessage(messages[start])) start -= 1;

  return {
    older: messages.slice(0, start),
    kept: messages.slice(start),
  };
}

function formatForSummary(message: BaseMessage) {
  const type = message._getType();
  if (type === "human") {
    const text = contentToText(message);
    return text ? `用户: ${text}` : null;
  }
  if (type === "ai") {
    const text = contentToText(message);
    const toolCalls = isAIMessage(message) ? message.tool_calls : undefined;
    const toolNames = (toolCalls ?? [])
      .map((call) => call.name)
      .filter(Boolean);
    const extra = toolNames.length
      ? `（调用工具: ${toolNames.join(", ")}）`
      : "";
    const body = [text, extra].filter(Boolean).join(" ");
    return body ? `助手: ${body}` : null;
  }
  if (type === "tool") {
    const text = contentToText(message);
    return text ? `工具结果: ${clip(text)}` : null;
  }
  return null;
}

export async function summarizeMessages(older: BaseMessage[]) {
  const transcript = older
    .map(formatForSummary)
    .filter((line): line is string => Boolean(line))
    .join("\n");

  if (!transcript.trim()) return "";

  const summarizer = createChatModel("deepseek-chat", 0.2, {
    streaming: false,
  });
  const response = await summarizer.invoke([
    new SystemMessage(
      "你是对话摘要助手。请把给定的较早对话压缩成简洁中文摘要，保留用户目标、已确认事实、关键结论、未完成事项。不要编造，不要复述全部原文。控制在 300 字以内，可用短列表。",
    ),
    new HumanMessage(`请摘要以下较早对话：\n\n${clip(transcript, 8000)}`),
  ]);

  return contentToText(response);
}
