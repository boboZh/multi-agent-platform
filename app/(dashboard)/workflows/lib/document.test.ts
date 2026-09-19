import { describe, expect, it } from "vitest";
import {
  createEmptyWorkflowDocument,
  parseWorkflowDocument,
  type WorkflowDocument,
} from "@/lib/workflow-dsl/schema";
import {
  addConditionBranch,
  addForkLane,
  addNode,
  canConnect,
  connect,
  nextEdgeId,
  nextNodeId,
  removeConditionBranch,
  removeEdges,
  removeForkLane,
  removeNodes,
  renameConditionBranch,
  renameForkLane,
  sanitizeDocumentForSave,
  setForkLaneLabel,
  updateNode,
} from "./document";

/**
 * 画布文档操作。这些函数的正确性直接决定「画布上看到的」和「编译器读到的」是否一致，
 * 所以用例重点压两类风险：端口约束被绕过、条件分支与边失去同步。
 */

/** 基线：start → end 的空图，再挂一个条件节点，便于测分支相关逻辑。 */
function docWithCondition(): WorkflowDocument {
  const base = createEmptyWorkflowDocument("测试");
  const { doc } = addNode(base, "condition", { x: 100, y: 100 });
  return doc;
}

function conditionConfig(doc: WorkflowDocument, nodeId: string) {
  const node = doc.nodes.find((item) => item.id === nodeId);
  if (!node || node.data.kind !== "condition") {
    throw new Error("测试夹具期望这是一个条件节点");
  }
  return node.data.config;
}

function docWithFork(): WorkflowDocument {
  const base = createEmptyWorkflowDocument("测试");
  const { doc } = addNode(base, "fork", { x: 100, y: 100 });
  return doc;
}

function forkConfig(doc: WorkflowDocument, nodeId: string) {
  const node = doc.nodes.find((item) => item.id === nodeId);
  if (!node || node.data.kind !== "fork") {
    throw new Error("测试夹具期望这是一个并行扇出节点");
  }
  return node.data.config;
}

describe("空图基线", () => {
  // 编辑器头部常驻拓扑校验结果，新建页一进来就报错会让人以为功能坏了。
  it("新建的 start→end 空图直接通过 graph 校验", () => {
    const parsed = parseWorkflowDocument(createEmptyWorkflowDocument("测试"), "graph");
    expect(parsed.ok).toBe(true);
  });
});

describe("nextNodeId / nextEdgeId", () => {
  it("首个节点用 n_<kind>，重名时按序号递增", () => {
    expect(nextNodeId("agent", [])).toBe("n_agent");
    expect(nextNodeId("agent", ["n_agent"])).toBe("n_agent_2");
    expect(nextNodeId("agent", ["n_agent", "n_agent_2"])).toBe("n_agent_3");
  });

  // id 会直接当 LangGraph 节点名，必须是合法标识符。
  it("生成的 id 始终符合图节点标识符规则", () => {
    expect(nextNodeId("human_review", [])).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
  });

  it("边界：已占用序号被跳过，不会产生重复 id", () => {
    expect(nextNodeId("tool", ["n_tool", "n_tool_2", "n_tool_3"])).toBe("n_tool_4");
    expect(nextEdgeId(["e_1", "e_2"])).toBe("e_3");
  });
});

