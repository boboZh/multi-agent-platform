"use client";

import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

function lineOf(event: WorkflowSseEvent): string {
  switch (event.type) {
    case "run_status":
      return `状态 → ${event.status}`;
    case "node_start":
      return `节点开始 ${event.nodeId}`;
    case "node_end":
      return `节点结束 ${event.nodeId}${event.text ? ` · ${event.text.slice(0, 80)}` : ""}`;
    case "token":
      return event.nodeId + ":" + event.content;
    case "tool_start":
      return `工具调用 ${event.name}`;
    case "tool_end":
      return `工具完成 ${event.name}`;
    case "interrupt":
      return `挂起 · ${event.payload.nodeId}`;
    case "error":
      return `错误：${event.message}`;
    case "done":
      return "流结束";
    default:
      return "";
  }
}

export function RunEventTimeline({ events }: { events: WorkflowSseEvent[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <ol className="space-y-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
        {events.length === 0 ? (
          <li className="text-muted-foreground">
            暂无事件。运行开始后会在这里流式输出。
          </li>
        ) : null}
        {events.map((event, index) => (
          <li
            key={`${event.type}-${index}`}
            className={
              event.type === "error"
                ? "text-destructive"
                : event.type === "interrupt"
                  ? "text-amber-800"
                  : event.type === "token"
                    ? "whitespace-pre-wrap text-foreground"
                    : "text-muted-foreground"
            }
          >
            <span className="mr-2 opacity-50">
              {String(index + 1).padStart(2, "0")}
            </span>
            {lineOf(event)}
          </li>
        ))}
      </ol>
    </div>
  );
}
