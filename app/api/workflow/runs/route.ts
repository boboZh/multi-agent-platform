import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { jsonError, issue, mockUserId } from "@/lib/workflow-runtime/http";
import {
  FLOW_RUN_SELECT_COLUMNS,
  FLOW_RUN_STATUSES,
  type FlowRunRow,
  type FlowRunStatus,
} from "@/lib/workflow-dsl/tables";

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
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const statusParam = parseListStatus(url.searchParams.get("status"));
  if (url.searchParams.get("status") && !statusParam) {
    return jsonError([issue("非法 status", ["status"])], 400);
  }
  const flowId = url.searchParams.get("flowId")?.trim() || "";
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

  const userId = mockUserId();
  const supabase = createSupabaseAdmin();
  let query = supabase
    .from("flow_runs")
    .select(FLOW_RUN_SELECT_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (statusParam) {
    query = query.in("status", dbStatuses(statusParam));
  }
  if (flowId) {
    query = query.eq("flow_id", flowId);
  }

  const { data, error } = await query;
  if (error) return jsonError([issue(error.message)], 500);
  const runs = (data ?? []) as FlowRunRow[];
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

  return Response.json({
    ok: true,
    items: runs.map((run) => ({
      ...run,
      flowName: names.get(run.flow_id) ?? "未命名工作流",
    })),
  });
}

export { FLOW_RUN_STATUSES };
