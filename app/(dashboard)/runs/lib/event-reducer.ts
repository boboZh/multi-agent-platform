import type {
  FlowRunInterruptPayload,
  FlowRunStatus,
} from "@/lib/workflow-dsl/tables";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

export type ReducedRunEvents = {
  events: WorkflowSseEvent[];
  status: FlowRunStatus | null;
  currentNodeIds: string[];
  interrupt: FlowRunInterruptPayload | null;
  lastError: { message: string; nodeId?: string } | null;
  failedNodeId: string | null;
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

function eventNodeId(event: WorkflowSseEvent): string | undefined {
  if ("nodeId" in event && typeof event.nodeId === "string" && event.nodeId) {
    return event.nodeId;
  }
  return undefined;
}

/**
 * 从后往前找「这一轮还没结束」的同节点 token 桶。
 * 并行时中间会夹着别的节点的 token，所以不能只看 events.at(-1)；
 * 但同一节点在 node_end / 本节点 tool 之后必须开新桶，否则环上第二轮会拼进第一轮，工具行也会被吞进正文。
 */
function findOpenTokenBucketIndex(
  events: WorkflowSseEvent[],
  nodeId: string | undefined
): number {
  if (!nodeId) {
    const prev = events.at(-1);
    if (prev && prev.type === "token" && !eventNodeId(prev)) {
      return events.length - 1;
    }
    return -1;
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const item = events[i]!;
    if (item.type === "node_end" && item.nodeId === nodeId) return -1;
    if (item.type === "node_start" && item.nodeId === nodeId) return -1;
    if (
      (item.type === "tool_start" || item.type === "tool_end") &&
      item.nodeId === nodeId
    ) {
      return -1;
    }
    if (item.type === "token" && item.nodeId === nodeId) return i;
  }
  return -1;
}

/**
 * 按 nodeId 分桶累积 token：并行交错时每路一条；时间线不要为每个字挂一个 li。
 */
export function appendTimelineEvent(
  events: WorkflowSseEvent[],
  event: WorkflowSseEvent
): WorkflowSseEvent[] {
  if (!Array.isArray(events)) return [event];
  if (event.type !== "token") return [...events, event];
  if (typeof event.content !== "string") return [...events, event];

  const idx = findOpenTokenBucketIndex(events, eventNodeId(event));
  if (idx < 0) return [...events, event];

  const prev = events[idx];
  if (!prev || prev.type !== "token" || typeof prev.content !== "string") {
    return [...events, event];
  }

  const next = events.slice();
  next[idx] = { ...prev, content: prev.content + event.content };
  return next;
}

/**
 * 把 SSE / 落库事件压成控制台要的派生态。
 * 终态不可回退：一旦出现 interrupted / completed / failed / cancelled（或 interrupt / error 推出来的终态），后面的 run_status、node_start 不能再把 status 改回去。
 * 正在跑的节点集合只认 node_start / node_end 上的 currentNodeIds。
 */
export function reduceRunEvents(events: WorkflowSseEvent[]): ReducedRunEvents {
  const result: ReducedRunEvents = {
    events: [...events],
    status: null,
    interrupt: null,
    lastError: null,
    currentNodeIds: [],
    failedNodeId: null,
  };

  let terminal: FlowRunStatus | null = null;

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
        break;
      case "node_start":
      case "node_end":
        if (!terminal) {
          result.currentNodeIds = event.currentNodeIds;
        }
        break;
      case "interrupt":
        terminal = "interrupted";
        result.status = "interrupted";
        result.interrupt = event.payload;
        break;
      case "error":
        result.lastError = {
          message: event.message,
          nodeId: event.nodeId || undefined,
        };
        if (!terminal) {
          result.status = "failed";
          terminal = "failed";
          result.failedNodeId =
            event.nodeId ||
            (result.currentNodeIds.length === 1
              ? result.currentNodeIds[0]!
              : null);
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
