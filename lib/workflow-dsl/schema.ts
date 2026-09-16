import { z } from "zod";
import {
  BRANCH_KEY_RE,
  DEFAULT_AGENT_OUTPUT_KEY,
  EDGE_KINDS,
  GRAPH_NODE_ID_RE,
  NODE_KIND_LABELS,
  NODE_KINDS,
  NODE_PORT_SPEC,
  DEFAULT_JOIN_WAIT,
  MAX_FORK_LANES,
  MIN_FORK_LANES,
  NODE_TYPE_BY_KIND,
  NODE_TYPES,
  REVIEW_FIELD_TYPES,
  START_VARIABLE_TYPES,
  WORKFLOW_SCHEMA_VERSION,
  defaultConditionBranches,
  defaultForkLanes,
  type NodeKind,
} from "@/lib/workflow-dsl/kinds";
import {
  analyzeForkJoinRegions,
  collectRegionWriteIssues,
} from "@/lib/workflow-dsl/fork-join-regions";

export const graphNodeIdSchema = z
  .string()
  .min(1)
  .regex(GRAPH_NODE_ID_RE, "节点 id 须符合 [a-zA-Z_][a-zA-Z0-9_]*");

export const branchKeySchema = z
  .string()
  .min(1)
  .regex(BRANCH_KEY_RE, "分支 key 须符合 [a-zA-Z_][a-zA-Z0-9_]*");

export const nodeKindSchema = z.enum(NODE_KINDS);
export const nodeTypeSchema = z.enum(NODE_TYPES);
export const edgeKindSchema = z.enum(EDGE_KINDS);

const uuidSchema = z.string().uuid();

export const nodeUiSchema = z
  .object({
    accentColor: z.string().optional(),
    icon: z.string().optional(),
  })
  .passthrough();

export const startVariableSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "变量 key 须为标识符"),
  label: z.string().min(1),
  type: z.enum(START_VARIABLE_TYPES),
  required: z.boolean().default(true),
});

/**
 * Start 入参写在 config.variables，运行时变成 state.vars。
 * 允许空数组：没有入参的流程点「运行」不必弹窗。
 * key 去重是为了防止两行抢同一个 vars 槽，运行表单也会渲染成两个同名输入。
 */
export const startConfigSchema = z
  .object({
    variables: z.array(startVariableSchema).default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, variable] of config.variables.entries()) {
      if (seen.has(variable.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `入参 key 重复: ${variable.key}`,
          path: ["variables", index, "key"],
        });
      }
      seen.add(variable.key);
    }
  });

export const endConfigSchema = z.object({}).strict();

export const agentConfigSchema = z.object({
  agentId: uuidSchema.optional(),
  inputMap: z.record(z.string(), z.string()).optional(),
  outputKey: z.string().min(1).default(DEFAULT_AGENT_OUTPUT_KEY),
});

export const toolConfigSchema = z.object({
  toolId: uuidSchema.optional(),
  inputMap: z.record(z.string(), z.string()).optional(),
  outputKey: z.string().min(1).optional(),
});

export const conditionBranchSchema = z.object({
  key: branchKeySchema,
  label: z.string().min(1),
});

const conditionBranchesSchema = z
  .array(conditionBranchSchema)
  .min(2, "条件节点至少需要两个分支")
  .superRefine((branches, ctx) => {
    const seen = new Set<string>();
    for (const [index, branch] of branches.entries()) {
      if (seen.has(branch.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `分支 key 重复: ${branch.key}`,
          path: [index, "key"],
        });
      }
      seen.add(branch.key);
    }
  });

const conditionBaseConfigSchema = z.object({
  branches: conditionBranchesSchema,
  defaultBranch: branchKeySchema,
});

export const conditionExpressionConfigSchema = conditionBaseConfigSchema.extend(
  {
    mode: z.literal("expression"),
    expression: z.string().min(1, "表达式不能为空"),
  }
);

export const conditionLlmConfigSchema = conditionBaseConfigSchema.extend({
  mode: z.literal("llm"),
  modelName: z.string().min(1),
  prompt: z.string().min(1, "路由提示词不能为空"),
  temperature: z.number().min(0).max(2).optional(),
});

