import { describe, expect, it, vi } from "vitest";
import type { ToolRow } from "@/app/(dashboard)/agents/lib/types";
import { buildLangChainTools, executeToolRow } from "@/lib/agent-runtime/tools";

function row(partial: Partial<ToolRow> & Pick<ToolRow, "name" | "connection_config">): ToolRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000000",
    display_name: null,
    description: null,
    tool_type: "explicit",
    ...partial,
  };
}

describe("buildLangChainTools", () => {
  it("边界：空数组不生成任何工具", () => {
    expect(buildLangChainTools([])).toEqual([]);
  });

  it("静态 JSON 按配置回填入参，不依赖工具名", async () => {
    const [lcTool] = buildLangChainTools([
      row({
        name: "lookup_order",
        connection_config: {
          schema: {
            order_id: { type: "string", description: "订单号" },
            amount: { type: "number" },
          },
          executor: {
            kind: "static",
            body: { order_id: "{{order_id}}", amount: "{{amount}}" },
          },
        },
      }),
    ]);
    const raw = await lcTool.invoke({ order_id: "A1", amount: 2000 });
    expect(JSON.parse(String(raw))).toEqual({ order_id: "A1", amount: 2000 });
  });

  it("边界：executor 不合法时返回配置错误，名字里带 weather 也不会去请求天气", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const text = await executeToolRow(
        row({
          name: "get_weather",
          connection_config: { executor: { kind: "http", method: "GET" } },
        }),
        { city: "杭州" },
      );
      expect(JSON.parse(text).error).toMatch(/url/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("HTTP 工具用配置里的 URL 和提取字段发请求", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ current_condition: [{ temp_C: "18" }] }), {
          status: 200,
        }),
      ),
    );
    try {
      const text = await executeToolRow(
        row({
          name: "city_temp",
          connection_config: {
            schema: { city: { type: "string" } },
            executor: {
              kind: "http",
              method: "GET",
              url: "https://example.com/{{city}}?format=j1",
              pick: { temperature_c: "current_condition.0.temp_C" },
            },
          },
        }),
        { city: "杭州" },
      );
      expect(JSON.parse(text)).toEqual({ temperature_c: "18" });
      expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
        "https://example.com/%E6%9D%AD%E5%B7%9E?format=j1",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
