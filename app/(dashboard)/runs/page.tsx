"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Loader2 } from "lucide-react";
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
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (flowId) params.set("flowId", flowId);
    params.set("page", String(page));
    params.set("pageSize", String(RUN_LIST_PAGE_SIZE));
    return `/api/workflow/runs?${params.toString()}`;
  }, [status, flowId, page]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(query);
        const payload = (await response.json()) as
          | {
              ok: true;
              items: RunListItem[];
              page: number;
              total: number;
              totalPages: number;
            }
          | { ok: false; errors?: Array<{ message: string }> };
        if (cancelled) return;
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
  }, [query, page, status, flowId, router]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
      <header className="mb-5 shrink-0">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="h-5 w-5" />
          运行监控
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          按 thread 查看历史运行。进行中的记录会自动刷新。
        </p>
      </header>
      <div className="shrink-0">
        <RunListFilters status={status as ListStatusFilter | null} flowId={flowId} />
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
