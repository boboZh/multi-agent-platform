import { NextResponse } from "next/server";
import { listAgentConversations } from "@/lib/agent-runtime/conversation-store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId")?.trim();

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  try {
    const conversations = await listAgentConversations(agentId);
    return NextResponse.json({ conversations });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load conversations";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
