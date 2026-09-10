"use client";

/**
 * 智能体试运行台：左侧草稿、中栏会话列表、右侧流式对话。
 * 核心约束：未保存草稿绝不进入 /api/chat；每条 thread 自带冻结 config，互不污染。
 */
import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bot,
  Loader2,
  MessageSquarePlus,
  Send,
  SlidersHorizontal,
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
} from "../components/agent-trial-editor";
import type { AgentRow, AgentToolRow, AgentWithTools, ToolRow } from "../lib/types";
import { getErrorMessage } from "../lib/utils";
import { ChatMarkdown } from "../components/chat-markdown";
import type { ChatSseEvent } from "@/lib/agent-runtime/sse";
import { ThreadList } from "../components/thread-list";
import { ThreadConfigDrawer } from "../components/thread-config-drawer";
import {
  createEmptyThread,
  threadFromStored,
  type ConversationThread,
  type PlaygroundMessage,
  type StoredThreadListItem,
} from "../lib/thread-types";

/**
 * 解析 SSE 缓冲。fetch 按字节切片，一帧可能横跨两次 read。
 *
 * 入参：`buffer` — 已累计的未完成文本。
 * 出参：`events` 已完整的 JSON 帧；`rest` 留给下次拼接的半帧。
 * 步骤：按 `\n\n` 分帧 → 取 `data:` 行 → JSON.parse；坏 JSON 丢弃，避免一条脏事件掐死整段流。
 */
