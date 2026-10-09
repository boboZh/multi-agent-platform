import { describe, expect, it } from "vitest";
import {
  assertHttpUrl,
  formatToolHttpResult,
  interpolateValue,
  MAX_TOOL_RESPONSE_CHARS,
  parseConnectionConfig,
  pickPaths,
  prepareHttpCall,
  zodObjectFromConfig,
} from "@/lib/agent-runtime/tool-config";

describe("parseConnectionConfig", () => {
  it("边界：null、字符串和数组都当成没有执行器，而不是抛错", () => {
    for (const raw of [null, "http://example.com", [], 0]) {
      const parsed = parseConnectionConfig(raw);
      expect(parsed.executor).toBeNull();
      expect(parsed.rejected).toBe(false);
      expect(parsed.schema).toEqual({});
    }
  });

  it("边界：写了 executor 但缺少 url 时标记为拒绝，避免回落到按名字的旧实现", () => {
    const parsed = parseConnectionConfig({
      executor: { kind: "http", method: "GET" },
    });
    expect(parsed.executor).toBeNull();
    expect(parsed.rejected).toBe(true);
    expect(parsed.errors.some((item) => item.includes("url"))).toBe(true);
  });

  it("边界：kind 为未知字符串时拒绝执行", () => {
    const parsed = parseConnectionConfig({
      executor: { kind: "eval", code: "process.exit(1)" },
    });
    expect(parsed.rejected).toBe(true);
    expect(parsed.executor).toBeNull();
  });

  it("边界：schema 不是对象时清空参数并带回错误", () => {
    const parsed = parseConnectionConfig({ schema: ["city"] });
    expect(parsed.schema).toEqual({});
    expect(parsed.errors).toContain("schema 必须是对象");
  });

  it("空 schema 对象可以被解析", () => {
    expect(parseConnectionConfig({ schema: {} }).schema).toEqual({});
  });
});

describe("interpolateValue / prepareHttpCall", () => {
  it("边界：模板引用了未传入的参数时替换成空字符串", () => {
    expect(interpolateValue("city={{city}}", {})).toBe("city=");
    expect(interpolateValue({ id: "{{order_id}}" }, {})).toEqual({ id: "" });
  });

  it("边界：整个字符串是占位符且入参是数字时保留数字类型", () => {
    expect(interpolateValue({ amount: "{{amount}}", note: "x{{amount}}" }, { amount: 2000 })).toEqual({
      amount: 2000,
      note: "x2000",
    });
  });

  it("边界：file 协议、账号密码和云元数据地址不能发出去", () => {
    expect(assertHttpUrl("file:///etc/passwd")).toMatch(/http/);
    expect(assertHttpUrl("https://user:secret@example.com/a")).toMatch(/账号/);
    expect(assertHttpUrl("http://169.254.169.254/latest/meta-data")).toMatch(/元数据/);
  });

  it("URL 占位符会编码，GET 不携带 body", () => {
    const prepared = prepareHttpCall(
      {
        kind: "http",
        method: "GET",
        url: "https://example.com/search?q={{query}}",
        body: { ignored: true },
      },
      { query: "a b" },
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.call.url).toBe("https://example.com/search?q=a%20b");
    expect(prepared.call.body).toBeUndefined();
  });
});

describe("pickPaths / formatToolHttpResult", () => {
  it("边界：路径中断或下标不是数字时返回 null", () => {
    expect(
      pickPaths({ current_condition: [] }, { temperature_c: "current_condition.0.temp_C", bad: "a..b" }),
    ).toEqual({ temperature_c: null, bad: null });
  });

  it("边界：空 pick 对象不提取字段", () => {
    expect(pickPaths({ a: 1 }, {})).toEqual({});
  });

  it("边界：超长响应被截断，非 2xx 仍返回 JSON 错误而不是抛错", () => {
    const text = "x".repeat(MAX_TOOL_RESPONSE_CHARS + 5);
    const raw = formatToolHttpResult(502, text);
    const parsed = JSON.parse(raw) as { status: number; truncated?: boolean; body: string };
    expect(parsed.status).toBe(502);
    expect(parsed.truncated).toBe(true);
    expect(parsed.body.length).toBe(MAX_TOOL_RESPONSE_CHARS);
  });

  it("2xx 且配置了 pick 时只返回声明的字段", () => {
    const raw = formatToolHttpResult(
      200,
      JSON.stringify({ current_condition: [{ temp_C: "21", extra: "drop" }] }),
      { temperature_c: "current_condition.0.temp_C" },
    );
    expect(JSON.parse(raw)).toEqual({ temperature_c: "21" });
  });
});

describe("zodObjectFromConfig", () => {
  it("边界：有执行器但 schema 为空时不再塞自由 input 字段", () => {
    const schema = zodObjectFromConfig({
      schema: {},
      executor: { kind: "static", body: { ok: true } },
    });
    expect(schema.safeParse({}).success).toBe(true);
    expect(Object.keys(schema.shape)).toEqual([]);
  });

  it("边界：没有执行器时仍接受可选 input，兼容旧工具", () => {
    const schema = zodObjectFromConfig(null);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ input: "x" }).success).toBe(true);
    expect(schema.shape.input).toBeDefined();
  });

  it("边界：非法类型的 required 字段不会把整个 schema 判废，未知 type 按字符串", () => {
    const schema = zodObjectFromConfig({
      schema: { city: { type: "nope", required: false } },
    });
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ city: "杭州" }).success).toBe(true);
    expect(schema.safeParse({ city: 1 }).success).toBe(false);
  });
});
