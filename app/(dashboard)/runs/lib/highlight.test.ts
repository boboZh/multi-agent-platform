import { describe, expect, it } from "vitest";
import { reduceRunEvents } from "@/app/(dashboard)/runs/lib/event-reducer";
import { deriveHighlight } from "@/app/(dashboard)/runs/lib/highlight";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

describe("deriveHighlight", () => {
  it("没有任何 node_start 时 running 不高亮节点", () => {
    const reduced = reduceRunEvents([{ type: "run_status", status: "running" }]);
    const highlight = deriveHighlight("running", reduced);
    expect(highlight.currentNodeId).toBeNull();
    expect(highlight.doneNodeIds.size).toBe(0);
  });

  it("连续两个节点时 current 是尚未 node_end 的那个，已结束的进 done", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_a" },
      { type: "node_end", nodeId: "n_a" },
      { type: "node_start", nodeId: "n_b" },
    ];
    const highlight = deriveHighlight("running", reduceRunEvents(events));
    expect(highlight.currentNodeId).toBe("n_b");
    expect([...highlight.doneNodeIds]).toEqual(["n_a"]);
  });

  it("failed 且 error 没有 nodeId 时回退到 currentNodeId", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_tool" },
      { type: "error", message: "boom" },
    ];
    const highlight = deriveHighlight("failed", reduceRunEvents(events));
    expect(highlight.failedNodeId).toBe("n_tool");
    expect(highlight.currentNodeId).toBeNull();
  });
});
