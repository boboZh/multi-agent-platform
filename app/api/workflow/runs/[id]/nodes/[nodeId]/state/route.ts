import { jsonError, issue, mockUserId } from "@/lib/workflow-runtime/http";
import { loadRunWithDsl } from "@/lib/workflow-runtime/load-run";
import { compileWorkflow } from "@/lib/workflow-dsl/compile";
import { getRedisCheckpointer } from "@/lib/redis";
import { nodeStateFromHistory } from "@/lib/workflow-runtime/node-state";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id, nodeId } = await context.params;
  const userId = mockUserId();
  const loaded = await loadRunWithDsl(id, userId);
  if (!loaded) return jsonError([issue("运行不存在", ["id"])], 404);

  const exists = loaded.dsl.nodes.some((node) => node.id === nodeId);
  if (!exists) {
    return Response.json({ ok: true, nodeId, state: null });
  }

  const checkpointer = await getRedisCheckpointer();
  const compiled = await compileWorkflow(loaded.dsl, { checkpointer, userId });
  if (!compiled.ok) {
    return jsonError(compiled.errors, 422);
  }

  const snapshots = [];
  for await (const snap of compiled.app.getStateHistory({
    configurable: { thread_id: loaded.run.thread_id },
  })) {
    snapshots.push(snap);
  }

  const state = nodeStateFromHistory(snapshots, nodeId);
  return Response.json({ ok: true, nodeId, state });
}
