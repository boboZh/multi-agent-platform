import React from "react";
import Link from "next/link";
import {
  LayoutDashboard,
  Bot,
  GitBranch,
  Terminal,
  Coins,
  Database,
} from "lucide-react";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const menuItems = [
    {
      name: "Dashboard",
      href: "/",
      icon: <LayoutDashboard size={18} />,
    },
    {
      name: "Agents",
      href: "/agents",
      icon: <Bot size={18} />,
    },
    {
      name: "Workflows",
      href: "/workflows",
      icon: <GitBranch size={18} />,
    },
    {
      name: "Execution Logs",
      href: "/logs",
      icon: <Terminal size={18} />,
    },
    {
      name: "Token Usage",
      href: "/usage",
      icon: <Coins size={18} />,
    },
  ];
  return (
    <div className="flex h-screen w-screen bg-zinc-50 overflow-hidden text-zinc-900 font-sans">
      {/* 🧭 PERSISTENT LEFT SIDEBAR */}
      <aside className="w-64 bg-white border-r border-zinc-200 flex flex-col justify-between p-4 shrink-0">
        <div className="space-y-6">
          {/* Platform Branding Logo Header */}
          <div className="px-2 py-1.5 flex items-center gap-2 font-bold text-lg tracking-tight border-b border-zinc-100 pb-4">
            <span className="w-6 h-6 rounded-lg bg-blue-600 flex items-center justify-center text-white text-xs">
              Ω
            </span>
            AgentEngine Studio
          </div>

          {/* Navigation Link Menu List */}
          <nav className="space-y-1">
            {menuItems.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100/80 transition-colors"
              >
                {item.icon}
                {item.name}
              </Link>
            ))}
          </nav>
        </div>

        {/* Future Extension Slot: Disabled/Hidden placeholder until you build Vector DB features */}
        <div className="border-t border-zinc-100 pt-4 opacity-50 pointer-events-none">
          <div className="flex items-center gap-3 px-3 py-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
            Coming Soon
          </div>
          <div className="flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg text-zinc-400">
            <Database size={18} />
            Knowledge Base
          </div>
        </div>
      </aside>

      {/* 🖥️ MAIN APPLICATION WORKSPACE VIEWPORTS */}
      <main className="flex-1 flex flex-col overflow-y-auto">
        <div className="p-8 max-w-7xl w-full mx-auto">
          {children}{" "}
          {/* 👈 This is where page.tsx, agents/page.tsx, etc., get rendered */}
        </div>
      </main>
    </div>
  );
}
