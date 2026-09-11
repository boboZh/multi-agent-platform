"use client";

import type { NodeStateView } from "@/lib/workflow-runtime/node-state";
import { Button } from "@/components/ui/button";

export function RunNodeStatePanel({
  nodeId,
  state,
  loading,
  canRetry,
  retrying,
  onRetry,
}: {
  nodeId: string;
  state: NodeStateView | null | undefined;
  loading: boolean;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="max-h-56 shrink-0 overflow-y-auto border-t border-primary/10 bg-card px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-medium">节点状态 · {nodeId}</div>
        {canRetry ? (
          <Button type="button" size="xs" variant="outline" disabled={retrying} onClick={onRetry}>
            {retrying ? "重试中" : "从此节点重试"}
          </Button>
        ) : null}
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">读取 checkpoint…</p>
      ) : state == null ? (
        <p className="text-xs text-muted-foreground">尚未执行</p>
      ) : (
        <div className="space-y-2 font-mono text-[11px]">
          {state.checkpointTs ? (
            <div className="text-muted-foreground">{state.checkpointTs}</div>
          ) : null}
          <div>
            <div className="text-muted-foreground">lastAgentText</div>
            <pre className="whitespace-pre-wrap break-all">{state.lastAgentText || "—"}</pre>
          </div>
          <div>
            <div className="text-muted-foreground">vars</div>
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(state.vars, null, 2)}
            </pre>
          </div>
          {state.messagesPreview.length > 0 ? (
            <div>
              <div className="text-muted-foreground">messages</div>
              {state.messagesPreview.map((line, index) => (
                <p key={index} className="truncate">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
