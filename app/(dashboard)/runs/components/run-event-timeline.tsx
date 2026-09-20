"use client";

import { ChatMarkdown } from "@/app/(dashboard)/agents/components/chat-markdown";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

function lineOf(event: Exclude<WorkflowSseEvent, { type: "token" }>): string {
  switch (event.type) {
    case "run_status":
      return `状态 → ${event.status}`;
    case "node_start":
      return `节点开始 ${event.nodeId}`;
    case "node_end":
      return `节点结束 ${event.nodeId}${event.text ? ` · ${event.text.slice(0, 80)}` : ""}`;
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

function EventIndex({ n }: { n: number }) {
  return (
    <span className="mr-2 font-mono opacity-50">
      {String(n).padStart(2, "0")}
    </span>
  );
}

export function RunEventTimeline({ events }: { events: WorkflowSseEvent[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <ol className="space-y-1.5 text-[11px] leading-relaxed text-foreground/80">
        {events.length === 0 ? (
          <li className="font-mono text-muted-foreground">
            暂无事件。运行开始后会在这里流式输出。
          </li>
        ) : null}
        {events.map((event, index) => {
          if (event.type === "token") {
            return (
              <li
                key={`${event.type}-${index}`}
                className="text-foreground"
              >
                <div className="mb-1 font-mono text-muted-foreground">
                  <EventIndex n={index + 1} />
                  {event.nodeId ?? "token"}
                </div>
                {/* 分桶后的整段模型输出才走 Markdown；控制事件仍当日志，避免 node_start 被解析成标题。 */}
                <div className="overflow-x-auto">
                  <ChatMarkdown content={event.content} />
                </div>
              </li>
            );
          }

          return (
            <li
              key={`${event.type}-${index}`}
              className={
                event.type === "error"
                  ? "font-mono text-destructive"
                  : event.type === "interrupt"
                    ? "font-mono text-amber-800"
                    : "font-mono text-muted-foreground"
              }
            >
              <EventIndex n={index + 1} />
              {lineOf(event)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
