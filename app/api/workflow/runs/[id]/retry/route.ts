import { jsonError, issue, mockUserId } from "@/lib/workflow-runtime/http";
import { loadRunWithDsl } from "@/lib/workflow-runtime/load-run";
import { scheduleWorkflowEngine } from "@/lib/workflow-runtime/engine";
import { patchFlowRun } from "@/lib/workflow-runtime/persist";
import { compileWorkflow } from "@/lib/workflow-dsl/compile";
import { getWorkflowCheckpointer } from "@/lib/workflow-runtime/checkpointer";
import { findRetryCheckpointId } from "@/lib/workflow-runtime/retry";

export const runtime = "nodejs";

/**
 * 节点重试：时间旅行到目标节点执行前，控制面 after() 拉起引擎续跑。
 * 不 new thread_id，否则上游 vars 全丢。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError([issue("请求体不是合法 JSON")], 400);
  }
  const nodeId =
    body && typeof body === "object" && typeof (body as { nodeId?: unknown }).nodeId === "string"
      ? (body as { nodeId: string }).nodeId.trim()
      : "";
  if (!nodeId) return jsonError([issue("缺少 nodeId", ["nodeId"])], 400);

  const userId = mockUserId();
  const loaded = await loadRunWithDsl(id, userId);
  if (!loaded) return jsonError([issue("运行不存在", ["id"])], 404);

  const { run, dsl } = loaded;
  const allowedFailed = run.status === "failed";
  const allowedInterrupt =
    run.status === "interrupted" &&
    run.interrupt_payload?.nodeId === nodeId;
  if (!allowedFailed && !allowedInterrupt) {
    return jsonError([issue("当前状态不允许重试该节点", ["nodeId"], nodeId)], 409);
  }

  const checkpointer = await getWorkflowCheckpointer();
  const compiled = await compileWorkflow(dsl, { checkpointer, userId });
  if (!compiled.ok) {
    return jsonError(compiled.errors, 422);
  }

  const snapshots = [];
  for await (const snap of compiled.app.getStateHistory({
    configurable: { thread_id: run.thread_id },
  })) {
    snapshots.push(snap);
  }
  const checkpointId = findRetryCheckpointId(snapshots, nodeId);
  if (!checkpointId) {
    return jsonError(
      [issue("找不到该节点执行前的 checkpoint，无法时间旅行", ["nodeId"], nodeId)],
      409,
    );
  }

  const next = await patchFlowRun(id, {
    status: "running",
    interrupt_payload: null,
    error: null,
  });
  scheduleWorkflowEngine({
    run: next,
    dsl,
    command: { kind: "retry", checkpointId },
    userId,
  });
  return Response.json({ ok: true, run: next, checkpointId });
}
