"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  GitBranch,
  Grid2X2,
  LayoutList,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
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
import { cn } from "@/lib/utils";
import type { UUID } from "@/lib/workflow-dsl/tables";
import { FLOW_SELECT_COLUMNS, type FlowRecord } from "./types";
import {
  descriptionSnippet,
  flowDisplayName,
  flowStatusLabel,
  formatRelativeTime,
  getErrorMessage,
  summarizeFlowDsl,
  type FlowDslSummary,
} from "./utils";

/**
 * 工作流目录：只做「读 + 删 + 入口」。
 *
 * 新增与编辑一律跳到 /workflows/[id] 编辑器页 —— 工作流的可编辑内容是整张图（节点、连线、
 * 分支配置），塞进列表弹窗既放不下也无法校验拓扑，所以这里不出现任何表单。
 */

/** 列表用派生视图：把「每行要跑一次 Zod」的结果缓存下来，见下方 useMemo 说明。 */
type FlowListItem = {
  flow: FlowRecord;
  summary: FlowDslSummary;
  updatedLabel: string;
};

/** DSL 徽标的语义色：invalid 必须显眼，因为点进编辑器会得到一张画不出来的图。 */
const DSL_BADGE_TONE: Record<FlowDslSummary["state"], string> = {
  empty: "border-muted-foreground/20 bg-muted text-muted-foreground",
  valid: "border-primary/25 bg-primary/10 text-primary",
  invalid: "border-amber-500/30 bg-amber-500/10 text-amber-700",
};

/** 首屏骨架：块高对齐真实卡片，避免加载完成时网格塌陷跳动。 */
function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-xl border border-primary/10 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-4 w-40 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
        <div className="h-6 w-16 rounded-full bg-muted" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-4/6 rounded bg-muted" />
      </div>
      <div className="mt-4 flex gap-2">
        <div className="h-6 w-24 rounded-full bg-muted" />
        <div className="h-6 w-20 rounded-full bg-muted" />
      </div>
      <div className="mt-5 h-9 w-full rounded bg-muted" />
    </div>
  );
}

