import type { FlowRunStatus } from "@/lib/workflow-dsl/tables";
import type { ReducedRunEvents } from "@/app/(dashboard)/runs/lib/event-reducer";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

export type RunHighlight = {
  currentNodeId: string | null;
  doneNodeIds: ReadonlySet<string>;
  failedNodeId: string | null;
  interruptedNodeId: string | null;
};

const EMPTY: RunHighlight = {
  currentNodeId: null,
  doneNodeIds: new Set(),
  failedNodeId: null,
  interruptedNodeId: null,
};

function doneFromEvents(events: WorkflowSseEvent[]) {
  const done = new Set<string>();
  for (const event of events) {
    if (event.type === "node_end") done.add(event.nodeId);
  }
  return done;
}

/**
 * 画布高亮只看 status + 已压过的事件，禁止组件里再手写一套。
 */
export function deriveHighlight(
  status: FlowRunStatus | null | undefined,
  reduced: ReducedRunEvents,
): RunHighlight {
  const doneNodeIds = doneFromEvents(reduced.events);
  if (!status) return { ...EMPTY, doneNodeIds };

  if (status === "interrupted") {
    const interruptedNodeId =
      reduced.interrupt?.nodeId ?? reduced.currentNodeId ?? null;
    return {
      currentNodeId: null,
      doneNodeIds,
      failedNodeId: null,
      interruptedNodeId,
    };
  }

  if (status === "failed") {
    return {
      currentNodeId: null,
      doneNodeIds,
      failedNodeId: reduced.lastError?.nodeId ?? reduced.currentNodeId ?? null,
      interruptedNodeId: null,
    };
  }

  if (status === "running" || status === "pending") {
    return {
      currentNodeId: reduced.currentNodeId,
      doneNodeIds,
      failedNodeId: null,
      interruptedNodeId: null,
    };
  }

  return {
    currentNodeId: null,
    doneNodeIds,
    failedNodeId: null,
    interruptedNodeId: null,
  };
}
