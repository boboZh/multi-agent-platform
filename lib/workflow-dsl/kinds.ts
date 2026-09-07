/** Stable DSL enumerations. Canvas `type` is visual; `kind` is what the compiler reads. */

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export const GRAPH_NODE_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const BRANCH_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const NODE_KINDS = [
  "start",
  "end",
  "agent",
  "tool",
  "condition",
  "human_review",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_TYPE_BY_KIND = {
  start: "startNode",
  end: "endNode",
  agent: "agentNode",
  tool: "toolNode",
  condition: "conditionNode",
  human_review: "interruptNode",
} as const satisfies Record<NodeKind, string>;

export type NodeType = (typeof NODE_TYPE_BY_KIND)[NodeKind];

export const NODE_TYPES = [
  NODE_TYPE_BY_KIND.start,
  NODE_TYPE_BY_KIND.end,
  NODE_TYPE_BY_KIND.agent,
  NODE_TYPE_BY_KIND.tool,
  NODE_TYPE_BY_KIND.condition,
  NODE_TYPE_BY_KIND.human_review,
] as const;

export const KIND_BY_NODE_TYPE = Object.fromEntries(
  NODE_KINDS.map((kind) => [NODE_TYPE_BY_KIND[kind], kind]),
) as Record<NodeType, NodeKind>;

export const EDGE_KINDS = ["normal", "branch"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const CONDITION_MODES = ["expression", "llm"] as const;
export type ConditionMode = (typeof CONDITION_MODES)[number];

export const REVIEW_FIELD_TYPES = ["text", "enum", "boolean"] as const;
export type ReviewFieldType = (typeof REVIEW_FIELD_TYPES)[number];

export type PortSpec = {
  /** Incoming handles. `0` = Start. */
  targets: 0 | 1;
  /** Outgoing handles. `branches` = one source handle per condition key. */
  sources: 0 | 1 | "branches";
  defaultOutgoingEdgeKind: EdgeKind | null;
};

export const NODE_PORT_SPEC: Record<NodeKind, PortSpec> = {
  start: { targets: 0, sources: 1, defaultOutgoingEdgeKind: "normal" },
  end: { targets: 1, sources: 0, defaultOutgoingEdgeKind: null },
  agent: { targets: 1, sources: 1, defaultOutgoingEdgeKind: "normal" },
  tool: { targets: 1, sources: 1, defaultOutgoingEdgeKind: "normal" },
  condition: {
    targets: 1,
    sources: "branches",
    defaultOutgoingEdgeKind: "branch",
  },
  human_review: { targets: 1, sources: 1, defaultOutgoingEdgeKind: "normal" },
};

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  start: "开始",
  end: "结束",
  agent: "智能体",
  tool: "工具",
  condition: "条件",
  human_review: "人工审核",
};

export const DEFAULT_CONDITION_BRANCHES = [
  { key: "yes", label: "是" },
  { key: "no", label: "否" },
] as const;

export const DEFAULT_AGENT_OUTPUT_KEY = "lastAgentText";

export type ConditionBranch = {
  key: string;
  label: string;
};

/** Shared LangGraph state shape (compiler Annotation). Not persisted on the document. */
export type WorkflowSharedState = {
  messages: unknown[];
  vars: Record<string, unknown>;
  lastAgentText: string;
  _route?: string;
};

export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}

export function isNodeType(value: string): value is NodeType {
  return value in KIND_BY_NODE_TYPE;
}

export function nodeTypeForKind(kind: NodeKind): NodeType {
  return NODE_TYPE_BY_KIND[kind];
}

export function kindForNodeType(type: NodeType): NodeKind {
  return KIND_BY_NODE_TYPE[type];
}

export function isGraphNodeId(value: string): boolean {
  return GRAPH_NODE_ID_RE.test(value);
}

export function isBranchKey(value: string): boolean {
  return BRANCH_KEY_RE.test(value);
}

export function defaultLabelForKind(kind: NodeKind): string {
  return NODE_KIND_LABELS[kind];
}

export function defaultConditionBranches(): ConditionBranch[] {
  return DEFAULT_CONDITION_BRANCHES.map((branch) => ({ ...branch }));
}
