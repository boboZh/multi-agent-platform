"use client";

import { useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MODEL_LABELS } from "./types";
import { formatTemp, toolLabel } from "./utils";
import type { ToolRow } from "./types";
import type { ConversationThread } from "./thread-types";

type ThreadConfigDrawerProps = {
  open: boolean;
  thread: ConversationThread | null;
  availableTools: ToolRow[];
  applying?: boolean;
  onClose: () => void;
  onReuse: () => void;
};

export function ThreadConfigDrawer({
  open,
  thread,
  availableTools,
  applying,
  onClose,
  onReuse,
}: ThreadConfigDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const config = thread?.config;
  const boundTools = availableTools.filter((tool) =>
    config?.selectedToolIds.includes(tool.id),
  );

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 bg-black/20"
        aria-label="关闭配置抽屉"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[380px] flex-col border-l bg-card shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">对话配置</div>
            <div className="truncate text-xs text-muted-foreground">
              {thread?.title || "未选择对话"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          {config ? (
            <>
              <Field label="名称" value={config.name || "未命名"} />
              <Field
                label="模型"
                value={MODEL_LABELS[config.modelName] ?? config.modelName}
              />
              <Field label="温度" value={formatTemp(config.temperature)} />
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  系统提示词
                </div>
                <pre className="whitespace-pre-wrap rounded-xl border bg-muted/40 p-3 text-xs leading-5">
                  {config.systemPrompt.trim() || "（空）"}
                </pre>
              </div>
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">
                  显式工具
                </div>
                {boundTools.length === 0 ? (
                  <p className="text-xs text-muted-foreground">未绑定工具</p>
                ) : (
                  <ul className="space-y-2">
                    {boundTools.map((tool) => (
                      <li
                        key={tool.id}
                        className="rounded-xl border px-3 py-2 text-xs"
                      >
                        <div className="font-medium">{toolLabel(tool)}</div>
                        <div className="mt-0.5 text-muted-foreground">
                          {tool.description?.trim() || "暂无描述"}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">没有可展示的配置。</p>
          )}
        </div>

        <div className="border-t p-4">
          <Button
            className="w-full"
            disabled={!config || applying}
            onClick={onReuse}
          >
            {applying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                应用中
              </>
            ) : (
              "复用参数"
            )}
          </Button>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}
