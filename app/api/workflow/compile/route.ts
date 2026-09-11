import { dryRunCompile } from "@/lib/workflow-dsl/compile";

export const runtime = "nodejs";

/**
 * 编译校验（dry-run）。
 *
 * 入参：`{ doc }` — 当前画布 DSL。
 * 出参：能编成 StateGraph 则 200；schema/拓扑/缺资源则 422 + errors。
 * 不 invoke、不落库。发布前和画布「编译」按钮共用这一条。
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, errors: [{ message: "请求体不是合法 JSON", path: [] }] }, { status: 400 });
  }

  const doc =
    body && typeof body === "object" && "doc" in body
      ? (body as { doc: unknown }).doc
      : undefined;
  if (doc == null) {
    return Response.json(
      { ok: false, errors: [{ message: "缺少 doc", path: ["doc"] }] },
      { status: 400 },
    );
  }

  const result = await dryRunCompile(doc, {
    userId: process.env.NEXT_PUBLIC_MOCK_USER_ID,
  });
  if (!result.ok) {
    return Response.json(result, { status: 422 });
  }
  return Response.json(result);
}
