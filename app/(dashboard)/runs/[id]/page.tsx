"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RunConsoleLayout } from "@/app/(dashboard)/runs/components/run-console-layout";
import { RunEventTimeline } from "@/app/(dashboard)/runs/components/run-event-timeline";
import { RunInterruptForm } from "@/app/(dashboard)/runs/components/run-interrupt-form";
import { RunNodeStatePanel } from "@/app/(dashboard)/runs/components/run-node-state-panel";
import { RunStatusBadge } from "@/app/(dashboard)/runs/components/run-status-badge";
import { reduceRunEvents } from "@/app/(dashboard)/runs/lib/event-reducer";
import { deriveHighlight } from "@/app/(dashboard)/runs/lib/highlight";
import { useRunConsoleStore } from "@/app/(dashboard)/runs/store/run-console-store";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";
import type { FlowRunRow } from "@/lib/workflow-dsl/tables";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";
import { isWorkflowSseEvent } from "@/lib/workflow-runtime/sse";
import type { NodeStateView } from "@/lib/workflow-runtime/node-state";

const RunCanvas = dynamic(
  () =>
    import("@/app/(dashboard)/runs/components/run-canvas").then(
      (mod) => mod.RunCanvas,
    ),
  { ssr: false },
);

type Snapshot = {
  ok: true;
  run: FlowRunRow;
  dsl: WorkflowDocument;
  flowName: string;
  events: WorkflowSseEvent[];
};

function liveStatuses(status: string | undefined) {
  return status === "pending" || status === "running";
}

