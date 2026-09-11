import { jsonError, issue, mockUserId } from "@/lib/workflow-runtime/http";
import { loadRunWithDsl } from "@/lib/workflow-runtime/load-run";
import { listPersistedEvents } from "@/lib/workflow-runtime/persist";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const userId = mockUserId();
  try {
    const loaded = await loadRunWithDsl(id, userId);
    if (!loaded) {
      return jsonError([issue("运行不存在", ["id"])], 404);
    }
    const events = await listPersistedEvents(id);
    return Response.json({
      ok: true,
      run: loaded.run,
      dsl: loaded.dsl,
      flowName: loaded.flowName,
      events: events.map((row) => row.event),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取运行失败";
    return jsonError([issue(message)], 500);
  }
}
