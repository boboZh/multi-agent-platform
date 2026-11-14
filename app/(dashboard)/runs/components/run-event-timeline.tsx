"use client";

import { useEffect, useRef } from "react";
import { ChatMarkdown } from "@/app/(dashboard)/agents/components/chat-markdown";
import { nextAutoFollow } from "@/app/(dashboard)/runs/lib/auto-follow";
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const followingRef = useRef(true);
  const previousTopRef = useRef(0);
  const touchYRef = useRef<number | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let frame: number | null = null;
    const follow = () => {
      if (!followingRef.current || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!followingRef.current) return;
        // 只移动左侧容器；连续 token 不使用平滑动画，以免动画排队追不上正文。
        viewport.scrollTop = viewport.scrollHeight;
        previousTopRef.current = viewport.scrollTop;
      });
    };
    // token 拼接时事件条数不变，Markdown 也可能延后排版，因此观察实际内容高度。
    // 容器尺寸改变时同样重新贴底；用 ref 保存跟随状态，避免带动画布重新渲染。
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(viewport);
    follow();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      ref={viewportRef}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      style={{ overflowAnchor: "none" }}
      tabIndex={0}
      aria-label="运行输出"
      onScroll={(event) => {
        const viewport = event.currentTarget;
        followingRef.current = nextAutoFollow(
          followingRef.current, previousTopRef.current, viewport,
        );
        previousTopRef.current = viewport.scrollTop;
      }}
      onWheel={(event) => {
        if (event.deltaY < 0) followingRef.current = false;
      }}
      onTouchStart={(event) => {
        touchYRef.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY;
        if (y === undefined) return;
        if (touchYRef.current !== null && y > touchYRef.current) {
          followingRef.current = false;
        }
        touchYRef.current = y;
      }}
      onTouchEnd={() => { touchYRef.current = null; }}
      onTouchCancel={() => { touchYRef.current = null; }}
      onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key) ||
          (event.key === " " && event.shiftKey)) {
          followingRef.current = false;
        }
      }}
    >
      <ol ref={contentRef} className="space-y-1.5 text-[11px] leading-relaxed text-foreground/80">
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