export default function RunConsolePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const hydrate = useRunConsoleStore((s) => s.hydrate);
  const applyEvent = useRunConsoleStore((s) => s.applyEvent);
  const reset = useRunConsoleStore((s) => s.reset);
  const setConnection = useRunConsoleStore((s) => s.setConnection);
  const selectNode = useRunConsoleStore((s) => s.selectNode);
  const putNodeState = useRunConsoleStore((s) => s.putNodeState);
  const run = useRunConsoleStore((s) => s.run);
  const dsl = useRunConsoleStore((s) => s.dsl);
  const flowName = useRunConsoleStore((s) => s.flowName);
  const events = useRunConsoleStore((s) => s.events);
  const interrupt = useRunConsoleStore((s) => s.interrupt);
  const selectedNodeId = useRunConsoleStore((s) => s.selectedNodeId);
  const nodeStateCache = useRunConsoleStore((s) => s.nodeStateCache);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [stateLoading, setStateLoading] = useState(false);
  const [sseNonce, setSseNonce] = useState(0);

  // 获取运行详情：流基本信息、运行信息
  useEffect(() => {
    reset();
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(`/api/workflow/runs/${id}`);
        const payload = (await response.json()) as
          | Snapshot
          | { ok: false; errors?: Array<{ message: string }> };
        if (cancelled) return;
        if (!payload.ok) {
          setError(payload.errors?.[0]?.message ?? "加载失败");
          return;
        }
        hydrate(payload);
        setError(null);
      } catch {
        if (!cancelled) setError("加载运行失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      reset();
    };
  }, [id, hydrate, reset]);

  const status = run?.status;

  useEffect(() => {
    if (!run || !liveStatuses(status)) return;
    let stopped = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const open = () => {
      if (stopped) return;
      const after = useRunConsoleStore.getState().lastEventId;
      const url =
        after > 0
          ? `/api/workflow/runs/${id}/events?after=${after}`
          : `/api/workflow/runs/${id}/events`;
      const es = new EventSource(url);
      source = es;
      setConnection("streaming");
      es.onmessage = (message) => {
        attempt = 0;
        try {
          const parsed: unknown = JSON.parse(message.data);
          if (!isWorkflowSseEvent(parsed)) return;
          const eventId = Number.parseInt(message.lastEventId, 10);
          applyEvent(parsed, Number.isFinite(eventId) ? eventId : undefined);
          if (parsed.type === "done") {
            stopped = true;
            es.close();
            setConnection("idle");
          }
        } catch {
          // 单帧坏 JSON 忽略
        }
      };
      es.onerror = () => {
        if (stopped) return;
        // CONNECTING：浏览器正在自带重连，不要 close 再 new，否则 /events 编译请求会叠成进程风暴。
        if (es.readyState === EventSource.CONNECTING) {
          setConnection("reconnecting");
          return;
        }
        es.close();
        source = null;
        setConnection("reconnecting");
        const delay = Math.min(2000 * 2 ** attempt, 15_000);
        attempt += 1;
        retryTimer = setTimeout(open, delay);
      };
    };

    open();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      setConnection("idle");
    };
  }, [id, run?.id, status, sseNonce, applyEvent, setConnection]);

  const reduced = useMemo(() => reduceRunEvents(events), [events]);
  const highlight = useMemo(
    () => deriveHighlight(status, reduced),
    [status, reduced]
  );

  useEffect(() => {
    if (!selectedNodeId) return;
    let cancelled = false;
    setStateLoading(true);
    void fetch(`/api/workflow/runs/${id}/nodes/${selectedNodeId}/state`)
      .then((response) => response.json())
      .then((payload: { ok: boolean; state?: NodeStateView | null }) => {
        if (cancelled || !payload.ok) return;
        putNodeState(selectedNodeId, payload.state ?? null);
      })
      .finally(() => {
        if (!cancelled) setStateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, selectedNodeId, putNodeState, status]);

  const handleResume = useCallback(
    async (resume: Record<string, unknown>) => {
      setSubmitting(true);
      setError(null);
      try {
        const response = await fetch(`/api/workflow/runs/${id}/resume`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resume }),
        });
        const payload = (await response.json()) as
          | { ok: true; run: FlowRunRow }
          | { ok: false; errors?: Array<{ message: string }> };
        if (!payload.ok) {
          setError(payload.errors?.[0]?.message ?? "resume 失败");
          return;
        }
        hydrate({
          run: payload.run,
          dsl: useRunConsoleStore.getState().dsl!,
          flowName: useRunConsoleStore.getState().flowName,
          events: useRunConsoleStore.getState().events,
        });
        setSseNonce((n) => n + 1);
      } finally {
        setSubmitting(false);
      }
    },
    [id, hydrate]
  );

  const handleRetry = useCallback(async () => {
    if (!selectedNodeId) return;
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(`/api/workflow/runs/${id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: selectedNodeId }),
      });
      const payload = (await response.json()) as
        | { ok: true; run: FlowRunRow }
        | { ok: false; errors?: Array<{ message: string }> };
      if (!payload.ok) {
        setError(payload.errors?.[0]?.message ?? "重试失败");
        return;
      }
      hydrate({
        run: payload.run,
        dsl: useRunConsoleStore.getState().dsl!,
        flowName: useRunConsoleStore.getState().flowName,
        events: useRunConsoleStore.getState().events,
      });
      setSseNonce((n) => n + 1);
    } finally {
      setRetrying(false);
    }
  }, [id, selectedNodeId, hydrate]);

  const canRetry =
    Boolean(selectedNodeId) &&
    (status === "failed" ||
      (status === "interrupted" && interrupt?.nodeId === selectedNodeId));

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!run || !dsl) {
    return (
      <div className="p-6 text-sm text-destructive">
        {error ?? "运行不存在"}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-primary/15 bg-card px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon-sm" aria-label="返回列表">
            <Link href="/runs">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">
              {flowName || "工作流运行"}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              v{run.flow_version} · {run.thread_id}
            </div>
          </div>
        </div>
        <RunStatusBadge status={run.status} />
      </header>
      {error ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <RunConsoleLayout
        left={
          <>
            <RunEventTimeline events={events} />
            {run.status === "interrupted" && interrupt ? (
              <RunInterruptForm
                payload={interrupt}
                submitting={submitting}
                onSubmit={handleResume}
              />
            ) : null}
          </>
        }
        right={
          <>
            <RunCanvas
              dsl={dsl}
              highlight={highlight}
              selectedNodeId={selectedNodeId}
              onSelectNode={selectNode}
            />
            {selectedNodeId ? (
              <RunNodeStatePanel
                nodeId={selectedNodeId}
                state={nodeStateCache[selectedNodeId]}
                loading={stateLoading}
                canRetry={canRetry}
                retrying={retrying}
                onRetry={handleRetry}
              />
            ) : null}
          </>
        }
      />
    </div>
  );
}
