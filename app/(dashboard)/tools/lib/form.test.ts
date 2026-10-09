import { describe, expect, it } from "vitest";
import { formFromTool, formToToolPayload, emptyToolForm } from "./form";

describe("formToToolPayload", () => {
  it("边界：名称为空、参数名为空、参数名重复时返回多条错误", () => {
    const result = formToToolPayload({
      ...emptyToolForm(),
      name: "",
      url: "https://example.com",
      params: [
        { key: "", type: "string", description: "缺名字", required: true },
        { key: "city", type: "string", description: "", required: true },
        { key: "city", type: "number", description: "", required: true },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "工具名称为必填项",
        "参数名不能为空",
        "参数名 city 重复",
      ]),
    );
  });

  it("边界：file 协议和非法占位符不能保存", () => {
    const fileUrl = formToToolPayload({
      ...emptyToolForm(),
      name: "read_file",
      url: "file:///etc/passwd",
    });
    expect(fileUrl.ok).toBe(false);

    const badToken = formToToolPayload({
      ...emptyToolForm(),
      name: "lookup",
      url: "https://example.com/{{bad-name}}",
    });
    expect(badToken.ok).toBe(false);
  });

  it("边界：空参数列表生成空 schema，而不是省略配置", () => {
    const result = formToToolPayload({
      ...emptyToolForm(),
      name: "ping",
      url: "https://example.com/health",
      params: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.connection_config).toEqual({
      schema: {},
      executor: {
        kind: "http",
        method: "GET",
        url: "https://example.com/health",
      },
    });
  });

  it("边界：静态结果不是 JSON、或传入未知执行方式时失败", () => {
    const badJson = formToToolPayload({
      ...emptyToolForm(),
      name: "mock_order",
      kind: "static",
      bodyText: "{order_id}",
    });
    expect(badJson.ok).toBe(false);

    const badKind = formToToolPayload({
      ...emptyToolForm(),
      name: "mock_order",
      kind: "script" as "static",
      bodyText: "{}",
    });
    expect(badKind.ok).toBe(false);
  });

  it("没有 executor 的旧工具来回编辑后仍然不写出 executor", () => {
    const loaded = formFromTool({
      name: "get_order_info",
      display_name: "订单",
      description: null,
      connection_config: {
        schema: { order_id: { type: "string", description: "订单号" } },
      },
    });
    expect(loaded.allowBuiltin).toBe(true);
    expect(loaded.values.kind).toBe("builtin");

    const saved = formToToolPayload(loaded.values);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.payload.connection_config).toEqual({
      schema: {
        order_id: { type: "string", description: "订单号", required: true },
      },
    });
    expect(saved.payload.display_name).toBe("订单");
    expect(saved.payload.description).toBeNull();
  });
});
