"use client";

import {
  Bot,
  CircleStop,
  GitBranch,
  GitFork,
  Merge,
  UserCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { NODE_KIND_LABELS, type NodeKind } from "@/lib/workflow-dsl/kinds";

/** 拖拽时写进 dataTransfer 的私有 MIME，避免和页面上其它拖放源（文件、文本）混淆。 */
export const NODE_KIND_MIME = "application/x-workflow-node-kind";

/**
 * 可拖入画布的节点类型。
 * 不含 start：整张图只允许一个入口，start 由空图模板铺好，多一个就会让 graph 校验直接失败。
 */
const PALETTE_ITEMS: Array<{
  kind: NodeKind;
  icon: LucideIcon;
  hint: string;
}> = [
  { kind: "agent", icon: Bot, hint: "调用已配置的智能体" },
  { kind: "tool", icon: Wrench, hint: "单次结构化工具调用" },
  { kind: "condition", icon: GitBranch, hint: "表达式或 LLM 路由分支" },
  { kind: "fork", icon: GitFork, hint: "并行扇出，可增删通道" },
  { kind: "join", icon: Merge, hint: "等待全部完成" },
  { kind: "human_review", icon: UserCheck, hint: "挂起等待人工填表" },
  { kind: "end", icon: CircleStop, hint: "接到流程终点" },
];

/**
 * 左侧节点面板。
 *
 * 同时支持拖拽和点击：拖拽能决定落点，点击则由画布放在视口中心。
 * 只给拖拽会让触控板不熟练的用户加不了节点，只给点击又没法控制布局。
 */
export function NodePalette({
  onAdd,
  disabled,
}: {
  onAdd: (kind: NodeKind) => void;
  disabled?: boolean;
}) {
  return (
    <aside className="flex w-52 shrink-0 flex-col gap-2 overflow-y-auto border-r border-primary/15 bg-card p-3">
      <div className="px-1 text-xs font-medium tracking-wide text-muted-foreground">
        节点
      </div>
      {PALETTE_ITEMS.map(({ kind, icon: Icon, hint }) => (
        <button
          key={kind}
          type="button"
          draggable={!disabled}
          disabled={disabled}
          onDragStart={(event) => {
            event.dataTransfer.setData(NODE_KIND_MIME, kind);
            event.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => onAdd(kind)}
          className="group flex cursor-grab items-start gap-2 rounded-lg border border-transparent bg-background p-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50 active:cursor-grabbing"
        >
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {NODE_KIND_LABELS[kind]}
            </span>
            <span className="block text-[11px] leading-tight text-muted-foreground">
              {hint}
            </span>
          </span>
        </button>
      ))}
      <p className="mt-1 px-1 text-[11px] leading-relaxed text-muted-foreground">
        拖到画布上放置，或直接点击添加到视图中央。
      </p>
    </aside>
  );
}
