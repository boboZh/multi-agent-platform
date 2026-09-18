import type { FlowRunStatus } from "@/lib/workflow-dsl/tables";
import type { ReducedRunEvents } from "@/app/(dashboard)/runs/lib/event-reducer";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

export type RunHighlight = {
  currentNodeIds: ReadonlySet<string>;
  doneNodeIds: ReadonlySet<string>;
  failedNodeId: string | null;
  interruptedNodeId: string | null;
};

const EMPTY: RunHighlight = {
  currentNodeIds: new Set(),
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

function asIdSet(ids: string[] | undefined): Set<string> {
  return new Set((ids ?? []).filter((id) => typeof id === "string" && id.length > 0));
}

/**
 * 画布高亮只看 status + 已压过的事件，禁止组件里再手写一套。
 * 正在跑的节点只认 currentNodeIds：串行 size=1、并行 size=N，id 命中即脉冲。
 */
export function deriveHighlight(
  status: FlowRunStatus | null | undefined,
  reduced: ReducedRunEvents
): RunHighlight {
  const doneNodeIds = doneFromEvents(reduced.events);
  if (!status) return { ...EMPTY, doneNodeIds };

  if (status === "interrupted") {
    return {
      currentNodeIds: new Set(),
      doneNodeIds,
      failedNodeId: null,
      interruptedNodeId: reduced.interrupt?.nodeId ?? null,
    };
  }

  if (status === "failed") {
    const open = reduced.currentNodeIds;
    const failedNodeId =
      reduced.lastError?.nodeId ||
      reduced.failedNodeId ||
      (open.length === 1 ? open[0]! : null) ||
      null;
    return {
      currentNodeIds: new Set(),
      doneNodeIds,
      failedNodeId,
      interruptedNodeId: null,
    };
  }

  if (status === "running" || status === "pending") {
    return {
      currentNodeIds: asIdSet(reduced.currentNodeIds),
      doneNodeIds,
      failedNodeId: null,
      interruptedNodeId: null,
    };
  }

  return {
    currentNodeIds: new Set(),
    doneNodeIds,
    failedNodeId: null,
    interruptedNodeId: null,
  };
}
