import type { FlowRunInterruptPayload, FlowRunStatus } from "@/lib/workflow-dsl/tables";

/**
 * 工作流 SSE 事件。独立于 ChatSseEvent：多了节点/状态，避免 chat 协议被工作流字段撑破。
 */
export type WorkflowSseEvent =
  | { type: "run_status"; status: FlowRunStatus; currentNodeId?: string }
  | { type: "node_start"; nodeId: string }
  | { type: "node_end"; nodeId: string; text?: string }
  | { type: "token"; nodeId?: string; content: string }
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
