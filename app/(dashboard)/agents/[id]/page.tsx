"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Loader2,
  Send,
  Wrench,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  AgentTrialEditor,
  draftFromAgent,
  draftsEqual,
  type AgentDraft,
} from "../agent-trial-editor";
import type {
  AgentRow,
  AgentToolRow,
  AgentWithTools,
  ToolRow,
} from "../types";
import { getErrorMessage } from "../utils";
import type { ChatSseEvent } from "@/lib/agent-runtime/sse";

type PlaygroundMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: Array<{
    runId: string;
    name: string;
    status: "running" | "done";
    input?: unknown;
    output?: unknown;
  }>;
};

function parseSseChunk(buffer: string) {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: ChatSseEvent[] = [];
  for (const frame of frames) {
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    const json = dataLine.replace(/^data:\s?/, "").trim();
    if (!json) continue;
    try {
      events.push(JSON.parse(json) as ChatSseEvent);
    } catch {
      // ignore malformed frames
    }
  }
  return { events, rest };
}

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [agent, setAgent] = useState<AgentWithTools | null>(null);
  const [availableTools, setAvailableTools] = useState<ToolRow[]>([]);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<AgentDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
      const { data: row, error: agentErr } = await supabase
        .from("agents")
        .select(
          "id,user_id,name,system_prompt,model_name,temperature,created_at",
        )
        .eq("id", id)
        .maybeSingle();
      if (cancelled) return;
      if (agentErr || !row) {
        setError("未找到该智能体。");
        setAgent(null);
        setLoading(false);
        return;
      }
      const agentRow = row as AgentRow;
      if (mockUserId && agentRow.user_id !== mockUserId) {
        setError("未找到该智能体。");
        setAgent(null);
        setLoading(false);
        return;
      }

      const { data: allTools } = await supabase
        .from("tools")
        .select(
          "id,user_id,name,display_name,description,tool_type,connection_config",
        )
        .eq("user_id", agentRow.user_id)
        .eq("tool_type", "explicit")
        .order("display_name", { ascending: true });

      const { data: links } = await supabase
        .from("agent_tools")
        .select("id,agent_id,tool_id")
        .eq("agent_id", id);
      const toolIds = ((links || []) as AgentToolRow[]).map((l) => l.tool_id);
      const catalog = (allTools || []) as ToolRow[];
      const bound = catalog.filter((tool) => toolIds.includes(tool.id));
      if (cancelled) return;
      const hydrated = { ...agentRow, explicitTools: bound };
      const nextDraft = draftFromAgent(hydrated);
      setAvailableTools(catalog);
      setAgent(hydrated);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const historyPayload = useMemo(
    () =>
      messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    [messages],
  );

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming || !agent || !draft) return;

    const userMsg: PlaygroundMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      tools: [],
    };
    const assistantMsg: PlaygroundMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      tools: [],
    };

    setInput("");
    setStreaming(true);
    setError(null);
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          messages: [...historyPayload, { role: "user", content: text }],
          config: {
            system_prompt: draft.systemPrompt,
            model_name: draft.modelName,
            temperature: draft.temperature,
            toolIds: draft.selectedToolIds,
          },
        }),
      });

      if (!response.ok || !response.body) {
        const errText = await response.text();
        throw new Error(errText || `Request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          applyEvent(assistantMsg.id, event);
        }
      }
      if (buffer.trim()) {
        const parsed = parseSseChunk(`${buffer}\n\n`);
        for (const event of parsed.events) {
          applyEvent(assistantMsg.id, event);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "试运行失败";
      setError(message);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id && !m.content
            ? { ...m, content: `错误：${message}` }
            : m,
        ),
      );
    } finally {
      setStreaming(false);
    }
  }

  function applyEvent(assistantId: string, event: ChatSseEvent) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== assistantId) return m;
        if (event.type === "token") {
          return { ...m, content: m.content + event.content };
        }
        if (event.type === "tool_start") {
          const runId = event.runId || crypto.randomUUID();
          return {
            ...m,
            tools: [
              ...m.tools.filter((t) => t.runId !== runId),
              {
                runId,
                name: event.name,
                status: "running",
                input: event.input,
              },
            ],
          };
        }
        if (event.type === "tool_end") {
          const runId = event.runId;
          const nextTools = m.tools.map((t) =>
            runId && t.runId === runId
              ? { ...t, status: "done" as const, output: event.output }
              : t,
          );
          const exists = runId && nextTools.some((t) => t.runId === runId);
          return {
            ...m,
            tools: exists
              ? nextTools
              : [
                  ...nextTools,
                  {
                    runId: runId || crypto.randomUUID(),
                    name: event.name,
                    status: "done",
                    output: event.output,
                  },
                ],
          };
        }
        if (event.type === "error") {
          return {
            ...m,
            content: m.content || `错误：${event.message}`,
          };
        }
        return m;
      }),
    );
    if (event.type === "error") setError(event.message);
  }

  const dirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));

  async function saveDraft() {
    if (!agent || !draft || saving) return;
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      setSaveMessage("智能体名称为必填项。");
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const userId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
      const { error: updErr } = await supabase
        .from("agents")
        .update({
          name: trimmedName,
          system_prompt: draft.systemPrompt.trim(),
          model_name: draft.modelName,
          temperature: draft.temperature,
        })
        .eq("id", agent.id)
        .eq("user_id", userId);
      if (updErr) throw updErr;

      const { error: delErr } = await supabase
        .from("agent_tools")
        .delete()
        .eq("agent_id", agent.id);
      if (delErr) throw delErr;

      if (draft.selectedToolIds.length > 0) {
        const { error: bindErr } = await supabase.from("agent_tools").insert(
          draft.selectedToolIds.map((tool_id) => ({
            agent_id: agent.id,
            tool_id,
          })),
        );
        if (bindErr) throw bindErr;
      }

      const bound = availableTools.filter((tool) =>
        draft.selectedToolIds.includes(tool.id),
      );
      const nextAgent = {
        ...agent,
        name: trimmedName,
        system_prompt: draft.systemPrompt.trim(),
        model_name: draft.modelName,
        temperature: draft.temperature,
        explicitTools: bound,
      };
      const nextDraft = draftFromAgent(nextAgent);
      setAgent(nextAgent);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setSaveMessage("已保存。");
    } catch (e: unknown) {
      setSaveMessage(getErrorMessage(e) ?? "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-[360px] shrink-0 flex-col border-r bg-card">
        <div className="flex items-center gap-2 border-b p-4">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href="/agents" aria-label="返回目录">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">
              {loading ? "加载中…" : draft?.name || agent?.name || "智能体详情"}
            </div>
            <div className="text-xs text-muted-foreground">
              {dirty ? "试运行草稿（未保存）" : "编辑并试运行"}
            </div>
          </div>
        </div>
        {draft && agent ? (
          <>
            {saveMessage ? (
              <div
                className={cn(
                  "px-4 pt-3 text-xs",
                  saveMessage === "已保存。"
                    ? "text-muted-foreground"
                    : "text-destructive",
                )}
              >
                {saveMessage}
              </div>
            ) : null}
            <AgentTrialEditor
              draft={draft}
              availableTools={availableTools}
              dirty={dirty}
              saving={saving}
              disabled={streaming}
              onChange={(patch) => {
                setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
                setSaveMessage(null);
              }}
              onSave={() => void saveDraft()}
            />
          </>
        ) : loading ? (
          <div className="animate-pulse space-y-3 p-4">
            <div className="h-24 rounded-xl bg-muted" />
            <div className="h-40 rounded-xl bg-muted" />
          </div>
        ) : (
          <p className="p-4 text-sm text-destructive">{error}</p>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-medium">流式对话</div>
            <div className="text-xs text-muted-foreground">
              发送时使用左侧当前参数，不自动保存
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              发送一条消息，试运行该智能体。
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.role === "user" ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-4 py-3 text-sm shadow-sm",
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "border bg-card",
                  )}
                >
                  {message.tools.length > 0 ? (
                    <div className="mb-2 space-y-1">
                      {message.tools.map((tool) => (
                        <div
                          key={tool.runId}
                          className="flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary"
                        >
                          {tool.status === "running" ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Wrench className="h-3 w-3" />
                          )}
                          {tool.name}
                          {tool.status === "running" ? " 执行中" : " 已完成"}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="whitespace-pre-wrap">
                    {message.content ||
                      (streaming && message.role === "assistant" ? "…" : "")}
                  </div>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {error ? (
          <div className="px-5 pb-2 text-xs text-destructive">{error}</div>
        ) : null}

        <form
          className="border-t p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入试运行消息…"
              rows={3}
              disabled={streaming || !agent || !draft}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <Button type="submit" disabled={streaming || !agent || !draft || !input.trim()}>
              {streaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              发送
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