describe("addNode", () => {
  it("拖入的新节点自带合法默认配置且 type 与 kind 对齐", () => {
    const { doc, nodeId } = addNode(
      createEmptyWorkflowDocument("测试"),
      "agent",
      { x: 10, y: 20 },
    );
    const node = doc.nodes.find((item) => item.id === nodeId);
    expect(node?.type).toBe("agentNode");
    expect(node?.position).toEqual({ x: 10, y: 20 });
    // 刚拖进来就必须能过 draft 校验，否则用户没法保存半成品草稿。
    expect(parseWorkflowDocument(doc, "draft").ok).toBe(true);
  });

  it("拖入 Fork / Join 时 type 对齐，Fork 默认两条通道、Join 只有 wait:all", () => {
    const fork = addNode(createEmptyWorkflowDocument("测试"), "fork", {
      x: 0,
      y: 0,
    });
    const forkNode = fork.doc.nodes.find((item) => item.id === fork.nodeId);
    expect(forkNode?.type).toBe("forkNode");
    expect(forkNode?.data.kind === "fork" && forkNode.data.config.lanes).toEqual([
      { key: "lane_1", label: "通道 1" },
      { key: "lane_2", label: "通道 2" },
    ]);

    const join = addNode(fork.doc, "join", { x: 0, y: 80 });
    const joinNode = join.doc.nodes.find((item) => item.id === join.nodeId);
    expect(joinNode?.type).toBe("joinNode");
    expect(joinNode?.data.kind === "join" && joinNode.data.config).toEqual({
      wait: "all",
    });
    expect(parseWorkflowDocument(join.doc, "draft").ok).toBe(true);

    const assign = addNode(join.doc, "assign", { x: 0, y: 160 });
    const assignNode = assign.doc.nodes.find((item) => item.id === assign.nodeId);
    expect(assignNode?.type).toBe("assignNode");
    expect(
      assignNode?.data.kind === "assign" && assignNode.data.config.sets,
    ).toEqual([]);
    expect(parseWorkflowDocument(assign.doc, "draft").ok).toBe(true);
  });
});

describe("removeNodes", () => {
  it("删除节点时级联删掉挂在它身上的边", () => {
    const base = createEmptyWorkflowDocument("测试");
    const next = removeNodes(base, ["n_end"]);
    expect(next.nodes.map((node) => node.id)).toEqual(["n_start"]);
    expect(next.edges).toHaveLength(0);
  });

  // start 是 startNodeId 指向的运行入口，删掉无法在画布上恢复。
  it("边界：start 节点受保护，请求删除时被忽略", () => {
    const base = createEmptyWorkflowDocument("测试");
    const next = removeNodes(base, ["n_start"]);
    expect(next).toBe(base);
    expect(next.nodes.map((node) => node.id)).toContain("n_start");
  });

  it("边界：传入空集合或不存在的 id 时返回原对象，不产生无谓重渲染", () => {
    const base = createEmptyWorkflowDocument("测试");
    expect(removeNodes(base, [])).toBe(base);
    expect(removeNodes(base, ["ghost"])).toBe(base);
    expect(removeEdges(base, [])).toBe(base);
  });

  it("批量删除时只跳过 start，其余照常删除", () => {
    const base = createEmptyWorkflowDocument("测试");
    const next = removeNodes(base, ["n_start", "n_end"]);
    expect(next.nodes.map((node) => node.id)).toEqual(["n_start"]);
  });
});

