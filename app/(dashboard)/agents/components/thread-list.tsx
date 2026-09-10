"use client";

import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConversationThread } from "../lib/thread-types";

type ThreadListProps = {
  threads: ConversationThread[];
  activeThreadId: string | null;
  loading?: boolean;
  /** 流式或拉 history 时锁住切换/新建，避免两个 SSE/两个 history 请求交叉写同一条 thread。 */
  disabled?: boolean;
  onSelect: (threadId: string) => void;
  onNew: () => void;
};

function formatThreadTime(iso: string) {
  const date = new Date(iso);
  // 坏时间戳直接藏掉，避免把 Invalid Date 渲到侧栏。
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ThreadList({
  threads,
  activeThreadId,
  loading,
  disabled,
  onSelect,
  onNew,
}: ThreadListProps) {
  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-3">
        <div className="text-sm font-medium">对话列表</div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={onNew}
          aria-label="发起新对话"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="animate-pulse space-y-2 p-1  ">
            <div className="h-12 rounded-xl bg-muted" />
            <div className="h-12 rounded-xl bg-muted" />
            <div className="h-12 rounded-xl bg-muted" />
          </div>
        ) : threads.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            暂无对话
          </p>
        ) : (
          <div className="space-y-1">
            {threads.map((thread) => {
              const active = thread.threadId === activeThreadId;
              return (
                <button
                  key={thread.threadId}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(thread.threadId)}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                      : "border-transparent hover:bg-primary/5",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <div className="truncate text-sm font-medium">
                    {thread.title}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {formatThreadTime(thread.createdAt)}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
