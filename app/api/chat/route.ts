import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createChatModel } from "@/lib/agent-runtime/llm";
import {
  encodeSse,
  mapStreamEvent,
  type ChatSseEvent,
} from "@/lib/agent-runtime/sse";
import { buildLangChainTools } from "@/lib/agent-runtime/tools";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import type {
  AgentRow,
  AgentToolRow,
  ToolRow,
} from "@/app/(dashboard)/agents/lib/types";
import { getRedisCheckpointer } from "@/lib/redis";
import {
  ensureAgentConversation,
  titleFromMessage,
} from "@/lib/agent-runtime/conversation-store";
import { lastWindow, summarizeMessages } from "@/lib/agent-runtime/context";

export const runtime = "nodejs";
export const maxDuration = 60;

type ChatRequestBody = {
  agentId?: string;
  message: string;
  threadId: string;
  title?: string;
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
  const threadId = body.threadId?.trim();
  const incomingMessage = body.message?.trim();
  const messages = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.content.trim(),
  );

  if (!agentId || !threadId || (!incomingMessage && messages.length === 0)) {
    return Response.json(
      { error: "agentId, threadId and message are required" },
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

  const userText = incomingMessage || messages.at(-1)?.content || "";
  try {
    await ensureAgentConversation(agentId, {
      threadId,
      title: body.title?.trim() || titleFromMessage(userText),
      createdAt: new Date().toISOString(),
      config: {
        name: agentRow.name,
        system_prompt: systemPrompt,
        model_name: modelName,
        temperature: temperature == null ? null : Number(temperature),
        toolIds,
      },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to persist conversation";
    return Response.json({ error: message }, { status: 500 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatSseEvent) => {
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      try {
        const llm = createChatModel(modelName, Number(temperature ?? 0.7));
        const tools = buildLangChainTools(toolRows);
        const redisCheckpointer = await getRedisCheckpointer();
        const basePrompt =
          systemPrompt?.trim() ||
          "You are a helpful AI agent. Use tools when they improve the answer.";
        let cachedSummaryKey = "";
        let cachedSummary = "";
        const reactAgent = createReactAgent({
          llm,
          tools,
          checkpointer: redisCheckpointer,
          prompt: async (state) => {
            const { older, kept } = lastWindow(state.messages, 2);
            const summaryKey = String(older.length);
            if (older.length > 0 && cachedSummaryKey !== summaryKey) {
              cachedSummary = await summarizeMessages(older);
              cachedSummaryKey = summaryKey;
            }
            const summary = older.length > 0 ? cachedSummary : "";
            console.log("summary: ", summary);
            return [
              new SystemMessage(
                summary
                  ? `${basePrompt}\n\n此前对话摘要：\n${summary}`
                  : basePrompt,
              ),
              ...kept,
            ];
          },
        });

        const config = {
          configurable: {
            thread_id: threadId,
          },
        };

        // 后续改为从redis获取上下文并做动态修剪
        // const lcMessages = messages.map((m) =>
        //   m.role === "assistant"
        //     ? new AIMessage(m.content)
        //     : new HumanMessage(m.content),
        // );

        // 不需要再传入历史messages，Langgraph会自动通过threadId去redis抓历史消息，并把这句新的humanMessage append进去
        const eventStream = await reactAgent.streamEvents(
          { messages: [new HumanMessage(userText)] },
          { ...config, version: "v2" },
        );

        for await (const raw of eventStream) {
          const mapped = mapStreamEvent(raw);
          if (mapped) send(mapped);
        }

        send({ type: "done" });
        const state = await reactAgent.getState(config);
        console.log("state: ", state);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Agent run failed";
        send({ type: "error", message });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return sseResponse(stream);
}
