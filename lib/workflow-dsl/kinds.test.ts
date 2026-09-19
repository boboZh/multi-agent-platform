import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORK_LANES,
  EDGE_KINDS,
  KIND_BY_NODE_TYPE,
  MAX_FORK_LANES,
  MIN_FORK_LANES,
  NODE_KIND_LABELS,
  NODE_KINDS,
  NODE_PORT_SPEC,
  NODE_TYPE_BY_KIND,
  defaultForkLanes,
  defaultLabelForKind,
  isLaneKey,
  isNodeKind,
  isNodeType,
} from "@/lib/workflow-dsl/kinds";

describe("fork / join 枚举与端口表", () => {
  it("NODE_KINDS 含 fork/join，画布 type 映射为 forkNode/joinNode", () => {
    expect(NODE_KINDS).toContain("fork");
    expect(NODE_KINDS).toContain("join");
    expect(NODE_KINDS).toContain("assign");
    expect(NODE_TYPE_BY_KIND.fork).toBe("forkNode");
    expect(NODE_TYPE_BY_KIND.join).toBe("joinNode");
    expect(NODE_TYPE_BY_KIND.assign).toBe("assignNode");
    expect(KIND_BY_NODE_TYPE.forkNode).toBe("fork");
    expect(KIND_BY_NODE_TYPE.joinNode).toBe("join");
  });

  it("lane 边与 branch 边分立，避免校验按 XOR 处理 AND 扇出", () => {
    expect(EDGE_KINDS).toEqual(["normal", "branch", "lane"]);
    expect(NODE_PORT_SPEC.fork.defaultOutgoingEdgeKind).toBe("lane");
    expect(NODE_PORT_SPEC.condition.defaultOutgoingEdgeKind).toBe("branch");
  });

  it("Fork 出端口是 lanes、Join 入端口是 many，中文 label 无业务通道名", () => {
    expect(NODE_PORT_SPEC.fork).toEqual({
      targets: 1,
      sources: "lanes",
      defaultOutgoingEdgeKind: "lane",
    });
    expect(NODE_PORT_SPEC.join).toEqual({
      targets: "many",
      sources: 1,
      defaultOutgoingEdgeKind: "normal",
    });
    expect(NODE_KIND_LABELS.fork).toBe("并行扇出");
    expect(NODE_KIND_LABELS.join).toBe("等待汇合");
    expect(defaultLabelForKind("fork")).toBe("并行扇出");
  });

  it("默认两条 lane 是通用通道名，且 defaultForkLanes 返回可写副本", () => {
    expect(MIN_FORK_LANES).toBe(2);
    expect(MAX_FORK_LANES).toBe(16);
    expect(DEFAULT_FORK_LANES).toHaveLength(MIN_FORK_LANES);
    const lanes = defaultForkLanes();
    expect(lanes).toEqual([
      { key: "lane_1", label: "通道 1" },
      { key: "lane_2", label: "通道 2" },
    ]);
    lanes[0]!.key = "mutated";
    expect(DEFAULT_FORK_LANES[0]!.key).toBe("lane_1");
  });

  it("边界：空字符串、连字符、数字开头都不是合法 lane key", () => {
    expect(isLaneKey("")).toBe(false);
    expect(isLaneKey("lane-1")).toBe(false);
    expect(isLaneKey("1lane")).toBe(false);
  });

  it("边界：未知 kind / type 不得被识别为节点种类", () => {
    expect(isNodeKind("map")).toBe(false);
    expect(isNodeKind("assign")).toBe(true);
    expect(isNodeType("fork")).toBe(false);
    expect(isNodeType("forkNode")).toBe(true);
  });

  it("边界：lane key 允许下划线标识符，与 BRANCH_KEY_RE 共用同一套规则", () => {
    expect(isLaneKey("lane_1")).toBe(true);
    expect(isLaneKey("_private")).toBe(true);
  });
});
