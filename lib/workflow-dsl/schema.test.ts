import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_OUTPUT_KEY,
  NODE_KIND_LABELS,
  NODE_TYPE_BY_KIND,
  WORKFLOW_SCHEMA_VERSION,
  type NodeKind,
} from "@/lib/workflow-dsl/kinds";
import {
  agentConfigSchema,
  createEmptyWorkflowDocument,
  createNodeData,
  defaultConfigForKind,
  formatWorkflowIssues,
  parseWorkflowDocument,
  reviewFormFieldSchema,
  startConfigSchema,
  workflowDocumentShapeSchema,
  workflowEdgeSchema,
  workflowNodeSchema,
  type WorkflowDocument,
} from "@/lib/workflow-dsl/schema";
import { z } from "zod";

/**
 * 校验分三档：draft 保未完成画布、graph 保拓扑可连、compile 保可运行。
 * 本文件只测纯 schema / 工厂函数，不挂 React Flow。
 */

/**
 * compile 模式才会要求绑定真实资源；用固定 UUID 避免把测试绑到数据库。
 * v4 UUID 形态是为了过 schema 的 uuid()，不是为了模拟某个环境里的真实记录。
 */
const AGENT_UUID = "11111111-1111-4111-8111-111111111111";
const TOOL_UUID = "22222222-2222-4222-8222-222222222222";

/**
 * 入参：业务 kind、图节点 id，可选覆盖 position。
 * 出参：React Flow 节点形状，且 type 已按 NODE_TYPE_BY_KIND 对齐。
 *
 * 画布存的是 type（视觉组件），编译器读的是 data.kind。
 * 夹具默认两者一致，才能把失败归因到「拓扑/配置」，而不是误打 type/kind 错配。
 * 故意不开放 data 参数：想注入坏 data 的用例一律用 `{ ...node(...), data: bad }` 覆盖，
 * 这样返回类型保持窄的 WorkflowNodeData，夹具能直接喂给 WorkflowDocument。
 */
function node(
  kind: NodeKind,
  id: string,
  extras?: { position?: { x: number; y: number } },
) {
  return {
    id,
    type: NODE_TYPE_BY_KIND[kind],
    position: extras?.position ?? { x: 0, y: 0 },
    data: createNodeData(kind),
  };
}

/**
 * 入参：可选覆盖字段（用来注入脏数据）。
 * 出参：最小合法线性图 start → end。
 *
 * 这是 graph 模式的基线：有唯一 start、startNodeId 对齐、一条 normal 出边。
 * 覆盖 nodes/edges 时必须整段替换，否则会和默认边的端点对不上。
 */
function linearStartEndDoc(
  overrides: Partial<WorkflowDocument> = {},
): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "线性图",
    startNodeId: "n_start",
    nodes: [node("start", "n_start"), node("end", "n_end")],
    edges: [
      {
        id: "e_start_end",
        source: "n_start",
        target: "n_end",
        data: { kind: "normal" },
      },
    ],
    ...overrides,
  };
}

/**
 * 出参：每个默认分支恰好一条 branch 边的条件图。
 *
 * 条件节点把控制流编码在三处：branches[].key、sourceHandle、data.branchKey。
 * 三者必须同一标识符，编译器才能按 handle 选边；夹具先给齐，再在用例里单独打坏其中一处。
 */
function conditionDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "条件图",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      node("condition", "n_cond"),
      node("end", "n_end_yes", { position: { x: 0, y: 200 } }),
      node("end", "n_end_no", { position: { x: 200, y: 200 } }),
    ],
    edges: [
      {
        id: "e_start_cond",
        source: "n_start",
        target: "n_cond",
        data: { kind: "normal" },
      },
      {
        id: "e_yes",
        source: "n_cond",
        target: "n_end_yes",
        sourceHandle: "yes",
        data: { kind: "branch", branchKey: "yes" },
      },
      {
        id: "e_no",
        source: "n_cond",
        target: "n_end_no",
        sourceHandle: "no",
        data: { kind: "branch", branchKey: "no" },
      },
    ],
  };
}

