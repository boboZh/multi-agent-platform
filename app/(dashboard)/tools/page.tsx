"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Loader2,
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
import { Input } from "@/components/ui/input";
import type { ToolRow, UUID } from "@/app/(dashboard)/agents/lib/types";
import { getErrorMessage, toolLabel } from "@/app/(dashboard)/agents/lib/utils";
import { summarizeExecutor } from "@/lib/agent-runtime/tool-config";
import { ToolEditorDialog } from "./components/tool-editor-dialog";

/**
 * 工具目录：在这里声明 HTTP / 静态 JSON，运行时按 connection_config 生成函数。
 * 只列 explicit。implicit 由运行时注入，放进目录会被人改掉检索类能力。
 */
export default function ToolsPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [query, setQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ToolRow | null>(null);
  const [deletingId, setDeletingId] = useState<UUID | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool) => {
      const label = toolLabel(tool).toLowerCase();
      return label.includes(q) || tool.name.toLowerCase().includes(q);
    });
  }, [tools, query]);

  async function loadAll({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
    try {
      const { data, error: loadErr } = await supabase
        .from("tools")
        .select(
          "id,user_id,name,display_name,description,tool_type,connection_config",
        )
        .eq("user_id", mockUserId)
        .eq("tool_type", "explicit")
        .order("display_name", { ascending: true });
      if (loadErr) throw loadErr;
      setTools((data || []) as ToolRow[]);
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "加载工具失败。");
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

  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(tool: ToolRow) {
    setEditing(tool);
    setEditorOpen(true);
  }

  /**
   * 先删 agent_tools 再删 tools。中间表还指着这条工具时，数据库会拒绝删除。
   */
  async function deleteTool(toolId: UUID) {
    if (deletingId) return;
    setDeletingId(toolId);
    setError(null);
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
    try {
      const { error: unbindErr } = await supabase
        .from("agent_tools")
        .delete()
        .eq("tool_id", toolId);
      if (unbindErr) throw unbindErr;

      const { error: delErr } = await supabase
        .from("tools")
        .delete()
        .eq("id", toolId)
        .eq("user_id", mockUserId);
      if (delErr) throw delErr;
      await loadAll({ silent: true });
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "删除工具失败。");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/25">
              <Wrench className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                工具目录
              </h1>
              <p className="text-sm text-muted-foreground">
                用 URL 模板或静态 JSON 声明工具。绑定到智能体后，模型会按这里的参数调用。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                setRefreshing(true);
                void loadAll({ silent: true }).finally(() => setRefreshing(false));
              }}
              disabled={refreshing}
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
              创建工具
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/15 bg-card p-4">
          <div className="relative w-full sm:max-w-md">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-primary/70" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按名称搜索工具…"
              className="h-9 border-primary/20 pl-9 focus-visible:border-primary focus-visible:ring-primary/30"
            />
          </div>
          <span className="rounded-full border border-primary/20 bg-primary/5 px-2 py-1 text-xs font-medium text-primary">
            {filtered.length} / {tools.length}
          </span>
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-xl border border-primary/10 bg-muted/40"
              />
            ))}
          </div>
        ) : tools.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-primary/25 bg-card p-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <Wrench className="h-6 w-6 text-primary" />
            </div>
            <div className="mt-4 text-lg font-semibold">暂无工具</div>
            <div className="mt-1 text-sm text-muted-foreground">
              创建一个 HTTP 工具或静态 JSON 工具，再回到智能体里绑定。
            </div>
            <div className="mt-5 flex justify-center">
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                创建工具
              </Button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-primary/15 bg-card p-10 text-center">
            <div className="text-lg font-semibold">未找到匹配的工具</div>
            <Button variant="outline" className="mt-4" onClick={() => setQuery("")}>
              清除搜索
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((tool) => (
              <Card key={tool.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="truncate">{toolLabel(tool)}</CardTitle>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {tool.name}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="line-clamp-3 text-sm text-muted-foreground">
                    {tool.description?.trim() || "暂无说明。"}
                  </p>
                  <div className="truncate rounded-full border border-primary/15 bg-primary/5 px-2 py-1 font-mono text-xs text-primary">
                    {summarizeExecutor(tool.connection_config)}
                  </div>
                </CardContent>
                <CardFooter className="justify-between">
                  <Button variant="outline" onClick={() => openEdit(tool)}>
                    修改配置
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={deletingId === tool.id}
                    aria-label={`删除 ${toolLabel(tool)}`}
                    onClick={() => void deleteTool(tool.id)}
                  >
                    {deletingId === tool.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}

        <ToolEditorDialog
          open={editorOpen}
          tool={editing}
          onOpenChange={setEditorOpen}
          onSaved={() => loadAll({ silent: true })}
        />
      </div>
    </div>
  );
}
