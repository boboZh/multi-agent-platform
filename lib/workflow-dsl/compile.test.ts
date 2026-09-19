import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { describe, expect, it } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentRow, ToolRow } from "@/app/(dashboard)/agents/lib/types";
import {
  DEFAULT_AGENT_OUTPUT_KEY,
  NODE_TYPE_BY_KIND,
  WORKFLOW_SCHEMA_VERSION,
  type NodeKind,
} from "@/lib/workflow-dsl/kinds";
import {
  createNodeData,
  parseWorkflowDocument,
  type WorkflowDocument,
} from "@/lib/workflow-dsl/schema";
import {
  compileWorkflow,
  dryRunCompile,
  type CompiledWorkflowApp,
} from "@/lib/workflow-dsl/compile";
import {
  buildBranchPathMap,
  collectStaticControlEdges,
  evaluateExpressionRoute,
  joinBarrierChannelName,
  pickBranchKey,
  pickExpressionBranchKey,
  regionInteriorNodeIds,
  resolveInputMap,
  resolveStatePath,
  type WorkflowGraphState,
} from "@/lib/workflow-dsl/compile-utils";
import { END, START } from "@langchain/langgraph";

const AGENT_UUID = "11111111-1111-4111-8111-111111111111";
const TOOL_UUID = "22222222-2222-4222-8222-222222222222";

function emptyState(vars: Record<string, unknown> = {}): WorkflowGraphState {
  return { messages: [], vars, lastAgentText: "", _route: "" };
}

function node(kind: NodeKind, id: string) {
  return {
    id,
    type: NODE_TYPE_BY_KIND[kind],
    position: { x: 0, y: 0 },
    data: createNodeData(kind),
  };
}

function agentRow(): AgentRow {
  return {
    id: AGENT_UUID,
    user_id: "00000000-0000-4000-8000-000000000000",
    name: "客服",
    system_prompt: "只输出 need_human 或 ok。",
    model_name: "gpt-4o",
    temperature: 0,
    created_at: new Date().toISOString(),
  };
}

/**
 * 脚本化模型：不打真实 API。createReactAgent 无工具时只会 invoke 一次；
 * bindTools 返回自身，避免空工具列表时还去找 ChatOpenAI 的实现。
 */
function scriptedCreateModel(replies: string[]) {
  const queue = [...replies];
  const llm = RunnableLambda.from(
    async () => new AIMessage(queue.shift() ?? "")
  );
  Object.assign(llm, { bindTools: () => llm });
  return () => llm as unknown as BaseChatModel;
}

function agentThenConditionDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "Start-Agent-Condition-End",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      {
        ...node("agent", "n_agent"),
        data: {
          kind: "agent" as const,
          label: "智能体",
          config: { agentId: AGENT_UUID, outputKey: DEFAULT_AGENT_OUTPUT_KEY },
        },
      },
      {
        id: "n_cond",
        type: NODE_TYPE_BY_KIND.condition,
        position: { x: 0, y: 0 },
        data: {
          kind: "condition" as const,
          label: "条件",
          config: {
            mode: "expression" as const,
            expression: 'state.lastAgentText == "need_human"',
            branches: [
              { key: "yes", label: "是" },
              { key: "no", label: "否" },
            ],
            defaultBranch: "no",
          },
        },
      },
      node("end", "n_end_yes"),
      node("end", "n_end_no"),
    ],
    edges: [
      {
        id: "e_start_agent",
        source: "n_start",
        target: "n_agent",
        data: { kind: "normal" },
      },
      {
        id: "e_agent_cond",
        source: "n_agent",
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

function expressionDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "条件编译图",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      {
        id: "n_cond",
        type: NODE_TYPE_BY_KIND.condition,
        position: { x: 0, y: 0 },
        data: {
          kind: "condition" as const,
          label: "条件",
          config: {
            mode: "expression" as const,
            expression: "state.vars.need_human === true",
            branches: [
              { key: "yes", label: "是" },
              { key: "no", label: "否" },
            ],
            defaultBranch: "no",
          },
        },
      },
      node("end", "n_end_yes"),
      node("end", "n_end_no"),
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

function humanReviewDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "审核图",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      node("human_review", "n_review"),
      node("end", "n_end"),
    ],
    edges: [
      {
        id: "e1",
        source: "n_start",
        target: "n_review",
        data: { kind: "normal" },
      },
      {
        id: "e2",
        source: "n_review",
        target: "n_end",
        data: { kind: "normal" },
      },
    ],
  };
}

describe("resolveStatePath / resolveInputMap", () => {
  it("按点号路径从 vars 取值", () => {
    const state = emptyState({ order_id: "A-1", nested: { n: 2 } });
    expect(resolveStatePath(state, "state.vars.order_id")).toBe("A-1");
  });

  it("边界：非法路径和中途断开都返回 undefined，不抛异常", () => {
    const state = emptyState({ order_id: "A-1" });
    expect(resolveStatePath(state, "vars.order_id")).toBeUndefined();
    expect(resolveStatePath(state, "state.")).toBeUndefined();
    expect(resolveStatePath(state, "state.vars.missing.deep")).toBeUndefined();
    expect(resolveStatePath(state, "")).toBeUndefined();
  });

  it("边界：inputMap 缺路径的键仍保留，值为 undefined", () => {
    const mapped = resolveInputMap(emptyState({ amount: 10 }), {
      amount: "state.vars.amount",
      ghost: "state.vars.ghost",
    });
    expect(mapped).toEqual({ amount: 10, ghost: undefined });
  });
});

