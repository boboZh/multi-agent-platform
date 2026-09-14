"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { visiblePageItems } from "@/app/(dashboard)/runs/lib/pagination";

export function RunListPagination({
  page,
  total,
  totalPages,
  onPageChange,
}: {
  page: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (total <= 0) return null;

  const items = visiblePageItems(page, totalPages);

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-primary/10 pt-3">
      <p className="text-xs text-muted-foreground">共 {total} 条</p>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={page <= 1}
          aria-label="上一页"
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
        </Button>
        {items.map((item, index) =>
          item === "ellipsis" ? (
            <span
              key={`ellipsis-${index}`}
              className="px-1.5 text-xs text-muted-foreground"
            >
              …
            </span>
          ) : (
            <Button
              key={item}
              type="button"
              size="icon-sm"
              variant={item === page ? "default" : "outline"}
              aria-current={item === page ? "page" : undefined}
              onClick={() => onPageChange(item)}
            >
              {item}
            </Button>
          ),
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          disabled={page >= totalPages}
          aria-label="下一页"
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