export default function WorkflowsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [flows, setFlows] = useState<FlowRecord[]>([]);
  const [query, setQuery] = useState("");
  const [gridCompact, setGridCompact] = useState(false);
  const [deletingId, setDeletingId] = useState<UUID | null>(null);

  /**
   * 派生一次就够的重活：summarizeFlowDsl 内部要跑 Zod 解析，
   * 相对时间也需要一个稳定的「现在」。只依赖 flows，这样在搜索框里逐字输入
   * 不会把每行 DSL 重新解析一遍，也不会让时间文案在两次渲染间跳动。
   */
  const items = useMemo<FlowListItem[]>(() => {
    const now = new Date();
    return flows.map((flow) => ({
      flow,
      summary: summarizeFlowDsl(flow.dsl),
      updatedLabel: formatRelativeTime(flow.updated_at, now),
    }));
  }, [flows]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    // 名称 + 描述都参与匹配：工作流常被起成「流程 A / 流程 B」，只搜名称几乎搜不到东西。
    return items.filter(({ flow }) => {
      const name = flowDisplayName(flow.name).toLowerCase();
      const desc = (flow.description ?? "").toLowerCase();
      return name.includes(q) || desc.includes(q);
    });
  }, [items, query]);

  /**
   * 拉当前 mock 用户的工作流目录。
   *
   * 入参：`silent` — true 时不切全页 loading（刷新/返回后重载），避免网格被骨架闪一下。
   * 出参：写入 `flows`；失败只写 `error`，保留旧列表让用户还能操作。
   * 步骤：按 user_id 过滤 → updated_at 倒序（命中 flows_user_updated_at_idx）→ 原样存行，
   *       DSL 的解析留给 useMemo，不在网络回调里做 CPU 活。
   */
  async function loadAll({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    setError(null);
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
    try {
      const { data, error: selectErr } = await supabase
        .from("flows")
        .select(FLOW_SELECT_COLUMNS)
        .eq("user_id", mockUserId)
        .order("updated_at", { ascending: false });
      if (selectErr) throw selectErr;
      setFlows((data || []) as FlowRecord[]);
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "加载工作流失败。");
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
   * 删除工作流。
   *
   * flow_runs 对 flows 是 `on delete restrict`，直接删父行会被外键挡住；
   * flow_versions 是 `on delete cascade`，不用手动清。所以顺序固定为「先删运行记录、再删定义」——
   * 运行历史属于这张流程，流程没了留着孤儿记录也没有查询入口。
   * `deletingId` 作互斥锁，防止连点菜单对同一行发两次 delete。
   */
  async function deleteFlow(flowId: UUID) {
    if (deletingId) return;
    setDeletingId(flowId);
    setError(null);
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
    try {
      const { error: delRunsErr } = await supabase
        .from("flow_runs")
        .delete()
        .eq("flow_id", flowId);
      if (delRunsErr) throw delRunsErr;

      const { error: delFlowErr } = await supabase
        .from("flows")
        .delete()
        .eq("id", flowId)
        .eq("user_id", mockUserId);
      if (delFlowErr) throw delFlowErr;

      await loadAll({ silent: true });
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "删除工作流失败。");
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
                <GitBranch className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  智能体工作流
                </h1>
                <p className="text-sm text-muted-foreground">
                  浏览已保存的编排；新增与编辑都在画布编辑器里完成。
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
            {/* 入口按钮：不在列表建行，交给编辑器决定「保存时才落库」。 */}
            <Button asChild size="lg">
              <Link href="/workflows/new">
                <Plus className="h-4 w-4" />
                创建工作流
              </Link>
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-primary/15 bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-md">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-primary/70" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按名称或描述搜索工作流…"
              className="h-9 border-primary/20 pl-9 focus-visible:border-primary focus-visible:ring-primary/30"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-primary/20 bg-primary/5 px-2 py-1 text-xs font-medium text-primary sm:inline-flex">
              {filteredItems.length} / {flows.length}
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
        ) : flows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-primary/25 bg-card p-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <GitBranch className="h-6 w-6 text-primary" />
            </div>
            <div className="mt-4 text-lg font-semibold text-foreground">
              暂无工作流
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              创建第一条编排：在画布上串起智能体、条件分支与人工审核节点。
            </div>
            <div className="mt-5 flex justify-center">
              <Button asChild>
                <Link href="/workflows/new">
                  <Plus className="h-4 w-4" />
                  创建工作流
                </Link>
              </Button>
            </div>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="rounded-2xl border border-primary/15 bg-card p-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <Search className="h-6 w-6 text-primary" />
            </div>
            <div className="mt-4 text-lg font-semibold text-foreground">
              未找到匹配的工作流
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
            {filteredItems.map(({ flow, summary, updatedLabel }) => (
              <Card
                key={flow.id}
                className="group cursor-pointer transition-shadow hover:shadow-md hover:ring-1 hover:ring-primary/20"
                onClick={() => router.push(`/workflows/${flow.id}`)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate">
                        {flowDisplayName(flow.name)}
                      </CardTitle>
                      <div className="mt-1 inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {flowStatusLabel(flow.status)} · v{flow.version}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium",
                        DSL_BADGE_TONE[summary.state],
                      )}
                    >
                      {summary.state === "invalid" ? (
                        <TriangleAlert className="h-3.5 w-3.5" />
                      ) : null}
                      {summary.state === "empty"
                        ? "尚未编排"
                        : summary.state === "invalid"
                          ? "DSL 待迁移"
                          : `${summary.nodeCount} 节点 · ${summary.edgeCount} 边`}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    最近更新：{updatedLabel}
                  </div>
                </CardHeader>

                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {descriptionSnippet(flow.description, "暂无描述。")}
                  </p>
                </CardContent>

                <CardFooter
                  className="justify-between"
                  // 卡片本身跳编辑器；底部按钮必须拦住冒泡，否则「删除」会先被路由走掉。
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    asChild
                    variant="outline"
                    className="border-primary/30 text-primary hover:bg-primary/10 hover:text-primary"
                  >
                    <Link href={`/workflows/${flow.id}`}>
                      <Pencil className="h-4 w-4" />
                      编辑编排
                    </Link>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={deletingId === flow.id}
                        aria-label="工作流操作"
                      >
                        {deletingId === flow.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <MoreHorizontal className="h-4 w-4" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem asChild>
                        <Link href={`/workflows/${flow.id}`}>
                          <Pencil className="h-4 w-4" />
                          编辑编排
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => void deleteFlow(flow.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                        删除工作流
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
