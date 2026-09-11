import { createSupabaseAdmin } from "@/lib/supabase-admin";
import { jsonError, issue, mockUserId } from "@/lib/workflow-runtime/http";
import { setPendingCommand } from "@/lib/workflow-runtime/buffer";
import { FLOW_RUN_SELECT_COLUMNS, type FlowRunRow } from "@/lib/workflow-dsl/tables";
import type { FlowRow } from "@/lib/workflow-dsl/tables";

export const runtime = "nodejs";

/**
 * 启动一次运行：校验已发布版本 → 插入 pending → 把 start 命令放进 Redis。
 * 立刻返回 run，真正 invoke 交给详情页 GET .../events，避免「运行」按钮卡住整段 LLM。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError([issue("请求体不是合法 JSON")], 400);
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const flowId = typeof record.flowId === "string" ? record.flowId.trim() : "";
  if (!flowId) {
    return jsonError([issue("缺少 flowId", ["flowId"])], 400);
  }

  const input =
    record.input && typeof record.input === "object" && !Array.isArray(record.input)
      ? (record.input as { messages?: unknown[]; vars?: Record<string, unknown> })
      : {};

  const userId = mockUserId();
  const supabase = createSupabaseAdmin();
  const { data: flow, error: flowErr } = await supabase
    .from("flows")
    .select("id,user_id,name,status,version")
    .eq("id", flowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (flowErr) return jsonError([issue(flowErr.message)], 500);
  if (!flow) return jsonError([issue("工作流不存在", ["flowId"])], 404);

  const flowRow = flow as Pick<FlowRow, "id" | "status" | "version">;
  if (flowRow.status !== "published" || flowRow.version < 1) {
    return jsonError([issue("请先发布工作流再运行", ["flowId"])], 422);
  }

  const { data: version, error: versionErr } = await supabase
    .from("flow_versions")
    .select("version")
    .eq("flow_id", flowId)
    .eq("version", flowRow.version)
    .maybeSingle();
  if (versionErr) return jsonError([issue(versionErr.message)], 500);
  if (!version) {
    return jsonError([issue("找不到已发布版本，请重新发布", ["flowId"])], 422);
  }

  const threadId = crypto.randomUUID();
  const { data: inserted, error: insertErr } = await supabase
    .from("flow_runs")
    .insert({
      flow_id: flowId,
      flow_version: flowRow.version,
      user_id: userId,
      thread_id: threadId,
      status: "pending",
      input: {
        messages: input.messages ?? [],
        vars: input.vars ?? {},
      },
    })
    .select(FLOW_RUN_SELECT_COLUMNS)
    .single();
  if (insertErr || !inserted) {
    return jsonError([issue(insertErr?.message ?? "创建运行失败")], 500);
  }

  const run = inserted as FlowRunRow;
  await setPendingCommand(run.id, {
    kind: "start",
    input: {
      messages: input.messages ?? [],
      vars: input.vars ?? {},
    },
  });

  return Response.json({ ok: true, run });
}