export const conditionConfigSchema = z
  .discriminatedUnion("mode", [
    conditionExpressionConfigSchema,
    conditionLlmConfigSchema,
  ])
  .superRefine((config, ctx) => {
    const keys = new Set(config.branches.map((branch) => branch.key));
    if (!keys.has(config.defaultBranch)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "defaultBranch 必须是某个 branches[].key",
        path: ["defaultBranch"],
      });
    }
  });

export const reviewFormFieldSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "表单字段名须为标识符"),
    type: z.enum(REVIEW_FIELD_TYPES),
    label: z.string().min(1).optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().min(1)).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === "enum" && (!field.options || field.options.length < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "enum 字段必须提供 options",
        path: ["options"],
      });
    }
  });

export const humanReviewConfigSchema = z.object({
  title: z.string().min(1),
  formFields: z.array(reviewFormFieldSchema).min(1),
});

export const forkLaneSchema = z.object({
  key: branchKeySchema,
  label: z.string().min(1),
});

/**
 * lanes 数是画布配置，不是业务常量：下限 2 才能构成并行，上限 16 挡住 Handle 重叠与并发尖峰。
 * joinId 只是可选断言，不是控制流边；配对是否成立留给后续区域校验。
 */
export const forkConfigSchema = z
  .object({
    lanes: z
      .array(forkLaneSchema)
      .min(MIN_FORK_LANES, `Fork 至少需要 ${MIN_FORK_LANES} 条通道`)
      .max(MAX_FORK_LANES, `Fork 最多 ${MAX_FORK_LANES} 条通道`)
      .superRefine((lanes, ctx) => {
        const seen = new Set<string>();
        for (const [index, lane] of lanes.entries()) {
          if (seen.has(lane.key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `通道 key 重复: ${lane.key}`,
              path: [index, "key"],
            });
          }
          seen.add(lane.key);
        }
      }),
    joinId: graphNodeIdSchema.optional(),
  })
  .strict();

export const joinConfigSchema = z
  .object({
    wait: z.literal(DEFAULT_JOIN_WAIT),
  })
  .strict();

