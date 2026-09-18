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
    expect(reduced.currentNodeIds).toEqual([]);
    expect(reduced.interrupt).toBeNull();
    expect(reduced.events).toEqual([]);
  });

  it("乱序 tool_end 出现在 tool_start 之前时仍保留事件，不抛错", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_agent", currentNodeIds: ["n_agent"] },
      { type: "tool_end", name: "search", output: "x" },
      { type: "tool_start", name: "search", input: {} },
    ];
    const reduced = reduceRunEvents(events);
    expect(reduced.currentNodeIds).toEqual(["n_agent"]);
    expect(reduced.events).toHaveLength(3);
  });

  it("interrupt 之后仍收到 token 不能把 status 改回 running", () => {
    const events: WorkflowSseEvent[] = [
      { type: "node_start", nodeId: "n_review", currentNodeIds: ["n_review"] },
      {
        type: "interrupt",
        payload: { nodeId: "n_review", kind: "human_review" },
      },
      { type: "token", content: "迟到的 token" },
      { type: "run_status", status: "running" },
    ];
    const reduced = reduceRunEvents(events);
    expect(reduced.status).toBe("interrupted");
    expect(reduced.interrupt?.nodeId).toBe("n_review");
    expect(reduced.currentNodeIds).toEqual(["n_review"]);
  });

  it("并行两个 node_start 都要留在 currentNodeIds，不能被后启动的覆盖", () => {
    const reduced = reduceRunEvents([
      { type: "node_start", nodeId: "n_a", currentNodeIds: ["n_a"] },
      { type: "node_start", nodeId: "n_b", currentNodeIds: ["n_a", "n_b"] },
    ]);
    expect(reduced.currentNodeIds).toEqual(["n_a", "n_b"]);
  });

  it("并行一路结束后另一路仍是 current，已结束的不得留在集合里", () => {
    const reduced = reduceRunEvents([
      { type: "node_start", nodeId: "n_a", currentNodeIds: ["n_a"] },
      { type: "node_start", nodeId: "n_b", currentNodeIds: ["n_a", "n_b"] },
      { type: "node_end", nodeId: "n_a", currentNodeIds: ["n_b"] },
    ]);
    expect(reduced.currentNodeIds).toEqual(["n_b"]);
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
    expect(once).toEqual([{ type: "token", nodeId: "n_agent", content: "室" }]);
  });

  it("换节点或非 token 不能合并，否则工具行会被吃进正文", () => {
    const start = appendTimelineEvent(
      [{ type: "token", nodeId: "a", content: "hi" }],
      { type: "tool_start", name: "search", input: {}, nodeId: "a" },
    );
    expect(start).toHaveLength(2);
    const otherNode = appendTimelineEvent(
      [{ type: "token", nodeId: "a", content: "hi" }],
      { type: "token", nodeId: "b", content: "x" },
    );
    expect(otherNode).toHaveLength(2);
    const afterTool = appendTimelineEvent(start, {
      type: "token",
      nodeId: "a",
      content: " there",
    });
    expect(afterTool).toEqual([
      { type: "token", nodeId: "a", content: "hi" },
      { type: "tool_start", name: "search", input: {}, nodeId: "a" },
      { type: "token", nodeId: "a", content: " there" },
    ]);
  });

  it("并行交错 token 按 nodeId 分桶，不能把 B 的字拼进 A", () => {
    let events: WorkflowSseEvent[] = [];
    events = appendTimelineEvent(events, { type: "token", nodeId: "n_a", content: "市" });
    events = appendTimelineEvent(events, { type: "token", nodeId: "n_b", content: "产" });
    events = appendTimelineEvent(events, { type: "token", nodeId: "n_a", content: "场" });
    events = appendTimelineEvent(events, { type: "token", nodeId: "n_b", content: "品" });
    expect(events).toEqual([
      { type: "token", nodeId: "n_a", content: "市场" },
      { type: "token", nodeId: "n_b", content: "产品" },
    ]);
  });

  it("同一节点 node_end 之后再输出，必须开新桶，不能拼进上一轮", () => {
    const afterEnd = [
      { type: "token", nodeId: "n_a", content: "初稿" } as WorkflowSseEvent,
      { type: "node_end", nodeId: "n_a", currentNodeIds: [] } as WorkflowSseEvent,
      { type: "node_start", nodeId: "n_a", currentNodeIds: ["n_a"] } as WorkflowSseEvent,
    ];
    const next = appendTimelineEvent(afterEnd, {
      type: "token",
      nodeId: "n_a",
      content: "修订",
    });
    expect(next).toEqual([
      { type: "token", nodeId: "n_a", content: "初稿" },
      { type: "node_end", nodeId: "n_a", currentNodeIds: [] },
      { type: "node_start", nodeId: "n_a", currentNodeIds: ["n_a"] },
      { type: "token", nodeId: "n_a", content: "修订" },
    ]);
  });

  it("没有 nodeId 的 token 不得并进已有归属的节点桶", () => {
    const merged = appendTimelineEvent(
      [{ type: "token", nodeId: "n_a", content: "市场" }],
      { type: "token", content: "幽灵" },
    );
    expect(merged).toEqual([
      { type: "token", nodeId: "n_a", content: "市场" },
      { type: "token", content: "幽灵" },
    ]);
  });
});
