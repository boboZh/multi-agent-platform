import { jsonError, issue, mockUserId } from "@/lib/workflow-runtime/http";
import { loadRunWithDsl } from "@/lib/workflow-runtime/load-run";
import { setPendingCommand } from "@/lib/workflow-runtime/buffer";
import { patchFlowRun } from "@/lib/workflow-runtime/persist";
import { parseResumePayload } from "@/app/(dashboard)/runs/lib/resume-payload";
import type { ReviewFormField } from "@/lib/workflow-dsl/schema";

export const runtime = "nodejs";

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
  const resume =
    body && typeof body === "object" && "resume" in body
      ? (body as { resume: unknown }).resume
      : undefined;

  const userId = mockUserId();
  const loaded = await loadRunWithDsl(id, userId);
  if (!loaded) return jsonError([issue("运行不存在", ["id"])], 404);
  if (loaded.run.status !== "interrupted") {
    return jsonError([issue("当前运行未挂起，不能 resume", ["status"])], 409);
  }

  const form = loaded.run.interrupt_payload?.form;
  const fields = Array.isArray(form) ? (form as ReviewFormField[]) : [];
  const parsed = parseResumePayload(fields, resume);
  if (!parsed.ok) {
    return jsonError(parsed.errors, 422);
  }

  await setPendingCommand(id, { kind: "resume", resume: parsed.resume });
  const run = await patchFlowRun(id, {
    status: "running",
    interrupt_payload: null,
    error: null,
  });
  return Response.json({ ok: true, run });
}