export const startNodeDataSchema = z.object({
  kind: z.literal("start"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: startConfigSchema,
});

export const endNodeDataSchema = z.object({
  kind: z.literal("end"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: endConfigSchema,
});

export const agentNodeDataSchema = z.object({
  kind: z.literal("agent"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: agentConfigSchema,
});

export const toolNodeDataSchema = z.object({
  kind: z.literal("tool"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: toolConfigSchema,
});

export const conditionNodeDataSchema = z.object({
  kind: z.literal("condition"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: conditionConfigSchema,
});

export const humanReviewNodeDataSchema = z.object({
  kind: z.literal("human_review"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: humanReviewConfigSchema,
});

export const forkNodeDataSchema = z.object({
  kind: z.literal("fork"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: forkConfigSchema,
});

export const joinNodeDataSchema = z.object({
  kind: z.literal("join"),
  label: z.string().min(1),
  ui: nodeUiSchema.optional(),
  config: joinConfigSchema,
});

export const nodeDataSchema = z.discriminatedUnion("kind", [
  startNodeDataSchema,
  endNodeDataSchema,
  agentNodeDataSchema,
  toolNodeDataSchema,
  conditionNodeDataSchema,
  humanReviewNodeDataSchema,
  forkNodeDataSchema,
  joinNodeDataSchema,
]);

const reactFlowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const workflowNodeSchema = z
  .object({
    id: graphNodeIdSchema,
    type: nodeTypeSchema,
    position: reactFlowPositionSchema,
    data: nodeDataSchema,
    style: z.record(z.string(), z.unknown()).optional(),
    className: z.string().optional(),
    hidden: z.boolean().optional(),
    draggable: z.boolean().optional(),
    selectable: z.boolean().optional(),
    connectable: z.boolean().optional(),
    zIndex: z.number().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
  })
  .superRefine((node, ctx) => {
    const expected = NODE_TYPE_BY_KIND[node.data.kind];
    if (node.type !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `节点 type 应为 ${expected}（kind=${node.data.kind}）`,
        path: ["type"],
        params: { nodeId: node.id },
      });
    }
  });

export const normalEdgeDataSchema = z.object({
  kind: z.literal("normal"),
});

export const branchEdgeDataSchema = z.object({
  kind: z.literal("branch"),
  branchKey: branchKeySchema,
});

export const laneEdgeDataSchema = z.object({
  kind: z.literal("lane"),
  laneKey: branchKeySchema,
});

export const edgeDataSchema = z.discriminatedUnion("kind", [
  normalEdgeDataSchema,
  branchEdgeDataSchema,
  laneEdgeDataSchema,
]);

export const workflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: graphNodeIdSchema,
  target: graphNodeIdSchema,
  sourceHandle: z.string().min(1).optional().nullable(),
  targetHandle: z.string().min(1).optional().nullable(),
  label: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  animated: z.boolean().optional(),
  style: z.record(z.string(), z.unknown()).optional(),
  data: edgeDataSchema.default({ kind: "normal" }),
});

export const workflowViewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().positive(),
});

const workflowDocumentFields = {
  $schema: z.string().optional(),
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  id: uuidSchema.optional(),
  name: z.string().min(1),
  startNodeId: graphNodeIdSchema,
  viewport: workflowViewportSchema.optional(),
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(workflowEdgeSchema),
};

/** Structural document: safe to persist incomplete drafts. */
export const workflowDocumentShapeSchema = z.object(workflowDocumentFields);

export type WorkflowDocument = z.infer<typeof workflowDocumentShapeSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowNodeData = z.infer<typeof nodeDataSchema>;
export type WorkflowEdgeData = z.infer<typeof edgeDataSchema>;
export type AgentNodeConfig = z.infer<typeof agentConfigSchema>;
export type ToolNodeConfig = z.infer<typeof toolConfigSchema>;
export type ConditionNodeConfig = z.infer<typeof conditionConfigSchema>;
export type HumanReviewNodeConfig = z.infer<typeof humanReviewConfigSchema>;
export type ForkNodeConfig = z.infer<typeof forkConfigSchema>;
export type JoinNodeConfig = z.infer<typeof joinConfigSchema>;
export type ForkLaneConfig = z.infer<typeof forkLaneSchema>;
export type ReviewFormField = z.infer<typeof reviewFormFieldSchema>;
export type StartNodeConfig = z.infer<typeof startConfigSchema>;
export type StartVariable = z.infer<typeof startVariableSchema>;

export type WorkflowIssue = {
  message: string;
  path: Array<string | number>;
  nodeId?: string;
  edgeId?: string;
};

export type WorkflowValidationMode = "draft" | "graph" | "compile";

function issueParams(nodeId?: string, edgeId?: string) {
  return { nodeId, edgeId };
}

function addIssue(
  ctx: z.RefinementCtx,
  message: string,
  path: Array<string | number>,
  params?: { nodeId?: string; edgeId?: string }
) {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message,
    path,
    params,
  });
}

function outgoing(edges: WorkflowEdge[], nodeId: string) {
  return edges.filter((edge) => edge.source === nodeId);
}

function incoming(edges: WorkflowEdge[], nodeId: string) {
  return edges.filter((edge) => edge.target === nodeId);
}

function handleOf(edge: WorkflowEdge) {
  return edge.sourceHandle ?? undefined;
}

