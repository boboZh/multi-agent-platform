"use client";

import { createContext, memo, useContext } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  Bot,
  CircleStop,
  GitBranch,
  GitFork,
  Merge,
  Play,
  UserCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  NODE_KIND_LABELS,
  NODE_PORT_SPEC,
  type NodeKind,
} from "@/lib/workflow-dsl/kinds";
import type { WorkflowNodeData } from "@/lib/workflow-dsl/schema";
import { cn } from "@/lib/utils";

/**
 * 画布节点。各 kind 共用一个渲染器：端口数量与语义完全由 data.kind 决定，
 * 拆成多个组件只会让「条件 / Fork 动态 handle」这段逻辑散落多处。
 * nodeTypes 在模块作用域定义并导出，避免每次渲染换新对象导致 reactflow 整图重挂。
 */

/**
 * 校验错误锚点。用 context 而不是塞进 node.data：
 * data 是要落库的 DSL，把瞬时的校验状态写进去会污染文档，还会让 dirty 判定误报。
 */
export const NodeIssuesContext = createContext<ReadonlySet<string>>(new Set());

/**
 * agentId / toolId → 展示名。节点卡上要显示「绑定了哪个智能体」，
 * 但 DSL 里只存 UUID，名字得由编辑器查表后从外面传进来。
 */
export const NodeRefNamesContext = createContext<ReadonlyMap<string, string>>(
  new Map(),
);

/**
 * 运行监控画布高亮。默认全空，编辑器不传就不会有脉冲边框。
 * 不塞进 node.data：那是 DSL，运行态一写进去会和编辑器文档搅在一起。
 */
export type RunNodeHighlight = {
  currentNodeId: string | null;
  doneNodeIds: ReadonlySet<string>;
  failedNodeId: string | null;
  interruptedNodeId: string | null;
};

export const RunHighlightContext = createContext<RunNodeHighlight>({
  currentNodeId: null,
  doneNodeIds: new Set(),
  failedNodeId: null,
  interruptedNodeId: null,
});

const KIND_ICONS: Record<NodeKind, LucideIcon> = {
  start: Play,
  end: CircleStop,
  agent: Bot,
  tool: Wrench,
  condition: GitBranch,
  human_review: UserCheck,
  fork: GitFork,
  join: Merge,
};

const HANDLE_CLASS =
  "!h-2.5 !w-2.5 !rounded-full !border-2 !border-background !bg-primary";

/** 节点卡上的一行摘要：让用户不点开抽屉也能看出这个节点配没配全。 */
function summaryOf(
  data: WorkflowNodeData,
  refNames: ReadonlyMap<string, string>,
): { text: string; muted: boolean } {
  switch (data.kind) {
    case "agent": {
      const id = data.config.agentId;
      if (!id) return { text: "未绑定智能体", muted: true };
      return { text: refNames.get(id) ?? "已绑定智能体", muted: false };
    }
    case "tool": {
      const id = data.config.toolId;
      if (!id) return { text: "未绑定工具", muted: true };
      return { text: refNames.get(id) ?? "已绑定工具", muted: false };
    }
    case "condition":
      return {
        text:
          data.config.mode === "expression"
            ? data.config.expression
            : `LLM 路由 · ${data.config.modelName}`,
        muted: false,
      };
    case "human_review":
      return {
        text: `${data.config.title} · ${data.config.formFields.length} 个字段`,
        muted: false,
      };
    case "start": {
      // 发布快照可能是 variables 落地前的旧 DSL，config 里没有这个字段。
      const count = data.config.variables?.length ?? 0;
      return count === 0
        ? { text: "无入参", muted: true }
        : { text: `${count} 个入参`, muted: false };
    }
    case "fork":
      return {
        text: `${data.config.lanes.length} 条通道`,
        muted: false,
      };
    case "join":
      return { text: "等待全部完成", muted: false };
    case "end":
      return { text: "", muted: true };
  }
}

