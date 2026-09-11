import type { FlowRunInterruptPayload, FlowRunStatus } from "@/lib/workflow-dsl/tables";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

export type ReducedRunEvents = {
  events: WorkflowSseEvent[];
  status: FlowRunStatus | null;
  currentNodeId: string | null;
  interrupt: FlowRunInterruptPayload | null;
  lastError: { message: string; nodeId?: string } | null;
};

/**
 * 把 SSE / 落库事件压成控制台要的派生态。
 * 乱序 tool_end、interrupt 之后还来 token 都要吞掉而不是把 status 改回去。
 */
export function reduceRunEvents(events: WorkflowSseEvent[]): ReducedRunEvents {
  const result: ReducedRunEvents = {
    events: [...events],
    status: null,
    currentNodeId: null,
    interrupt: null,
    lastError: null,
  };

  let terminal: FlowRunStatus | null = null;
  const openNodes: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "run_status":
        if (event.status === "interrupted" || event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
          terminal = event.status;
          result.status = event.status;
        } else if (!terminal) {
          result.status = event.status;
        }
        if (event.currentNodeId && !terminal) {
          result.currentNodeId = event.currentNodeId;
        }
        break;
      case "node_start":
        if (!terminal) {
          result.currentNodeId = event.nodeId;
          openNodes.push(event.nodeId);
        }
        break;
      case "node_end": {
        const idx = openNodes.lastIndexOf(event.nodeId);
        if (idx >= 0) openNodes.splice(idx, 1);
        if (!terminal) {
          result.currentNodeId = openNodes.at(-1) ?? null;
        }
        break;
      }
      case "interrupt":
        terminal = "interrupted";
        result.status = "interrupted";
        result.interrupt = event.payload;
        result.currentNodeId = event.payload.nodeId;
        break;
      case "error":
        result.lastError = { message: event.message, nodeId: event.nodeId };
        if (!terminal) {
          result.status = "failed";
          terminal = "failed";
          result.currentNodeId = event.nodeId ?? result.currentNodeId;
        }
        break;
      case "token":
      case "tool_start":
      case "tool_end":
      case "done":
        break;
      default:
        break;
    }
  }

  return result;
}
