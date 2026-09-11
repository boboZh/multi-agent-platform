"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Activity, Loader2 } from "lucide-react";
import { RunListFilters } from "@/app/(dashboard)/runs/components/run-list-filters";
import {
  RunListTable,
  type RunListItem,
} from "@/app/(dashboard)/runs/components/run-list-table";
import {
  isListStatusFilter,
  type ListStatusFilter,
} from "@/app/(dashboard)/runs/lib/status";

function RunsPageInner() {
  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status");
  const status = isListStatusFilter(statusParam) ? statusParam : null;
  const flowId = searchParams.get("flowId")?.trim() ?? "";

  const [items, setItems] = useState<RunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (flowId) params.set("flowId", flowId);
    const qs = params.toString();
    return qs ? `/api/workflow/runs?${qs}` : "/api/workflow/runs";
  }, [status, flowId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(query);
        const payload = (await response.json()) as
          | { ok: true; items: RunListItem[] }
          | { ok: false; errors?: Array<{ message: string }> };
        if (cancelled) return;
        if (!payload.ok) {
          setError(payload.errors?.[0]?.message ?? "加载失败");
          return;
        }
        setItems(payload.items);
        setError(null);
      } catch {
        if (!cancelled) setError("加载运行列表失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Activity className="h-5 w-5" />
            运行监控
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按 thread 查看历史运行。进行中的记录会自动刷新。
          </p>
        </div>
      </header>
      <RunListFilters status={status as ListStatusFilter | null} flowId={flowId} />
      {error ? (
        <p className="mt-4 text-sm text-destructive">{error}</p>
      ) : null}
      <div className="mt-4">
        {loading && items.length === 0 ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <RunListTable items={items} />
        )}
      </div>
    </div>
  );
}

export default function RunsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-muted-foreground">加载中…</div>
      }
    >
      <RunsPageInner />
    </Suspense>
  );
}
