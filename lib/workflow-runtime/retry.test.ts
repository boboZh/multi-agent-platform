import { describe, expect, it } from "vitest";
import { findRetryCheckpointId } from "@/lib/workflow-runtime/retry";

describe("findRetryCheckpointId", () => {
  it("空 nodeId 或空 history 返回 null", () => {
    expect(findRetryCheckpointId([], "n_agent")).toBeNull();
    expect(
      findRetryCheckpointId(
        [{ next: ["n_agent"], config: { configurable: { checkpoint_id: "cp1" } } }],
        "   ",
      ),
    ).toBeNull();
  });

  it("优先使用 next 包含目标节点的那一帧（执行前）", () => {
    const id = findRetryCheckpointId(
      [
        { next: [], config: { configurable: { checkpoint_id: "after" } } },
        {
          next: ["n_agent"],
          config: { configurable: { checkpoint_id: "before" } },
        },
      ],
      "n_agent",
    );
    expect(id).toBe("before");
  });

  it("节点已失败时回退到 parentConfig，避免带着失败 messages 续跑", () => {
    const id = findRetryCheckpointId(
      [
        {
          next: [],
          config: { configurable: { checkpoint_id: "failed-frame" } },
          parentConfig: { configurable: { checkpoint_id: "parent" } },
          tasks: [{ name: "n_agent", error: "boom" }],
        },
      ],
      "n_agent",
    );
    expect(id).toBe("parent");
  });
});
