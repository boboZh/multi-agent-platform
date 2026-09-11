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
import { compileWorkflow, dryRunCompile } from "@/lib/workflow-dsl/compile";
import {
  buildBranchPathMap,
  evaluateExpressionRoute,
  pickBranchKey,
  resolveInputMap,
  resolveStatePath,
  type WorkflowGraphState,
} from "@/lib/workflow-dsl/compile-utils";
import { END } from "@langchain/langgraph";

const AGENT_UUID = "11111111-1111-4111-8111-111111111111";
const TOOL_UUID = "22222222-2222-4222-8222-222222222222";

function emptyState(
  vars: Record<string, unknown> = {},
): WorkflowGraphState {
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
    async () => new AIMessage(queue.shift() ?? ""),
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
        "no",
      ),
    ).toBe("yes");
    expect(
      evaluateExpressionRoute(
        "state.vars.need_human === true",
        emptyState({ need_human: false }),
        keys,
        "no",
      ),
    ).toBe("no");
  });

  it("边界：表达式抛错或返回未知值时走 defaultBranch，避免整图崩溃", () => {
    expect(
      evaluateExpressionRoute("state.vars.x.y.z", emptyState(), keys, "no"),
    ).toBe("no");
    expect(
      evaluateExpressionRoute("'maybe'", emptyState(), keys, "no"),
    ).toBe("no");
  });

  it("边界：表达式直接返回分支 key 字符串时按 key 跳而不是当布尔", () => {
    expect(
      evaluateExpressionRoute(
        "state.vars.route",
        emptyState({ route: "yes" }),
        keys,
        "no",
      ),
    ).toBe("yes");
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
      new Set(["n_end"]),
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
      "compile",
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
            config: { agentId: AGENT_UUID, outputKey: DEFAULT_AGENT_OUTPUT_KEY },
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
    expect(compiled.errors.some((issue) => issue.message.includes("找不到智能体"))).toBe(
      true,
    );
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
    const doc: WorkflowDocument = {
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
    const compiled = await compileWorkflow(doc, {
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
      { resources: { agents: new Map(), tools: new Map() } },
    );
    expect(fail.ok).toBe(false);
    if (fail.ok) return;
    expect(fail.errors.length).toBeGreaterThan(0);
  });
});
