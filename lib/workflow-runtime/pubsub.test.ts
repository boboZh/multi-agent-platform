import { describe, expect, it } from "vitest";
import {
  parsePublishedSse,
  runEventChannel,
  selectSseAfter,
} from "@/lib/workflow-runtime/pubsub";
import type { BufferedSseEvent } from "@/lib/workflow-runtime/sse";

describe("runEventChannel", () => {
  it("按 runId 隔离频道，避免两条运行互相串事件", () => {
    expect(runEventChannel("run-a")).toBe("wf:sse:run-a:pub");
    expect(runEventChannel("run-b")).not.toBe(runEventChannel("run-a"));
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
    { id: 1, event: { type: "node_start", nodeId: "a" } },
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