function refineUniqueIds(doc: WorkflowDocument, ctx: z.RefinementCtx) {
  const nodeIds = new Set<string>();
  for (const [index, node] of doc.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      addIssue(ctx, `节点 id 重复: ${node.id}`, ["nodes", index, "id"], {
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const [index, edge] of doc.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      addIssue(ctx, `边 id 重复: ${edge.id}`, ["edges", index, "id"], {
        edgeId: edge.id,
      });
    }
    edgeIds.add(edge.id);
  }
}

function refineStart(doc: WorkflowDocument, ctx: z.RefinementCtx) {
  const starts = doc.nodes.filter((node) => node.data.kind === "start");
  if (starts.length === 0) {
    addIssue(ctx, "必须有且仅有一个 start 节点", ["nodes"]);
    return;
  }
  if (starts.length > 1) {
    for (const node of starts.slice(1)) {
      addIssue(ctx, "start 节点至多一个", ["startNodeId"], {
        nodeId: node.id,
      });
    }
  }
  const start = starts[0];
  if (doc.startNodeId !== start.id) {
    addIssue(ctx, "startNodeId 必须指向唯一的 start 节点", ["startNodeId"], {
      nodeId: start.id,
    });
  }
}
// fix: 校验孤立节点
function refineIsolateNode(doc: WorkflowDocument, ctx: z.RefinementCtx) {
  const { nodes, edges } = doc;
  for (const [index, node] of nodes.entries()) {
    const { type } = node;
    const outgoingEdges = outgoing(edges, node.id);
    const incomingEdges = incoming(edges, node.id);
    if (type === NODE_TYPE_BY_KIND.start && outgoingEdges.length === 0) {
      addIssue(ctx, "start 节点不能没有出边", ["nodes", index, "id"], {
        nodeId: node.id,
      });
      continue;
    } else if (type === NODE_TYPE_BY_KIND.end && incomingEdges.length === 0) {
      addIssue(ctx, "end 节点不能没有入边", ["nodes", index, "id"], {
        nodeId: node.id,
      });
      continue;
    } else if (
      type !== NODE_TYPE_BY_KIND.start &&
      type !== NODE_TYPE_BY_KIND.end &&
      (outgoingEdges.length === 0 || incomingEdges.length === 0)
    ) {
      addIssue(ctx, "孤立节点", ["nodes", index, "id"], {
        nodeId: node.id,
      });
      continue;
    }
  }
}

function refineEdgesExist(doc: WorkflowDocument, ctx: z.RefinementCtx) {
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  for (const [index, edge] of doc.edges.entries()) {
    if (!nodeIds.has(edge.source)) {
      addIssue(
        ctx,
        `边指向不存在的 source: ${edge.source}`,
        ["edges", index, "source"],
        { edgeId: edge.id }
      );
    }
    if (!nodeIds.has(edge.target)) {
      addIssue(
        ctx,
        `边指向不存在的 target: ${edge.target}`,
        ["edges", index, "target"],
        { edgeId: edge.id }
      );
    }
  }
}

function refinePortsAndControlFlow(
  doc: WorkflowDocument,
  ctx: z.RefinementCtx,
  mode: WorkflowValidationMode
) {
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node]));

  for (const [index, edge] of doc.edges.entries()) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;

    if (target.data.kind === "start") {
      addIssue(ctx, "start 节点不能有入边", ["edges", index, "target"], {
        nodeId: target.id,
        edgeId: edge.id,
      });
    }
    if (source.data.kind === "end") {
      addIssue(ctx, "end 节点不能有出边", ["edges", index, "source"], {
        nodeId: source.id,
        edgeId: edge.id,
      });
    }
  }

  for (const [nodeIndex, node] of doc.nodes.entries()) {
    const outs = outgoing(doc.edges, node.id);
    const ins = incoming(doc.edges, node.id);
    const spec = NODE_PORT_SPEC[node.data.kind];

    if (spec.targets === 0 && ins.length > 0) {
      addIssue(ctx, `${node.data.kind} 节点不能有入边`, ["nodes", nodeIndex], {
        nodeId: node.id,
      });
    }
    if (spec.sources === 0 && outs.length > 0) {
      addIssue(ctx, `${node.data.kind} 节点不能有出边`, ["nodes", nodeIndex], {
        nodeId: node.id,
      });
    }

    if (node.data.kind === "condition") {
      const { branches } = node.data.config;
      const keys = new Set(branches.map((branch) => branch.key));

      for (const branch of branches) {
        const matches = outs.filter((edge) => handleOf(edge) === branch.key);
        if (matches.length === 0) {
          addIssue(
            ctx,
            `条件分支「${branch.key}」必须有且仅有一条出边`,
            ["nodes", nodeIndex, "data", "config", "branches"],
            { nodeId: node.id }
          );
          continue;
        }
        if (matches.length > 1) {
          addIssue(
            ctx,
            `条件分支「${branch.key}」存在多条出边`,
            ["nodes", nodeIndex, "data", "config", "branches"],
            { nodeId: node.id }
          );
        }
        for (const edge of matches) {
          const edgeIndex = doc.edges.findIndex((item) => item.id === edge.id);
          if (edge.data.kind !== "branch") {
            addIssue(
              ctx,
              "条件出边的 data.kind 必须为 branch",
              ["edges", edgeIndex, "data", "kind"],
              { nodeId: node.id, edgeId: edge.id }
            );
          } else if (edge.data.branchKey !== branch.key) {
            addIssue(
              ctx,
              "sourceHandle、branchKey 与 branches[].key 必须一致",
              ["edges", edgeIndex, "data", "branchKey"],
              { nodeId: node.id, edgeId: edge.id }
            );
          }
        }
      }

      for (const edge of outs) {
        const handle = handleOf(edge);
        if (!handle || !keys.has(handle)) {
          const edgeIndex = doc.edges.findIndex((item) => item.id === edge.id);
          addIssue(
            ctx,
            "条件节点出边的 sourceHandle 必须是某个 branch key",
            ["edges", edgeIndex, "sourceHandle"],
            { nodeId: node.id, edgeId: edge.id }
          );
        }
      }
      continue;
    }

    if (node.data.kind === "fork") {
      const { lanes } = node.data.config;
      const keys = new Set(lanes.map((lane) => lane.key));

      for (const lane of lanes) {
        const matches = outs.filter((edge) => handleOf(edge) === lane.key);
        if (matches.length === 0) {
          addIssue(
            ctx,
            `并行通道「${lane.key}」必须有且仅有一条出边`,
            ["nodes", nodeIndex, "data", "config", "lanes"],
            { nodeId: node.id }
          );
          continue;
        }
        if (matches.length > 1) {
          addIssue(
            ctx,
            `并行通道「${lane.key}」存在多条出边`,
            ["nodes", nodeIndex, "data", "config", "lanes"],
            { nodeId: node.id }
          );
        }
        for (const edge of matches) {
          const edgeIndex = doc.edges.findIndex((item) => item.id === edge.id);
          if (edge.data.kind !== "lane") {
            addIssue(
              ctx,
              "Fork 出边的 data.kind 必须为 lane",
              ["edges", edgeIndex, "data", "kind"],
              { nodeId: node.id, edgeId: edge.id }
            );
          } else if (edge.data.laneKey !== lane.key) {
            addIssue(
              ctx,
              "sourceHandle、laneKey 与 lanes[].key 必须一致",
              ["edges", edgeIndex, "data", "laneKey"],
              { nodeId: node.id, edgeId: edge.id }
            );
          }
        }
      }

      for (const edge of outs) {
        const handle = handleOf(edge);
        if (!handle || !keys.has(handle)) {
          const edgeIndex = doc.edges.findIndex((item) => item.id === edge.id);
          addIssue(
            ctx,
            "Fork 出边的 sourceHandle 必须是某个 lane key",
            ["edges", edgeIndex, "sourceHandle"],
            { nodeId: node.id, edgeId: edge.id }
          );
        }
      }
      continue;
    }

    for (const edge of outs) {
      const edgeIndex = doc.edges.findIndex((item) => item.id === edge.id);
      if (edge.data.kind === "lane") {
        addIssue(
          ctx,
          "非 Fork 节点不得发出 lane 边",
          ["edges", edgeIndex, "data", "kind"],
          { nodeId: node.id, edgeId: edge.id }
        );
      } else if (edge.data.kind !== "normal") {
        addIssue(
          ctx,
          "非条件出边的 data.kind 必须为 normal",
          ["edges", edgeIndex, "data", "kind"],
          { nodeId: node.id, edgeId: edge.id }
        );
      }
    }

    if (node.data.kind === "human_review" && outs.length > 1) {
      addIssue(ctx, "人工审核节点默认只能有一条出边", ["nodes", nodeIndex], {
        nodeId: node.id,
      });
    }

    if (
      (node.data.kind === "agent" || node.data.kind === "tool") &&
      outs.length > 1
    ) {
      addIssue(
        ctx,
        "并行只能从 Fork 的通道端口发出，智能体/工具不能有多条匿名出边",
        ["nodes", nodeIndex],
        { nodeId: node.id }
      );
    }

    if (node.data.kind === "join" && ins.length < 2) {
      addIssue(ctx, "Join 至少需要两条入边", ["nodes", nodeIndex], {
        nodeId: node.id,
      });
    }

    if (mode === "compile") {
      if (node.data.kind !== "end" && outs.length < 1) {
        addIssue(
          ctx,
          "可运行图中非结束节点必须至少有一条出边",
          ["nodes", nodeIndex],
          {
            nodeId: node.id,
          }
        );
      }
      if (node.data.kind === "human_review" && outs.length !== 1) {
        addIssue(
          ctx,
          "可运行图中人工审核节点必须恰好有一条出边",
          ["nodes", nodeIndex],
          {
            nodeId: node.id,
          }
        );
      }
      if (node.data.kind === "join" && outs.length !== 1) {
        addIssue(
          ctx,
          "可运行图中 Join 必须恰好有一条出边",
          ["nodes", nodeIndex],
          {
            nodeId: node.id,
          }
        );
      }
      if (node.data.kind === "agent" && !node.data.config.agentId) {
        addIssue(
          ctx,
          "智能体节点必须绑定 agentId",
          ["nodes", nodeIndex, "data", "config", "agentId"],
          {
            nodeId: node.id,
          }
        );
      }
      if (node.data.kind === "tool" && !node.data.config.toolId) {
        addIssue(
          ctx,
          "工具节点必须绑定 toolId",
          ["nodes", nodeIndex, "data", "config", "toolId"],
          {
            nodeId: node.id,
          }
        );
      }
    }
  }
}

