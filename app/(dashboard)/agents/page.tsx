"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Grid2X2,
  LayoutList,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { AgentEditorDialog } from "./agent-editor-dialog";
import type {
  AgentRow,
  AgentToolRow,
  AgentWithTools,
  ToolRow,
  UUID,
} from "./types";
import {
  clamp,
  formatTemp,
  getErrorMessage,
  modelLabel,
  promptSnippet,
  toolLabel,
} from "./utils";

/**
 * 智能体目录：工作流画布拖拽前的配置入口。
 * 卡片点整卡进试运行，底部操作区单独 stopPropagation，避免「改配置」被路由成详情。
 */

/** 首屏骨架：与真实卡片区块高度接近，避免加载完成时网格突然塌陷。 */
function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-xl border border-primary/10 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-3 w-28 rounded bg-muted" />
        </div>
        <div className="h-6 w-20 rounded-full bg-muted" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-5/6 rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
      </div>
      <div className="mt-4 flex gap-2">
        <div className="h-6 w-24 rounded-full bg-muted" />
        <div className="h-6 w-20 rounded-full bg-muted" />
      </div>
      <div className="mt-5 h-9 w-full rounded bg-muted" />
    </div>
  );
}

export default function AgentsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentWithTools[]>([]);
  /** 全量显式工具目录，传给编辑器做绑定；与每张卡片上的 agent.explicitTools（已绑定子集）分开存，避免每次打开弹窗再打一轮 tools 表。 */
  const [explicitTools, setExplicitTools] = useState<ToolRow[]>([]);

  const [query, setQuery] = useState("");
  const [gridCompact, setGridCompact] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentWithTools | null>(null);
  const [deletingId, setDeletingId] = useState<UUID | null>(null);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    // 只搜名称：系统提示词进过滤会让用户搜到「看起来不匹配标题」的卡，目录场景不合适。
    return agents.filter((a) => a.name.toLowerCase().includes(q));
  }, [agents, query]);

  function openCreate() {
    setEditingAgent(null);
    setEditorOpen(true);
  }

  function openEdit(agent: AgentWithTools) {
    setEditingAgent(agent);
    setEditorOpen(true);
  }

  /**
   * 拉目录并拼出 AgentWithTools。
   *
   * 入参：`silent` — true 时不切全页 loading（刷新/保存后），避免网格被骨架闪一下。
   * 出参：写入 `agents` + `explicitTools`；失败只写 `error`。
   * 步骤：
   * 1. 并行拉 agents 与 explicit tools（implicit 不进目录，否则编辑器会把运行时默认工具画成可解绑项）。
   * 2. 再按 agent_id IN (...) 一次拉齐中间表，避免对每个 agent 打 N 次请求。
   * 3. 只把「当前工具目录里仍存在」的 tool_id 挂上去，跳过已删工具的幽灵绑定。
   */
  async function loadAll({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    console.log("mockUserId: ", process.env);
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
    try {
      const [agentsRes, toolsRes] = await Promise.all([
        supabase
          .from("agents")
          .select(
            "id,user_id,name,system_prompt,model_name,temperature,created_at",
          )
          .eq("user_id", mockUserId)
          .order("created_at", { ascending: false }),
        supabase
          .from("tools")
          .select(
            "id,user_id,name,display_name,description,tool_type,connection_config",
          )
          .eq("user_id", mockUserId)
          .eq("tool_type", "explicit")
          .order("display_name", { ascending: true }),
      ]);

      console.log("agentRes: ", agentsRes, toolsRes);
      if (agentsRes.error) throw agentsRes.error;
      if (toolsRes.error) throw toolsRes.error;

      const agentRows = (agentsRes.data || []) as AgentRow[];
      const toolRows = (toolsRes.data || []) as ToolRow[];
      setExplicitTools(toolRows);

      if (agentRows.length === 0) {
        setAgents([]);
        return;
      }

      const agentIds = agentRows.map((a) => a.id);
      const { data: agentToolsData, error: agentToolsErr } = await supabase
        .from("agent_tools")
        .select("id,agent_id,tool_id")
        .in("agent_id", agentIds);
      if (agentToolsErr) throw agentToolsErr;

      const agentToolRows = (agentToolsData || []) as AgentToolRow[];
      const toolById = new Map(
        toolRows.map((tool) => [tool.id, tool] as const),
      );

      const toolsByAgent = new Map<UUID, ToolRow[]>();
      for (const link of agentToolRows) {
        const tool = toolById.get(link.tool_id);
        // 中间表可能仍指向已删除/已改为 implicit 的工具，不能展示成有效绑定。
        if (!tool) continue;
        const list = toolsByAgent.get(link.agent_id) ?? [];
        list.push(tool);
        toolsByAgent.set(link.agent_id, list);
      }

      const hydrated: AgentWithTools[] = agentRows.map((agent) => ({
        ...agent,
        explicitTools: toolsByAgent.get(agent.id) ?? [],
      }));

      setAgents(hydrated);
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "加载智能体失败。");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    // 推迟到 microtask：避开 Strict Mode 下 effect 同步执行时与卸载竞态；cancelled 让迟到的 setState 失效。
    queueMicrotask(() => {
      if (cancelled) return;
      void loadAll();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await loadAll({ silent: true });
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * 删除智能体。先清 agent_tools 再删 agents，避免中间表外键挡住删除。
   * `deletingId` 作互斥锁，防止连点菜单对同一行发两次 delete。
   */
  async function deleteAgent(agentId: UUID) {
    if (deletingId) return;
    setDeletingId(agentId);
    setError(null);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const user = userRes.user;
      if (!user) {
        setError("未登录。");
        return;
      }

      const { error: delBindingsErr } = await supabase
        .from("agent_tools")
        .delete()
        .eq("agent_id", agentId);
      if (delBindingsErr) throw delBindingsErr;

      const { error: delAgentErr } = await supabase
        .from("agents")
        .delete()
        .eq("id", agentId)
        .eq("user_id", user.id);
      if (delAgentErr) throw delAgentErr;

      await loadAll({ silent: true });
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "删除智能体失败。");
    } finally {
      setDeletingId(null);
    }
  }

  const gridCols = gridCompact
    ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    : "grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3";

  return (
    <div className="flex-1 overflow-y-auto p-8">
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/25">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                AI 智能体目录
              </h1>
              <p className="text-sm text-muted-foreground">
                在将智能体拖入工作流画布之前，浏览、搜索并配置它们。
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleRefresh}
            disabled={refreshing}
            size="lg"
          >
            {refreshing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                刷新中
              </>
            ) : (
              <>
                <SlidersHorizontal className="h-4 w-4" />
                刷新
              </>
            )}
          </Button>
          <Button onClick={openCreate} size="lg">
            <Plus className="h-4 w-4" />
            创建智能体
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-primary/15 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-md">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-primary/70" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按名称搜索智能体…"
            className="h-9 border-primary/20 pl-9 focus-visible:border-primary focus-visible:ring-primary/30"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-full border border-primary/20 bg-primary/5 px-2 py-1 text-xs font-medium text-primary sm:inline-flex">
            {filteredAgents.length} / {agents.length}
          </span>
          <Button
            variant={gridCompact ? "outline" : "default"}
            size="icon-sm"
            onClick={() => setGridCompact(false)}
            disabled={!gridCompact}
            aria-label="宽松网格视图"
          >
            <Grid2X2 className="h-4 w-4" />
          </Button>
          <Button
            variant={gridCompact ? "default" : "outline"}
            size="icon-sm"
            onClick={() => setGridCompact(true)}
            disabled={gridCompact}
            aria-label="紧凑网格视图"
          >
            <LayoutList className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className={gridCols}>
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-primary/25 bg-card p-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <Bot className="h-6 w-6 text-primary" />
          </div>
          <div className="mt-4 text-lg font-semibold text-foreground">
            暂无智能体
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            创建您的第一个智能体，设置系统提示词、选择模型，并授予显式工具集成权限。
          </div>
          <div className="mt-5 flex justify-center">
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              创建智能体
            </Button>
          </div>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="rounded-2xl border border-primary/15 bg-card p-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <Search className="h-6 w-6 text-primary" />
          </div>
          <div className="mt-4 text-lg font-semibold text-foreground">
            未找到匹配的智能体
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            请尝试其他搜索关键词。
          </div>
          <div className="mt-5 flex justify-center">
            <Button variant="outline" onClick={() => setQuery("")}>
              清除搜索
            </Button>
          </div>
        </div>
      ) : (
        <div className={gridCols}>
          {filteredAgents.map((agent) => (
            <Card
              key={agent.id}
              className="group cursor-pointer transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/20"
              onClick={() => router.push(`/agents/${agent.id}`)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{agent.name}</CardTitle>
                    <div className="mt-1 inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {modelLabel(agent.model_name)}
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                    <Wrench className="h-3.5 w-3.5" />
                    {agent.explicitTools.length}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  温度：
                  {formatTemp(clamp(agent.temperature ?? 0.7, 0, 1))}
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {promptSnippet(agent.system_prompt, "暂无系统提示词。")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {agent.explicitTools.length === 0 ? (
                    <span className="inline-flex rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                      无显式工具
                    </span>
                  ) : (
                    agent.explicitTools.slice(0, 4).map((tool) => (
                      <span
                        key={tool.id}
                        className="inline-flex rounded-full border border-primary/15 bg-primary/5 px-2 py-1 text-xs text-primary"
                      >
                        {toolLabel(tool)}
                      </span>
                    ))
                  )}
                  {agent.explicitTools.length > 4 ? (
                    <span className="inline-flex rounded-full border border-primary/15 bg-primary/5 px-2 py-1 text-xs text-primary">
                      另有 {agent.explicitTools.length - 4} 个
                    </span>
                  ) : null}
                </div>
              </CardContent>

              <CardFooter
                className="justify-between"
                // 卡片本身跳详情；底部按钮必须拦住冒泡，否则「改配置」会先被路由走掉。
                onClick={(e) => e.stopPropagation()}
              >
                <Button
                  variant="outline"
                  className="border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
                  onClick={() => openEdit(agent)}
                >
                  修改配置
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={deletingId === agent.id}
                      aria-label="智能体操作"
                    >
                      {deletingId === agent.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <MoreHorizontal className="h-4 w-4" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => openEdit(agent)}>
                      修改配置
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => void deleteAgent(agent.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      删除智能体
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <AgentEditorDialog
        open={editorOpen}
        agent={editingAgent}
        explicitTools={explicitTools}
        onOpenChange={setEditorOpen}
        onSaved={() => loadAll({ silent: true })}
        onError={setError}
      />
    </div>
    </div>
  );
}
