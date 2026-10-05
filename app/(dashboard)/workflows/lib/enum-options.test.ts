import { describe, expect, it } from "vitest";
import {
  formatEnumOptions,
  parseEnumOptions,
  sameEnumOptions,
} from "./enum-options";

describe("parseEnumOptions", () => {
  it("按逗号切开并去掉两端空格", () => {
    expect(parseEnumOptions("approve, reject")).toEqual(["approve", "reject"]);
  });

  // 输入框失焦前经常停在「approve,」；空段必须丢掉，否则会写出非法的空 option。
  it("边界：末尾逗号不产生空选项", () => {
    expect(parseEnumOptions("approve,")).toEqual(["approve"]);
    expect(parseEnumOptions("approve, ")).toEqual(["approve"]);
  });

  it("边界：空字符串或只有分隔符时返回空数组", () => {
    expect(parseEnumOptions("")).toEqual([]);
    expect(parseEnumOptions("   ")).toEqual([]);
    expect(parseEnumOptions(", , ,")).toEqual([]);
  });

  it("边界：非法类型不调用 split，避免脏数据把文档写炸", () => {
    expect(parseEnumOptions(undefined as unknown as string)).toEqual([]);
    expect(parseEnumOptions(null as unknown as string)).toEqual([]);
    expect(parseEnumOptions(1 as unknown as string)).toEqual([]);
  });
});

describe("formatEnumOptions", () => {
  it("用逗号空格拼回展示字符串", () => {
    expect(formatEnumOptions(["approve", "reject"])).toBe("approve, reject");
  });

  it("边界：空数组展示为空字符串而不是分隔符", () => {
    expect(formatEnumOptions([])).toBe("");
  });
});

describe("sameEnumOptions", () => {
  it("内容和顺序都相同时视为相同", () => {
    expect(sameEnumOptions(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("边界：顺序不同视为不同，避免把用户刚改的顺序悄悄压回去", () => {
    expect(sameEnumOptions(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("边界：长度不同视为不同", () => {
    expect(sameEnumOptions(["a"], ["a", "b"])).toBe(false);
    expect(sameEnumOptions([], ["a"])).toBe(false);
  });
});
