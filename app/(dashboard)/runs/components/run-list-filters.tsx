"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  LIST_STATUS_FILTERS,
  LIST_STATUS_LABELS,
  type ListStatusFilter,
} from "@/app/(dashboard)/runs/lib/status";

export function RunListFilters({
  status,
  flowId,
}: {
  status: ListStatusFilter | null;
  flowId: string;
}) {
  const router = useRouter();

  function push(nextStatus: ListStatusFilter | null) {
    const params = new URLSearchParams();
    if (nextStatus) params.set("status", nextStatus);
    if (flowId) params.set("flowId", flowId);
    const qs = params.toString();
    router.push(qs ? `/runs?${qs}` : "/runs");
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <Button
        type="button"
        size="sm"
        variant={status == null ? "default" : "outline"}
        onClick={() => push(null)}
      >
        全部
      </Button>
      {LIST_STATUS_FILTERS.map((key) => (
        <Button
          key={key}
          type="button"
          size="sm"
          variant={status === key ? "default" : "outline"}
          onClick={() => push(key)}
        >
          {LIST_STATUS_LABELS[key]}
        </Button>
      ))}
    </div>
  );
}