describe("createNodeData / defaultConfigForKind", () => {
  // 画布拖入节点时不应要求用户立刻填配置；默认值必须能过 shape schema，否则空节点无法落库。
  it("未传入 label 时使用 NODE_KIND_LABELS 作为默认显示名", () => {
    const data = createNodeData("agent");
    expect(data.kind).toBe("agent");
    expect(data.label).toBe(NODE_KIND_LABELS.agent);
    expect(data.config).toEqual({ outputKey: DEFAULT_AGENT_OUTPUT_KEY });
  });

  it("条件节点默认配置包含 yes/no 分支且 defaultBranch 指向 no", () => {
    const config = defaultConfigForKind("condition");
    expect(config).toMatchObject({
      mode: "expression",
      defaultBranch: "no",
    });
    expect("branches" in config && config.branches).toEqual([
      { key: "yes", label: "是" },
      { key: "no", label: "否" },
    ]);
  });

  // `??` 只把 undefined 当「未提供」；空字符串是用户清空标题，不能偷偷改回「工具」。
  it("边界：传入空字符串 label 时仍原样写入，不回退到默认中文名", () => {
    const data = createNodeData("tool", "");
    expect(data.label).toBe("");
    expect(data.kind).toBe("tool");
  });
});

describe("createEmptyWorkflowDocument", () => {
  // 新建工作流必须立刻可保存：工厂产物走 graph 校验，避免「空画布」和「可持久化草稿」两套形状。
  it("生成可被 graph 模式解析的最小 start→end 文档", () => {
    const doc = createEmptyWorkflowDocument("测试工作流");
    const parsed = parseWorkflowDocument(doc, "graph");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document.name).toBe("测试工作流");
      expect(parsed.document.startNodeId).toBe("n_start");
      expect(parsed.document.nodes).toHaveLength(2);
      expect(parsed.document.edges).toHaveLength(1);
    }
  });
});

describe("agentConfigSchema", () => {
  // 下游节点用 outputKey 从共享 state 取智能体文本；缺省必须落到 DEFAULT_AGENT_OUTPUT_KEY，否则运行时读不到 lastAgentText。
  it("缺省 outputKey 时填充 DEFAULT_AGENT_OUTPUT_KEY", () => {
    const parsed = agentConfigSchema.parse({});
    expect(parsed.outputKey).toBe(DEFAULT_AGENT_OUTPUT_KEY);
  });

  // 空字符串过不了 min(1)，否则运行时会把结果写进匿名 key，后续节点无法引用。
  it("边界：outputKey 为空字符串时拒绝", () => {
    const result = agentConfigSchema.safeParse({ outputKey: "" });
    expect(result.success).toBe(false);
  });
});

