import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createChatModel } from "@/lib/agent-runtime/llm";
import { encodeSse, mapStreamEvent, type ChatSseEvent } from "@/lib/agent-runtime/sse";
import { buildLangChainTools } from "@/lib/agent-runtime/tools";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import type { AgentRow, AgentToolRow, ToolRow } from "@/app/(dashboard)/agents/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type ChatRequestBody = {
  agentId?: string;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  config?: {
    system_prompt?: string;
    model_name?: string;
    temperature?: number;
    toolIds?: string[];
  };
};

function sseResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: Request) {
  const encoder = new TextEncoder();

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const agentId = body.agentId?.trim();
  const messages = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim(),
  );

  if (!agentId || messages.length === 0) {
    return Response.json(
      { error: "agentId and messages are required" },
      { status: 400 },
    );
  }

  const supabase = createSupabaseAdmin();
  const { data: agent, error: agentErr } = await supabase
    .from("agents")
    .select("id,user_id,name,system_prompt,model_name,temperature,created_at")
    .eq("id", agentId)
    .maybeSingle();

  if (agentErr || !agent) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  const agentRow = agent as AgentRow;
  const override = body.config;
  const modelName = override?.model_name ?? agentRow.model_name;
  const temperature = override?.temperature ?? agentRow.temperature;
  const systemPrompt = override?.system_prompt ?? agentRow.system_prompt;

  let toolIds: string[];
  if (override?.toolIds) {
    toolIds = override.toolIds;
  } else {
    const { data: links } = await supabase
      .from("agent_tools")
      .select("id,agent_id,tool_id")
      .eq("agent_id", agentId);
    toolIds = ((links || []) as AgentToolRow[]).map((l) => l.tool_id);
  }

  let toolRows: ToolRow[] = [];
  if (toolIds.length > 0) {
    const { data: tools } = await supabase
      .from("tools")
      .select(
        "id,user_id,name,display_name,description,tool_type,connection_config",
      )
      .in("id", toolIds)
      .eq("user_id", agentRow.user_id)
      .eq("tool_type", "explicit");
    toolRows = (tools || []) as ToolRow[];
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatSseEvent) => {
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      try {
        const llm = createChatModel(
          modelName,
          Number(temperature ?? 0.7),
        );
        const tools = buildLangChainTools(toolRows);
        const reactAgent = createReactAgent({
          llm,
          tools,
          prompt:
            systemPrompt?.trim() ||
            "You are a helpful AI agent. Use tools when they improve the answer.",
        });

        const lcMessages = messages.map((m) =>
          m.role === "assistant"
            ? new AIMessage(m.content)
            : new HumanMessage(m.content),
        );

        const eventStream = await reactAgent.streamEvents(
          { messages: lcMessages },
          { version: "v2" },
        );

        for await (const raw of eventStream) {
          const mapped = mapStreamEvent(raw);
          if (mapped) send(mapped);
        }

        send({ type: "done" });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Agent run failed";
        send({ type: "error", message });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return sseResponse(stream);
}
