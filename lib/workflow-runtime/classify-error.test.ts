import { describe, expect, it } from "vitest";
import { classifyNodeError } from "@/lib/workflow-runtime/classify-error";

describe("classifyNodeError", () => {
  it("边界：null、undefined、空字符串、空对象都判 fatal，且不抛", () => {
    expect(classifyNodeError(null)).toEqual({ kind: "fatal", message: "" });
    expect(classifyNodeError(undefined)).toEqual({ kind: "fatal", message: "" });
    expect(classifyNodeError("")).toEqual({ kind: "fatal", message: "" });
    expect(classifyNodeError({})).toEqual({ kind: "fatal", message: "" });
    expect(classifyNodeError(new Error("   "))).toEqual({
      kind: "fatal",
      message: "",
    });
  });

  it("边界：非 Error 对象按 status 分类；没有线索的对象、数字和布尔判 fatal", () => {
    expect(classifyNodeError({ status: 503, message: "upstream down" })).toEqual({
      kind: "retryable",
      message: "upstream down",
      status: 503,
    });
    expect(classifyNodeError({ foo: "bar" })).toEqual({
      kind: "fatal",
      message: "",
    });
    expect(classifyNodeError(0)).toEqual({ kind: "fatal", message: "" });
    expect(classifyNodeError(false)).toEqual({ kind: "fatal", message: "" });
    expect(classifyNodeError([])).toEqual({ kind: "fatal", message: "" });
  });

  it("超时信号优先于 5xx：TimeoutError、超时文案、504 都判 timeout", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(classifyNodeError(timeout).kind).toBe("timeout");

    expect(classifyNodeError(new Error("request timed out")).kind).toBe("timeout");
    expect(classifyNodeError({ status: 504, message: "gateway timeout" })).toEqual({
      kind: "timeout",
      message: "gateway timeout",
      status: 504,
    });
    expect(classifyNodeError({ code: "ETIMEDOUT", message: "connect" }).kind).toBe(
      "timeout",
    );
  });

  it("5xx 和 429 判 retryable，其它 4xx 判 fatal", () => {
    expect(classifyNodeError({ status: 500, message: "internal" })).toMatchObject({
      kind: "retryable",
      status: 500,
    });
    expect(classifyNodeError({ statusCode: "502", message: "bad gateway" })).toMatchObject(
      {
        kind: "retryable",
        status: 502,
      },
    );
    expect(classifyNodeError(new Error("Weather lookup failed (503)"))).toMatchObject({
      kind: "retryable",
      status: 503,
    });
    expect(classifyNodeError({ status: 429, message: "rate limit" })).toMatchObject({
      kind: "retryable",
      status: 429,
    });
    expect(classifyNodeError({ status: 400, message: "bad request" })).toMatchObject({
      kind: "fatal",
      status: 400,
    });
    expect(classifyNodeError({ status: 404, message: "missing tool" })).toMatchObject({
      kind: "fatal",
      status: 404,
    });
  });

  it("边界：ZodError 和缺配置文案判 fatal，网络错误码判 retryable", () => {
    expect(
      classifyNodeError({
        name: "ZodError",
        message: "invalid input",
        issues: [{ path: ["city"], message: "Required" }],
      }),
    ).toMatchObject({ kind: "fatal", message: "invalid input" });

    expect(classifyNodeError(new Error("智能体节点缺少 agentId")).kind).toBe(
      "fatal",
    );
    expect(classifyNodeError({ code: "ECONNRESET", message: "socket hang up" })).toMatchObject(
      { kind: "retryable", message: "socket hang up" },
    );
    expect(classifyNodeError(new Error("fetch failed")).kind).toBe("retryable");
  });

  it("外层没有状态码时，沿 cause 读到 502 仍判 retryable", () => {
    const cause = Object.assign(new Error("upstream"), { status: 502 });
    const wrapped = new Error("model call failed", { cause });
    expect(classifyNodeError(wrapped)).toMatchObject({
      kind: "retryable",
      message: "model call failed",
      status: 502,
    });
  });
});
