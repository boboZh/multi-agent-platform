import { parseWorkflowDocument } from "@/lib/workflow-dsl/schema";
import { FLOW_STATUSES, type FlowStatus } from "@/lib/workflow-dsl/tables";

/**
 * DSL 健康度。列表页据此告诉用户「这张图能不能直接进编辑器」：
 * - empty：刚建好还没编排，编辑器会给它铺一张 start→end 空图。
 * - valid：能过 draft 校验，可原样 round-trip 回画布。
 * - invalid：有内容但不符合当前 schemaVersion（多为旧 flow_data 迁过来的 Demo 数据），
 *   直接喂给画布会渲染出没有 position/kind 的坏节点，所以必须在列表就标出来。
 */
export type FlowDslState = "empty" | "valid" | "invalid";

export type FlowDslSummary = {
  state: FlowDslState;
  nodeCount: number;
  edgeCount: number;
};

/** 只统计数组长度，非数组一律按 0，避免旧数据把 undefined.length 抛进渲染。 */
function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * 判定一行 flows.dsl 的可用状态，并给出节点/边数量。
 *
 * 入参：`dsl` — 库里的 jsonb，可能是 `{}`、合法 Document，或旧版 flow_data 结构。
 * 出参：`FlowDslSummary`。
 * 步骤：
 * 1. 先排除 null / 非对象 / 空对象 —— 这是「新建未编排」，不算错误，不该标红。
 * 2. 走 draft 校验（只卡文档形状，不卡拓扑），通过就用解析结果的数量，保证与编辑器口径一致。
 * 3. 不通过则回落到防御式计数，让用户至少看到「里面有几个节点」再决定是否重建。
 */
export function summarizeFlowDsl(dsl: unknown): FlowDslSummary {
  if (!dsl || typeof dsl !== "object" || Array.isArray(dsl)) {
    return { state: "empty", nodeCount: 0, edgeCount: 0 };
  }

  const record = dsl as Record<string, unknown>;
  if (Object.keys(record).length === 0) {
    return { state: "empty", nodeCount: 0, edgeCount: 0 };
  }

  const parsed = parseWorkflowDocument(dsl, "draft");
  if (parsed.ok) {
    return {
      state: "valid",
      nodeCount: parsed.document.nodes.length,
      edgeCount: parsed.document.edges.length,
    };
  }

  return {
    state: "invalid",
    nodeCount: countArray(record.nodes),
    edgeCount: countArray(record.edges),
  };
}

export function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return null;
}

const FLOW_STATUS_LABELS: Record<FlowStatus, string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
};

/** status 是自由文本列（仅有 CHECK 约束），手工改库可能写进未知值，展示层必须兜底。 */
export function isFlowStatus(value: string | null | undefined): value is FlowStatus {
  return FLOW_STATUSES.includes(value as FlowStatus);
}

export function flowStatusLabel(status: string | null | undefined) {
  return isFlowStatus(status) ? FLOW_STATUS_LABELS[status] : "未知状态";
}

/** name 允许被改成空白串；列表不能出现无字卡片，否则用户找不到入口点哪张。 */
export function flowDisplayName(name: string | null | undefined) {
  const trimmed = (name ?? "").trim();
  return trimmed || "未命名工作流";
}

/**
 * 描述摘要：压扁空白后截断，避免长描述把网格撑成参差行高（与 agents 的 promptSnippet 同口径）。
 */
export function descriptionSnippet(
  description: string | null | undefined,
  emptyLabel: string,
  maxLen = 120,
) {
  const text = (description || "").trim().replaceAll(/\s+/g, " ");
  if (!text) return emptyLabel;
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}

/**
 * 「最近更新」相对时间。
 *
 * 入参：`iso` — updated_at；`now` — 由调用方注入，便于测试且避免同一次渲染内多次取 Date.now 产生不一致文案。
 * 出参：中文相对时间；无法解析时返回 "—"，不要让 Invalid Date 漏到卡片上。
 * 步骤：解析 → 负差值（库时钟快于浏览器）按「刚刚」处理 → 按分/时/天分档 → 超过 7 天退化为绝对日期。
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const thenMs = then.getTime();
  if (Number.isNaN(thenMs)) return "—";

  const diffMs = now.getTime() - thenMs;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays <= 7) return `${diffDays} 天前`;

  return then.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
