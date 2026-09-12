import { describe, expect, it } from "vitest";
import {
  appendTimelineEvent,
  reduceRunEvents,
  shouldSkipSseEvent,
} from "@/app/(dashboard)/runs/lib/event-reducer";
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

describe("shouldSkipSseEvent", () => {
  it("非法 incomingId 不能跳过，否则会把有效首帧丢掉", () => {
    expect(shouldSkipSseEvent(10, "10")).toBe(false);
    expect(shouldSkipSseEvent(10, Number.NaN)).toBe(false);
    expect(shouldSkipSseEvent(10, 0)).toBe(false);
  });

  it("id 小于等于已确认游标的帧视为重放，必须丢", () => {
    expect(shouldSkipSseEvent(10, 10)).toBe(true);
    expect(shouldSkipSseEvent(10, 9)).toBe(true);
    expect(shouldSkipSseEvent(10, 11)).toBe(false);
  });

  it("lastEventId 尚未建立时（0/非法）不跳过", () => {
    expect(shouldSkipSseEvent(0, 1)).toBe(false);
    expect(shouldSkipSseEvent(Number.NaN, 1)).toBe(false);
  });
});

describe("appendTimelineEvent", () => {
  it("空列表或非数组时仍能收下第一条", () => {
    expect(appendTimelineEvent([], { type: "token", content: "你" })).toEqual([
      { type: "token", content: "你" },
    ]);
    expect(appendTimelineEvent(null as unknown as WorkflowSseEvent[], { type: "done" })).toEqual([
      { type: "done" },
    ]);
  });

  it("相邻同节点 token 合并，避免一字一行撑爆 DOM", () => {
    const once = appendTimelineEvent([], {
      type: "token",
      nodeId: "n_agent",
      content: "室",
    });
    const twice = appendTimelineEvent(once, {
      type: "token",
      nodeId: "n_agent",
      content: "内",
    });
    expect(twice).toEqual([{ type: "token", nodeId: "n_agent", content: "室内" }]);
  });

  it("换节点或非 token 不能合并，否则工具行会被吃进正文", () => {
    const start = appendTimelineEvent(
      [{ type: "token", nodeId: "a", content: "hi" }],
      { type: "tool_start", name: "search", input: {} },
    );
    expect(start).toHaveLength(2);
    const otherNode = appendTimelineEvent(
      [{ type: "token", nodeId: "a", content: "hi" }],
      { type: "token", nodeId: "b", content: "x" },
    );
    expect(otherNode).toHaveLength(2);
  });
});