function refineTopology(
  doc: WorkflowDocument,
  ctx: z.RefinementCtx,
  mode: Exclude<WorkflowValidationMode, "draft">
) {
  refineUniqueIds(doc, ctx);
  refineStart(doc, ctx);
  // refineIsolateNode(doc, ctx);
  refineEdgesExist(doc, ctx);
  refinePortsAndControlFlow(doc, ctx, mode);
  refineForkJoinRegions(doc, ctx, mode);
}

function refineForkJoinRegions(
  doc: WorkflowDocument,
  ctx: z.RefinementCtx,
  mode: WorkflowValidationMode
) {
  const analysis = analyzeForkJoinRegions(doc);
  for (const issue of analysis.issues) {
    const nodeIndex = issue.nodeId
      ? doc.nodes.findIndex((node) => node.id === issue.nodeId)
      : -1;
    const path: Array<string | number> =
      nodeIndex >= 0 ? ["nodes", nodeIndex] : ["nodes"];
    addIssue(ctx, issue.message, path, {
      nodeId: issue.nodeId,
      edgeId: issue.edgeId,
    });
  }
  // 编译模式才校验并行区写入的合法性
  if (mode === "compile") {
    for (const issue of collectRegionWriteIssues(doc, analysis.regions)) {
      const nodeIndex = issue.nodeId
        ? doc.nodes.findIndex((node) => node.id === issue.nodeId)
        : -1;
      const path: Array<string | number> =
        nodeIndex >= 0 ? ["nodes", nodeIndex] : ["nodes"];
      addIssue(ctx, issue.message, path, { nodeId: issue.nodeId });
    }
  }
}

