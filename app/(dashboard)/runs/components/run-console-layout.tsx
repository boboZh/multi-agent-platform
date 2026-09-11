"use client";

import type { ReactNode } from "react";

export function RunConsoleLayout({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <section className="flex min-h-0 w-[42%] min-w-[320px] max-w-[560px] flex-col border-r border-primary/10">
        {left}
      </section>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">{right}</section>
    </div>
  );
}
