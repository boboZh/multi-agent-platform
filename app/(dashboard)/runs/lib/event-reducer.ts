import type {
  FlowRunInterruptPayload,
  FlowRunStatus,
} from "@/lib/workflow-dsl/tables";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

export type ReducedRunEvents = {
  events: WorkflowSseEvent[];
  status: FlowRunStatus | null;
  currentNodeId: string | null;
  interrupt: FlowRunInterruptPayload | null;
  lastError: { message: string; nodeId?: string } | null;
};

/**
 * Last-Event-ID 已见过的帧直接丢，避免重连把同一段 token 再灌进 store 撑爆内存。
 */
export function shouldSkipSseEvent(
  lastEventId: number,
  incomingId: unknown
): boolean {
  if (
    typeof incomingId !== "number" ||
    !Number.isInteger(incomingId) ||
    incomingId < 1
  ) {
    return false;
  }
  if (typeof lastEventId !== "number" || !Number.isFinite(lastEventId)) {
    return false;
  }
  return incomingId <= lastEventId;
}

/**
 * 相邻同节点 token 拼成一条，时间线不要为每个字挂一个 li（否则 600 字就会卡死主线程）。
 */
export function appendTimelineEvent(
  events: WorkflowSseEvent[],
  event: WorkflowSseEvent
): WorkflowSseEvent[] {
  if (!Array.isArray(events)) return [event];
  if (event.type !== "token") return [...events, event];
  const prev = events.at(-1);
  if (
    prev &&
    prev.type === "token" &&
    prev.nodeId === event.nodeId &&
    typeof prev.content === "string" &&
    typeof event.content === "string"
  ) {
    const next = events.slice(0, -1);
    next.push({
      ...prev,
      content: prev.content + event.content,
    });
    return next;
  }
  return [...events, event];
}

/**
 * 把 SSE / 落库事件压成控制台要的派生态。
 * 终态不可回退：一旦出现 interrupted / completed / failed / cancelled（或 interrupt / error 推出来的终态），后面的 run_status、node_start 不能再把 status 改回去。
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
  const openNodes: string[] = []; // 还没 node_end 的节点列表

  for (const event of events) {
    switch (event.type) {
      case "run_status":
        if (
          event.status === "interrupted" ||
          event.status === "completed" ||
          event.status === "failed" ||
          event.status === "cancelled"
        ) {
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