export const workflowDocumentSchema = workflowDocumentShapeSchema.superRefine(
  (doc, ctx) => refineTopology(doc, ctx, "graph")
);

export const workflowDocumentCompileSchema =
  workflowDocumentShapeSchema.superRefine((doc, ctx) =>
    refineTopology(doc, ctx, "compile")
  );

export function formatWorkflowIssues(error: z.ZodError): WorkflowIssue[] {
  return error.issues.map((issue) => {
    // 只有 custom issue 才带 params（本文件所有拓扑校验都走 addIssue → custom）。
    // 内建 issue（类型不符、min 长度等）上没有这个字段，直接读会被 TS 拒掉。
    const params =
      issue.code === z.ZodIssueCode.custom
        ? (issue.params as { nodeId?: string; edgeId?: string } | undefined)
        : undefined;
    return {
      message: issue.message,
      path: issue.path.map((part) =>
        typeof part === "symbol" ? String(part) : part
      ),
      nodeId: params?.nodeId,
      edgeId: params?.edgeId,
    };
  });
}

export function parseWorkflowDocument(
  input: unknown,
  mode: WorkflowValidationMode = "graph"
):
  | { ok: true; document: WorkflowDocument }
  | { ok: false; errors: WorkflowIssue[] } {
  const schema =
    mode === "draft"
      ? workflowDocumentShapeSchema
      : mode === "compile"
        ? workflowDocumentCompileSchema
        : workflowDocumentSchema;
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, document: result.data };
  }
  return { ok: false, errors: formatWorkflowIssues(result.error) };
}

