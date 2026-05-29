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
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

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
  name: string; // machine-safe: tool_<hex>
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

const MODEL_OPTIONS = [
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" },
] as const;

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
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

function modelLabel(modelName: string | null) {
  const found = MODEL_OPTIONS.find((m) => m.value === modelName);
  return found?.label ?? (modelName || "Unknown model");
}

function toolLabel(tool: ToolRow) {
  // display_name is human-friendly; name is the abstract identifier
  return tool.display_name?.trim() || tool.name;
}

function promptSnippet(prompt: string | null, maxLen = 140) {
  const p = (prompt || "").trim().replaceAll(/\s+/g, " ");
  if (!p) return "No system prompt yet.";
  return p.length <= maxLen ? p : `${p.slice(0, maxLen - 1)}…`;
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border p-5 animate-pulse">
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

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<UUID | null>(null);

  // form state
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelName, setModelName] = useState<(typeof MODEL_OPTIONS)[number]["value"]>(
    MODEL_OPTIONS[0].value,
  );
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
    setModelName(MODEL_OPTIONS[0].value);
    setTemperature(0.7);
    setSelectedToolIds(new Set());
  }

  function openCreate() {
    resetForm();
    setDrawerOpen(true);
  }

  function openEdit(agent: AgentWithTools) {
    setEditingAgentId(agent.id);
    setName(agent.name || "");
    setSystemPrompt(agent.system_prompt || "");
    setModelName(
      (MODEL_OPTIONS.find((m) => m.value === agent.model_name)?.value ??
        MODEL_OPTIONS[0].value) as (typeof MODEL_OPTIONS)[number]["value"],
    );
    setTemperature(clamp(agent.temperature ?? 0.7, 0, 1));
    setSelectedToolIds(new Set(agent.explicitTools.map((t) => t.id)));
    setDrawerOpen(true);
  }

  async function loadAll({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const user = userRes.user;
      if (!user) {
        setAgents([]);
        setExplicitTools([]);
        setError("You’re not signed in. Please log in to manage agents.");
        return;
      }

      const [agentsRes, toolsRes] = await Promise.all([
        supabase
          .from("agents")
          .select("id,user_id,name,system_prompt,model_name,temperature,created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("tools")
          .select(
            "id,user_id,name,display_name,description,tool_type,connection_config",
          )
          .eq("user_id", user.id)
          .eq("tool_type", "explicit")
          .order("display_name", { ascending: true }),
      ]);

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
      const toolById = new Map(toolRows.map((t) => [t.id, t] as const));

      const toolsByAgent = new Map<UUID, ToolRow[]>();
      for (const at of agentToolRows) {
        const t = toolById.get(at.tool_id);
        if (!t) continue; // only show explicit tools (checkbox set) here
        const arr = toolsByAgent.get(at.agent_id) ?? [];
        arr.push(t);
        toolsByAgent.set(at.agent_id, arr);
      }

      const hydrated: AgentWithTools[] = agentRows.map((a) => ({
        ...a,
        explicitTools: toolsByAgent.get(a.id) ?? [],
      }));

      setAgents(hydrated);
    } catch (e: unknown) {
      setError(getErrorMessage(e) || "Failed to load agents.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    // Defer the async call to avoid strict "setState in effect" linting.
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
      setError("Agent name is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const user = userRes.user;
      if (!user) throw new Error("Not signed in.");

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
          .insert({
            user_id: user.id,
            ...payload,
          })
          .select("id")
          .single();
        if (insErr) throw insErr;
        agentId = (insData as { id: UUID } | null)?.id ?? null;
      }

      if (!agentId) throw new Error("Failed to resolve agent id.");

      // Rebind explicit tools in one sweep:
      // - delete existing explicit tool bindings
      // - insert selected ones
      const selected = Array.from(selectedToolIds);

      // Delete all bindings for this agent (safe + simple; implicit tools are not stored here)
      const { error: delErr } = await supabase
        .from("agent_tools")
        .delete()
        .eq("agent_id", agentId);
      if (delErr) throw delErr;

      if (selected.length > 0) {
        const rows = selected.map((tool_id) => ({ agent_id: agentId, tool_id }));
        const { error: bindErr } = await supabase
          .from("agent_tools")
          .insert(rows);
        if (bindErr) throw bindErr;
      }

      setDrawerOpen(false);
      resetForm();
      await loadAll({ silent: true });
    } catch (e: unknown) {
      setError(getErrorMessage(e) || "Failed to save agent.");
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
      if (!user) throw new Error("Not signed in.");

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
      setError(getErrorMessage(e) || "Failed to delete agent.");
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
    ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
    : "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6";

  const closeDialog = () => {
    setDrawerOpen(false);
    resetForm();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
                AI Agent Directory
              </h1>
              <p className="text-sm text-muted-foreground">
                Browse, search, and configure agents before adding them to a
                workflow canvas.
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleRefresh} disabled={refreshing} size="lg">
            {refreshing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Refreshing
              </>
            ) : (
              <>
                <SlidersHorizontal className="h-4 w-4" />
                Refresh
              </>
            )}
          </Button>
          <Button onClick={openCreate} size="lg">
            <Plus className="h-4 w-4" />
            Create Agent
          </Button>
        </div>
      </div>

      {/* Search + view toggle */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents by name…"
            className="pl-9 h-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex text-xs rounded-full border px-2 py-1">
            {filteredAgents.length} / {agents.length}
          </span>
          <Button
            variant={gridCompact ? "outline" : "secondary"}
            size="icon-sm"
            onClick={() => setGridCompact(false)}
            disabled={!gridCompact}
          >
            <Grid2X2 className="h-4 w-4" />
          </Button>
          <Button
            variant={gridCompact ? "secondary" : "outline"}
            size="icon-sm"
            onClick={() => setGridCompact(true)}
            disabled={gridCompact}
          >
            <LayoutList className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {/* Content */}
      {loading ? (
        <div className={gridCols}>
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
            <Bot className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="mt-4 text-lg font-semibold text-zinc-900">
            No agents yet
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Create your first agent, set its system prompt, pick a model, and
            grant explicit tool integrations.
          </div>
          <div className="mt-5 flex justify-center">
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Create Agent
            </Button>
          </div>
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="rounded-2xl border bg-card p-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
            <Search className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="mt-4 text-lg font-semibold text-zinc-900">
            No matching agents
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Try a different search term.
          </div>
          <div className="mt-5 flex justify-center">
            <Button variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        </div>
      ) : (
        <div className={gridCols}>
          {filteredAgents.map((agent) => (
            <Card key={agent.id} className="group">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{agent.name}</CardTitle>
                    <div className="mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs">
                      {modelLabel(agent.model_name)}
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs">
                    <Wrench className="h-3.5 w-3.5" />
                    {agent.explicitTools.length}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                    Temp: {formatTemp(clamp(agent.temperature ?? 0.7, 0, 1))}
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{promptSnippet(agent.system_prompt)}</p>
                <div className="flex flex-wrap gap-2">
                  {agent.explicitTools.length === 0 ? (
                    <span className="inline-flex rounded-full bg-muted px-2 py-1 text-xs">
                      No explicit tools
                    </span>
                  ) : (
                    agent.explicitTools.slice(0, 4).map((t) => (
                      <span key={t.id} className="inline-flex rounded-full bg-muted px-2 py-1 text-xs">
                        {toolLabel(t)}
                      </span>
                    ))
                  )}
                  {agent.explicitTools.length > 4 ? (
                    <span className="inline-flex rounded-full bg-muted px-2 py-1 text-xs">
                      +{agent.explicitTools.length - 4} more
                    </span>
                  ) : null}
                </div>
              </CardContent>

              <CardFooter className="justify-between">
                <Button variant="outline" onClick={() => openEdit(agent)}>
                  Modify Configuration
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" disabled={deletingId === agent.id}>
                      {deletingId === agent.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <MoreHorizontal className="h-4 w-4" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => openEdit(agent)}>
                      Modify Configuration
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => void deleteAgent(agent.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete Agent
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={drawerOpen} onOpenChange={(open) => (!open ? closeDialog() : setDrawerOpen(true))}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingAgentId ? "Modify Agent" : "Create Agent"}</DialogTitle>
            <DialogDescription>
              Configure persona, model settings, and explicit tool integrations.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Customer Support Assistant"
                className="h-9"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium">System Prompt</label>
                <span className="inline-flex rounded-full border px-2 py-1 text-xs">Persona + constraints</span>
              </div>
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Describe the agent's role, style, and boundaries…"
                rows={8}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">Model</label>
                <select
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value as (typeof MODEL_OPTIONS)[number]["value"])}
                  className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {MODEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm font-medium">Temperature</label>
                  <span className="inline-flex rounded-full border px-2 py-1 text-xs">
                    {formatTemp(temperature)}
                  </span>
                </div>
                <Slider
                  min={0}
                  max={1}
                  step={0.1}
                  value={[temperature]}
                  onValueChange={(v) => setTemperature(clamp(v[0] ?? 0.7, 0, 1))}
                />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>0.0 Deterministic</span>
                  <span>1.0 Creative</span>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Explicit tool integrations</div>
                  <div className="text-xs text-muted-foreground">
                    Bind/unbind real-world execution rights (email, webhooks, proxies).
                  </div>
                </div>
                <span className="inline-flex rounded-full bg-muted px-2 py-1 text-xs">
                  {selectedToolIds.size} selected
                </span>
              </div>

              {explicitTools.length === 0 ? (
                <div className="rounded-xl border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  No explicit tools available yet. Create tools first, then come back to grant them to an agent.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {explicitTools.map((t) => {
                    const checked = selectedToolIds.has(t.id);
                    return (
                      <label
                        key={t.id}
                        className={cn(
                          "flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors",
                          checked ? "border-primary bg-muted/40" : "hover:bg-muted/40",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleTool(t.id)}
                          className="mt-1 h-4 w-4 accent-primary"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="truncate text-sm font-semibold">{toolLabel(t)}</div>
                            <span className="inline-flex rounded-full border px-2 py-0.5 text-[10px]">
                              explicit
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t.description?.trim() ? t.description : "No description provided."}
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
            <div className="text-xs text-muted-foreground mr-auto">
              Implicit tools are always-on and don’t appear here.
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={closeDialog} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void upsertAgent()} disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving
                  </>
                ) : editingAgentId ? (
                  "Save Changes"
                ) : (
                  "Create Agent"
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
