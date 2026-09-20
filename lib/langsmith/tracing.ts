import { RunTree } from "langsmith/run_trees";
import type { PendingRunCommand } from "@/lib/workflow-runtime/buffer";
import type { FlowRunRow } from "@/lib/workflow-dsl/tables";

export type LangSmithRunConfig = {
  runName: string;
  tags: string[];
  metadata: Record<string, string | number>;
};

function flagOn(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function compactMeta(
  raw: Record<string, string | number | undefined>
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

/**
 * 入参：任意 env 快照（单测注入，运行时传 process.env）。
 * 出参：是否应把 LangChain 回调打到 LangSmith。
 * 只认字面量 "true"（大小写不敏感），避免 "1"/对象被当成开启。
 */
export function isLangSmithTracingEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return flagOn(env.LANGSMITH_TRACING) || flagOn(env.LANGCHAIN_TRACING_V2);
}

/**
 * 入参：flow_runs 行 + 本轮 start/resume/retry + userId。
 * 出参：挂到 streamEvents 上的 runName/tags/metadata，用来把 LangSmith 树和 Runs 页对上。
 * retry 才写 checkpoint_id，避免 start/resume 带上空字段污染过滤。
 */
export function workflowLangSmithConfig(input: {
  run: Pick<
    FlowRunRow,
    "id" | "flow_id" | "flow_version" | "thread_id"
  >;
  command: PendingRunCommand;
  userId: string;
}): LangSmithRunConfig {
  const { run, command, userId } = input;
  return {
    runName: `workflow:${command.kind}`,
    tags: ["workflow-engine", command.kind],
    metadata: compactMeta({
      surface: "workflow-engine",
      flow_run_id: run.id,
      flow_id: run.flow_id,
      flow_version: run.flow_version,
      thread_id: run.thread_id,
      command: command.kind,
      user_id: userId,
      checkpoint_id:
        command.kind === "retry" ? command.checkpointId : undefined,
    }),
  };
}

/**
 * 入参：试跑对话的 agent / thread / 模型。
 * 出参：Chat SSE 那次 createReactAgent.streamEvents 的 LangSmith 标注。
 */
export function chatLangSmithConfig(input: {
  agentId: string;
  threadId: string;
  modelName?: string | null;
}): LangSmithRunConfig {
  return {
    runName: "agent-chat",
    tags: ["agent-chat"],
    metadata: compactMeta({
      surface: "agent-chat",
      agent_id: input.agentId,
      thread_id: input.threadId,
      model_name: input.modelName ?? undefined,
    }),
  };
}

/**
 * after() / SSE 结束时把共享 Client 上未发出的 batch 刷完。
 * 必须用 RunTree.getSharedClient()：LangChain 自动 tracing 写的是这个单例，new Client() 刷不到。
 */
export async function flushLangSmithTraces(): Promise<void> {
  if (!isLangSmithTracingEnabled()) return;
  try {
    await RunTree.getSharedClient().awaitPendingTraceBatches();
  } catch {
    // 上报失败不能回滚已经跑完的图或掐掉 SSE
  }
}
