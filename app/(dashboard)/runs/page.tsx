"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Loader2, RefreshCw } from "lucide-react";
import { RunListFilters } from "@/app/(dashboard)/runs/components/run-list-filters";
import { RunListPagination } from "@/app/(dashboard)/runs/components/run-list-pagination";
import {
  RunListTable,
  type RunListItem,
} from "@/app/(dashboard)/runs/components/run-list-table";
import {
  parseRunListPagination,
  RUN_LIST_PAGE_SIZE,
} from "@/app/(dashboard)/runs/lib/pagination";
import {
  isListStatusFilter,
  type ListStatusFilter,
} from "@/app/(dashboard)/runs/lib/status";
import { Button } from "@/components/ui/button";

function runsListHref(input: {
  status: ListStatusFilter | null;
  flowId: string;
  page: number;
}) {
  const params = new URLSearchParams();
  if (input.status) params.set("status", input.status);
  if (input.flowId) params.set("flowId", input.flowId);
  if (input.page > 1) params.set("page", String(input.page));
  const qs = params.toString();
  return qs ? `/runs?${qs}` : "/runs";
}

function RunsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const statusParam = searchParams.get("status");
  const status = isListStatusFilter(statusParam) ? statusParam : null;
  const flowId = searchParams.get("flowId")?.trim() ?? "";
  const { page } = parseRunListPagination({
    page: searchParams.get("page"),
  });

  const [items, setItems] = useState<RunListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (flowId) params.set("flowId", flowId);
    params.set("page", String(page));
    params.set("pageSize", String(RUN_LIST_PAGE_SIZE));
    return `/api/workflow/runs?${params.toString()}`;
  }, [status, flowId, page]);

  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      try {
        const response = await fetch(query, { cache: "no-store", signal: ac.signal });
        const payload = (await response.json()) as
          | {
              ok: true;
              items: RunListItem[];
              page: number;
              total: number;
              totalPages: number;
            }
          | { ok: false; errors?: Array<{ message: string }> };
        if (ac.signal.aborted) return;
        if (!payload.ok) {
          setError(payload.errors?.[0]?.message ?? "加载失败");
          return;
        }
        setItems(payload.items);
        setTotal(payload.total);
        setTotalPages(payload.totalPages);
        setError(null);
        // 服务端夹页后同步 URL，避免刷新后又打到空页。
        if (payload.page !== page) {
          router.replace(runsListHref({ status, flowId, page: payload.page }));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("加载运行列表失败");
      } finally {
        if (!ac.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [query, page, status, flowId, router],
  );

  useEffect(() => {
    void load("initial");
    return () => abortRef.current?.abort();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
      <header className="mb-5 shrink-0">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="h-5 w-5" />
          运行监控
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          按 thread 查看历史运行。最新状态请手动刷新。
        </p>
      </header>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <RunListFilters status={status as ListStatusFilter | null} flowId={flowId} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || refreshing}
          onClick={() => void load("refresh")}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          刷新
        </Button>
      </div>
      {error ? (
        <p className="mt-4 shrink-0 text-sm text-destructive">{error}</p>
      ) : null}
      <div className="mt-4 min-h-0 flex-1 overflow-hidden">
        {loading && items.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <RunListTable items={items} />
        )}
      </div>
      <div className="mt-3 shrink-0">
        <RunListPagination
          page={page}
          total={total}
          totalPages={totalPages}
          onPageChange={(next) =>
            router.push(runsListHref({ status, flowId, page: next }))
          }
        />
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
