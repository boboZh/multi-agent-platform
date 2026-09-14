"use client";

import { useRouter } from "next/navigation";
import { RunStatusBadge } from "@/app/(dashboard)/runs/components/run-status-badge";
import { formatRelativeTime } from "@/app/(dashboard)/workflows/utils";
import type { FlowRunRow } from "@/lib/workflow-dsl/tables";

export type RunListItem = FlowRunRow & { flowName: string };

function truncateThread(threadId: string) {
  if (threadId.length <= 12) return threadId;
  return `${threadId.slice(0, 8)}…`;
}

export function RunListTable({ items }: { items: RunListItem[] }) {
  const router = useRouter();
  if (items.length === 0) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center rounded-xl border border-dashed border-primary/20 px-6 py-16 text-center text-sm text-muted-foreground">
        还没有运行记录。从已发布的工作流点「运行」后会出现在这里。
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto rounded-xl border border-primary/10 bg-card">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 border-b border-primary/10 bg-muted text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">工作流</th>
            <th className="px-4 py-2.5 font-medium">版本</th>
            <th className="px-4 py-2.5 font-medium">thread</th>
            <th className="px-4 py-2.5 font-medium">状态</th>
            <th className="px-4 py-2.5 font-medium">更新</th>
            <th className="px-4 py-2.5 font-medium">错误</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className="cursor-pointer border-b border-primary/5 last:border-0 hover:bg-muted/40"
              onClick={() => router.push(`/runs/${item.id}`)}
            >
              <td className="px-4 py-3">
                <div className="font-medium">{item.flowName}</div>
                {item.status === "interrupted" ? (
                  <div className="mt-0.5 text-[11px] text-amber-700">待干预</div>
                ) : null}
              </td>
              <td className="px-4 py-3 text-muted-foreground">v{item.flow_version}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {truncateThread(item.thread_id)}
              </td>
              <td className="px-4 py-3">
                <RunStatusBadge status={item.status} />
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {formatRelativeTime(item.updated_at)}
              </td>
              <td className="max-w-[220px] truncate px-4 py-3 text-xs text-destructive">
                {item.error ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
