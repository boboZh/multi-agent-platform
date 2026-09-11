"use client";

import { cn } from "@/lib/utils";
import { runStatusLabel } from "@/app/(dashboard)/runs/lib/status";

const TONE: Record<string, string> = {
  pending: "border-blue-500/30 bg-blue-500/10 text-blue-700",
  running: "border-blue-500/30 bg-blue-500/10 text-blue-700",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  interrupted: "border-amber-500/30 bg-amber-500/10 text-amber-800",
  cancelled: "border-muted-foreground/20 bg-muted text-muted-foreground",
};

export function RunStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        TONE[status] ?? "border-muted-foreground/20 bg-muted text-muted-foreground",
      )}
    >
      {runStatusLabel(status)}
    </span>
  );
}
