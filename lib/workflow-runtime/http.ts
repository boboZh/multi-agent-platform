import type { WorkflowIssue } from "@/lib/workflow-dsl/schema";

export function jsonError(errors: WorkflowIssue[], status: number) {
  return Response.json({ ok: false, errors }, { status });
}

export function issue(message: string, path: Array<string | number> = [], nodeId?: string): WorkflowIssue {
  return { message, path, nodeId };
}

export function mockUserId() {
  return process.env.NEXT_PUBLIC_MOCK_USER_ID ?? "";
}

export function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}
