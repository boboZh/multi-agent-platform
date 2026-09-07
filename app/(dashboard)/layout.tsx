"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  GitBranch,
  Database,
  PanelLeftClose,
  PanelLeftOpen,
  FlipHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const pathname = usePathname();

  const menuItems = [
    {
      name: "智能体",
      href: "/agents",
      icon: <Bot size={18} />,
    },
    {
      name: "智能体工作流",
      href: "/workflows",
      icon: <GitBranch size={18} />,
    },
    {
      name: "flow-demo",
      href: "/flowDemo",
      icon: <FlipHorizontal size={18} />,
    },
  ];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-50 font-sans text-zinc-900">
      <aside
        className={cn(
          "flex shrink-0 flex-col justify-between border-r border-zinc-200 bg-white transition-[width,padding] duration-200 ease-out",
          sidebarExpanded ? "w-64 p-4" : "w-16 items-center px-2 py-3",
        )}
      >
        <div
          className={cn(
            "flex flex-col",
            sidebarExpanded ? "space-y-6" : "items-center gap-3",
          )}
        >
          <div
            className={cn(
              "flex items-center border-b border-zinc-100",
              sidebarExpanded
                ? "gap-2 px-2 py-1.5 pb-4"
                : "flex-col gap-2 pb-3",
            )}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white">
              MMA
            </span>
            {sidebarExpanded ? (
              <span className="flex-1 truncate text-lg font-bold tracking-tight">
                Multi-Agent Collaboration
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="relative shrink-0"
              onClick={() => setSidebarExpanded((open) => !open)}
              aria-label={sidebarExpanded ? "关闭边栏" : "打开边栏"}
            >
              {sidebarExpanded ? <PanelLeftClose /> : <PanelLeftOpen />}
              <span className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity group-hover/button:opacity-100">
                {sidebarExpanded ? "关闭边栏" : "打开边栏"}
              </span>
            </Button>
          </div>

          <nav
            className={cn(
              "space-y-1",
              !sidebarExpanded && "flex flex-col items-center",
            )}
          >
            {menuItems.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.name}
                  aria-label={item.name}
                  className={cn(
                    "group relative flex items-center rounded-lg text-sm font-medium transition-colors",
                    sidebarExpanded
                      ? "gap-3 px-3 py-2.5"
                      : "h-9 w-9 justify-center",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900",
                  )}
                >
                  {item.icon}
                  {sidebarExpanded ? (
                    item.name
                  ) : (
                    <span className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                      {item.name}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div
          className={cn(
            "border-t border-zinc-100 opacity-50",
            sidebarExpanded
              ? "pointer-events-none pt-4"
              : "flex justify-center pt-3",
          )}
        >
          {sidebarExpanded ? (
            <>
              <div className="mb-1 flex items-center gap-3 px-3 py-2 text-xs font-semibold tracking-wider text-zinc-400 uppercase">
                Coming Soon
              </div>
              <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-400">
                <Database size={18} />
                知识库
              </div>
            </>
          ) : (
            <div className="group relative flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400">
              <Database size={18} />
              <span className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                知识库
              </span>
            </div>
          )}
        </div>
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
