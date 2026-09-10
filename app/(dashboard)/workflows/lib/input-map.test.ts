import { describe, expect, it } from "vitest";
import {
  duplicateInputMapTargets,
  inputMapFromRows,
  isLikelyStatePath,
  isValidInputMapTarget,
  rowsFromInputMap,
  type InputMapRow,
} from "./input-map";

/**
 * inputMap 是「画布配置」和「运行时取值」之间唯一的契约。
 * 这里的用例集中压两件事：编辑中的半成品不能漏进 DSL，以及折叠结果必须和用户看到的一致。
 */

function row(target: string, source: string, id = target || "empty"): InputMapRow {
  return { id, target, source };
}

describe("rowsFromInputMap", () => {
  it("按 record 顺序展开成行，并给出稳定的 id", () => {
    const rows = rowsFromInputMap({
      order_id: "state.vars.order_id",
      amount: "state.vars.amount",
    });
    expect(rows).toEqual([
      { id: "row_0", target: "order_id", source: "state.vars.order_id" },
      { id: "row_1", target: "amount", source: "state.vars.amount" },
    ]);
  });

  // 「没配映射」应该是空列表而不是一行空白，否则用户分不清是没配还是配了个空的。
  it("边界：未配置映射时返回空数组而非占位行", () => {
    expect(rowsFromInputMap(undefined)).toEqual([]);
    expect(rowsFromInputMap({})).toEqual([]);
  });
});

describe("inputMapFromRows", () => {
  it("正常行折叠成 record", () => {
    expect(
      inputMapFromRows([
        row("order_id", "state.vars.order_id"),
        row("amount", "state.vars.amount"),
      ]),
    ).toEqual({
      order_id: "state.vars.order_id",
      amount: "state.vars.amount",
    });
  });

  // 复制路径时极易带上空格，留着会让编译器取值失败，且在 UI 上完全看不出来。
  it("两端空格被 trim，避免写出取不到值的路径", () => {
    expect(inputMapFromRows([row("  order_id  ", "  state.vars.order_id ")])).toEqual(
      { order_id: "state.vars.order_id" },
    );
  });

  it("边界：目标键为空的半成品行不进 DSL", () => {
    expect(
      inputMapFromRows([row("", "state.vars.order_id"), row("   ", "state.vars.x")]),
    ).toBeUndefined();
  });

  it("边界：目标键形状非法时不进 DSL，避免编译器收到无法绑定的入参名", () => {
    expect(
      inputMapFromRows([
        row("1order", "state.vars.order"),
        row("order-id", "state.vars.order"),
      ]),
    ).toBeUndefined();
  });

  it("边界：只有键没有取值路径的行同样丢掉", () => {
    expect(inputMapFromRows([row("order_id", "")])).toBeUndefined();
    expect(
      inputMapFromRows([
        row("order_id", ""),
        row("amount", "state.vars.amount"),
      ]),
    ).toEqual({ amount: "state.vars.amount" });
  });

  // schema 里 inputMap 是 optional：写 {} 会让「从未配置」和「配过又删空」在 dsl 里不一样。
  it("边界：空数组与全为无效行时返回 undefined 而不是空对象", () => {
    expect(inputMapFromRows([])).toBeUndefined();
    expect(inputMapFromRows([row("", "")])).toBeUndefined();
  });

  it("重复目标键后者覆盖前者，与对象字面量行为一致", () => {
    expect(
      inputMapFromRows([
        row("order_id", "state.vars.old", "a"),
        row("order_id", "state.vars.new", "b"),
      ]),
    ).toEqual({ order_id: "state.vars.new" });
  });
});

describe("duplicateInputMapTargets", () => {
  it("标出重复键，让用户知道有一条被静默丢掉了", () => {
    const dup = duplicateInputMapTargets([
      row("order_id", "state.vars.a", "1"),
      row("amount", "state.vars.b", "2"),
      row("order_id", "state.vars.c", "3"),
    ]);
    expect(dup).toEqual(new Set(["order_id"]));
  });

  it("边界：空键不算重复，否则多敲两行空白就会满屏报红", () => {
    const dup = duplicateInputMapTargets([row("", "", "1"), row("  ", "", "2")]);
    expect(dup.size).toBe(0);
  });
});

describe("路径与键的形状检查", () => {
  it("识别合法的 state 取值路径", () => {
    expect(isLikelyStatePath("state.vars.order_id")).toBe(true);
    expect(isLikelyStatePath("state.messages")).toBe(true);
    expect(isLikelyStatePath("state.messages[0]")).toBe(true);
    expect(isLikelyStatePath("  state.vars.a  ")).toBe(true);
  });

  it("边界：不以 state 开头、或有残缺片段的路径被标为可疑", () => {
    expect(isLikelyStatePath("vars.order_id")).toBe(false);
    expect(isLikelyStatePath("state")).toBe(false);
    expect(isLikelyStatePath("state.")).toBe(false);
    expect(isLikelyStatePath("state..vars")).toBe(false);
    expect(isLikelyStatePath("")).toBe(false);
  });

  it("边界：目标键必须是标识符，数字开头或带连字符都不行", () => {
    expect(isValidInputMapTarget("order_id")).toBe(true);
    expect(isValidInputMapTarget("1order")).toBe(false);
    expect(isValidInputMapTarget("order-id")).toBe(false);
    expect(isValidInputMapTarget("")).toBe(false);
  });
});
