import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { getRedisCheckpointer } from "@/lib/redis";

export type CheckpointChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: Array<{
    runId: string;
    name: string;
    status: "done";
    input?: unknown;
    output?: unknown;
  }>;
};

function contentToText(message: BaseMessage) {
  const { content } = message;
  if (typeof content === "string") return content;
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
    .join("");
}

function messageId(message: BaseMessage, fallback: string) {
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : fallback;
}

export function checkpointMessagesToChat(
  messages: BaseMessage[],
): CheckpointChatMessage[] {
  const chat: CheckpointChatMessage[] = [];

  function lastAssistant() {
    const last = chat.at(-1);
    return last?.role === "assistant" ? last : null;
  }

  function appendAssistant(index: number, message: BaseMessage) {
    const content = contentToText(message);
    const tools =
      message._getType() === "ai"
        ? ((message as AIMessage).tool_calls ?? []).map((call) => ({
            runId: call.id || crypto.randomUUID(),
            name: call.name,
            status: "done" as const,
            input: call.args,
          }))
        : [];
    const existing = lastAssistant();
    if (existing) {
      existing.content = [existing.content, content]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
      existing.tools.push(...tools);
      return;
    }
    chat.push({
      id: messageId(message, `ai-${index}`),
      role: "assistant",
      content,
      tools,
    });
  }

  for (const [index, message] of messages.entries()) {
    const type = message._getType();
    if (type === "human") {
      chat.push({
        id: messageId(message, `human-${index}`),
        role: "user",
        content: contentToText(message),
        tools: [],
      });
      continue;
    }

    if (type === "ai") {
      appendAssistant(index, message);
      continue;
    }

    if (type === "tool") {
      const last = lastAssistant();
      if (!last) continue;
      const toolMessage = message as ToolMessage;
      const runId = toolMessage.tool_call_id || `tool-${index}`;
      const existing = last.tools.find((tool) => tool.runId === runId);
      const output = contentToText(toolMessage) || toolMessage.content;
      if (existing) {
        existing.output = output;
        existing.status = "done";
      } else {
        last.tools.push({
          runId,
          name: toolMessage.name || "tool",
          status: "done",
          output,
        });
      }
    }
  }

  return chat.filter(
    (item) => item.content.trim().length > 0 || item.tools.length > 0,
  );
}

function coerceMessage(item: unknown): BaseMessage | null {
  if (item && typeof item === "object" && typeof (item as BaseMessage)._getType === "function") {
    return item as BaseMessage;
  }
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const type = String(rec.type ?? rec.role ?? "");
  const content =
    typeof rec.content === "string"
      ? rec.content
      : rec.content == null
        ? ""
        : JSON.stringify(rec.content);
  const id = typeof rec.id === "string" ? rec.id : undefined;
  if (type === "human" || type === "user") {
    return new HumanMessage({ content, id });
  }
  if (type === "ai" || type === "assistant") {
    return new AIMessage({
      content,
      id,
      tool_calls: Array.isArray(rec.tool_calls)
        ? (rec.tool_calls as AIMessage["tool_calls"])
        : undefined,
    });
  }
  if (type === "tool") {
    return new ToolMessage({
      content,
      id,
      tool_call_id: String(rec.tool_call_id ?? ""),
      name: typeof rec.name === "string" ? rec.name : undefined,
    });
  }
  return null;
}

export async function loadCheckpointMessages(threadId: string) {
  const checkpointer = await getRedisCheckpointer();
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId },
  });
  const raw = tuple?.checkpoint?.channel_values?.messages;
  if (!Array.isArray(raw)) return [];
  const messages = raw
    .map(coerceMessage)
    .filter((message): message is BaseMessage => message != null);
  return checkpointMessagesToChat(messages);
}
