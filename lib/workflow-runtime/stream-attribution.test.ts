import { describe, expect, it } from "vitest";
import {
  isDslNodeName,
  nodeIdFromStreamMetadata,
  pickFailedTaskName,
} from "@/lib/workflow-runtime/stream-attribution";

const NODE_IDS = new Set(["n_a", "n_b", "n_agent", "n_join"]);

describe("nodeIdFromStreamMetadata", () => {
  it("metadata 缺失或非对象时必须留空，不能回退到全局游标", () => {
    expect(nodeIdFromStreamMetadata(undefined, NODE_IDS)).toBeUndefined();
    expect(nodeIdFromStreamMetadata(null, NODE_IDS)).toBeUndefined();
    expect(nodeIdFromStreamMetadata("n_a", NODE_IDS)).toBeUndefined();
    expect(nodeIdFromStreamMetadata([], NODE_IDS)).toBeUndefined();
  });

  it("createReactAgent 子图里 langgraph_node 是 agent，必须改从 checkpoint_ns 取画布 id", () => {
    expect(
      nodeIdFromStreamMetadata(
        {
          langgraph_node: "agent",
          checkpoint_ns: "n_agent:75f427e9-601e-558d-bdcc-f3dc7b709907",
        },
        NODE_IDS
      )
    ).toBe("n_agent");
  });

  it("checkpoint_ns 第一段不是 DSL 节点时留空，避免把 __start__ 或幽灵 id 标上画布", () => {
    expect(
      nodeIdFromStreamMetadata(
        { langgraph_node: "agent", checkpoint_ns: "__start__:abc" },
        NODE_IDS
      )
    ).toBeUndefined();
    expect(
      nodeIdFromStreamMetadata({ checkpoint_ns: "" }, NODE_IDS)
    ).toBeUndefined();
  });

  it("嵌套 namespace 只取最外层画布节点，内层 agent:uuid 不能覆盖", () => {
    expect(
      nodeIdFromStreamMetadata(
        {
          langgraph_node: "agent",
          langgraph_checkpoint_ns:
            "n_a:outer-uuid|agent:55d01d15-2a60-5e4b-8f50-eacb69f27ca3",
        },
        NODE_IDS
      )
    ).toBe("n_a");
  });

  it("Fork/Join 这类非子图帧：checkpoint_ns 为空时允许 langgraph_node 等于画布 id", () => {
    expect(
      nodeIdFromStreamMetadata({ langgraph_node: "n_join" }, NODE_IDS)
    ).toBe("n_join");
  });
});

describe("isDslNodeName", () => {
  it("空名或不在节点表里的 chain name 不能当成用户节点边界", () => {
    expect(isDslNodeName(undefined, NODE_IDS)).toBe(false);
    expect(isDslNodeName("", NODE_IDS)).toBe(false);
    expect(isDslNodeName("LangGraph", NODE_IDS)).toBe(false);
    expect(isDslNodeName("agent", NODE_IDS)).toBe(false);
    expect(isDslNodeName("n_a", NODE_IDS)).toBe(true);
  });
});

describe("pickFailedTaskName", () => {
  it("空 history 或没有 task.error 时不能捏造失败节点", () => {
    expect(pickFailedTaskName(null, ["n_a"])).toBeUndefined();
    expect(pickFailedTaskName([], ["n_a"])).toBeUndefined();
    expect(
      pickFailedTaskName([{ tasks: [{ name: "n_a", error: null }] }], ["n_a"])
    ).toBeUndefined();
  });

  it("并行 inflight 多个节点时必须落到带 error 的那一路，不能取集合里的第一个", () => {
    const snapshots = [
      {
        tasks: [
          { name: "n_a", error: null },
          { name: "n_b", error: "boom" },
        ],
      },
    ];
    expect(pickFailedTaskName(snapshots, ["n_a", "n_b"])).toBe("n_b");
  });

  it("inflight 已空时回退到任意带 error 的任务，避免 catch 时集合被清掉就丢归属", () => {
    expect(
      pickFailedTaskName([{ tasks: [{ name: "n_join", error: "late" }] }], [])
    ).toBe("n_join");
  });
});
