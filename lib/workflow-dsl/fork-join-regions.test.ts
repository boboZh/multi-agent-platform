import { describe, expect, it } from "vitest";
import {
  NODE_TYPE_BY_KIND,
  WORKFLOW_SCHEMA_VERSION,
  type NodeKind,
} from "@/lib/workflow-dsl/kinds";
import {
  createNodeData,
  type WorkflowDocument,
  type WorkflowNode,
} from "@/lib/workflow-dsl/schema";
import {
  analyzeForkJoinRegions,
  collectRegionWriteIssues,
} from "@/lib/workflow-dsl/fork-join-regions";

function node(kind: NodeKind, id: string): WorkflowNode {
  return {
    id,
    type: NODE_TYPE_BY_KIND[kind],
    position: { x: 0, y: 0 },
    data: createNodeData(kind),
  };
}

function forkNode(id: string, laneCount: number, joinId?: string): WorkflowNode {
  const data = createNodeData("fork");
  if (data.kind !== "fork") throw new Error("unreachable");
  data.config = {
    lanes: Array.from({ length: laneCount }, (_, index) => ({
      key: `lane_${index + 1}`,
      label: `通道 ${index + 1}`,
    })),
    ...(joinId ? { joinId } : {}),
  };
  return { ...node("fork", id), data };
}

function agentNode(id: string, outputKey: string): WorkflowNode {
  const data = createNodeData("agent");
  if (data.kind !== "agent") throw new Error("unreachable");
  data.config = { ...data.config, outputKey };
  return { ...node("agent", id), data };
}

function assignNode(
  id: string,
  sets: Array<{ key: string; expression: string }>,
): WorkflowNode {
  const data = createNodeData("assign");
  if (data.kind !== "assign") throw new Error("unreachable");
  data.config = { sets };
  return { ...node("assign", id), data };
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

/**
 * Start → Fork(N) → N 个 Agent → Join → End。
 * 不等长：lane_2 中间多一个节点，用来锁死屏障名单是链尾而不是入口。
 */
function parallelDoc(options?: {
  laneCount?: number;
  uneven?: boolean;
  joinId?: string;
}): WorkflowDocument {
  const laneCount = options?.laneCount ?? 2;
  const agents = Array.from({ length: laneCount }, (_, index) =>
    agentNode(`n_a${index + 1}`, `out_${index + 1}`),
  );
  const extra = options?.uneven ? [agentNode("n_a2b", "out_2b")] : [];
  const nodes: WorkflowNode[] = [
    node("start", "n_start"),
    forkNode("n_fork", laneCount, options?.joinId),
    ...agents,
    ...extra,
    node("join", "n_join"),
    node("end", "n_end"),
  ];
  const edges = [
    normalEdge("e_start", "n_start", "n_fork"),
    ...agents.map((agent, index) =>
      laneEdge(
        `e_lane_${index + 1}`,
        "n_fork",
        agent.id,
        `lane_${index + 1}`,
      ),
    ),
    ...agents.map((agent, index) => {
      if (options?.uneven && index === 1) {
        return normalEdge("e_a2_extra", agent.id, "n_a2b");
      }
      return normalEdge(`e_to_join_${index + 1}`, agent.id, "n_join");
    }),
    ...(options?.uneven ? [normalEdge("e_extra_join", "n_a2b", "n_join")] : []),
    normalEdge("e_join_end", "n_join", "n_end"),
  ];
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name: "并行区",
    startNodeId: "n_start",
    nodes,
    edges,
  };
}

