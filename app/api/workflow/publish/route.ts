import { dryRunCompile } from "@/lib/workflow-dsl/compile";
import { nextPublishedVersion } from "@/lib/workflow-dsl/publish";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";
import { FLOW_SELECT_COLUMNS } from "@/app/(dashboard)/workflows/types";
import type { FlowRecord } from "@/app/(dashboard)/workflows/types";

export const runtime = "nodejs";

/**
 * 发布：先 dry-run 编译，通过才把当前 DSL 钉进 flow_versions，并升 flows.version / status。
 *
 * 入参：`{ flowId, doc }`。必须是已落库的 flow（新建页没有 id，不能发布一堆未保存草稿）。
 * 出参：更新后的 flows 行；编译失败 422 + errors，不写版本表。
 *
 * 之后的 run 只读 flow_versions 快照，避免发布后继续改画布把正在跑的图改掉。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, errors: [{ message: "请求体不是合法 JSON", path: [] }] }, { status: 400 });
  }

  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const flowId = typeof record.flowId === "string" ? record.flowId.trim() : "";
  const doc = record.doc;
  if (!flowId || flowId === "new") {
    return Response.json(
      { ok: false, errors: [{ message: "请先保存工作流再发布", path: ["flowId"] }] },
      { status: 400 },
    );
  }
  if (doc == null) {
    return Response.json(
      { ok: false, errors: [{ message: "缺少 doc", path: ["doc"] }] },
      { status: 400 },
    );
  }

  const userId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
  const compiled = await dryRunCompile(doc, { userId });
  if (!compiled.ok) {
    return Response.json(compiled, { status: 422 });
  }

  const supabase = createSupabaseAdmin();
  const { data: flow, error: flowErr } = await supabase
    .from("flows")
    .select(FLOW_SELECT_COLUMNS)
    .eq("id", flowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (flowErr) {
    return Response.json(
      { ok: false, errors: [{ message: flowErr.message, path: [] }] },
      { status: 500 },
    );
  }
  if (!flow) {
    return Response.json(
      { ok: false, errors: [{ message: "工作流不存在", path: ["flowId"] }] },
      { status: 404 },
    );
  }

  const { data: versionRows, error: versionErr } = await supabase
    .from("flow_versions")
    .select("version")
    .eq("flow_id", flowId);
  if (versionErr) {
    return Response.json(
      { ok: false, errors: [{ message: versionErr.message, path: [] }] },
      { status: 500 },
    );
  }
  const nextVersion = nextPublishedVersion(
    ((versionRows ?? []) as { version: number }[]).map((row) => row.version),
  );

  const document = doc as WorkflowDocument;
  const { error: insertErr } = await supabase.from("flow_versions").insert({
    flow_id: flowId,
    version: nextVersion,
    dsl: document,
  });
  if (insertErr) {
    return Response.json(
      { ok: false, errors: [{ message: insertErr.message, path: [] }] },
      { status: 500 },
    );
  }

  const { data: updated, error: updateErr } = await supabase
    .from("flows")
    .update({
      dsl: document,
      status: "published",
      version: nextVersion,
      name: document.name,
    })
    .eq("id", flowId)
    .eq("user_id", userId)
    .select(FLOW_SELECT_COLUMNS)
    .single();
  if (updateErr) {
    return Response.json(
      { ok: false, errors: [{ message: updateErr.message, path: [] }] },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    version: nextVersion,
    flow: updated as FlowRecord,
  });
}
