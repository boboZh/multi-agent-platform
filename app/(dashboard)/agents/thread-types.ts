import type { AgentDraft } from "./agent-trial-editor";
import { MODEL_VALUES } from "./types";
import { clamp, isModelValue } from "./utils";

/**
 * 试运行气泡。`tools` 按 SSE 的 runId 增量更新：同一轮回复里可能多次 tool_start/tool_end，
 * 不能把工具调用塞进 content，否则流式拼 token 时会把 JSON 和自然语言搅在一起。
 */
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

/** `/api/chat/threads` 列表项：只带快照配置，消息正文按需再拉 history，避免列表接口一次灌入全部对话。 */
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

/**
 * 侧栏会话。
 * `config` 是该 thread 创建时冻结的 AgentDraft，后续改左侧草稿不应污染历史对话。
 * `persisted=false` 表示尚未发过消息、服务端没有记录；刷新列表时要保住这条本地草稿，不能被远程列表覆盖掉。
 */
export type ConversationThread = {
  threadId: string;
  title: string;
  createdAt: string;
  config: AgentDraft;
  messages: PlaygroundMessage[];
  persisted: boolean;
};

/**
 * 用当前已保存（或即将使用）的配置开一条空会话。
 *
 * 入参：`config` — 会被浅拷贝；`selectedToolIds` 必须再摊一份数组，避免多条 thread 共享同一引用、勾选工具时互相改写。
 * 出参：本地 thread，`persisted=false`。
 */
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

/**
 * 把列表接口的 snake_case 快照转成编辑器同构的 AgentDraft。
 *
 * 入参：服务端列表项（字段可空、模型名可能已下线）。
 * 出参：`messages` 先留空，点选后再拉 history，避免切会话前就渲染过期正文。
 * 步骤：补默认名 → 模型白名单回落 → temperature clamp → toolIds 默认 []。
 */
export function threadFromStored(
  item: StoredThreadListItem,
): ConversationThread {
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
