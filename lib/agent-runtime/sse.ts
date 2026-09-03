export type ChatSseEvent =
  | { type: "token"; content: string }
  | { type: "tool_start"; name: string; input: unknown; runId?: string }
  | { type: "tool_end"; name: string; output: unknown; runId?: string }
  | { type: "error"; message: string }
  | { type: "done" };

export function encodeSse(event: ChatSseEvent) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function extractStreamText(chunk: unknown): string {
  if (chunk == null) return "";
  if (typeof chunk === "string") return chunk;
  if (typeof chunk !== "object") return "";

  const record = chunk as { content?: unknown };
  const content = record.content;
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

export function mapStreamEvent(event: {
  event?: string;
  name?: string;
  run_id?: string;
  data?: { chunk?: unknown; input?: unknown; output?: unknown };
}): ChatSseEvent | null {
  switch (event.event) {
    case "on_chat_model_stream": {
      const content = extractStreamText(event.data?.chunk);
      if (!content) return null;
      return { type: "token", content };
    }
    case "on_tool_start":
      return {
        type: "tool_start",
        name: event.name || "tool",
        input: event.data?.input ?? null,
        runId: event.run_id,
      };
    case "on_tool_end":
      return {
        type: "tool_end",
        name: event.name || "tool",
        output: event.data?.output ?? null,
        runId: event.run_id,
      };
    default:
      return null;
  }
}
