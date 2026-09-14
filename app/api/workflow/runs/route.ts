import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { jsonError, issue, mockUserId } from "@/lib/workflow-runtime/http";
import {
  FLOW_RUN_SELECT_COLUMNS,
  FLOW_RUN_STATUSES,
  type FlowRunRow,
  type FlowRunStatus,
} from "@/lib/workflow-dsl/tables";
import {
  clampPage,
  paginationMeta,
  parseRunListPagination,
  toInclusiveRange,
} from "@/app/(dashboard)/runs/lib/pagination";

export const runtime = "nodejs";

const LIST_STATUSES = ["running", "completed", "failed", "interrupted"] as const;
type ListStatus = (typeof LIST_STATUSES)[number];

function parseListStatus(value: string | null): ListStatus | null {
  if (!value) return null;
  return LIST_STATUSES.includes(value as ListStatus)
    ? (value as ListStatus)
    : null;
}

function dbStatuses(filter: ListStatus): FlowRunStatus[] {
  if (filter === "running") return ["pending", "running"];
  return [filter];
}

/**
 * 运行列表。status=running 把 pending 算进去，cancelled 不出现在四个主筛选项里。
 * exact count + inclusive range 做服务端分页；页码越界时夹回最后一页再查，避免空窗。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusParam = parseListStatus(url.searchParams.get("status"));
  if (url.searchParams.get("status") && !statusParam) {
    return jsonError([issue("非法 status", ["status"])], 400);
  }
  const flowId = url.searchParams.get("flowId")?.trim() || "";
  const parsed = parseRunListPagination({
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("pageSize"),
  });

  const userId = mockUserId();
  const supabase = createSupabaseAdmin();

  async function fetchPage(page: number) {
    const { from, to } = toInclusiveRange(page, parsed.pageSize);
    let query = supabase
      .from("flow_runs")
      .select(FLOW_RUN_SELECT_COLUMNS, { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);
    if (statusParam) {
      query = query.in("status", dbStatuses(statusParam));
    }
    if (flowId) {
      query = query.eq("flow_id", flowId);
    }
    return query;
  }

  const first = await fetchPage(parsed.page);
  if (first.error) return jsonError([issue(first.error.message)], 500);

  const total = first.count ?? 0;
  const page = clampPage(parsed.page, total, parsed.pageSize);
  let runs = (first.data ?? []) as FlowRunRow[];

  if (page !== parsed.page) {
    const second = await fetchPage(page);
    if (second.error) return jsonError([issue(second.error.message)], 500);
    runs = (second.data ?? []) as FlowRunRow[];
  }

  const flowIds = [...new Set(runs.map((row) => row.flow_id))];
  const names = new Map<string, string>();
  if (flowIds.length > 0) {
    const { data: flows } = await supabase
      .from("flows")
      .select("id,name")
      .in("id", flowIds);
    for (const flow of (flows ?? []) as Array<{ id: string; name: string }>) {
      names.set(flow.id, flow.name);
    }
  }

  const meta = paginationMeta(page, parsed.pageSize, total);
  return Response.json({
    ok: true,
    items: runs.map((run) => ({
      ...run,
      flowName: names.get(run.flow_id) ?? "未命名工作流",
    })),
    ...meta,
  });
}

export { FLOW_RUN_STATUSES };
