import { describe, expect, it } from "vitest";
import { createEmptyWorkflowDocument } from "@/lib/workflow-dsl/schema";
import { addNode, connect, type CanvasConnection, type DocumentResult } from "./document";
import {
  isParallelInteriorNode,
  parallelInputMapSourceWarning,
  parallelOutputKeyWarning,
} from "./parallel-inspector";

function mustConnect(
  doc: ReturnType<typeof createEmptyWorkflowDocument>,
  connection: CanvasConnection,
) {
  const result: DocumentResult = connect(doc, connection);
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
}

/**
 * start → Fork → 两 Agent → Join → Agent → end。
 * 用画布 connect 拼，保证判定函数吃的是编辑器真实会产出的边形状。
 */
function pairedParallelDoc() {
  const empty = createEmptyWorkflowDocument("测试");
  const fork = addNode(empty, "fork", { x: 0, y: 80 });
  const a1 = addNode(fork.doc, "agent", { x: 0, y: 180 });
  const a2 = addNode(a1.doc, "agent", { x: 200, y: 180 });
  const join = addNode(a2.doc, "join", { x: 80, y: 280 });
  const after = addNode(join.doc, "agent", { x: 80, y: 380 });

  let doc = after.doc;
  doc = mustConnect(doc, {
    source: "n_start",
    target: "n_fork",
    sourceHandle: null,
    targetHandle: null,
  });
  doc = mustConnect(doc, {
    source: "n_fork",
    target: "n_agent",
    sourceHandle: "lane_1",
    targetHandle: null,
  });
  doc = mustConnect(doc, {
    source: "n_fork",
    target: "n_agent_2",
    sourceHandle: "lane_2",
    targetHandle: null,
  });
  doc = mustConnect(doc, {
    source: "n_agent",
    target: "n_join",
    sourceHandle: null,
    targetHandle: null,
  });
  doc = mustConnect(doc, {
    source: "n_agent_2",
    target: "n_join",
    sourceHandle: null,
    targetHandle: null,
  });
  doc = mustConnect(doc, {
    source: "n_join",
    target: "n_agent_3",
    sourceHandle: null,
    targetHandle: null,
  });
  return mustConnect(doc, {
    source: "n_agent_3",
    target: "n_end",
    sourceHandle: null,
    targetHandle: null,
  });
}

describe("isParallelInteriorNode", () => {
  it("配对成功后只有通道内的节点算区内，Join 之后仍是区外", () => {
    const doc = pairedParallelDoc();
    expect(isParallelInteriorNode(doc, "n_agent")).toBe(true);
    expect(isParallelInteriorNode(doc, "n_agent_2")).toBe(true);
    expect(isParallelInteriorNode(doc, "n_agent_3")).toBe(false);
    expect(isParallelInteriorNode(doc, "n_fork")).toBe(false);
    expect(isParallelInteriorNode(doc, "n_join")).toBe(false);
  });

  it("边界：尚未配对出 region 时不当作区内，避免半成品图误报", () => {
    const { doc } = addNode(createEmptyWorkflowDocument("测试"), "fork", {
      x: 0,
      y: 0,
    });
    const withAgent = addNode(doc, "agent", { x: 0, y: 80 });
    expect(isParallelInteriorNode(withAgent.doc, "n_agent")).toBe(false);
  });

  it("边界：空图、不存在的 id、空字符串都不抛且返回 false", () => {
    const doc = createEmptyWorkflowDocument("测试");
    expect(isParallelInteriorNode(doc, "n_start")).toBe(false);
    expect(isParallelInteriorNode(doc, "ghost")).toBe(false);
    expect(isParallelInteriorNode(doc, "")).toBe(false);
  });
});

describe("parallelOutputKeyWarning", () => {
  it("默认 lastAgentText 给出与 compile 一致的警示", () => {
    expect(parallelOutputKeyWarning("lastAgentText")).toContain("lastAgentText");
  });

  it("独立 vars key 不警示", () => {
    expect(parallelOutputKeyWarning("market_review")).toBeNull();
  });

  it("边界：Tool 留空表示不写回，不能按默认 lastAgentText 处理", () => {
    expect(parallelOutputKeyWarning(undefined)).toBeNull();
    expect(parallelOutputKeyWarning("")).toBeNull();
  });
});

describe("parallelInputMapSourceWarning", () => {
  it("引用共享 lastAgentText 时警示", () => {
    expect(parallelInputMapSourceWarning("state.lastAgentText")).toContain(
      "state.lastAgentText",
    );
  });

  it("读 vars 不警示，即使 vars 里碰巧叫 lastAgentText", () => {
    expect(parallelInputMapSourceWarning("state.vars.market")).toBeNull();
    expect(parallelInputMapSourceWarning("state.vars.lastAgentText")).toBeNull();
  });

  it("边界：空白、子路径、带空格的共享字段引用", () => {
    expect(parallelInputMapSourceWarning("")).toBeNull();
    expect(parallelInputMapSourceWarning("   ")).toBeNull();
    expect(parallelInputMapSourceWarning("  state.lastAgentText  ")).not.toBeNull();
    expect(parallelInputMapSourceWarning("state.lastAgentText[0]")).not.toBeNull();
  });
});