function WorkflowNodeCardImpl({ id, data, selected }: NodeProps<WorkflowNodeData>) {
  const issues = useContext(NodeIssuesContext);
  const refNames = useContext(NodeRefNamesContext);
  const highlight = useContext(RunHighlightContext);
  const hasIssue = issues.has(id);
  const isCurrent = highlight.currentNodeId === id;
  const isDone = highlight.doneNodeIds.has(id);
  const isFailed = highlight.failedNodeId === id;
  const isInterrupted = highlight.interruptedNodeId === id;
  const Icon = KIND_ICONS[data.kind];
  const summary = summaryOf(data, refNames);

  // 端口有无一律读 NODE_PORT_SPEC，和连线校验用的是同一张表，不会出现「画得出但连不上」。
  const spec = NODE_PORT_SPEC[data.kind];
  // Fork / Condition 都是 named source；共用同一套均分 Handle，差别只在边 kind。
  const namedSources =
    data.kind === "condition"
      ? data.config.branches
      : data.kind === "fork"
        ? data.config.lanes
        : [];

  return (
    <div
      className={cn(
        "min-w-[190px] max-w-[260px] rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-colors",
        selected
          ? "border-primary ring-2 ring-primary/30"
          : "border-foreground/10",
        hasIssue && !selected && "border-destructive/60 ring-2 ring-destructive/20",
        isCurrent && "animate-pulse border-blue-500 ring-2 ring-blue-400/40",
        isDone && !isCurrent && "border-emerald-500/70",
        isFailed && "border-destructive ring-2 ring-destructive/30",
        isInterrupted && "border-amber-500 ring-2 ring-amber-400/40",
      )}
    >
      {spec.targets !== 0 ? (
        <Handle
          type="target"
          position={Position.Top}
          className={HANDLE_CLASS}
        />
      ) : null}

      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {data.label}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {NODE_KIND_LABELS[data.kind]}
          </div>
        </div>
      </div>

      {summary.text ? (
        <div
          className={cn(
            "mt-2 truncate rounded-md bg-muted/60 px-2 py-1 text-[11px]",
            summary.muted ? "text-muted-foreground italic" : "text-foreground/80",
          )}
          title={summary.text}
        >
          {summary.text}
        </div>
      ) : null}

      {namedSources.length > 0 ? (
        <>
          {/* 通道/分支名要贴着各自的端口显示，否则多出口时用户分不清哪条线是哪个 key。 */}
          <div className="mt-2 flex justify-between gap-1 text-[10px] text-muted-foreground">
            {namedSources.map((port) => (
              <span key={port.key} className="truncate" title={port.key}>
                {port.label || port.key}
              </span>
            ))}
          </div>
          {namedSources.map((port, index) => (
            <Handle
              key={port.key}
              id={port.key}
              type="source"
              position={Position.Bottom}
              style={{ left: `${((index + 1) / (namedSources.length + 1)) * 100}%` }}
              className={HANDLE_CLASS}
            />
          ))}
        </>
      ) : spec.sources !== 0 ? (
        // 不带 id 的 source handle → 连接时 sourceHandle 为 null，正是非 named 边的约定。
        <Handle
          type="source"
          position={Position.Bottom}
          className={HANDLE_CLASS}
        />
      ) : null}
    </div>
  );
}

const WorkflowNodeCard = memo(WorkflowNodeCardImpl);

/** 画布 type 全部指向同一个渲染器；语义差异在组件内部按 data.kind 分流。 */
export const workflowNodeTypes = {
  startNode: WorkflowNodeCard,
  endNode: WorkflowNodeCard,
  agentNode: WorkflowNodeCard,
  toolNode: WorkflowNodeCard,
  conditionNode: WorkflowNodeCard,
  interruptNode: WorkflowNodeCard,
  forkNode: WorkflowNodeCard,
  joinNode: WorkflowNodeCard,
};
