import {
  FLOW_RUN_STATUSES,
  type FlowRunStatus,
} from "@/lib/workflow-dsl/tables";

/** 列表四个主筛选项。cancelled 入库但不进这里。 */
export const LIST_STATUS_FILTERS = [
  "running",
  "completed",
  "failed",
  "interrupted",
] as const;
export type ListStatusFilter = (typeof LIST_STATUS_FILTERS)[number];

export const LIST_STATUS_LABELS: Record<ListStatusFilter, string> = {
  running: "运行中",
  completed: "成功",
  failed: "失败",
  interrupted: "挂起",
};

/**
 * UI 四态 → 库 status 数组。running 把尚未被 SSE 拉起的 pending 算进去。
 */
export function mapListStatus(filter: ListStatusFilter): FlowRunStatus[] {
  if (filter === "running") return ["pending", "running"];
  return [filter];
}

export function isListStatusFilter(value: string | null): value is ListStatusFilter {
  return LIST_STATUS_FILTERS.includes(value as ListStatusFilter);
}

export function runStatusLabel(status: string | null | undefined) {
  if (status === "pending") return LIST_STATUS_LABELS.running;
  if (status === "running") return LIST_STATUS_LABELS.running;
  if (status === "completed") return LIST_STATUS_LABELS.completed;
  if (status === "failed") return LIST_STATUS_LABELS.failed;
  if (status === "interrupted") return LIST_STATUS_LABELS.interrupted;
  if (status === "cancelled") return "已取消";
  return "未知";
}

export function isFlowRunStatus(value: string | null | undefined): value is FlowRunStatus {
  return FLOW_RUN_STATUSES.includes(value as FlowRunStatus);
}
