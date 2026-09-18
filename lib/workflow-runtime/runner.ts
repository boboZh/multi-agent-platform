import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command, isGraphInterrupt } from "@langchain/langgraph";
import {
  compileWorkflow,
  type CompiledWorkflowApp,
} from "@/lib/workflow-dsl/compile";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";
import type { FlowRunRow } from "@/lib/workflow-dsl/tables";
import { mapStreamEvent } from "@/lib/agent-runtime/sse";
import { getWorkflowCheckpointer } from "@/lib/workflow-runtime/checkpointer";
import {
  appendSseBuffer,
  shouldPersistEvent,
  type PendingRunCommand,
} from "@/lib/workflow-runtime/buffer";
import {
  interruptPayloadFromError,
  interruptPayloadFromState,
} from "@/lib/workflow-runtime/interrupt";
import {
  insertPersistedEvent,
  patchFlowRun,
} from "@/lib/workflow-runtime/persist";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";
import { openEngineEventLog } from "@/lib/workflow-runtime/engine-event-log";
import {
  isDslNodeName,
  nodeIdFromStreamMetadata,
  pickFailedTaskName,
} from "@/lib/workflow-runtime/stream-attribution";
import type { RetrySnapshot } from "@/lib/workflow-runtime/retry";

export { isTerminalStatus } from "@/lib/workflow-runtime/run-status";

export type RunEmitter = (event: WorkflowSseEvent) => Promise<void>;

export async function emitAndPersist(
  runId: string,
  event: WorkflowSseEvent,
  onEvent?: RunEmitter
) {
  const buffered = await appendSseBuffer(runId, event);
  if (shouldPersistEvent(event)) {
    try {
      await insertPersistedEvent(runId, buffered.id, event);
    } catch {
      // 时间线丢一条粗事件不应把正在跑的图杀掉
    }
  }
  await onEvent?.(event);
  return buffered;
}

function toMessages(raw: unknown): BaseMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: BaseMessage[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as BaseMessage)._getType === "function"
    ) {
      out.push(item as BaseMessage);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const content =
      typeof rec.content === "string"
        ? rec.content
        : rec.content == null
          ? ""
          : JSON.stringify(rec.content);
    const role = String(rec.role ?? rec.type ?? "user");
    if (role === "assistant" || role === "ai") {
      out.push(new AIMessage(content));
    } else if (content.trim()) {
      out.push(new HumanMessage(content));
    }
  }
  return out;
}

function graphInputFromStart(input: {
  messages?: unknown[];
  vars?: Record<string, unknown>;
}) {
  return {
    messages: toMessages(input.messages),
    vars: input.vars ?? {},
    lastAgentText: "",
  };
}

function snapshotCurrentNodeIds(open: Set<string>): string[] {
  return [...open];
}

function textFromChainOutput(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const rec = output as Record<string, unknown>;
  if (typeof rec.lastAgentText === "string" && rec.lastAgentText.trim()) {
    return rec.lastAgentText;
  }
  return undefined;
}

async function compilePublished(
  dsl: unknown,
  userId: string
): Promise<CompiledWorkflowApp> {
  const checkpointer = await getWorkflowCheckpointer();
  const compiled = await compileWorkflow(dsl, { checkpointer, userId });
  if (!compiled.ok) {
    throw new Error(compiled.errors[0]?.message ?? "工作流编译失败");
  }
  return compiled.app;
}

/**
 * 真正跑图（只允许控制面 after() 调用，SSE 路由禁止进来）。
 * 入参：flow_runs 行 + 发布快照 DSL + 待执行命令。
 * 步骤：compile（Postgres checkpointer）→ streamEvents → 写状态/interrupt → Redis 只做 SSE Pub/Sub。
 * 同一 thread_id 上 resume/retry，不另开 checkpoint 会话。
 */