describe("canConnect", () => {
  const base = createEmptyWorkflowDocument("测试");

  it("边界：连到 start 的入边被拒绝", () => {
    const result = canConnect(base, {
      source: "n_end",
      target: "n_start",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(result.ok).toBe(false);
  });

  it("边界：从 end 拉出的出边被拒绝", () => {
    const { doc } = addNode(base, "agent", { x: 0, y: 0 });
    const result = canConnect(doc, {
      source: "n_end",
      target: "n_agent",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("结束节点");
  });

  it("边界：自环被拒绝", () => {
    const { doc } = addNode(base, "agent", { x: 0, y: 0 });
    const result = canConnect(doc, {
      source: "n_agent",
      target: "n_agent",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(result.ok).toBe(false);
  });

  it("边界：端点不存在时拒绝而不是抛异常", () => {
    expect(
      canConnect(base, {
        source: "ghost",
        target: "n_end",
        sourceHandle: null,
        targetHandle: null,
      }).ok,
    ).toBe(false);
    expect(
      canConnect(base, {
        source: null,
        target: null,
        sourceHandle: null,
        targetHandle: null,
      }).ok,
    ).toBe(false);
  });

  it("条件节点必须带分支 handle，非条件节点不允许带 handle", () => {
    const doc = docWithCondition();
    expect(
      canConnect(doc, {
        source: "n_condition",
        target: "n_end",
        sourceHandle: null,
        targetHandle: null,
      }).ok,
    ).toBe(false);
    expect(
      canConnect(doc, {
        source: "n_condition",
        target: "n_end",
        sourceHandle: "yes",
        targetHandle: null,
      }).ok,
    ).toBe(true);
    expect(
      canConnect(doc, {
        source: "n_start",
        target: "n_end",
        sourceHandle: "yes",
        targetHandle: null,
      }).ok,
    ).toBe(false);
  });

  it("边界：同源同 handle 的重复连线被拒绝", () => {
    // n_start → n_end 在空图里已存在。
    expect(
      canConnect(base, {
        source: "n_start",
        target: "n_end",
        sourceHandle: null,
        targetHandle: null,
      }).ok,
    ).toBe(false);
  });
});

describe("connect", () => {
  // 端口规格是「一个出口一条边」，所以改连线是替换而不是并存，否则立刻违反 graph 校验。
  it("同一出口再次连线时替换旧边而不是叠加", () => {
    const base = createEmptyWorkflowDocument("测试");
    const { doc } = addNode(base, "agent", { x: 0, y: 0 });
    const result = connect(doc, {
      source: "n_start",
      target: "n_agent",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outgoing = result.doc.edges.filter((edge) => edge.source === "n_start");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].target).toBe("n_agent");
  });

  it("条件出边同时写入 sourceHandle 与 data.branchKey 且两者一致", () => {
    const doc = docWithCondition();
    const result = connect(doc, {
      source: "n_condition",
      target: "n_end",
      sourceHandle: "no",
      targetHandle: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.doc.edges.find((item) => item.source === "n_condition");
    expect(edge?.sourceHandle).toBe("no");
    expect(edge?.data).toEqual({ kind: "branch", branchKey: "no" });
  });

  it("非条件出边写入 normal", () => {
    const base = createEmptyWorkflowDocument("测试");
    const { doc } = addNode(base, "agent", { x: 0, y: 0 });
    const result = connect(doc, {
      source: "n_agent",
      target: "n_end",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.doc.edges.find((item) => item.source === "n_agent");
    expect(edge?.data).toEqual({ kind: "normal" });
  });

  it("边界：非法连线返回中文原因且不改动原文档", () => {
    const base = createEmptyWorkflowDocument("测试");
    const result = connect(base, {
      source: "n_end",
      target: "n_start",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
    expect(base.edges).toHaveLength(1);
  });
});

describe("条件分支与边的同步", () => {
  it("新增分支后画布多出一个可连的端口", () => {
    const doc = docWithCondition();
    const result = addConditionBranch(doc, "n_condition");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = conditionConfig(result.doc, "n_condition").branches.map(
      (branch) => branch.key,
    );
    // 画布按 branches 顺序长 handle，所以顺序本身也是契约的一部分。
    expect(keys).toEqual(["yes", "no", "branch_3"]);
  });

  it("删除分支时连带删掉挂在该端口上的边", () => {
    const doc = docWithCondition();
    const added = addConditionBranch(doc, "n_condition");
    if (!added.ok) throw new Error("夹具准备失败");
    const connected = connect(added.doc, {
      source: "n_condition",
      target: "n_end",
      sourceHandle: "branch_3",
      targetHandle: null,
    });
    if (!connected.ok) throw new Error("夹具准备失败");
    expect(
      connected.doc.edges.some((edge) => edge.sourceHandle === "branch_3"),
    ).toBe(true);

    const removed = removeConditionBranch(connected.doc, "n_condition", "branch_3");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(
      removed.doc.edges.some((edge) => edge.sourceHandle === "branch_3"),
    ).toBe(false);
  });

  // schema 要求至少两个分支，删到一个会让整份文档非法。
  it("边界：只剩两个分支时拒绝继续删除", () => {
    const doc = docWithCondition();
    const result = removeConditionBranch(doc, "n_condition", "no");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("至少");
  });

  it("边界：删除的正好是 defaultBranch 时改指到剩余的第一个分支", () => {
    const doc = docWithCondition();
    const added = addConditionBranch(doc, "n_condition");
    if (!added.ok) throw new Error("夹具准备失败");
    expect(conditionConfig(added.doc, "n_condition").defaultBranch).toBe("no");

    const removed = removeConditionBranch(added.doc, "n_condition", "no");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const config = conditionConfig(removed.doc, "n_condition");
    expect(config.defaultBranch).toBe("yes");
    expect(config.branches.map((branch) => branch.key)).toEqual([
      "yes",
      "branch_3",
    ]);
  });

  it("重命名分支时同步改掉边的 sourceHandle、branchKey 与 defaultBranch", () => {
    const doc = docWithCondition();
    const connected = connect(doc, {
      source: "n_condition",
      target: "n_end",
      sourceHandle: "no",
      targetHandle: null,
    });
    if (!connected.ok) throw new Error("夹具准备失败");

    const renamed = renameConditionBranch(connected.doc, "n_condition", "no", "reject");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;

    const config = conditionConfig(renamed.doc, "n_condition");
    expect(config.branches.map((b) => b.key)).toEqual(["yes", "reject"]);
    expect(config.defaultBranch).toBe("reject");
    const edge = renamed.doc.edges.find((item) => item.source === "n_condition");
    expect(edge?.sourceHandle).toBe("reject");
    expect(edge?.data).toEqual({ kind: "branch", branchKey: "reject" });
  });

  it("边界：非法或重复的分支 key 被拒绝", () => {
    const doc = docWithCondition();
    expect(renameConditionBranch(doc, "n_condition", "no", "1bad").ok).toBe(false);
    expect(renameConditionBranch(doc, "n_condition", "no", "yes").ok).toBe(false);
    expect(renameConditionBranch(doc, "n_condition", "ghost", "ok").ok).toBe(false);
  });

  it("边界：对非条件节点做分支操作时拒绝而不是崩溃", () => {
    const base = createEmptyWorkflowDocument("测试");
    expect(addConditionBranch(base, "n_start").ok).toBe(false);
    expect(removeConditionBranch(base, "n_start", "yes").ok).toBe(false);
    expect(renameConditionBranch(base, "n_start", "yes", "no").ok).toBe(false);
  });
});

describe("updateNode", () => {
  it("按 kind 收窄后只替换目标节点的 data，其余节点保持同一引用", () => {
    const base = createEmptyWorkflowDocument("测试");
    const { doc } = addNode(base, "agent", { x: 0, y: 0 });
    const next = updateNode(doc, "n_agent", (data) =>
      data.kind === "agent"
        ? { ...data, config: { ...data.config, outputKey: "reply" } }
        : data,
    );
    const agent = next.nodes.find((node) => node.id === "n_agent");
    expect(agent?.data.kind === "agent" && agent.data.config.outputKey).toBe("reply");
    // 未命中的节点保持引用不变，避免整张画布无谓重渲染。
    expect(next.nodes[0]).toBe(doc.nodes[0]);
  });
});

describe("sanitizeDocumentForSave", () => {
  // reactflow 会把选中态、拖拽态直接挂到节点对象上，这些瞬时字段不该进库。
  it("剥离 reactflow 注入的运行时字段（selected / dragging / positionAbsolute）", () => {
    const base = createEmptyWorkflowDocument("测试");
    const dirty = {
      ...base,
      nodes: base.nodes.map((node) => ({
        ...node,
        selected: true,
        dragging: false,
        positionAbsolute: { x: 1, y: 2 },
      })),
    } as WorkflowDocument;

    const result = sanitizeDocumentForSave(dirty);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const node of result.doc.nodes) {
      expect(node).not.toHaveProperty("selected");
      expect(node).not.toHaveProperty("dragging");
      expect(node).not.toHaveProperty("positionAbsolute");
    }
  });

  it("边界：文档形状被破坏时返回失败而不是写出脏 DSL", () => {
    const broken = {
      ...createEmptyWorkflowDocument("测试"),
      nodes: [],
    } as unknown as WorkflowDocument;
    expect(sanitizeDocumentForSave(broken).ok).toBe(false);
  });
});

describe("Fork / Join 画布连线与通道 CRUD", () => {
  it("两个通道 handle 上的边并存，不会因为连第二条而清掉第一条", () => {
    const { doc: withAgents } = addNode(docWithFork(), "agent", { x: 0, y: 200 });
    const { doc } = addNode(withAgents, "agent", { x: 200, y: 200 });
    const first = connect(doc, {
      source: "n_fork",
      target: "n_agent",
      sourceHandle: "lane_1",
      targetHandle: null,
    });
    if (!first.ok) throw new Error("夹具准备失败");
    const second = connect(first.doc, {
      source: "n_fork",
      target: "n_agent_2",
      sourceHandle: "lane_2",
      targetHandle: null,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const outgoing = second.doc.edges.filter((edge) => edge.source === "n_fork");
    expect(outgoing).toHaveLength(2);
    expect(outgoing.map((edge) => edge.data)).toEqual([
      { kind: "lane", laneKey: "lane_1" },
      { kind: "lane", laneKey: "lane_2" },
    ]);
  });

  it("新增通道后第 3 个 handle 可以连线，且写入 lane 边", () => {
    const added = addForkLane(docWithFork(), "n_fork");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(forkConfig(added.doc, "n_fork").lanes.map((lane) => lane.key)).toEqual([
      "lane_1",
      "lane_2",
      "lane_3",
    ]);

    const { doc: withAgent } = addNode(added.doc, "agent", { x: 0, y: 200 });
    const lane1 = connect(withAgent, {
      source: "n_fork",
      target: "n_agent",
      sourceHandle: "lane_1",
      targetHandle: null,
    });
    if (!lane1.ok) throw new Error("夹具准备失败");
    const result = connect(lane1.doc, {
      source: "n_fork",
      target: "n_end",
      sourceHandle: "lane_3",
      targetHandle: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outgoing = result.doc.edges.filter((edge) => edge.source === "n_fork");
    expect(outgoing).toHaveLength(2);
    expect(outgoing.map((edge) => edge.data)).toEqual([
      { kind: "lane", laneKey: "lane_1" },
      { kind: "lane", laneKey: "lane_3" },
    ]);
  });

  it("同一通道 handle 再次连线时替换旧边而不是叠加", () => {
    const { doc } = addNode(docWithFork(), "agent", { x: 0, y: 200 });
    const first = connect(doc, {
      source: "n_fork",
      target: "n_agent",
      sourceHandle: "lane_1",
      targetHandle: null,
    });
    if (!first.ok) throw new Error("夹具准备失败");
    const second = connect(first.doc, {
      source: "n_fork",
      target: "n_end",
      sourceHandle: "lane_1",
      targetHandle: null,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const lane1 = second.doc.edges.filter(
      (edge) => edge.source === "n_fork" && edge.sourceHandle === "lane_1",
    );
    expect(lane1).toHaveLength(1);
    expect(lane1[0].target).toBe("n_end");
  });

  it("Join 作目标时保留来自不同节点的多条入边", () => {
    const base = createEmptyWorkflowDocument("测试");
    const a1 = addNode(base, "agent", { x: 0, y: 0 });
    const a2 = addNode(a1.doc, "agent", { x: 200, y: 0 });
    const joined = addNode(a2.doc, "join", { x: 100, y: 200 });
    const first = connect(joined.doc, {
      source: "n_agent",
      target: "n_join",
      sourceHandle: null,
      targetHandle: null,
    });
    if (!first.ok) throw new Error("夹具准备失败");
    const second = connect(first.doc, {
      source: "n_agent_2",
      target: "n_join",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const incoming = second.doc.edges.filter((edge) => edge.target === "n_join");
    expect(incoming).toHaveLength(2);
    expect(incoming.map((edge) => edge.source).sort()).toEqual([
      "n_agent",
      "n_agent_2",
    ]);
  });

  it("边界：Fork 不带通道 handle 的拉线被拒绝", () => {
    const result = canConnect(docWithFork(), {
      source: "n_fork",
      target: "n_end",
      sourceHandle: null,
      targetHandle: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("通道端口");
  });

  it("边界：只剩两条通道时拒绝继续删除", () => {
    const result = removeForkLane(docWithFork(), "n_fork", "lane_1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("至少");
  });

  it("重命名通道时同步改掉边的 sourceHandle 与 laneKey", () => {
    const connected = connect(docWithFork(), {
      source: "n_fork",
      target: "n_end",
      sourceHandle: "lane_2",
      targetHandle: null,
    });
    if (!connected.ok) throw new Error("夹具准备失败");

    const renamed = renameForkLane(connected.doc, "n_fork", "lane_2", "market");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(forkConfig(renamed.doc, "n_fork").lanes.map((lane) => lane.key)).toEqual([
      "lane_1",
      "market",
    ]);
    const edge = renamed.doc.edges.find((item) => item.source === "n_fork");
    expect(edge?.sourceHandle).toBe("market");
    expect(edge?.data).toEqual({ kind: "lane", laneKey: "market" });
  });

  it("改通道展示名只动 label，不改边的 laneKey", () => {
    const connected = connect(docWithFork(), {
      source: "n_fork",
      target: "n_end",
      sourceHandle: "lane_1",
      targetHandle: null,
    });
    if (!connected.ok) throw new Error("夹具准备失败");
    const next = setForkLaneLabel(connected.doc, "n_fork", "lane_1", "市场调研");
    expect(forkConfig(next, "n_fork").lanes[0]).toEqual({
      key: "lane_1",
      label: "市场调研",
    });
    const edge = next.edges.find((item) => item.source === "n_fork");
    expect(edge?.data).toEqual({ kind: "lane", laneKey: "lane_1" });
  });

  it("边界：未知 handle、fork 直连 fork、以及超上限增通道都被拒绝", () => {
    const forkA = docWithFork();
    const { doc: twoForks } = addNode(forkA, "fork", { x: 300, y: 100 });
    expect(
      canConnect(twoForks, {
        source: "n_fork",
        target: "n_fork_2",
        sourceHandle: "lane_1",
        targetHandle: null,
      }).ok,
    ).toBe(false);
    expect(
      canConnect(forkA, {
        source: "n_fork",
        target: "n_end",
        sourceHandle: "ghost",
        targetHandle: null,
      }).ok,
    ).toBe(false);

    let current = forkA;
    for (let i = 0; i < 14; i += 1) {
      const added = addForkLane(current, "n_fork");
      if (!added.ok) throw new Error("夹具准备失败");
      current = added.doc;
    }
    expect(forkConfig(current, "n_fork").lanes).toHaveLength(16);
    const overflow = addForkLane(current, "n_fork");
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toContain("最多");
  });

  it("边界：对非 Fork 节点做通道操作时拒绝而不是崩溃", () => {
    const base = createEmptyWorkflowDocument("测试");
    expect(addForkLane(base, "n_start").ok).toBe(false);
    expect(removeForkLane(base, "n_start", "lane_1").ok).toBe(false);
    expect(renameForkLane(base, "n_start", "lane_1", "lane_x").ok).toBe(false);
    expect(renameForkLane(docWithFork(), "n_fork", "lane_1", "1bad").ok).toBe(
      false,
    );
    expect(renameForkLane(docWithFork(), "n_fork", "lane_1", "lane_2").ok).toBe(
      false,
    );
    expect(renameForkLane(docWithFork(), "n_fork", "ghost", "lane_x").ok).toBe(
      false,
    );
  });

  it("删除通道时连带删掉挂在该端口上的边，其它通道的边保留", () => {
    const added = addForkLane(docWithFork(), "n_fork");
    if (!added.ok) throw new Error("夹具准备失败");
    const lane1 = connect(added.doc, {
      source: "n_fork",
      target: "n_end",
      sourceHandle: "lane_1",
      targetHandle: null,
    });
    if (!lane1.ok) throw new Error("夹具准备失败");
    const { doc: withAgent } = addNode(lane1.doc, "agent", { x: 0, y: 200 });
    const lane3 = connect(withAgent, {
      source: "n_fork",
      target: "n_agent",
      sourceHandle: "lane_3",
      targetHandle: null,
    });
    if (!lane3.ok) throw new Error("夹具准备失败");

    const removed = removeForkLane(lane3.doc, "n_fork", "lane_3");
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(
      removed.doc.edges.some((edge) => edge.sourceHandle === "lane_3"),
    ).toBe(false);
    expect(
      removed.doc.edges.some((edge) => edge.sourceHandle === "lane_1"),
    ).toBe(true);
  });
});
