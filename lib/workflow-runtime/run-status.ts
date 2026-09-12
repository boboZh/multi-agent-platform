import type { FlowRunStatus } from "@/lib/workflow-dsl/tables";

/** 终态不再需要 SSE 订阅；interrupted 也算终态，resume 会另开一轮引擎。 */
export function isTerminalStatus(status: FlowRunStatus) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