function parseSseChunk(buffer: string) {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: ChatSseEvent[] = [];
  for (const frame of frames) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
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

/** 冻结一份草稿给 thread.config：selectedToolIds 必须拷贝，否则勾选工具会改写其它会话的快照。 */
function cloneDraft(draft: AgentDraft): AgentDraft {
  return { ...draft, selectedToolIds: [...draft.selectedToolIds] };
}

/** 用首条用户消息生成侧栏标题；压空白后截断，避免超长 prompt 撑爆 240px 列表。 */
function titleFromText(text: string) {
  const compact = text.replaceAll(/\s+/g, " ").trim();
  if (!compact) return "新对话";
  return compact.length <= 24 ? compact : `${compact.slice(0, 23)}…`;
}

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [agent, setAgent] = useState<AgentWithTools | null>(null);
  const [availableTools, setAvailableTools] = useState<ToolRow[]>([]);
  /** 左侧正在改的草稿；发送消息故意不读它，只读 savedDraft / thread.config。 */
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  /** 已落库的参数；新对话与首条消息用这份，保证「未点保存」不会悄悄改运行时。 */
  const [savedDraft, setSavedDraft] = useState<AgentDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.threadId === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const messages = useMemo(() => activeThread?.messages ?? [], [activeThread]);

  useEffect(() => {
    let cancelled = false;
    /**
     * 详情页首屏：智能体 + 工具目录 + 会话列表。
     *
     * 入参：路由 `id`。
     * 出参：灌 agent/draft/savedDraft；threads 先放一条本地空会话，再与远程列表合并。
     * 步骤：
     * 1. 读 agents 行；mock 用户不一致时伪装成 404，避免把别人的 prompt 漏到试运行页。
     * 2. 拉该 user 的 explicit tools + 本 agent 的绑定，拼出 draft。
     * 3. 立刻塞一条未 persisted 的空 thread，让聊天区可先用，不必等列表接口。
     * 4. 拉远程列表后：本地未落库会话留在最前，避免接口返回把「新对话」冲掉。
     */
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
        setThreadsLoading(false);
        return;
      }
      const agentRow = row as AgentRow;
      // RLS 未开：用 mock user 做归属校验，失败文案与「不存在」相同，避免泄露他人智能体是否存在。
      if (mockUserId && agentRow.user_id !== mockUserId) {
        setError("未找到该智能体。");
        setAgent(null);
        setLoading(false);
        setThreadsLoading(false);
        return;
      }

      const { data } = await supabase
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
      const allTools = (data || []) as ToolRow[];

      const bound = allTools.filter((tool) => toolIds.includes(tool.id));
      if (cancelled) return;
      const hydrated = { ...agentRow, explicitTools: bound };
      const nextDraft = draftFromAgent(hydrated);
      const fresh = createEmptyThread(nextDraft);
      setAvailableTools(allTools);
      setAgent(hydrated);
      setDraft(nextDraft);
      setSavedDraft(nextDraft);
      setThreads([fresh]);
      setActiveThreadId(fresh.threadId);
      setLoading(false);

      let remote: ConversationThread[] = [];
      setThreadsLoading(true);
      try {
        const threadsRes = await fetch(
          `/api/chat/threads?agentId=${encodeURIComponent(id)}`,
        );
        if (cancelled) return;
        if (!threadsRes.ok) {
          const errText = await threadsRes.text();
          throw new Error(errText || `加载对话列表失败 (${threadsRes.status})`);
        }
        const payload = (await threadsRes.json()) as {
          conversations?: StoredThreadListItem[];
        };
        remote = (payload.conversations ?? []).map(threadFromStored);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(getErrorMessage(e) ?? "加载对话列表失败。");
        setThreadsLoading(false);
        return;
      }

      if (cancelled) return;
      setThreads((prev) => {
        // 远程列表不含未发过消息的本地草稿；必须保留，否则用户刚点「新对话」会被接口回写冲掉。
        const local = prev.filter((thread) => !thread.persisted);
        const keepLocal =
          local.length > 0 ? local : [createEmptyThread(nextDraft)];
        return [...keepLocal, ...remote];
      });
      setThreadsLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  function startNewConversation(config = savedDraft) {
    if (!config || streaming || historyLoading) return;
    const fresh = createEmptyThread(config);
    // 丢掉其它未 persisted 空会话，侧栏只保留一条「新对话」+ 已落库历史。
    setThreads((prev) => [fresh, ...prev.filter((thread) => thread.persisted)]);
    setActiveThreadId(fresh.threadId);
    setHistoryLoading(false);
    setError(null);
    setConfigOpen(false);
  }

  /**
   * 切换会话。未落库的空会话没有 history；已 persisted 的每次点选都重拉，
   * 避免沿用内存里的流式半成品（例如上次 SSE 中断留下的空 assistant 气泡）。
   */
  async function selectThread(threadId: string) {
    if (streaming || historyLoading) return;
    const thread = threads.find((item) => item.threadId === threadId);
    setActiveThreadId(threadId);
    setError(null);
    setConfigOpen(false);
    if (!thread?.persisted) return;

    setHistoryLoading(true);
    try {
      const response = await fetch(
        `/api/chat/history?threadId=${encodeURIComponent(threadId)}`,
      );
      const payload = (await response.json()) as {
        messages?: PlaygroundMessage[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error || `加载对话历史失败 (${response.status})`,
        );
      }
      setThreads((prev) =>
        prev.map((item) =>
          item.threadId === threadId
            ? { ...item, messages: payload.messages ?? [] }
            : item,
        ),
      );
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "加载对话历史失败。");
    } finally {
      setHistoryLoading(false);
    }
  }

  function updateActiveThread(
    threadId: string,
    updater: (thread: ConversationThread) => ConversationThread,
  ) {
    // 按 id 替换单条，避免 SSE 每次 token 都重建整个 threads 数组语义之外的引用混乱。
    setThreads((prev) =>
      prev.map((thread) =>
        thread.threadId === threadId ? updater(thread) : thread,
      ),
    );
  }

  /**
   * 把试运行草稿写回 agents + 全量重写 agent_tools。
   *
   * 入参：`nextDraft` 待落库配置；`successText` 区分「保存」与「复用该对话参数」两条路径的提示。
   * 出参：成功返回洗过的 AgentDraft，失败 null（调用方不要因此开新对话）。
   * 步骤：更新 agents 行 → DELETE 全部绑定 → INSERT 勾选 → 本地 agent/draft/savedDraft 一起对齐，避免 UI 与库短暂分叉。
   */
  async function persistAgent(nextDraft: AgentDraft, successText: string) {
    if (!agent || saving) return null;
    const trimmedName = nextDraft.name.trim();
    if (!trimmedName) {
      setSaveMessage("智能体名称为必填项。");
      return null;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const userId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
      const { error: updErr } = await supabase
        .from("agents")
        .update({
          name: trimmedName,
          system_prompt: nextDraft.systemPrompt.trim(),
          model_name: nextDraft.modelName,
          temperature: nextDraft.temperature,
        })
        .eq("id", agent.id)
        .eq("user_id", userId);
      if (updErr) throw updErr;

      const { error: delErr } = await supabase
        .from("agent_tools")
        .delete()
        .eq("agent_id", agent.id);
      if (delErr) throw delErr;

      if (nextDraft.selectedToolIds.length > 0) {
        const { error: bindErr } = await supabase.from("agent_tools").insert(
          nextDraft.selectedToolIds.map((tool_id) => ({
            agent_id: agent.id,
            tool_id,
          })),
        );
        if (bindErr) throw bindErr;
      }

      const bound = availableTools.filter((tool) =>
        nextDraft.selectedToolIds.includes(tool.id),
      );
      const nextAgent = {
        ...agent,
        name: trimmedName,
        system_prompt: nextDraft.systemPrompt.trim(),
        model_name: nextDraft.modelName,
        temperature: nextDraft.temperature,
        explicitTools: bound,
      };
      const persisted = draftFromAgent(nextAgent);
      setAgent(nextAgent);
      setDraft(persisted);
      setSavedDraft(persisted);
      setSaveMessage(successText);
      return persisted;
    } catch (e: unknown) {
      setSaveMessage(getErrorMessage(e) ?? "保存失败。");
      return null;
    } finally {
      setSaving(false);
    }
  }

  /**
   * 发送试运行消息并消费 /api/chat SSE。
   *
   * 入参：输入框文本；实际请求体用 `sendConfig`，不是左侧未保存 draft。
   * 出参：把 user + 空 assistant 气泡写入当前 thread，再按 token/tool 事件原地拼内容。
   * 步骤：
   * 1. 没有 active thread 则用 savedDraft 现开一条。
   * 2. 该 thread 若还没有消息，把此刻的 savedDraft clone 进 config（冻结本轮模型/工具）；已有消息则沿用 thread.config。
   * 3. 先乐观插入气泡并把 persisted=true，这样刷新列表时不会把进行中的对话当本地草稿丢掉。
   * 4. 读流：半帧留在 buffer；结束时补 `\n\n` 冲掉最后一帧。
   * 5. 失败且 assistant 仍无 content 时才写错误文案，避免覆盖已经流出来的半段回复。
   */
  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming || !agent || !savedDraft) return;

    let thread = threads.find((item) => item.threadId === activeThreadId);
    if (!thread) {
      thread = createEmptyThread(savedDraft);
      setThreads((prev) => [thread!, ...prev]);
      setActiveThreadId(thread.threadId);
    }

    // 空会话：用已保存参数冻结本 thread；续聊必须沿用当时的 config，左侧后改的草稿不能改写历史轮次。
    const sendConfig =
      thread.messages.length === 0 ? cloneDraft(savedDraft) : thread.config;
    const threadId = thread.threadId;

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
    updateActiveThread(threadId, (current) => ({
      ...current,
      persisted: true,
      title:
        current.messages.length === 0 ? titleFromText(text) : current.title,
      config: sendConfig,
      messages: [...current.messages, userMsg, assistantMsg],
    }));

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          threadId,
          message: text,
          title:
            thread.messages.length === 0 ? titleFromText(text) : thread.title,
          config: {
            system_prompt: sendConfig.systemPrompt,
            model_name: sendConfig.modelName,
            temperature: sendConfig.temperature,
            toolIds: sendConfig.selectedToolIds,
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
          applyEvent(threadId, assistantMsg.id, event);
        }
      }
      if (buffer.trim()) {
        // 流结束时最后一帧可能没有尾部分隔符，补空行才能解析。
        const parsed = parseSseChunk(`${buffer}\n\n`);
        for (const event of parsed.events) {
          applyEvent(threadId, assistantMsg.id, event);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "试运行失败";
      setError(message);
      updateActiveThread(threadId, (current) => ({
        ...current,
        messages: current.messages.map((m) =>
          m.id === assistantMsg.id && !m.content
            ? { ...m, content: `错误：${message}` }
            : m,
        ),
      }));
    } finally {
      setStreaming(false);
    }
  }

  /**
   * 把单条 SSE 事件叠到指定 assistant 气泡。
   *
   * 入参：threadId、本轮占位 assistant 的 id、已解析事件。
   * 出参：仅替换该消息；token 追加 content，工具按 runId upsert。
   * 步骤：
   * - tool_start：先滤掉同 runId 再追加，防止重放/重复 start 画出两行。
   * - tool_end：对得上 runId 则改 done；对不上（乱序/丢 start）也补一条 done，避免工具结果静默丢失。
   * - error：有正文则保留已流内容，只在气泡仍空时写入错误句。
   */
  function applyEvent(
    threadId: string,
    assistantId: string,
    event: ChatSseEvent,
  ) {
    updateActiveThread(threadId, (current) => ({
      ...current,
      messages: current.messages.map((m) => {
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
                status: "running" as const,
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
                    status: "done" as const,
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
    }));
    if (event.type === "error") setError(event.message);
  }

  const dirty = Boolean(draft && savedDraft && !draftsEqual(draft, savedDraft));

  async function saveDraft() {
    if (!draft) return;
    const persisted = await persistAgent(
      draft,
      "已保存。发送消息将使用新参数创建新的对话。",
    );
    // 保存后立刻开新会话：已有 thread 继续用旧 config，新消息才走新参数，避免同一 thread 中途换模型。
    if (persisted) startNewConversation(persisted);
  }

  async function reuseThreadConfig() {
    if (!activeThread) return;
    const persisted = await persistAgent(
      activeThread.config,
      "已复用该对话参数并保存到智能体。",
    );
    if (persisted) {
      setConfigOpen(false);
      startNewConversation(persisted);
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
                  saveMessage.includes("失败") || saveMessage.includes("必填")
                    ? "text-destructive"
                    : "text-muted-foreground",
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

      <ThreadList
        threads={threads}
        activeThreadId={activeThreadId}
        loading={threadsLoading}
        disabled={streaming || historyLoading}
        onSelect={(threadId) => {
          void selectThread(threadId);
        }}
        onNew={() => startNewConversation()}
      />

      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {activeThread?.title || "流式对话"}
            </div>
            <div className="text-xs text-muted-foreground">
              {dirty
                ? "未保存的修改不会用于发送，仍使用已保存参数"
                : "每个对话对应独立 thread_id"}
            </div>
          </div>
          {/* <Button
            type="button"
            variant="outline"
            disabled={streaming || !savedDraft}
            onClick={() => startNewConversation()}
          >
            <MessageSquarePlus className="h-4 w-4" />
            发起新对话
          </Button> */}
          <Button
            type="button"
            variant="outline"
            disabled={!activeThread}
            onClick={() => setConfigOpen(true)}
          >
            <SlidersHorizontal className="h-4 w-4" />
            配置信息
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {historyLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载对话历史…
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              发送一条消息，使用已保存参数开启该对话。
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
                  {message.content ? (
                    <ChatMarkdown
                      content={message.content}
                      variant={message.role}
                    />
                  ) : streaming && message.role === "assistant" ? (
                    <div>…</div>
                  ) : null}
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
              disabled={streaming || historyLoading || !agent || !savedDraft}
              onKeyDown={(e) => {
                // 单独 Enter 发送、Shift+Enter 换行：Textarea 默认 Enter 会插入换行，必须拦掉。
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <Button
              type="submit"
              disabled={
                streaming ||
                historyLoading ||
                !agent ||
                !savedDraft ||
                !input.trim()
              }
            >
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

      <ThreadConfigDrawer
        open={configOpen}
        thread={activeThread}
        availableTools={availableTools}
        applying={saving}
        onClose={() => setConfigOpen(false)}
        onReuse={() => void reuseThreadConfig()}
      />
    </div>
  );
}
