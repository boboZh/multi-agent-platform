import { describe, expect, it } from "vitest";
import { createEmptyWorkflowDocument } from "@/lib/workflow-dsl/schema";
import type { StartVariable } from "@/lib/workflow-dsl/schema";
import {
  parseStartInput,
  startVariablesFromDsl,
  startVariablesOf,
} from "@/lib/workflow-dsl/start-variables";

const orderId: StartVariable = {
  key: "orderId",
  label: "订单号",
  type: "string",
  required: true,
};
const amount: StartVariable = {
  key: "amount",
  label: "金额",
  type: "number",
  required: true,
};
const rush: StartVariable = {
  key: "rush",
  label: "加急",
  type: "boolean",
  required: false,
};

describe("startVariablesOf", () => {
  it("空图 start 没有入参声明时返回空数组", () => {
    expect(startVariablesOf(createEmptyWorkflowDocument("测试"))).toEqual([]);
  });

  it("优先读 startNodeId 指向的节点，避免误用其它 start", () => {
    const doc = createEmptyWorkflowDocument("测试");
    const start = doc.nodes.find((node) => node.id === doc.startNodeId);
    if (!start || start.data.kind !== "start") throw new Error("missing start");
    start.data = {
      ...start.data,
      config: { variables: [orderId] },
    };
    expect(startVariablesOf(doc)).toEqual([orderId]);
  });

  it("边界：dsl 不是文档时 startVariablesFromDsl 返回空数组而不是抛错", () => {
    expect(startVariablesFromDsl(null)).toEqual([]);
    expect(startVariablesFromDsl({ nodes: "bad" })).toEqual([]);
  });
});

describe("parseStartInput", () => {
  it("把填写值裁剪成只含声明 key 的 vars，丢掉多余字段", () => {
    const parsed = parseStartInput([orderId, rush], {
      orderId: "A-1",
      rush: false,
      extra: 1,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.vars).toEqual({ orderId: "A-1", rush: false });
    }
  });

  it("边界：入参是数组或字符串时拒绝，避免整段脏数据写进 state.vars", () => {
    expect(parseStartInput([orderId], ["A-1"]).ok).toBe(false);
    expect(parseStartInput([orderId], "A-1").ok).toBe(false);
  });

  it("边界：缺必填字段时失败；可选布尔缺省时可以不出现在结果里", () => {
    const missing = parseStartInput([orderId, rush], {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.some((e) => e.path.includes("orderId"))).toBe(true);
    }
    const optionalOnly = parseStartInput([rush], {});
    expect(optionalOnly.ok).toBe(true);
    if (optionalOnly.ok) expect(optionalOnly.vars).toEqual({});
  });

  it("边界：数字字段收到非数字、布尔字段收到非法值时分别报错；数字字符串要 coerce", () => {
    expect(parseStartInput([amount], { amount: "abc" }).ok).toBe(false);
    expect(parseStartInput([rush], { rush: "yes" }).ok).toBe(false);
    const ok = parseStartInput([amount], { amount: "12.5" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.vars).toEqual({ amount: 12.5 });
  });

  it("没有变量声明时忽略传入内容，返回空对象", () => {
    const parsed = parseStartInput([], { orderId: "x" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.vars).toEqual({});
  });
});
