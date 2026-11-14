import { describe, expect, it } from "vitest";
import { splitTokenBatches } from "@/lib/workflow-runtime/token-batch";

describe("splitTokenBatches", () => {
  it("空事件数组不产生发布批次", () => {
    expect(splitTokenBatches([], 128)).toEqual([]);
  });

  it("拒绝零、负数、小数及非有限的批次上限", () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => splitTokenBatches([1], limit)).toThrow("正整数");
    }
  });

  it("拒绝伪装成数字的非法类型", () => {
    expect(() => splitTokenBatches([1], "2" as unknown as number)).toThrow();
  });

  it("跨批次保留并行节点、空文本和多字节文本的原始顺序", () => {
    const events = Object.freeze([
      { type: "token", nodeId: "a", content: "中" },
      { type: "token", nodeId: "b", content: "" },
      { type: "token", content: "🌏" },
    ]);
    const batches = splitTokenBatches(events, 2);
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(batches.flat()).toEqual(events);
    expect(batches[0][0]).toBe(events[0]);
  });

  it("恰好达到上限时不增加空尾批次且不修改输入", () => {
    const events = Object.freeze(Array.from({ length: 256 }, (_, i) => i));
    const batches = splitTokenBatches(events, 128);
    expect(batches.map((batch) => batch.length)).toEqual([128, 128]);
    expect(batches.flat()).toEqual(events);
  });
});