describe("analyzeForkJoinRegions", () => {
  it("N=2 时推断配对 Join，屏障前驱按节点 id 排序", () => {
    const analysis = analyzeForkJoinRegions(parallelDoc());
    expect(analysis.issues).toEqual([]);
    expect(analysis.regions).toHaveLength(1);
    expect(analysis.regions[0]).toMatchObject({
      forkId: "n_fork",
      joinId: "n_join",
      predecessors: ["n_a1", "n_a2"],
    });
  });

  it("N=3 时三条通道的链尾都进入屏障名单", () => {
    const analysis = analyzeForkJoinRegions(parallelDoc({ laneCount: 3 }));
    expect(analysis.issues).toEqual([]);
    expect(analysis.regions[0]?.predecessors).toEqual(["n_a1", "n_a2", "n_a3"]);
  });

  it("不等长通道时前驱是链尾而不是入口", () => {
    const analysis = analyzeForkJoinRegions(parallelDoc({ uneven: true }));
    expect(analysis.issues).toEqual([]);
    expect(analysis.regions[0]?.predecessors).toEqual(["n_a1", "n_a2b"]);
  });

  it("边界：空通道（lane 边直连 Join）时拒绝", () => {
    const doc = parallelDoc();
    doc.edges = doc.edges.map((edge) =>
      edge.id === "e_lane_1"
        ? { ...edge, target: "n_join" }
        : edge.id === "e_to_join_1"
          ? { ...edge, source: "n_a1", target: "n_end" }
          : edge,
    );
    const analysis = analyzeForkJoinRegions(doc);
    expect(
      analysis.issues.some((issue) => issue.message.includes("不能直接连到 Join")),
    ).toBe(true);
    expect(analysis.regions).toHaveLength(0);
  });

  it("边界：两条通道共享中间节点时拒绝", () => {
    const doc = parallelDoc();
    doc.edges = doc.edges.map((edge) =>
      edge.id === "e_lane_2" ? { ...edge, target: "n_a1" } : edge,
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e_to_join_2");
    const analysis = analyzeForkJoinRegions(doc);
    expect(
      analysis.issues.some((issue) => issue.message.includes("共享节点")),
    ).toBe(true);
  });

  it("边界：joinId 断言与推断结果冲突时拒绝", () => {
    const analysis = analyzeForkJoinRegions(
      parallelDoc({ joinId: "n_end" }),
    );
    expect(
      analysis.issues.some((issue) =>
        issue.message.includes("joinId 断言") && issue.message.includes("不一致"),
      ),
    ).toBe(true);
  });
});

describe("collectRegionWriteIssues", () => {
  it("边界：区域内两个 Agent 都用默认 lastAgentText 时报告冲突", () => {
    const doc = parallelDoc();
    doc.nodes = doc.nodes.map((item) => {
      if (item.data.kind !== "agent") return item;
      const data = createNodeData("agent");
      return { ...item, data };
    });
    const analysis = analyzeForkJoinRegions(doc);
    expect(analysis.regions).toHaveLength(1);
    const issues = collectRegionWriteIssues(doc, analysis.regions);
    expect(issues.some((issue) => issue.message.includes("lastAgentText"))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.message.includes("冲突"))).toBe(true);
  });

  it("边界：inputMap 引用 state.lastAgentText 时拒绝", () => {
    const doc = parallelDoc();
    doc.nodes = doc.nodes.map((item) => {
      if (item.id !== "n_a1" || item.data.kind !== "agent") return item;
      return {
        ...item,
        data: {
          ...item.data,
          config: {
            ...item.data.config,
            inputMap: { q: "state.lastAgentText" },
          },
        },
      };
    });
    const analysis = analyzeForkJoinRegions(doc);
    const issues = collectRegionWriteIssues(doc, analysis.regions);
    expect(
      issues.some((issue) => issue.message.includes("state.lastAgentText")),
    ).toBe(true);
  });

  it("边界：空 region 列表时不产生写冲突", () => {
    expect(collectRegionWriteIssues(parallelDoc(), [])).toEqual([]);
  });

  it("赋值节点可以放在通道内，sets.key 与 Agent outputKey 共用冲突表", () => {
    const doc = parallelDoc();
    doc.nodes = doc.nodes.map((item) =>
      item.id === "n_a2"
        ? assignNode("n_a2", [
            { key: "out_2", expression: "state.vars.round + 1" },
          ])
        : item,
    );
    const analysis = analyzeForkJoinRegions(doc);
    expect(analysis.issues).toEqual([]);
    expect(collectRegionWriteIssues(doc, analysis.regions)).toEqual([]);
  });

  it("边界：Assign sets.key 与同区 Agent outputKey 相同时报告冲突", () => {
    const doc = parallelDoc();
    doc.nodes = doc.nodes.map((item) =>
      item.id === "n_a2"
        ? assignNode("n_a2", [{ key: "out_1", expression: "1" }])
        : item,
    );
    const analysis = analyzeForkJoinRegions(doc);
    const issues = collectRegionWriteIssues(doc, analysis.regions);
    expect(issues.some((issue) => issue.message.includes("out_1"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("冲突"))).toBe(true);
  });

  it("边界：两条通道上的 Assign 写同一 key 时也冲突", () => {
    const doc = parallelDoc();
    doc.nodes = doc.nodes.map((item) => {
      if (item.id === "n_a1") {
        return assignNode("n_a1", [{ key: "shared", expression: "1" }]);
      }
      if (item.id === "n_a2") {
        return assignNode("n_a2", [{ key: "shared", expression: "2" }]);
      }
      return item;
    });
    const analysis = analyzeForkJoinRegions(doc);
    const issues = collectRegionWriteIssues(doc, analysis.regions);
    expect(issues.some((issue) => issue.message.includes("shared"))).toBe(true);
  });
});
