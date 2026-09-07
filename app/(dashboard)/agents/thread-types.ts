import type { AgentDraft } from "./agent-trial-editor";
import { MODEL_VALUES } from "./types";
import { clamp, isModelValue } from "./utils";

export type PlaygroundMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: Array<{
    runId: string;
    name: string;
    status: "running" | "done";
    input?: unknown;
    output?: unknown;
  }>;
};

export type StoredThreadListItem = {
  threadId: string;
  title: string;
  createdAt: string;
  config: {
    name: string;
    system_prompt: string | null;
    model_name: string | null;
    temperature: number | null;
    toolIds: string[];
  };
};

export type ConversationThread = {
  threadId: string;
  title: string;
  createdAt: string;
  config: AgentDraft;
  messages: PlaygroundMessage[];
  persisted: boolean;
};

export function createEmptyThread(config: AgentDraft): ConversationThread {
  return {
    threadId: crypto.randomUUID(),
    title: "新对话",
    createdAt: new Date().toISOString(),
    config: { ...config, selectedToolIds: [...config.selectedToolIds] },
    messages: [],
    persisted: false,
  };
}

export function threadFromStored(item: StoredThreadListItem): ConversationThread {
  return {
    threadId: item.threadId,
    title: item.title || "未命名对话",
    createdAt: item.createdAt,
    config: {
      name: item.config.name || "",
      systemPrompt: item.config.system_prompt || "",
      modelName: isModelValue(item.config.model_name)
        ? item.config.model_name
        : MODEL_VALUES[0],
      temperature: clamp(item.config.temperature ?? 0.7, 0, 1),
      selectedToolIds: item.config.toolIds ?? [],
    },
    messages: [],
    persisted: true,
  };
}