describe("evaluateExpressionRoute", () => {
  const keys = ["yes", "no"];

  it("默认草稿里的 === 会被当成布尔路由", () => {
    expect(
      evaluateExpressionRoute(
        "state.vars.need_human === true",
        emptyState({ need_human: true }),
        keys,
        "no"
      )
    ).toBe("yes");
    expect(
      evaluateExpressionRoute(
        "state.vars.need_human === true",
        emptyState({ need_human: false }),
        keys,
        "no"
      )
    ).toBe("no");
  });

  it("边界：表达式抛错或返回未知值时走 defaultBranch，避免整图崩溃", () => {
    expect(
      evaluateExpressionRoute("state.vars.x.y.z", emptyState(), keys, "no")
    ).toBe("no");
    expect(evaluateExpressionRoute("'maybe'", emptyState(), keys, "no")).toBe(
      "no"
    );
  });

  it("边界：表达式直接返回分支 key 字符串时按 key 跳而不是当布尔", () => {
    expect(
      evaluateExpressionRoute(
        "state.vars.route",
        emptyState({ route: "yes" }),
        keys,
        "no"
      )
    ).toBe("yes");
  });

  it("比较表达式在 true/false 分支上能命中 true，而不是掉进 defaultBranch", () => {
    expect(
      evaluateExpressionRoute(
        "state.vars.order_info.amount > 200",
        emptyState({ order_info: { amount: 2000 } }),
        ["true", "false"],
        "false"
      )
    ).toBe("true");
  });
});

describe("pickExpressionBranchKey", () => {
  it("边界：分支列表不是数组或为空时直接走兜底，避免 includes 崩掉", () => {
    expect(
      pickExpressionBranchKey(true, null as unknown as string[], "no")
    ).toBe("no");
    expect(pickExpressionBranchKey(true, [], "fallback")).toBe("fallback");
  });

  it("边界：非法类型和无关字符串不当真值，防止 maybe 误入 yes", () => {
    const keys = ["yes", "no"];
    expect(pickExpressionBranchKey("maybe", keys, "no")).toBe("no");
    expect(pickExpressionBranchKey({ ok: true }, keys, "no")).toBe("no");
    expect(pickExpressionBranchKey(2, keys, "no")).toBe("no");
    expect(pickExpressionBranchKey(undefined, keys, "no")).toBe("no");
  });

  it("边界：字符串 reject 精确匹配，不会因为真值同义词撞到 approve", () => {
    expect(
      pickExpressionBranchKey("reject", ["approve", "reject"], "approve")
    ).toBe("reject");
    expect(pickExpressionBranchKey("YES", ["yes", "no"], "no")).toBe("yes");
  });

  it("布尔和 0/1 按声明顺序映射到 yes|true|1 或 no|false|0", () => {
    expect(pickExpressionBranchKey(true, ["true", "false"], "false")).toBe(
      "true"
    );
    expect(pickExpressionBranchKey(false, ["true", "false"], "false")).toBe(
      "false"
    );
    expect(pickExpressionBranchKey(1, ["yes", "no"], "no")).toBe("yes");
    expect(pickExpressionBranchKey(0, ["yes", "no"], "no")).toBe("no");
    expect(pickExpressionBranchKey(true, ["yes", "true"], "no")).toBe("yes");
  });
});

describe("pickBranchKey", () => {
  const keys = ["yes", "no", "reject"];

  it("模型输出夹着标点和空格时仍能抠出 key", () => {
    expect(pickBranchKey(" yes. ", keys, "no")).toBe("yes");
    expect(pickBranchKey("`reject`", keys, "no")).toBe("reject");
  });

  it("边界：空串或不在列表里的胡话回落 fallback", () => {
    expect(pickBranchKey("", keys, "no")).toBe("no");
    expect(pickBranchKey("I think we should continue", keys, "no")).toBe("no");
  });

  it("边界：一段文本里同时出现多个 key 时取声明更靠前的，避免随机", () => {
    expect(pickBranchKey("not yes, maybe no", ["yes", "no"], "no")).toBe("yes");
  });
});

describe("buildBranchPathMap", () => {
  it("用 branchKey 而不是写死 yes/no，结束节点映射成 END", () => {
    const map = buildBranchPathMap(
      [
        {
          id: "e1",
          source: "n_cond",
          target: "n_end",
          sourceHandle: "approve",
          data: { kind: "branch", branchKey: "approve" },
        },
        {
          id: "e2",
          source: "n_cond",
          target: "n_agent",
          sourceHandle: "reject",
          data: { kind: "branch", branchKey: "reject" },
        },
      ],
      "n_cond",
      new Set(["n_end"])
    );
    expect(map).toEqual({ approve: END, reject: "n_agent" });
  });
});

