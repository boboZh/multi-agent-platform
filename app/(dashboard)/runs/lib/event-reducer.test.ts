import { describe, expect, it } from "vitest";
import { reduceRunEvents } from "@/app/(dashboard)/runs/lib/event-reducer";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

describe("reduceRunEvents", () => {
  it("空数组得到空派生态，不能当成 failed", () => {
    const reduced = reduceRunEvents([]);
    expect(reduced.status).toBeNull();
    expect(reduced.currentNodeId).toBeNull();
    expect(reduced.interrupt).toBeNull();
    expect(reduced.events).toEqual([]);
  });

  it("乱序 tool_end 出现在 tool_start 之前时仍保留事件，不抛错", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_agent" },
      { type: "tool_end", name: "search", output: "x" },
      { type: "tool_start", name: "search", input: {} },
    ];
    const reduced = reduceRunEvents(events);
    expect(reduced.currentNodeId).toBe("n_agent");
    expect(reduced.events).toHaveLength(3);
  });

  it("interrupt 之后仍收到 token 不能把 status 改回 running", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_review" },
      {
        type: "interrupt",
        payload: { nodeId: "n_review", kind: "human_review" },
      },
      { type: "token", content: "迟到的 token" },
      { type: "run_status", status: "running", currentNodeId: "n_agent" },
    ];
    const reduced = reduceRunEvents(events);
    expect(reduced.status).toBe("interrupted");
    expect(reduced.interrupt?.nodeId).toBe("n_review");
    expect(reduced.currentNodeId).toBe("n_review");
  });
});