export function defaultConfigForKind(
  kind: NodeKind
): WorkflowNodeData["config"] {
  switch (kind) {
    case "start":
      return { variables: [] };
    case "end":
      return {};
    case "agent":
      return { outputKey: DEFAULT_AGENT_OUTPUT_KEY };
    case "tool":
      return {};
    case "condition":
      return {
        mode: "expression" as const,
        expression: "state.vars.need_human === true",
        branches: defaultConditionBranches(),
        defaultBranch: "no",
      };
    case "human_review":
      return {
        title: "人工审核",
        formFields: [
          {
            name: "decision",
            type: "enum" as const,
            options: ["approve", "reject"],
            label: "决定",
          },
        ],
      };
    case "fork":
      return { lanes: defaultForkLanes() };
    case "join":
      return { wait: DEFAULT_JOIN_WAIT };
  }
}

export function createNodeData(
  kind: NodeKind,
  label?: string
): WorkflowNodeData {
  const resolvedLabel = label ?? NODE_KIND_LABELS[kind];
  const config = defaultConfigForKind(kind);
  switch (kind) {
    case "start":
      return {
        kind,
        label: resolvedLabel,
        config: config as z.infer<typeof startConfigSchema>,
      };
    case "end":
      return {
        kind,
        label: resolvedLabel,
        config: config as z.infer<typeof endConfigSchema>,
      };
    case "agent":
      return { kind, label: resolvedLabel, config: config as AgentNodeConfig };
    case "tool":
      return { kind, label: resolvedLabel, config: config as ToolNodeConfig };
    case "condition":
      return {
        kind,
        label: resolvedLabel,
        config: config as ConditionNodeConfig,
      };
    case "human_review":
      return {
        kind,
        label: resolvedLabel,
        config: config as HumanReviewNodeConfig,
      };
    case "fork":
      return { kind, label: resolvedLabel, config: config as ForkNodeConfig };
    case "join":
      return { kind, label: resolvedLabel, config: config as JoinNodeConfig };
  }
}

export function createEmptyWorkflowDocument(
  name = "未命名工作流"
): WorkflowDocument {
  const startId = "n_start";
  const endId = "n_end";
  return workflowDocumentShapeSchema.parse({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name,
    startNodeId: startId,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: startId,
        type: NODE_TYPE_BY_KIND.start,
        position: { x: 80, y: 40 },
        data: createNodeData("start"),
      },
      {
        id: endId,
        type: NODE_TYPE_BY_KIND.end,
        position: { x: 80, y: 200 },
        data: createNodeData("end"),
      },
    ],
    edges: [
      {
        id: "e_start_end",
        source: startId,
        target: endId,
        data: { kind: "normal" },
      },
    ],
  });
}
