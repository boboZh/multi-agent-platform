import { describe, expect, it } from "vitest";
import {
  parsePublishedSse,
  runEventChannel,
  selectSseAfter,
  mergeSseReplay,
} from "@/lib/workflow-runtime/pubsub";
import type { BufferedSseEvent } from "@/lib/workflow-runtime/sse";

describe("runEventChannel", () => {
  it("按 runId 隔离频道，避免两条运行互相串事件", () => {
    expect(runEventChannel("run-a")).toBe("wf:sse:run-a:pub");
    expect(runEventChannel("run-b")).not.toBe(runEventChannel("run-a"));
  });
});

describe("mergeSseReplay", () => {
  const token = (id: number): BufferedSseEvent => ({
    id,
    event: { type: "token", nodeId: "a", content: String(id) },
  });

  it("快照和暂存区都为空时不产生帧", () => {
    expect(mergeSseReplay([], [], 0)).toEqual([]);
  });

  it("快照为空时仍保留读取期间到达的实时帧", () => {
    expect(mergeSseReplay([], [token(2), token(1)], 0)).toEqual([token(1), token(2)]);
  });

  it("实时新帧先到也不能跳过较旧的快照帧", () => {
    expect(mergeSseReplay([token(171), token(172)], [token(174), token(173)], 170))
      .toEqual([token(171), token(172), token(173), token(174)]);
  });

  it("快照与实时区重叠时每个 ID 只发送一次并过滤断点之前的帧", () => {
    expect(mergeSseReplay([token(1), token(2), token(3)], [token(3), token(4)], 2))
      .toEqual([token(3), token(4)]);
  });

  it("完成帧在读取快照期间到达时排在全部旧 token 之后", () => {
    const done: BufferedSseEvent = { id: 4, event: { type: "done" } };
    expect(mergeSseReplay([token(2)], [done, token(3), token(2)], 1))
      .toEqual([token(2), token(3), done]);
  });

  it("合并过程不修改冻结的输入快照或暂存数组", () => {
    expect(mergeSseReplay(Object.freeze([token(2)]), Object.freeze([token(1)]), 0))
      .toEqual([token(1), token(2)]);
  });
});

describe("parsePublishedSse", () => {
  it("空字符串、非法 JSON、数组都不能当成事件帧", () => {
    expect(parsePublishedSse("")).toBeNull();
    expect(parsePublishedSse("   ")).toBeNull();
    expect(parsePublishedSse("{")).toBeNull();
    expect(parsePublishedSse("[]")).toBeNull();
    expect(parsePublishedSse(null)).toBeNull();
  });

  it("id 必须是正整数，字符串或 0 会被丢弃以免打乱 Last-Event-ID", () => {
    expect(
      parsePublishedSse(JSON.stringify({ id: "1", event: { type: "done" } })),
    ).toBeNull();
    expect(
      parsePublishedSse(JSON.stringify({ id: 0, event: { type: "done" } })),
    ).toBeNull();
    expect(
      parsePublishedSse(JSON.stringify({ id: 1.5, event: { type: "done" } })),
    ).toBeNull();
  });

  it("缺少 type 或未知 type 的 event 不能转推到前端", () => {
    expect(
      parsePublishedSse(JSON.stringify({ id: 1, event: { foo: 1 } })),
    ).toBeNull();
    expect(
      parsePublishedSse(JSON.stringify({ id: 1, event: { type: "invoke" } })),
    ).toBeNull();
    expect(parsePublishedSse(JSON.stringify({ id: 2, event: { type: "done" } }))).toEqual({
      id: 2,
      event: { type: "done" },
    });
  });
});

describe("selectSseAfter", () => {
  const rows: BufferedSseEvent[] = [
    { id: 3, event: { type: "token", content: "c" } },
    { id: 1, event: { type: "node_start", nodeId: "a", currentNodeIds: ["a"] } },
    { id: 2, event: { type: "token", content: "b" } },
  ];

  it("空数组直接返回空，调用方不应误当成还在流式", () => {
    expect(selectSseAfter([], 0)).toEqual([]);
    expect(selectSseAfter(null, 0)).toEqual([]);
  });

  it("lastId 等于某帧 id 时该帧不再转发，避免重连重复打字", () => {
    expect(selectSseAfter(rows, 2).map((row) => row.id)).toEqual([3]);
  });

  it("非法 lastId 视为从 0 回放，且乱序输入会按 id 排好", () => {
    expect(selectSseAfter(rows, Number.NaN).map((row) => row.id)).toEqual([1, 2, 3]);
    expect(selectSseAfter(rows, -9).map((row) => row.id)).toEqual([1, 2, 3]);
  });
});
