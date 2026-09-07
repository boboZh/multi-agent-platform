import { NextResponse } from "next/server";
import { loadCheckpointMessages } from "@/lib/agent-runtime/checkpoint-history";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const threadId = searchParams.get("threadId")?.trim();

  if (!threadId) {
    return NextResponse.json(
      { error: "Thread ID is required" },
      { status: 400 },
    );
  }

  try {
    const messages = await loadCheckpointMessages(threadId);
    return NextResponse.json({ threadId, messages });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load conversation history";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
