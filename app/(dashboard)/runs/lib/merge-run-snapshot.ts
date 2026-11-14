import type { FlowRunRow } from "@/lib/workflow-dsl/tables";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";
import { isTerminalStatus } from "@/lib/workflow-runtime/run-status";
import { reduceRunEvents } from "@/app/(dashboard)/runs/lib/event-reducer";

/**
 * 入参：HTTP 运行快照、并行连接中已收到的 SSE 时间线。出参：合并后的运行行。
 * 实时终态优先于较旧的 HTTP 快照；快照终态也不能被回放中的 running 撤回。
 * 只补元数据和运行状态，不用粗事件的 seq 覆盖 SSE 游标，否则较早的正文 token 会被丢弃。
 */
export function mergeRunSnapshot(
  snapshot: FlowRunRow,
  events: WorkflowSseEvent[],
): FlowRunRow {
  const live = reduceRunEvents(events);
  const status = live.status && isTerminalStatus(live.status)
    ? live.status
    : isTerminalStatus(snapshot.status)
      ? snapshot.status
      : live.status ?? snapshot.status;
  return {
    ...snapshot,
    status,
    error: live.lastError?.message ?? snapshot.error,
    interrupt_payload: live.interrupt ?? snapshot.interrupt_payload,
  };
}