export async function executeWorkflowRun(options: {
  run: FlowRunRow;
  dsl: WorkflowDocument;
  command: PendingRunCommand;
  userId: string;
  onEvent?: RunEmitter;
}): Promise<FlowRunRow> {
  const { run, dsl, command, userId, onEvent } = options;
  const nodeIds = new Set(dsl.nodes.map((node) => node.id));
  const emit = (event: WorkflowSseEvent) =>
    emitAndPersist(run.id, event, onEvent);

  const currentNodeIds = new Set<string>();
  let lastFailedNodeId: string | undefined;
  await patchFlowRun(run.id, {
    status: "running",
    error: null,
    interrupt_payload: null,
  });
  await emit({
    type: "run_status",
    status: "running",
  });

  try {
    const app = await compilePublished(dsl, userId);
    const configurable: Record<string, string> = { thread_id: run.thread_id };
    if (command.kind === "retry") {
      configurable.checkpoint_id = command.checkpointId;
    }

    let graphInput: Parameters<CompiledWorkflowApp["streamEvents"]>[0];
    if (command.kind === "start") {
      graphInput = graphInputFromStart(command.input);
    } else if (command.kind === "resume") {
      graphInput = new Command({ resume: command.resume });
    } else {
      graphInput = null;
    }

    const eventStream = await app.streamEvents(graphInput, {
      version: "v2",
      configurable,
    });

    // 每次 execute 单独 dump 一份 streamEvents，resume/retry 不覆盖上一轮，方便对照并行分支。
    const eventLog = await openEngineEventLog({
      runId: run.id,
      threadId: run.thread_id,
      commandKind: command.kind,
    });
    let eventIndex = 0;
    try {
      for await (const raw of eventStream) {
        await eventLog?.write(eventIndex, raw);
        eventIndex += 1;
        const name = typeof raw.name === "string" ? raw.name : undefined;
        const eventNodeId = nodeIdFromStreamMetadata(raw.metadata, nodeIds);

        if (raw.event === "on_chain_start" && isDslNodeName(name, nodeIds)) {
          currentNodeIds.add(name as string);
          await emit({
        type: "node_start",
        nodeId: name as string,
        currentNodeIds: snapshotCurrentNodeIds(currentNodeIds),
      });
        }
        if (raw.event === "on_chain_end" && isDslNodeName(name, nodeIds)) {
          currentNodeIds.delete(name as string);
          await emit({
            type: "node_end",
            nodeId: name as string,
            text: textFromChainOutput(raw.data?.output),
            currentNodeIds: snapshotCurrentNodeIds(currentNodeIds),
          });
        }
        if (raw.event === "on_chain_error" && isDslNodeName(name, nodeIds)) {
          lastFailedNodeId = name;
        }

        const mapped = mapStreamEvent(raw);
        if (mapped?.type === "token") {
          await emit({
            type: "token",
            nodeId: eventNodeId,
            content: mapped.content,
          });
        } else if (mapped?.type === "tool_start") {
          await emit({
            type: "tool_start",
            nodeId: eventNodeId,
            name: mapped.name,
            input: mapped.input,
            runId: mapped.runId,
          });
        } else if (mapped?.type === "tool_end") {
          await emit({
            type: "tool_end",
            nodeId: eventNodeId,
            name: mapped.name,
            output: mapped.output,
            runId: mapped.runId,
          });
        }
      }
    } finally {
      await eventLog?.close();
    }

    const state = await app.getState({
      configurable: { thread_id: run.thread_id },
    });
    const interrupt = interruptPayloadFromState({
      tasks: state.tasks,
    });
    if (interrupt) {
      const next = await patchFlowRun(run.id, {
        status: "interrupted",
        interrupt_payload: interrupt,
      });
      await emit({ type: "interrupt", payload: interrupt });
      await emit({
        type: "run_status",
        status: "interrupted",
      });
      return next;
    }

    const values = (state.values ?? {}) as {
      vars?: Record<string, unknown>;
      lastAgentText?: string;
    };
    const next = await patchFlowRun(run.id, {
      status: "completed",
      output: {
        vars: values.vars ?? {},
        lastAgentText: values.lastAgentText ?? "",
      },
      interrupt_payload: null,
      error: null,
    });
    await emit({ type: "run_status", status: "completed" });
    await emit({ type: "done" });
    return next;
  } catch (err) {
    if (isGraphInterrupt(err)) {
      const payload = interruptPayloadFromError(err);
      if (payload) {
        const next = await patchFlowRun(run.id, {
          status: "interrupted",
          interrupt_payload: payload,
        });
        await emit({ type: "interrupt", payload });
        await emit({
          type: "run_status",
          status: "interrupted",
        });
        return next;
      }
    }
    const message = err instanceof Error ? err.message : "工作流执行失败";
    const next = await patchFlowRun(run.id, {
      status: "failed",
      error: message,
      interrupt_payload: null,
    });

    let failedNodeId = lastFailedNodeId;
    if (!failedNodeId) {
      try {
        const app = await compilePublished(dsl, userId);
        const snapshots: RetrySnapshot[] = [];
        for await (const snap of app.getStateHistory({
          configurable: { thread_id: run.thread_id },
        })) {
          snapshots.push(snap);
        }
        failedNodeId = pickFailedTaskName(snapshots, currentNodeIds);
      } catch {
        // history 拉失败时仍要发出 error 帧，只是没有节点归属
      }
    }

    await emit({
      type: "error",
      message,
      nodeId: failedNodeId,
    });
    await emit({
      type: "run_status",
      status: "failed",
    });
    await emit({ type: "done" });
    return next;
  }
}