describe("startConfigSchema", () => {
  it("合法入参对写入 variables，缺省 required 为 true", () => {
    const parsed = startConfigSchema.parse({
      variables: [{ key: "orderId", label: "订单号", type: "string" }],
    });
    expect(parsed.variables).toEqual([
      { key: "orderId", label: "订单号", type: "string", required: true },
    ]);
  });

  it("旧文档 config 为空对象时补成空 variables，避免历史草稿无法打开", () => {
    expect(startConfigSchema.parse({})).toEqual({ variables: [] });
  });

  it("边界：变量 key 为空字符串时拒绝", () => {
    const result = startConfigSchema.safeParse({
      variables: [{ key: "", label: "订单号", type: "string" }],
    });
    expect(result.success).toBe(false);
  });

  it("边界：重复 key 时拒绝，防止运行表单两个输入抢同一个 vars 槽", () => {
    const result = startConfigSchema.safeParse({
      variables: [
        { key: "orderId", label: "订单号", type: "string" },
        { key: "orderId", label: "另一个", type: "number" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("边界：type 不在枚举内时拒绝", () => {
    const result = startConfigSchema.safeParse({
      variables: [{ key: "orderId", label: "订单号", type: "text" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("reviewFormFieldSchema", () => {
  // 审核表单会进中断 UI；enum 没有 options 会渲染成空下拉，name 必须是标识符才能写回 vars。
  it("enum 字段提供非空 options 时通过", () => {
    const parsed = reviewFormFieldSchema.parse({
      name: "decision",
      type: "enum",
      options: ["approve"],
    });
    expect(parsed.name).toBe("decision");
  });

  it("边界：enum 字段缺少 options 时拒绝", () => {
    const result = reviewFormFieldSchema.safeParse({
      name: "decision",
      type: "enum",
    });
    expect(result.success).toBe(false);
  });

  it("边界：enum 字段 options 为空数组时拒绝", () => {
    const result = reviewFormFieldSchema.safeParse({
      name: "decision",
      type: "enum",
      options: [],
    });
    expect(result.success).toBe(false);
  });

  it("边界：字段名不符合标识符（含连字符）时拒绝", () => {
    const result = reviewFormFieldSchema.safeParse({
      name: "bad-name",
      type: "text",
    });
    expect(result.success).toBe(false);
  });
});

describe("workflowNodeSchema", () => {
  // 防脏数据：把 agent 的 type 改成 endNode 会导致画布组件和编译器各走一套语义。
  it("type 与 kind 映射一致时通过", () => {
    const result = workflowNodeSchema.safeParse(node("start", "n_start"));
    expect(result.success).toBe(true);
  });

  it("边界：type 与 kind 不一致时拒绝", () => {
    const result = workflowNodeSchema.safeParse({
      ...node("start", "n_start"),
      type: NODE_TYPE_BY_KIND.end,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("type"))).toBe(
        true,
      );
    }
  });

  // 节点 id 会进 LangGraph 状态键 / 表达式；数字开头不是合法 JS 标识符，禁止进图。
  it("边界：节点 id 以数字开头时拒绝", () => {
    const result = workflowNodeSchema.safeParse(node("end", "1_end"));
    expect(result.success).toBe(false);
  });
});

describe("workflowEdgeSchema", () => {
  // React Flow 新边常常只有 source/target；缺省 normal 才能把「普通连线」和条件 branch 边区分开。
  it("缺省 data 时默认 kind 为 normal", () => {
    const parsed = workflowEdgeSchema.parse({
      id: "e1",
      source: "n_a",
      target: "n_b",
    });
    expect(parsed.data).toEqual({ kind: "normal" });
  });
});

describe("parseWorkflowDocument — draft 模式", () => {
  // draft 只卡文档形状，方便用户边画边存；拓扑（孤立边、缺 start）留给 graph/compile。
  it("允许拓扑不完整的草稿（无 start、边指向不存在节点）通过结构校验", () => {
    const draft = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      name: "草稿",
      startNodeId: "n_missing_start",
      nodes: [node("end", "n_end")],
      edges: [
        {
          id: "e_orphan",
          source: "ghost",
          target: "n_end",
          data: { kind: "normal" },
        },
      ],
    };
    const parsed = parseWorkflowDocument(draft, "draft");
    expect(parsed.ok).toBe(true);
  });

  // 空 nodes 连草稿都不是：后续 startNodeId、画布渲染都没有锚点，必须在 shape 层挡掉。
  it("边界：nodes 为空数组时即使 draft 也拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "空节点",
        startNodeId: "n_start",
        nodes: [],
        edges: [],
      },
      "draft",
    );
    expect(parsed.ok).toBe(false);
  });

  it("边界：缺少必填 name 时拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        startNodeId: "n_start",
        nodes: [node("start", "n_start")],
        edges: [],
      },
      "draft",
    );
    expect(parsed.ok).toBe(false);
  });

  // 数字 1 和字符串 "1" 不能混用，否则以后升 schemaVersion 时旧草稿会被静默当成新版本。
  it("边界：schemaVersion 类型非法（字符串）时拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: "1",
        name: "版本类型错误",
        startNodeId: "n_start",
        nodes: [node("start", "n_start")],
        edges: [],
      },
      "draft",
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("parseWorkflowDocument — graph 模式", () => {
  // graph：画布保存前的拓扑契约。不要求绑定 agentId/toolId，但控制流必须可走通、id 必须唯一。
  it("合法线性图通过", () => {
    const parsed = parseWorkflowDocument(linearStartEndDoc(), "graph");
    expect(parsed.ok).toBe(true);
  });

  it("合法条件分支图通过", () => {
    const parsed = parseWorkflowDocument(conditionDoc(), "graph");
    expect(parsed.ok).toBe(true);
  });

  // 重复 id 会让 React Flow 与边索引静默串台，编译器也会把两条节点当一个状态键。
  it("边界：节点 id 重复时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        nodes: [node("start", "n_start"), node("end", "n_start")],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((err) => err.message.includes("节点 id 重复"))).toBe(
        true,
      );
    }
  });

  it("边界：边 id 重复时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        nodes: [
          node("start", "n_start"),
          node("agent", "n_agent"),
          node("end", "n_end"),
        ],
        edges: [
          {
            id: "dup",
            source: "n_start",
            target: "n_agent",
            data: { kind: "normal" },
          },
          {
            id: "dup",
            source: "n_agent",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((err) => err.message.includes("边 id 重复"))).toBe(
        true,
      );
    }
  });

  it("边界：缺少 start 节点时拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "无开始",
        startNodeId: "n_end",
        nodes: [node("end", "n_end")],
        edges: [],
      },
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) => err.message.includes("必须有且仅有一个 start")),
      ).toBe(true);
    }
  });

  it("边界：多个 start 节点时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        nodes: [
          node("start", "n_start"),
          node("start", "n_start_2"),
          node("end", "n_end"),
        ],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
  });

  // startNodeId 是运行入口；指向 end 时图仍「看起来有开始节点」，运行时却会从错误节点启动。
  it("边界：startNodeId 未指向唯一 start 时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({ startNodeId: "n_end" }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("startNodeId 必须指向唯一的 start"),
        ),
      ).toBe(true);
    }
  });

  it("边界：边的 source 指向不存在的节点时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        edges: [
          {
            id: "e_ghost",
            source: "ghost",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.some((err) => err.edgeId === "e_ghost")).toBe(true);
    }
  });

  // start 有入边会形成环或二次进入，破坏「工作流只从唯一入口启动」的约定。
  it("边界：start 节点存在入边时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        nodes: [
          node("start", "n_start"),
          node("agent", "n_agent"),
          node("end", "n_end"),
        ],
        edges: [
          {
            id: "e_back",
            source: "n_agent",
            target: "n_start",
            data: { kind: "normal" },
          },
          {
            id: "e_out",
            source: "n_start",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) => err.message.includes("start 节点不能有入边")),
      ).toBe(true);
    }
  });

  it("边界：end 节点存在出边时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        nodes: [
          node("start", "n_start"),
          node("end", "n_end"),
          node("end", "n_end_2"),
        ],
        edges: [
          {
            id: "e_start_end",
            source: "n_start",
            target: "n_end",
            data: { kind: "normal" },
          },
          {
            id: "e_end_out",
            source: "n_end",
            target: "n_end_2",
            data: { kind: "normal" },
          },
        ],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) => err.message.includes("end 节点不能有出边")),
      ).toBe(true);
    }
  });

  // 缺分支边时运行期 _route 会落到空 handle；必须在保存图画时就报，而不是编译后再炸。
  it("边界：条件分支缺少对应出边时拒绝", () => {
    const doc = conditionDoc();
    doc.edges = doc.edges.filter((edge) => edge.id !== "e_no");
    const parsed = parseWorkflowDocument(doc, "graph");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("条件分支「no」必须有且仅有一条出边"),
        ),
      ).toBe(true);
    }
  });

  it("边界：同一条件分支存在多条出边时拒绝", () => {
    const doc = conditionDoc();
    doc.edges.push({
      id: "e_yes_dup",
      source: "n_cond",
      target: "n_end_no",
      sourceHandle: "yes",
      data: { kind: "branch", branchKey: "yes" },
    });
    const parsed = parseWorkflowDocument(doc, "graph");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) => err.message.includes("条件分支「yes」存在多条出边")),
      ).toBe(true);
    }
  });

  it("边界：条件出边 data.kind 不是 branch 时拒绝", () => {
    const doc = conditionDoc();
    const yes = doc.edges.find((edge) => edge.id === "e_yes");
    if (yes) {
      yes.data = { kind: "normal" };
    }
    const parsed = parseWorkflowDocument(doc, "graph");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("条件出边的 data.kind 必须为 branch"),
        ),
      ).toBe(true);
    }
  });

  // 画布用 sourceHandle 连线，编译器用 data.branchKey；两者不一致时边会显示对了但路由走错。
  it("边界：sourceHandle 与 branchKey 不一致时拒绝", () => {
    const doc = conditionDoc();
    const yes = doc.edges.find((edge) => edge.id === "e_yes");
    if (yes && yes.data.kind === "branch") {
      yes.data = { kind: "branch", branchKey: "no" };
    }
    const parsed = parseWorkflowDocument(doc, "graph");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("sourceHandle、branchKey 与 branches[].key 必须一致"),
        ),
      ).toBe(true);
    }
  });

  it("边界：条件出边 sourceHandle 不是合法 branch key 时拒绝", () => {
    const doc = conditionDoc();
    doc.edges.push({
      id: "e_unknown",
      source: "n_cond",
      target: "n_end_yes",
      sourceHandle: "maybe",
      data: { kind: "branch", branchKey: "maybe" },
    });
    const parsed = parseWorkflowDocument(doc, "graph");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("sourceHandle 必须是某个 branch key"),
        ),
      ).toBe(true);
    }
  });

  it("边界：非条件节点出边使用 branch kind 时拒绝", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        edges: [
          {
            id: "e_start_end",
            source: "n_start",
            target: "n_end",
            data: { kind: "branch", branchKey: "yes" },
          },
        ],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("非条件出边的 data.kind 必须为 normal"),
        ),
      ).toBe(true);
    }
  });

  // 人工审核当前是单出口中断节点；多出边无法表达「通过/驳回」，应走 condition 而不是审核分叉。
  it("边界：人工审核节点有多条出边时拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "审核分叉",
        startNodeId: "n_start",
        nodes: [
          node("start", "n_start"),
          node("human_review", "n_review"),
          node("end", "n_end_a"),
          node("end", "n_end_b"),
        ],
        edges: [
          {
            id: "e_start_review",
            source: "n_start",
            target: "n_review",
            data: { kind: "normal" },
          },
          {
            id: "e_a",
            source: "n_review",
            target: "n_end_a",
            data: { kind: "normal" },
          },
          {
            id: "e_b",
            source: "n_review",
            target: "n_end_b",
            data: { kind: "normal" },
          },
        ],
      },
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("人工审核节点默认只能有一条出边"),
        ),
      ).toBe(true);
    }
  });

  // defaultBranch 是表达式/LLM 未命中时的兜底；指向不存在的 key 会在运行时静默丢路由，所以在节点 config 就拦截。
  it("边界：条件节点 defaultBranch 不在 branches 中时在节点级拒绝", () => {
    const bad = createNodeData("condition");
    if (bad.kind === "condition") {
      bad.config = {
        ...bad.config,
        defaultBranch: "missing",
      };
    }
    const result = workflowDocumentShapeSchema.safeParse(
      linearStartEndDoc({
        nodes: [node("start", "n_start"), { ...node("condition", "n_cond"), data: bad }],
        edges: [],
      }),
    );
    expect(result.success).toBe(false);
  });

  // 重复 key 会让两条出边争同一个 handle，路由变成非确定性。
  it("边界：条件分支 key 重复时拒绝", () => {
    const data = createNodeData("condition");
    if (data.kind === "condition") {
      data.config = {
        ...data.config,
        branches: [
          { key: "yes", label: "是" },
          { key: "yes", label: "也是" },
        ],
        defaultBranch: "yes",
      };
    }
    const result = workflowDocumentShapeSchema.safeParse({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      name: "重复分支",
      startNodeId: "n_start",
      nodes: [node("start", "n_start"), { ...node("condition", "n_cond"), data }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("parseWorkflowDocument — compile 模式", () => {
  // compile 比 graph 更严：非 end 必须有出边，agent/tool 必须绑定资源。防止「图画得通但跑不起来」被编译进运行时。
  it("已绑定 agentId 且连通的可运行图通过", () => {
    const boundAgent = createNodeData("agent");
    if (boundAgent.kind === "agent") {
      boundAgent.config = { ...boundAgent.config, agentId: AGENT_UUID };
    }
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "可编译",
        startNodeId: "n_start",
        nodes: [
          node("start", "n_start"),
          { ...node("agent", "n_agent"), data: boundAgent },
          node("end", "n_end"),
        ],
        edges: [
          {
            id: "e1",
            source: "n_start",
            target: "n_agent",
            data: { kind: "normal" },
          },
          {
            id: "e2",
            source: "n_agent",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      },
      "compile",
    );
    expect(parsed.ok).toBe(true);
  });

  // graph 允许占位智能体；compile 必须能解析到具体 agent，否则运行时才发现空调用。
  it("边界：compile 下智能体未绑定 agentId 时拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "未绑定智能体",
        startNodeId: "n_start",
        nodes: [
          node("start", "n_start"),
          node("agent", "n_agent"),
          node("end", "n_end"),
        ],
        edges: [
          {
            id: "e1",
            source: "n_start",
            target: "n_agent",
            data: { kind: "normal" },
          },
          {
            id: "e2",
            source: "n_agent",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      },
      "compile",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) => err.message.includes("必须绑定 agentId")),
      ).toBe(true);
    }
  });

  it("边界：compile 下工具未绑定 toolId 时拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "未绑定工具",
        startNodeId: "n_start",
        nodes: [
          node("start", "n_start"),
          node("tool", "n_tool"),
          node("end", "n_end"),
        ],
        edges: [
          {
            id: "e1",
            source: "n_start",
            target: "n_tool",
            data: { kind: "normal" },
          },
          {
            id: "e2",
            source: "n_tool",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      },
      "compile",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) => err.message.includes("必须绑定 toolId")),
      ).toBe(true);
    }
  });

  // 断头 start 在 graph 可存（用户还没连线）；compile 必须拒绝，否则运行会卡在无后继节点。
  it("边界：compile 下非结束节点没有出边时拒绝", () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "断头图",
        startNodeId: "n_start",
        nodes: [node("start", "n_start"), node("end", "n_end")],
        edges: [],
      },
      "compile",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.errors.some((err) =>
          err.message.includes("非结束节点必须至少有一条出边"),
        ),
      ).toBe(true);
    }
  });

  // 分层校验：保存画布允许先摆智能体节点；点运行/发布才要求 agentId。同一份文档必须能区分两档。
  it("同一份未绑定 agent 的图在 graph 模式可通过、compile 模式拒绝", () => {
    const doc = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      name: "分层校验",
      startNodeId: "n_start",
      nodes: [
        node("start", "n_start"),
        node("agent", "n_agent"),
        node("end", "n_end"),
      ],
      edges: [
        {
          id: "e1",
          source: "n_start",
          target: "n_agent",
          data: { kind: "normal" as const },
        },
        {
          id: "e2",
          source: "n_agent",
          target: "n_end",
          data: { kind: "normal" as const },
        },
      ],
    };
    expect(parseWorkflowDocument(doc, "graph").ok).toBe(true);
    expect(parseWorkflowDocument(doc, "compile").ok).toBe(false);
  });

  it("绑定合法 toolId 的工具图在 compile 模式通过", () => {
    const toolData = createNodeData("tool");
    if (toolData.kind === "tool") {
      toolData.config = { ...toolData.config, toolId: TOOL_UUID };
    }
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "工具可编译",
        startNodeId: "n_start",
        nodes: [
          node("start", "n_start"),
          { ...node("tool", "n_tool"), data: toolData },
          node("end", "n_end"),
        ],
        edges: [
          {
            id: "e1",
            source: "n_start",
            target: "n_tool",
            data: { kind: "normal" },
          },
          {
            id: "e2",
            source: "n_tool",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      },
      "compile",
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("formatWorkflowIssues", () => {
  // 画布高亮依赖 nodeId/edgeId，不能只给 Zod path；幽灵边要能定位到具体 edge 而不是整张图。
  it("把 ZodIssue 的 path 与 params 中的 nodeId/edgeId 映射到 WorkflowIssue", () => {
    const parsed = parseWorkflowDocument(
      linearStartEndDoc({
        edges: [
          {
            id: "e_ghost",
            source: "ghost",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      }),
      "graph",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const ghost = parsed.errors.find((err) => err.edgeId === "e_ghost");
      expect(ghost?.path).toEqual(["edges", 0, "source"]);
      expect(ghost?.message).toContain("不存在的 source");
    }
  });

  it("边界：对空 issues 数组返回空结果", () => {
    const error = new z.ZodError([]);
    expect(formatWorkflowIssues(error)).toEqual([]);
  });
});
