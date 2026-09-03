"use client";

import React, { useEffect, useMemo, useState } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn, getUserId } from "@/lib/utils";

type UUID = string;

type AgentRow = {
  id: UUID;
  user_id: UUID;
  name: string;
  system_prompt: string | null;
  model_name: string | null;
  temperature: number | null;
  created_at: string;
};

type ToolRow = {
  id: UUID;
  user_id: UUID;
  name: string;
  display_name: string | null;
  description: string | null;
  tool_type: "explicit" | "implicit" | string;
  connection_config: unknown;
};

type AgentToolRow = {
  id: UUID;
  agent_id: UUID;
  tool_id: UUID;
};

type AgentWithTools = AgentRow & {
  explicitTools: ToolRow[];
};

const MODEL_VALUES = [
  "gemini-2-5-flash",
  "gpt-4o",
  "claude-3-5-sonnet",
] as const;

type ModelValue = (typeof MODEL_VALUES)[number];

const MODEL_LABELS: Record<ModelValue, string> = {
  "gemini-2-5-flash": "Gemini 2.5 Flash",
  "gpt-4o": "GPT-4o",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function formatTemp(v: number) {
  const rounded = Math.round(v * 10) / 10;
  return rounded.toFixed(1);
}

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return null;
}

function isModelValue(value: string | null): value is ModelValue {
  return MODEL_VALUES.includes(value as ModelValue);
}

function modelLabel(model: string | null) {
  if (isModelValue(model)) return MODEL_LABELS[model];
  return "未知模型";
}

function toolLabel(tool: ToolRow) {
  return tool.display_name?.trim() || tool.name;
}