describe("compileWorkflow", () => {
  it("空的 start→end 图能编出来并能 invoke", async () => {
    const parsed = parseWorkflowDocument(
      {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        name: "空图",
        startNodeId: "n_start",
        nodes: [node("start", "n_start"), node("end", "n_end")],
        edges: [
          {
            id: "e1",
            source: "n_start",
            target: "n_end",
            data: { kind: "normal" },
          },
        ],
      },
      "compile"
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const compiled = await compileWorkflow(parsed.document, {
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const out = await compiled.app.invoke({
      messages: [new HumanMessage("hi")],
      vars: {},
    });
    expect(out.messages).toHaveLength(1);
  });

  it("表达式条件节点按 vars 选择分支，且 _route 写回 state", async () => {
    const compiled = await compileWorkflow(expressionDoc(), {
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const yes = await compiled.app.invoke({
      messages: [],
      vars: { need_human: true },
    });
    expect(yes._route).toBe("yes");
    const no = await compiled.app.invoke({
      messages: [],
      vars: { need_human: false },
    });
    expect(no._route).toBe("no");
  });

  it("边界：agentId 在资源里找不到时拒绝编译，不给出半成品图", async () => {
    const doc: WorkflowDocument = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      name: "缺智能体",
      startNodeId: "n_start",
      nodes: [
        node("start", "n_start"),
        {
          ...node("agent", "n_agent"),
          data: {
            kind: "agent",
            label: "智能体",
            config: {
              agentId: AGENT_UUID,
              outputKey: DEFAULT_AGENT_OUTPUT_KEY,
            },
          },
        },
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
    };
    const compiled = await compileWorkflow(doc, {
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(
      compiled.errors.some((issue) => issue.message.includes("找不到智能体"))
    ).toBe(true);
  });

  it("工具节点按 inputMap 取值并写入 outputKey", async () => {
    const tool: ToolRow = {
      id: TOOL_UUID,
      user_id: "00000000-0000-4000-8000-000000000000",
      name: "echo_tool",
      display_name: "Echo",
      description: "echo",
      tool_type: "explicit",
      connection_config: {
        schema: { city: { type: "string", description: "城市" } },
      },
    };
    const doc: WorkflowDocument = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      name: "工具图",
      startNodeId: "n_start",
      nodes: [
        node("start", "n_start"),
        {
          ...node("tool", "n_tool"),
          data: {
            kind: "tool",
            label: "工具",
            config: {
              toolId: TOOL_UUID,
              inputMap: { city: "state.vars.city" },
              outputKey: "weather",
            },
          },
        },
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
    };
    const compiled = await compileWorkflow(doc, {
      resources: {
        agents: new Map(),
        tools: new Map([[TOOL_UUID, tool]]),
      },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const out = await compiled.app.invoke({
      messages: [],
      vars: { city: "杭州" },
    });
    expect(out.vars.weather).toEqual({
      tool: "echo_tool",
      input: { city: "杭州" },
      note: "No live executor; echoing input.",
    });
  });

  it("边界：人工审核图在没有 checkpointer 时拒绝编译", async () => {
    const compiled = await compileWorkflow(humanReviewDoc(), {
      checkpointer: false,
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.errors[0]?.message).toContain("checkpointer");
  });

  it("Start→Agent→Condition(expression)→End：mock 模型输出决定分支", async () => {
    const agents = new Map([
      [AGENT_UUID, { agent: agentRow(), tools: [] as ToolRow[] }],
    ]);
    const compiled = await compileWorkflow(agentThenConditionDoc(), {
      resources: { agents, tools: new Map() },
      createModel: scriptedCreateModel(["need_human"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const yes = await compiled.app.invoke({
      messages: [new HumanMessage("这个单要不要人工？")],
      vars: {},
    });
    expect(yes.lastAgentText).toBe("need_human");
    expect(yes._route).toBe("yes");
  });

  it("同一张图 mock 输出非 need_human 时走 defaultBranch no", async () => {
    const agents = new Map([
      [AGENT_UUID, { agent: agentRow(), tools: [] as ToolRow[] }],
    ]);
    const compiled = await compileWorkflow(agentThenConditionDoc(), {
      resources: { agents, tools: new Map() },
      createModel: scriptedCreateModel(["ok"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const no = await compiled.app.invoke({
      messages: [new HumanMessage("正常咨询")],
      vars: {},
    });
    expect(no.lastAgentText).toBe("ok");
    expect(no._route).toBe("no");
  });

  it("dryRunCompile 成功时只返回计数，失败时带回结构化错误", async () => {
    const ok = await dryRunCompile(expressionDoc(), {
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(ok).toEqual({ ok: true, nodeCount: 4, edgeCount: 3 });

    const fail = await dryRunCompile(
      { schemaVersion: 1, name: "坏" },
      { resources: { agents: new Map(), tools: new Map() } }
    );
    expect(fail.ok).toBe(false);
    if (fail.ok) return;
    expect(fail.errors.length).toBeGreaterThan(0);
  });

  it("边界：省略 checkpointer 时人工审核图仍拒绝真正编译", async () => {
    const compiled = await compileWorkflow(humanReviewDoc(), {
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.errors[0]?.message).toContain("checkpointer");
  });

  it("边界：dryRunCompile 含人工审核且不传 checkpointer 仍应通过", async () => {
    const ok = await dryRunCompile(humanReviewDoc(), {
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(ok).toEqual({ ok: true, nodeCount: 3, edgeCount: 2 });
  });

  it("边界：dryRunCompile 即使显式 checkpointer:false 也不因 HITL 失败", async () => {
    const ok = await dryRunCompile(humanReviewDoc(), {
      checkpointer: false,
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(ok.ok).toBe(true);
  });

  it("边界：dryRunCompile 对空对象输入返回 schema 错误而不是 checkpointer 错误", async () => {
    const fail = await dryRunCompile(
      {},
      { resources: { agents: new Map(), tools: new Map() } }
    );
    expect(fail.ok).toBe(false);
    if (fail.ok) return;
    expect(fail.errors.some((e) => e.message.includes("checkpointer"))).toBe(
      false
    );
  });
});

function forkNode(id: string, laneCount: number) {
  const data = createNodeData("fork");
  if (data.kind !== "fork") throw new Error("unreachable");
  data.config = {
    lanes: Array.from({ length: laneCount }, (_, index) => ({
      key: `lane_${index + 1}`,
      label: `通道 ${index + 1}`,
    })),
  };
  return { ...node("fork", id), data };
}

function toolWithOutput(id: string, outputKey: string) {
  const data = createNodeData("tool");
  if (data.kind !== "tool") throw new Error("unreachable");
  data.config = {
    toolId: TOOL_UUID,
    outputKey,
    inputMap: { city: "state.vars.city" },
  };
  return { ...node("tool", id), data };
}

function laneEdge(id: string, source: string, target: string, key: string) {
  return {
    id,
    source,
    target,
    sourceHandle: key,
    data: { kind: "lane" as const, laneKey: key },
  };
}

function normalEdge(id: string, source: string, target: string) {
  return {
    id,
    source,
    target,
    data: { kind: "normal" as const },
  };
}

function echoTool(): ToolRow {
  return {
    id: TOOL_UUID,
    user_id: "00000000-0000-4000-8000-000000000000",
    name: "echo_tool",
    display_name: "Echo",
    description: "echo",
    tool_type: "explicit",
    connection_config: {
      schema: { city: { type: "string", description: "城市" } },
    },
  };
}

/**
 * Start → Fork(2) → 短 lane 一跳 / 长 lane 两跳 → Join → End。
 * 用来锁死屏障：若逐条 addEdge，Join 会在短 lane 结束后抢跑。
 */
function unevenParallelToolDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "不等长并行",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      forkNode("n_fork", 2),
      toolWithOutput("n_a1", "out_a"),
      toolWithOutput("n_a2", "out_b1"),
      toolWithOutput("n_a2b", "out_b2"),
      node("join", "n_join"),
      node("end", "n_end"),
    ],
    edges: [
      normalEdge("e_start", "n_start", "n_fork"),
      laneEdge("e_lane_1", "n_fork", "n_a1", "lane_1"),
      laneEdge("e_lane_2", "n_fork", "n_a2", "lane_2"),
      normalEdge("e_a1_join", "n_a1", "n_join"),
      normalEdge("e_a2_extra", "n_a2", "n_a2b"),
      normalEdge("e_extra_join", "n_a2b", "n_join"),
      normalEdge("e_join_end", "n_join", "n_end"),
    ],
  };
}

function equalParallelToolDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "等长并行",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      forkNode("n_fork", 2),
      toolWithOutput("n_zz", "out_zz"),
      toolWithOutput("n_aa", "out_aa"),
      node("join", "n_join"),
      node("end", "n_end"),
    ],
    edges: [
      normalEdge("e_start", "n_start", "n_fork"),
      laneEdge("e_lane_2", "n_fork", "n_zz", "lane_2"),
      laneEdge("e_lane_1", "n_fork", "n_aa", "lane_1"),
      normalEdge("e_zz_join", "n_zz", "n_join"),
      normalEdge("e_aa_join", "n_aa", "n_join"),
      normalEdge("e_join_end", "n_join", "n_end"),
    ],
  };
}

function twoRegionDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "两段并行",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      forkNode("n_fork_a", 2),
      toolWithOutput("n_a1", "out_a1"),
      toolWithOutput("n_a2", "out_a2"),
      node("join", "n_join_a"),
      forkNode("n_fork_b", 2),
      toolWithOutput("n_b1", "out_b1"),
      toolWithOutput("n_b2", "out_b2"),
      node("join", "n_join_b"),
      node("end", "n_end"),
    ],
    edges: [
      normalEdge("e_start", "n_start", "n_fork_a"),
      laneEdge("e_a_lane_1", "n_fork_a", "n_a1", "lane_1"),
      laneEdge("e_a_lane_2", "n_fork_a", "n_a2", "lane_2"),
      normalEdge("e_a1_join", "n_a1", "n_join_a"),
      normalEdge("e_a2_join", "n_a2", "n_join_a"),
      normalEdge("e_serial", "n_join_a", "n_fork_b"),
      laneEdge("e_b_lane_1", "n_fork_b", "n_b1", "lane_1"),
      laneEdge("e_b_lane_2", "n_fork_b", "n_b2", "lane_2"),
      normalEdge("e_b1_join", "n_b1", "n_join_b"),
      normalEdge("e_b2_join", "n_b2", "n_join_b"),
      normalEdge("e_end", "n_join_b", "n_end"),
    ],
  };
}

function parallelNToolDoc(laneCount: number): WorkflowDocument {
  const tools = Array.from({ length: laneCount }, (_, index) =>
    toolWithOutput(`n_t${index + 1}`, `out_${index + 1}`)
  );
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: `并行 N=${laneCount}`,
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      forkNode("n_fork", laneCount),
      ...tools,
      node("join", "n_join"),
      node("end", "n_end"),
    ],
    edges: [
      normalEdge("e_start", "n_start", "n_fork"),
      ...tools.map((tool, index) =>
        laneEdge(`e_lane_${index + 1}`, "n_fork", tool.id, `lane_${index + 1}`)
      ),
      ...tools.map((tool, index) =>
        normalEdge(`e_join_${index + 1}`, tool.id, "n_join")
      ),
      normalEdge("e_end", "n_join", "n_end"),
    ],
  };
}

function expressionCondition(
  id: string,
  expression: string,
  branches: Array<{ key: string; label: string }>,
  defaultBranch: string
) {
  return {
    id,
    type: NODE_TYPE_BY_KIND.condition,
    position: { x: 0, y: 0 },
    data: {
      kind: "condition" as const,
      label: "条件",
      config: {
        mode: "expression" as const,
        expression,
        branches,
        defaultBranch,
      },
    },
  };
}

function branchEdge(id: string, source: string, target: string, key: string) {
  return {
    id,
    source,
    target,
    sourceHandle: key,
    data: { kind: "branch" as const, branchKey: key },
  };
}

/**
 * Join → 主笔 → Condition；revise 打回主笔（两条入边必须是 OR）。
 * 若误把主笔的两条边编成屏障，会等 Condition 写入才调度，而 Condition 在主笔下游 → 主笔第一轮永不执行。
 * JoinA ───────→ 主笔  → Condition
                  ↑ revise  │
                  └─────────┘
 */
function reviseBackToWriterDoc(): WorkflowDocument {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "打回主笔",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      forkNode("n_fork", 2),
      toolWithOutput("n_aa", "out_aa"),
      toolWithOutput("n_zz", "out_zz"),
      node("join", "n_join"),
      agentWithOutput("n_writer", DEFAULT_AGENT_OUTPUT_KEY),
      expressionCondition(
        "n_cond",
        "state.lastAgentText",
        [
          { key: "revise", label: "修订" },
          { key: "pass", label: "通过" },
        ],
        "pass"
      ),
      node("end", "n_end"),
    ],
    edges: [
      normalEdge("e_start", "n_start", "n_fork"),
      laneEdge("e_lane_1", "n_fork", "n_aa", "lane_1"),
      laneEdge("e_lane_2", "n_fork", "n_zz", "lane_2"),
      normalEdge("e_aa_join", "n_aa", "n_join"),
      normalEdge("e_zz_join", "n_zz", "n_join"),
      normalEdge("e_join_writer", "n_join", "n_writer"),
      normalEdge("e_writer_cond", "n_writer", "n_cond"),
      branchEdge("e_revise", "n_cond", "n_writer", "revise"),
      branchEdge("e_pass", "n_cond", "n_end", "pass"),
    ],
  };
}

/**
 * revise 打回 Fork：第二轮会再进并行区。Join 必须靠屏障 consume 清空 seen 才能再等齐。
 */
function reviseBackToForkDoc(): WorkflowDocument {
  const doc = reviseBackToWriterDoc();
  return {
    ...doc,
    name: "打回 Fork",
    edges: doc.edges.map((edge) =>
      edge.id === "e_revise"
        ? branchEdge("e_revise", "n_cond", "n_fork", "revise")
        : edge
    ),
  };
}

async function streamedNodeOrder(
  app: CompiledWorkflowApp,
  input: { messages: unknown[]; vars: Record<string, unknown> },
  extra?: { recursionLimit?: number }
) {
  const order: string[] = [];
  const stream = await app.stream(input, {
    streamMode: "updates",
    ...extra,
  });
  for await (const chunk of stream) {
    order.push(...Object.keys(chunk as Record<string, unknown>));
  }
  return order;
}

describe("collectStaticControlEdges", () => {
  it("lane 边逐条连，Join 走排序后的数组屏障，通道名与边序无关", () => {
    const doc = equalParallelToolDoc();
    const reversed: WorkflowDocument = {
      ...doc,
      edges: [...doc.edges].reverse(),
    };
    const wired = collectStaticControlEdges(doc);
    const wiredReversed = collectStaticControlEdges(reversed);
    const barriers = wired.filter((edge) => Array.isArray(edge.source));
    expect(barriers).toEqual([{ source: ["n_aa", "n_zz"], target: "n_join" }]);
    expect(wiredReversed.filter((edge) => Array.isArray(edge.source))).toEqual(
      barriers
    );
    expect(joinBarrierChannelName(["n_zz", "n_aa"], "n_join")).toBe(
      "join:n_aa+n_zz:n_join"
    );
    expect(wired).toEqual(
      expect.arrayContaining([
        { source: "n_fork", target: "n_aa" },
        { source: "n_fork", target: "n_zz" },
      ])
    );
    expect(
      wired.some((edge) => edge.source === "n_aa" && edge.target === "n_join")
    ).toBe(false);
  });

  it("边界：不等长通道的屏障名单是链尾，不是入口", () => {
    const wired = collectStaticControlEdges(unevenParallelToolDoc());
    expect(wired.filter((edge) => Array.isArray(edge.source))).toEqual([
      { source: ["n_a1", "n_a2b"], target: "n_join" },
    ]);
  });

  it("边界：Start 直连 Join 时抛错，避免 LangGraph 把 START 塞进数组 addEdge", () => {
    const doc: WorkflowDocument = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      name: "非法",
      startNodeId: "n_start",
      nodes: [
        node("start", "n_start"),
        node("join", "n_join"),
        node("end", "n_end"),
      ],
      edges: [
        normalEdge("e1", "n_start", "n_join"),
        normalEdge("e2", "n_join", "n_end"),
      ],
    };
    expect(() => collectStaticControlEdges(doc)).toThrow("Start 不能直连 Join");
  });

  it("边界：同一前驱两条入 Join 的边只进屏障一次", () => {
    const doc = equalParallelToolDoc();
    doc.edges.push(normalEdge("e_dup", "n_aa", "n_join"));
    const barriers = collectStaticControlEdges(doc).filter((edge) =>
      Array.isArray(edge.source)
    );
    expect(barriers).toEqual([{ source: ["n_aa", "n_zz"], target: "n_join" }]);
  });

  it("两段并行各自一块屏障，JoinA 出边仍是普通边", () => {
    const wired = collectStaticControlEdges(twoRegionDoc());
    expect(wired.filter((edge) => Array.isArray(edge.source))).toEqual([
      { source: ["n_a1", "n_a2"], target: "n_join_a" },
      { source: ["n_b1", "n_b2"], target: "n_join_b" },
    ]);
    expect(wired).toEqual(
      expect.arrayContaining([
        { source: "n_join_a", target: "n_fork_b" },
        { source: START, target: "n_fork_a" },
        { source: "n_join_b", target: END },
      ])
    );
  });

  it("N=4 四条 lane 都逐条 addEdge，屏障名单含四个链尾", () => {
    const wired = collectStaticControlEdges(parallelNToolDoc(4));
    expect(wired.filter((edge) => Array.isArray(edge.source))).toEqual([
      { source: ["n_t1", "n_t2", "n_t3", "n_t4"], target: "n_join" },
    ]);
    expect(wired).toEqual(
      expect.arrayContaining([
        { source: "n_fork", target: "n_t1" },
        { source: "n_fork", target: "n_t2" },
        { source: "n_fork", target: "n_t3" },
        { source: "n_fork", target: "n_t4" },
      ])
    );
  });

  it("主笔的 Join 入边仍是普通边，不能编成屏障", () => {
    const wired = collectStaticControlEdges(reviseBackToWriterDoc());
    expect(
      wired.some(
        (edge) => Array.isArray(edge.source) && edge.target === "n_writer"
      )
    ).toBe(false);
    expect(wired).toEqual(
      expect.arrayContaining([{ source: "n_join", target: "n_writer" }])
    );
  });
});

describe("compileWorkflow fork/join", () => {
  const resources = {
    agents: new Map(),
    tools: new Map([[TOOL_UUID, echoTool()]]),
  };

  it("N=2 并行跑完后两路 outputKey 都进 vars，且 Join 排在两路之后", async () => {
    const compiled = await compileWorkflow(equalParallelToolDoc(), {
      resources,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const input = { messages: [], vars: { city: "杭州" } };
    const out = await compiled.app.invoke(input);
    expect(out.vars.out_aa).toBeDefined();
    expect(out.vars.out_zz).toBeDefined();
    const order = await streamedNodeOrder(compiled.app, input);
    expect(order.indexOf("n_join")).toBeGreaterThan(order.indexOf("n_aa"));
    expect(order.indexOf("n_join")).toBeGreaterThan(order.indexOf("n_zz"));
  });

  it("N=4 四条 lane 的 outputKey 都进 vars", async () => {
    const compiled = await compileWorkflow(parallelNToolDoc(4), { resources });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const out = await compiled.app.invoke({
      messages: [],
      vars: { city: "杭州" },
    });
    expect(out.vars.out_1).toBeDefined();
    expect(out.vars.out_2).toBeDefined();
    expect(out.vars.out_3).toBeDefined();
    expect(out.vars.out_4).toBeDefined();
  });

  it("边界：N=4 缺一条 lane 出边时 compile 失败", async () => {
    const doc = parallelNToolDoc(4);
    doc.edges = doc.edges.filter((edge) => edge.id !== "e_lane_3");
    const compiled = await compileWorkflow(doc, { resources });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(
      compiled.errors.some((issue) => issue.message.includes("lane_3"))
    ).toBe(true);
  });

  it("两段并行运行时各 Join 只跑一次，JoinA 早于第二段 Fork", async () => {
    const compiled = await compileWorkflow(twoRegionDoc(), { resources });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const order = await streamedNodeOrder(compiled.app, {
      messages: [],
      vars: { city: "杭州" },
    });
    expect(order.filter((id) => id === "n_join_a")).toHaveLength(1);
    expect(order.filter((id) => id === "n_join_b")).toHaveLength(1);
    expect(order.indexOf("n_join_a")).toBeLessThan(order.indexOf("n_fork_b"));
    expect(order.indexOf("n_join_a")).toBeLessThan(order.indexOf("n_b1"));
    expect(order.indexOf("n_join_b")).toBeGreaterThan(order.indexOf("n_b1"));
    expect(order.indexOf("n_join_b")).toBeGreaterThan(order.indexOf("n_b2"));
  });

  it("边界：不等长 lane 时 Join 只执行一次，且排在长 lane 链尾之后", async () => {
    const compiled = await compileWorkflow(unevenParallelToolDoc(), {
      resources,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const order = await streamedNodeOrder(compiled.app, {
      messages: [],
      vars: { city: "杭州" },
    });
    const joinHits = order.filter((id) => id === "n_join");
    expect(joinHits).toHaveLength(1);
    expect(order.indexOf("n_join")).toBeGreaterThan(order.indexOf("n_a2b"));
    expect(order.indexOf("n_a1")).toBeGreaterThan(-1);
    expect(order.indexOf("n_a2")).toBeGreaterThan(-1);
    expect(order.indexOf("n_a2")).toBeLessThan(order.indexOf("n_a2b"));
  });

  it("同一 DSL 两次编译得到同名屏障通道，resume 才对得上 checkpoint", async () => {
    const doc = equalParallelToolDoc();
    const first = await compileWorkflow(doc, { resources });
    const second = await compileWorkflow(
      { ...doc, edges: [...doc.edges].reverse() },
      { resources }
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const name = joinBarrierChannelName(["n_zz", "n_aa"], "n_join");
    const channelsOf = (app: { channels?: Record<string, unknown> }) =>
      Object.keys(app.channels ?? {});
    expect(channelsOf(first.app)).toContain(name);
    expect(channelsOf(second.app)).toContain(name);
  });

  it("区内 tool 不把摘要写进 messages，只有 vars 增加", async () => {
    const compiled = await compileWorkflow(equalParallelToolDoc(), {
      resources,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const seed = [new HumanMessage("并行前的对话")];
    const out = await compiled.app.invoke({
      messages: seed,
      vars: { city: "杭州" },
      lastAgentText: "before-parallel",
    });
    expect(out.lastAgentText).toBe("before-parallel");
    expect(out.messages).toHaveLength(1);
    expect(out.vars.out_aa).toBeDefined();
    expect(out.vars.out_zz).toBeDefined();
  });
});

function agentWithOutput(id: string, outputKey: string) {
  const data = createNodeData("agent");
  if (data.kind !== "agent") throw new Error("unreachable");
  data.config = { agentId: AGENT_UUID, outputKey };
  return { ...node("agent", id), data };
}

function parallelAgentDoc(afterJoin?: boolean): WorkflowDocument {
  const after = afterJoin
    ? [agentWithOutput("n_writer", DEFAULT_AGENT_OUTPUT_KEY)]
    : [];
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "并行智能体",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      forkNode("n_fork", 2),
      agentWithOutput("n_aa", "out_aa"),
      agentWithOutput("n_zz", "out_zz"),
      node("join", "n_join"),
      ...after,
      node("end", "n_end"),
    ],
    edges: [
      normalEdge("e_start", "n_start", "n_fork"),
      laneEdge("e_lane_1", "n_fork", "n_aa", "lane_1"),
      laneEdge("e_lane_2", "n_fork", "n_zz", "lane_2"),
      normalEdge("e_aa_join", "n_aa", "n_join"),
      normalEdge("e_zz_join", "n_zz", "n_join"),
      ...(afterJoin
        ? [
            normalEdge("e_join_writer", "n_join", "n_writer"),
            normalEdge("e_writer_end", "n_writer", "n_end"),
          ]
        : [normalEdge("e_join_end", "n_join", "n_end")]),
    ],
  };
}

describe("regionInteriorNodeIds / messagesMode", () => {
  it("无 Fork 的串行图 interior 为空，区外 Agent 仍写 lastAgentText 与 messages", async () => {
    expect(regionInteriorNodeIds(agentThenConditionDoc()).size).toBe(0);
    const agents = new Map([
      [AGENT_UUID, { agent: agentRow(), tools: [] as ToolRow[] }],
    ]);
    const compiled = await compileWorkflow(agentThenConditionDoc(), {
      resources: { agents, tools: new Map() },
      createModel: scriptedCreateModel(["need_human"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const seed = [new HumanMessage("这个单要不要人工？")];
    const out = await compiled.app.invoke({ messages: seed, vars: {} });
    expect(out.lastAgentText).toBe("need_human");
    expect(out.messages.length).toBeGreaterThan(seed.length);
  });

  it("并行区内 Agent 不改 lastAgentText / messages，只写各自 vars", async () => {
    const agents = new Map([
      [AGENT_UUID, { agent: agentRow(), tools: [] as ToolRow[] }],
    ]);
    const compiled = await compileWorkflow(parallelAgentDoc(), {
      resources: { agents, tools: new Map() },
      createModel: scriptedCreateModel(["lane-a", "lane-z"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const seed = [new HumanMessage("共享历史不应被区内改写")];
    const out = await compiled.app.invoke({
      messages: seed,
      vars: {},
      lastAgentText: "before-parallel",
    });
    expect(out.lastAgentText).toBe("before-parallel");
    expect(out.messages).toEqual(seed);
    expect(out.vars.out_aa).toBeTruthy();
    expect(out.vars.out_zz).toBeTruthy();
  });

  it("边界：Join 之后的 Agent 仍是 inherit，会写 lastAgentText", async () => {
    expect([...regionInteriorNodeIds(parallelAgentDoc(true))].sort()).toEqual([
      "n_aa",
      "n_zz",
    ]);
    const agents = new Map([
      [AGENT_UUID, { agent: agentRow(), tools: [] as ToolRow[] }],
    ]);
    const compiled = await compileWorkflow(parallelAgentDoc(true), {
      resources: { agents, tools: new Map() },
      createModel: scriptedCreateModel(["lane-a", "lane-z", "after-join"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const out = await compiled.app.invoke({
      messages: [new HumanMessage("seed")],
      vars: {},
      lastAgentText: "before-parallel",
    });
    expect(out.lastAgentText).toBe("after-join");
    expect(out.vars.lastAgentText).toBe("after-join");
    expect(out.vars.out_aa).toBeTruthy();
    expect(out.vars.out_zz).toBeTruthy();
  });

  it("边界：两段并行的 interior 是并集，Fork/Join 本身不算 interior", () => {
    const ids = regionInteriorNodeIds(twoRegionDoc());
    expect([...ids].sort()).toEqual(["n_a1", "n_a2", "n_b1", "n_b2"]);
    expect(ids.has("n_fork_a")).toBe(false);
    expect(ids.has("n_join_a")).toBe(false);
    expect(ids.has("n_fork_b")).toBe(false);
    expect(ids.has("n_join_b")).toBe(false);
  });

  it("边界：区内 Agent 没有 inputMap 时仍能跑，且不写回 messages", async () => {
    const agents = new Map([
      [AGENT_UUID, { agent: agentRow(), tools: [] as ToolRow[] }],
    ]);
    const compiled = await compileWorkflow(parallelAgentDoc(), {
      resources: { agents, tools: new Map() },
      createModel: scriptedCreateModel(["x", "y"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const out = await compiled.app.invoke({ messages: [], vars: {} });
    expect(out.messages).toEqual([]);
    expect(out.lastAgentText).toBe("");
  });
});

describe("compileWorkflow 环与屏障重置", () => {
  const toolResources = {
    agents: new Map([
      [AGENT_UUID, { agent: agentRow(), tools: [] as ToolRow[] }],
    ]),
    tools: new Map([[TOOL_UUID, echoTool()]]),
  };

  it("Join 之后打回主笔时主笔第一轮就执行，且能跑满两轮", async () => {
    const compiled = await compileWorkflow(reviseBackToWriterDoc(), {
      resources: toolResources,
      createModel: scriptedCreateModel(["revise", "pass"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const order = await streamedNodeOrder(
      compiled.app,
      { messages: [], vars: { city: "杭州" } },
      { recursionLimit: 50 }
    );
    const writerHits = order.filter((id) => id === "n_writer");
    expect(writerHits).toHaveLength(2);
    expect(order.indexOf("n_writer")).toBeLessThan(order.indexOf("n_cond"));
    expect(order.indexOf("n_join")).toBeLessThan(order.indexOf("n_writer"));
    expect(order.filter((id) => id === "n_join")).toHaveLength(1);
  });

  it("边界：revise 打回 Fork 时 Join 跑两次，说明屏障 consume 后能再等齐", async () => {
    const compiled = await compileWorkflow(reviseBackToForkDoc(), {
      resources: toolResources,
      createModel: scriptedCreateModel(["revise", "pass"]),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const order = await streamedNodeOrder(
      compiled.app,
      { messages: [], vars: { city: "杭州" } },
      { recursionLimit: 50 }
    );
    expect(order.filter((id) => id === "n_join")).toHaveLength(2);
    expect(order.filter((id) => id === "n_writer")).toHaveLength(2);
    expect(order.filter((id) => id === "n_fork")).toHaveLength(2);
  });

  it("边界：空 messages 的旧串行条件图仍能 compile 并按 vars 路由", async () => {
    const compiled = await compileWorkflow(expressionDoc(), {
      resources: { agents: new Map(), tools: new Map() },
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const yes = await compiled.app.invoke({
      messages: [],
      vars: { need_human: true },
    });
    expect(yes._route).toBe("yes");
  });
});

function serialAssignDoc(
  sets: Array<{ key: string; expression: string }>,
): WorkflowDocument {
  const data = createNodeData("assign");
  if (data.kind !== "assign") throw new Error("unreachable");
  data.config = { sets };
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "赋值运行",
    startNodeId: "n_start",
    nodes: [
      node("start", "n_start"),
      { ...node("assign", "n_assign"), data },
      node("end", "n_end"),
    ],
    edges: [
      {
        id: "e1",
        source: "n_start",
        target: "n_assign",
        data: { kind: "normal" },
      },
      {
        id: "e2",
        source: "n_assign",
        target: "n_end",
        data: { kind: "normal" },
      },
    ],
  };
}

describe("compileWorkflow assign", () => {
  const resources = { agents: new Map(), tools: new Map() };

  it("未写入 round 时赋值 round+1 得到 1，Start 不必声明该入参", async () => {
    const compiled = await compileWorkflow(
      serialAssignDoc([{ key: "round", expression: "state.vars.round + 1" }]),
      { resources },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const out = await compiled.app.invoke({ messages: [], vars: {} });
    expect(out.vars.round).toBe(1);
  });

  it("JSON 类型都可以写入 vars", async () => {
    const compiled = await compileWorkflow(
      serialAssignDoc([
        { key: "n", expression: "2" },
        { key: "ok", expression: "true" },
        { key: "title", expression: "'x'" },
        { key: "ids", expression: "[1, 2]" },
      ]),
      { resources },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const out = await compiled.app.invoke({ messages: [], vars: {} });
    expect(out.vars).toMatchObject({ n: 2, ok: true, title: "x", ids: [1, 2] });
  });

  it("边界：空 sets 在 compile 失败，不能编出可运行图", async () => {
    const compiled = await compileWorkflow(serialAssignDoc([]), { resources });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(
      compiled.errors.some((issue) => issue.message.includes("至少需要一条赋值")),
    ).toBe(true);
  });

  it("边界：缺失非 round 键做加法时运行 throw，而不是写入 NaN", async () => {
    const compiled = await compileWorkflow(
      serialAssignDoc([{ key: "n", expression: "state.vars.missing + 1" }]),
      { resources },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    await expect(
      compiled.app.invoke({ messages: [], vars: {} }),
    ).rejects.toThrow(/求值失败/);
  });
});
