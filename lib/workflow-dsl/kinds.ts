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
  "fork",
  "join",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_TYPE_BY_KIND = {
  start: "startNode",
  end: "endNode",
  agent: "agentNode",
  tool: "toolNode",
  condition: "conditionNode",
  human_review: "interruptNode",
  fork: "forkNode",
  join: "joinNode",
} as const satisfies Record<NodeKind, string>;

export type NodeType = (typeof NODE_TYPE_BY_KIND)[NodeKind];

export const NODE_TYPES = [
  NODE_TYPE_BY_KIND.start,
  NODE_TYPE_BY_KIND.end,
  NODE_TYPE_BY_KIND.agent,
  NODE_TYPE_BY_KIND.tool,
  NODE_TYPE_BY_KIND.condition,
  NODE_TYPE_BY_KIND.human_review,
  NODE_TYPE_BY_KIND.fork,
  NODE_TYPE_BY_KIND.join,
] as const;

export const KIND_BY_NODE_TYPE = Object.fromEntries(
  NODE_KINDS.map((kind) => [NODE_TYPE_BY_KIND[kind], kind])
) as Record<NodeType, NodeKind>;

export const EDGE_KINDS = ["normal", "branch", "lane"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const CONDITION_MODES = ["expression", "llm"] as const;
export type ConditionMode = (typeof CONDITION_MODES)[number];

export const REVIEW_FIELD_TYPES = ["text", "enum", "boolean"] as const;
export type ReviewFieldType = (typeof REVIEW_FIELD_TYPES)[number];

/** Start 节点入参类型；运行弹窗按这个渲染控件并写入 state.vars[key]。 */
export const START_VARIABLE_TYPES = ["string", "number", "boolean"] as const;
export type StartVariableType = (typeof START_VARIABLE_TYPES)[number];

export const START_VARIABLE_TYPE_LABELS: Record<StartVariableType, string> = {
  string: "字符串",
  number: "数字",
  boolean: "布尔",
};

export type PortSpec = {
  /**
   * 入端口数量语义，不是「第 N 号端口」。
   * `0` = 不渲染入点（Start）；`1` = 渲染一个 handle（不限制该 handle 上能接几条边）；
   * `"many"` = Join：一个 handle，明确允许多条入边，真正的 AND 汇合由编译器数组 addEdge 实现。
   */
  targets: 0 | 1 | "many";
  /**
   * 出端口。`branches` = 每个 condition key 一个 source；
   * `lanes` = 每个 fork lane key 一个 source（AND 扇出，不能复用 branch）。
   */
  sources: 0 | 1 | "branches" | "lanes";
  defaultOutgoingEdgeKind: EdgeKind | null;
};

// 边是有方向的：source：边从哪里来；target：边到哪里去
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
  fork: { targets: 1, sources: "lanes", defaultOutgoingEdgeKind: "lane" },
  join: { targets: "many", sources: 1, defaultOutgoingEdgeKind: "normal" },
};

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  start: "开始",
  end: "结束",
  agent: "智能体",
  tool: "工具",
  condition: "条件",
  human_review: "人工审核",
  fork: "并行扇出",
  join: "等待汇合",
};

/** 画布 Handle 与并发的双重护栏；lane 数是 Fork 配置，不是平台常量。 */
export const MIN_FORK_LANES = 2;
export const MAX_FORK_LANES = 16;

export const JOIN_WAIT_MODES = ["all"] as const;
export type JoinWaitMode = (typeof JOIN_WAIT_MODES)[number];
export const DEFAULT_JOIN_WAIT = "all" satisfies JoinWaitMode;

export const DEFAULT_FORK_LANES = [
  { key: "lane_1", label: "通道 1" },
  { key: "lane_2", label: "通道 2" },
] as const;

export const DEFAULT_CONDITION_BRANCHES = [
  { key: "yes", label: "是" },
  { key: "no", label: "否" },
] as const;

export const DEFAULT_AGENT_OUTPUT_KEY = "lastAgentText";

export type ConditionBranch = {
  key: string;
  label: string;
};

/** key 与 BRANCH_KEY_RE 相同；数组内必须去重。无业务语义，拖入时默认两条。 */
export type ForkLane = {
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

export function isLaneKey(value: string): boolean {
  return isBranchKey(value);
}

export function defaultLabelForKind(kind: NodeKind): string {
  return NODE_KIND_LABELS[kind];
}

export function defaultConditionBranches(): ConditionBranch[] {
  return DEFAULT_CONDITION_BRANCHES.map((branch) => ({ ...branch }));
}

export function defaultForkLanes(): ForkLane[] {
  return DEFAULT_FORK_LANES.map((lane) => ({ ...lane }));
}