function promptSnippet(
  prompt: string | null,
  emptyLabel: string,
  maxLen = 140,
) {
  const p = (prompt || "").trim().replaceAll(/\s+/g, " ");
  if (!p) return emptyLabel;
  return p.length <= maxLen ? p : `${p.slice(0, maxLen - 1)}…`;
}

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agents, setAgents] = useState<AgentWithTools[]>([]);
  const [explicitTools, setExplicitTools] = useState<ToolRow[]>([]);

  const [query, setQuery] = useState("");
  const [gridCompact, setGridCompact] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<UUID | null>(null);

  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelName, setModelName] = useState<ModelValue>(MODEL_VALUES[0]);
  const [temperature, setTemperature] = useState(0.7);
  const [selectedToolIds, setSelectedToolIds] = useState<Set<UUID>>(new Set());

  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<UUID | null>(null);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.name.toLowerCase().includes(q));
  }, [agents, query]);

  function resetForm() {
    setEditingAgentId(null);
    setName("");
    setSystemPrompt("");
    setModelName(MODEL_VALUES[0]);
    setTemperature(0.7);
    setSelectedToolIds(new Set());
  }

  function openCreate() {
    resetForm();
    setDialogOpen(true);
  }

  function openEdit(agent: AgentWithTools) {
    setEditingAgentId(agent.id);
    setName(agent.name || "");
    setSystemPrompt(agent.system_prompt || "");
    setModelName(
      isModelValue(agent.model_name) ? agent.model_name : MODEL_VALUES[0],
    );
    setTemperature(clamp(agent.temperature ?? 0.7, 0, 1));
    setSelectedToolIds(new Set(agent.explicitTools.map((tool) => tool.id)));
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    resetForm();
  }

  async function loadAll({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    const mockUserId = getUserId();
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

  async function upsertAgent() {
    if (saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("智能体名称为必填项。");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const user = userRes.user;
      if (!user) {
        setError("未登录。");
        return;
      }

      const payload = {
        name: trimmedName,
        system_prompt: systemPrompt.trim(),
        model_name: modelName,
        temperature: clamp(temperature, 0, 1),
      };

      let agentId = editingAgentId;
      if (editingAgentId) {
        const { error: updErr } = await supabase
          .from("agents")
          .update(payload)
          .eq("id", editingAgentId)
          .eq("user_id", user.id);
        if (updErr) throw updErr;
      } else {
        const { data: insData, error: insErr } = await supabase
          .from("agents")
          .insert({ user_id: user.id, ...payload })
          .select("id")
          .single();
        if (insErr) throw insErr;
        agentId = (insData as { id: UUID } | null)?.id ?? null;
      }

      if (!agentId) {
        setError("无法解析智能体 ID。");
        return;
      }

      const selected = Array.from(selectedToolIds);
      const { error: delErr } = await supabase
        .from("agent_tools")
        .delete()
        .eq("agent_id", agentId);
      if (delErr) throw delErr;

      if (selected.length > 0) {
        const rows = selected.map((tool_id) => ({
          agent_id: agentId,
          tool_id,
        }));
        const { error: bindErr } = await supabase
          .from("agent_tools")
          .insert(rows);
        if (bindErr) throw bindErr;
      }

      closeDialog();
      await loadAll({ silent: true });
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "保存智能体失败。");
    } finally {
      setSaving(false);
    }
  }

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

  function toggleTool(toolId: UUID) {
    setSelectedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }

  const gridCols = gridCompact
    ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    : "grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3";

  return (
    <div className="space-y-6">
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
              className="group transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/20"
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

              <CardFooter className="justify-between">
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

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingAgentId ? "修改智能体" : "创建智能体"}
            </DialogTitle>
            <DialogDescription>
              配置角色设定、模型参数和显式工具集成。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="agent-name">
                名称
              </label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：客户支持助手"
                className="h-9"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium" htmlFor="agent-prompt">
                  系统提示词
                </label>
                <span className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  角色 + 约束
                </span>
              </div>
              <Textarea
                id="agent-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="描述智能体的职责、风格与边界…"
                rows={8}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="agent-model">
                  模型
                </label>
                <select
                  id="agent-model"
                  value={modelName}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (isModelValue(value)) setModelName(value);
                  }}
                  className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30"
                >
                  {MODEL_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {MODEL_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-medium" htmlFor="agent-temp">
                    温度
                  </label>
                  <span className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                    {formatTemp(temperature)}
                  </span>
                </div>
                <Slider
                  id="agent-temp"
                  min={0}
                  max={1}
                  step={0.1}
                  value={[temperature]}
                  onValueChange={(v) =>
                    setTemperature(clamp(v[0] ?? 0.7, 0, 1))
                  }
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>0.0 确定性</span>
                  <span>1.0 创造性</span>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">显式工具集成</div>
                  <div className="text-xs text-muted-foreground">
                    绑定/解绑真实世界执行权限（邮件、Webhook、代理等）。
                  </div>
                </div>
                <span className="inline-flex rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  已选 {selectedToolIds.size} 项
                </span>
              </div>

              {explicitTools.length === 0 ? (
                <div className="rounded-xl border border-dashed border-primary/25 bg-primary/5 p-4 text-sm text-muted-foreground">
                  暂无可用显式工具。请先创建工具，再返回此处授予智能体权限。
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {explicitTools.map((tool) => {
                    const checked = selectedToolIds.has(tool.id);
                    return (
                      <label
                        key={tool.id}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors",
                          checked
                            ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                            : "hover:bg-primary/5",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleTool(tool.id)}
                          className="mt-1 h-4 w-4 accent-primary"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="truncate text-sm font-semibold">
                              {toolLabel(tool)}
                            </div>
                            <span className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              显式
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {tool.description?.trim()
                              ? tool.description
                              : "暂无描述。"}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="items-center justify-between sm:justify-between">
            <div className="mr-auto text-xs text-muted-foreground">
              隐式工具始终启用，不会在此显示。
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={closeDialog} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void upsertAgent()} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    保存中
                  </>
                ) : editingAgentId ? (
                  "保存更改"
                ) : (
                  "创建智能体"
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
