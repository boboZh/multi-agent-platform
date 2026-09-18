import { describe, expect, it } from "vitest";
import { reduceRunEvents } from "@/app/(dashboard)/runs/lib/event-reducer";
import { deriveHighlight } from "@/app/(dashboard)/runs/lib/highlight";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

describe("deriveHighlight", () => {
  it("没有任何 node_start 时 running 不高亮节点", () => {
    const reduced = reduceRunEvents([{ type: "run_status", status: "running" }]);
    const highlight = deriveHighlight("running", reduced);
    expect(highlight.currentNodeIds.size).toBe(0);
    expect(highlight.doneNodeIds.size).toBe(0);
  });

  it("连续两个节点时 current 是尚未 node_end 的那个，已结束的进 done", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_a", currentNodeIds: ["n_a"] },
      { type: "node_end", nodeId: "n_a", currentNodeIds: [] },
      { type: "node_start", nodeId: "n_b", currentNodeIds: ["n_b"] },
    ];
    const highlight = deriveHighlight("running", reduceRunEvents(events));
    expect([...highlight.currentNodeIds]).toEqual(["n_b"]);
    expect([...highlight.doneNodeIds]).toEqual(["n_a"]);
  });

  it("failed 且 error 没有 nodeId 时回退到仍在跑的那一个节点", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_tool", currentNodeIds: ["n_tool"] },
      { type: "error", message: "boom" },
    ];
    const highlight = deriveHighlight("failed", reduceRunEvents(events));
    expect(highlight.failedNodeId).toBe("n_tool");
    expect(highlight.currentNodeIds.size).toBe(0);
  });

  it("并行两路 running 时两个 id 都要脉冲", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_a", currentNodeIds: ["n_a"] },
      { type: "node_start", nodeId: "n_b", currentNodeIds: ["n_a", "n_b"] },
    ];
    const highlight = deriveHighlight("running", reduceRunEvents(events));
    expect(highlight.currentNodeIds.has("n_a")).toBe(true);
    expect(highlight.currentNodeIds.has("n_b")).toBe(true);
  });
});
