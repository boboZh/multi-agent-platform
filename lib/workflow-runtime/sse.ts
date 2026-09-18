import type {
  FlowRunInterruptPayload,
  FlowRunStatus,
} from "@/lib/workflow-dsl/tables";

/**
 * 工作流 SSE 事件。独立于 ChatSseEvent：多了节点/状态，避免 chat 协议被工作流字段撑破。
 *
 * nodeId：这一帧对应的画布节点。token/tool/error 从该条 stream 事件的 checkpoint_ns 解析
 * （Agent 内部是 createReactAgent 子图，langgraph_node 会变成 "agent"，不能当画布 id）。
 * currentNodeIds：只挂在 node_start / node_end 上，表示「此刻还在跑」的画布节点。
 * run_status 只报 run 级状态，不携带这个集合——集合没变时再推一次没有信息量。
 * node_start.nodeId：这一帧刚开始的那个节点，给时间线展示用。
 */
export type WorkflowSseEvent =
  | {
      type: "run_status";
      status: FlowRunStatus;
    }
  | { type: "node_start"; nodeId: string; currentNodeIds: string[] }
  | {
      type: "node_end";
      nodeId: string;
      text?: string;
      currentNodeIds: string[];
    }
  | {
      type: "token";
      nodeId?: string;
      content: string;
    }
  | {
      type: "tool_start";
      nodeId?: string;
      name: string;
      input: unknown;
      runId?: string;
    }
  | {
      type: "tool_end";
      nodeId?: string;
      name: string;
      output: unknown;
      runId?: string;
    }
  | { type: "interrupt"; payload: FlowRunInterruptPayload }
  | { type: "error"; message: string; nodeId?: string }
  | { type: "done" };

export type BufferedSseEvent = {
  id: number;
  event: WorkflowSseEvent;
};

/** SSE 帧带 id，浏览器 EventSource 重连时会自动带 Last-Event-ID。 */
export function encodeWorkflowSse(buffered: BufferedSseEvent) {
  return `id: ${buffered.id}\ndata: ${JSON.stringify(buffered.event)}\n\n`;
}

export function parseLastEventId(header: string | null): number {
  if (!header) return 0;
  const n = Number.parseInt(header, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isWorkflowSseEvent(value: unknown): value is WorkflowSseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "run_status" ||
    type === "node_start" ||
    type === "node_end" ||
    type === "token" ||
    type === "tool_start" ||
    type === "tool_end" ||
    type === "interrupt" ||
    type === "error" ||
    type === "done"
  );
}

export const PERSISTED_SSE_TYPES = new Set([
  "run_status",
  "node_start",
  "node_end",
  "tool_start",
  "tool_end",
  "interrupt",
  "error",
]);
