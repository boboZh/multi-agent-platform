import { describe, expect, it } from "vitest";
import {
  evaluateAssignSets,
  isJsonRoundTripValue,
  type WorkflowGraphState,
} from "@/lib/workflow-dsl/compile-utils";

function emptyState(vars: Record<string, unknown> = {}): WorkflowGraphState {
  return { messages: [], vars, lastAgentText: "", _route: "" };
}

describe("isJsonRoundTripValue", () => {
  it("数字、布尔、字符串、null、数组、普通对象都可以通过", () => {
    expect(isJsonRoundTripValue(0)).toBe(true);
    expect(isJsonRoundTripValue(false)).toBe(true);
    expect(isJsonRoundTripValue("hi")).toBe(true);
    expect(isJsonRoundTripValue(null)).toBe(true);
    expect(isJsonRoundTripValue([1, { a: true }])).toBe(true);
    expect(isJsonRoundTripValue({ nested: [null, "x"] })).toBe(true);
  });

  it("边界：NaN、Infinity、undefined 不能 round-trip，必须拒绝", () => {
    expect(isJsonRoundTripValue(Number.NaN)).toBe(false);
    expect(isJsonRoundTripValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonRoundTripValue(undefined)).toBe(false);
  });

  it("边界：Date 和含 undefined 槽的对象不能当 JSON 值写入 vars", () => {
    expect(isJsonRoundTripValue(new Date())).toBe(false);
    expect(isJsonRoundTripValue({ a: undefined })).toBe(false);
  });
});

describe("evaluateAssignSets", () => {
  it("没设过 round 时在求值前缺省为 0，round+1 写成 1 且不依赖 Start 入参", () => {
    const patch = evaluateAssignSets(
      [{ key: "round", expression: "state.vars.round + 1" }],
      emptyState({}),
    );
    expect(patch).toEqual({ round: 1 });
  });

  it("已有 round 时按当前值累加，不把缺省 0 覆盖上去", () => {
    const patch = evaluateAssignSets(
      [{ key: "round", expression: "state.vars.round + 1" }],
      emptyState({ round: 2 }),
    );
    expect(patch).toEqual({ round: 3 });
  });

  it("同一节点多条赋值按顺序累积，后一条能读到前一条刚写的 key", () => {
    const patch = evaluateAssignSets(
      [
        { key: "flag", expression: "true" },
        { key: "note", expression: "state.vars.flag" },
      ],
      emptyState({}),
    );
    expect(patch).toEqual({ flag: true, note: true });
  });

  it("边界：缺失的非 round key 做加法得到 NaN 时整节点 throw，不能写进去", () => {
    expect(() =>
      evaluateAssignSets(
        [{ key: "n", expression: "state.vars.missing + 1" }],
        emptyState({}),
      ),
    ).toThrow(/求值失败/);
  });

  it("边界：非法表达式必须 throw，禁止当成跳过", () => {
    expect(() =>
      evaluateAssignSets(
        [{ key: "x", expression: "state.vars.foo.bar.baz" }],
        emptyState({}),
      ),
    ).toThrow(/求值失败/);
  });

  it("边界：空表达式 throw；除法得到 Infinity 也不能写入", () => {
    expect(() =>
      evaluateAssignSets([{ key: "x", expression: "   " }], emptyState({})),
    ).toThrow(/不能为空/);
    expect(() =>
      evaluateAssignSets([{ key: "x", expression: "1/0" }], emptyState({})),
    ).toThrow(/JSON 往返/);
  });

  it("字符串、null 拷贝、数组字面量都能写入", () => {
    const patch = evaluateAssignSets(
      [
        { key: "title", expression: "'hello'" },
        { key: "copied", expression: "state.vars.maybeNull" },
        { key: "ids", expression: "[1, 2]" },
      ],
      emptyState({ maybeNull: null }),
    );
    expect(patch).toEqual({
      title: "hello",
      copied: null,
      ids: [1, 2],
    });
  });
});
