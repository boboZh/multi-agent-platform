import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyNodeError } from "@/lib/workflow-runtime/classify-error";
import {
  mergeAbortSignals,
  nodeTimeoutError,
  withTimeout,
} from "@/lib/workflow-runtime/timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("nodeTimeoutError", () => {
  it("name 和文案都能被分类成 timeout", () => {
    const error = nodeTimeoutError("工具请求", 1500);
    expect(classifyNodeError(error)).toMatchObject({
      kind: "timeout",
      message: "工具请求超时（1500ms）",
    });
  });
});

describe("withTimeout", () => {
  it("边界：0、负数、NaN 不启动调用，抛普通错误而不是 TimeoutError", async () => {
    const run = vi.fn(async () => "ok");
    await expect(withTimeout(0, "工具请求", run)).rejects.toThrow(
      "超时毫秒数必须为正数",
    );
    await expect(withTimeout(-1, "工具请求", run)).rejects.toThrow(
      "超时毫秒数必须为正数",
    );
    await expect(withTimeout(Number.NaN, "工具请求", run)).rejects.toThrow(
      "超时毫秒数必须为正数",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("边界：调用先抛出的普通错误原样冒泡，不改成超时", async () => {
    await expect(
      withTimeout(1_000, "工具请求", async () => {
        throw new Error("工具节点缺少 toolId");
      }),
    ).rejects.toThrow("工具节点缺少 toolId");
  });

  it("调用一直不返回时到点抛 TimeoutError，并 abort 传下去的 signal", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const pending = withTimeout(1_000, "智能体调用", (signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      message: "智能体调用超时（1000ms）",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(seen?.aborted).toBe(true);
    expect(classifyNodeError(seen?.reason).kind).toBe("timeout");
  });

  it("时限内完成则返回结果，到点之后不再补一次超时", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(1_000, "工具请求", async () => "ok");
    await expect(pending).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

describe("mergeAbortSignals", () => {
  it("边界：空列表得到一条未 abort 的 signal", () => {
    expect(mergeAbortSignals([]).aborted).toBe(false);
    expect(mergeAbortSignals([undefined]).aborted).toBe(false);
  });

  it("任一 signal 已 abort 时，合并结果带着同一个 reason", () => {
    const reason = nodeTimeoutError("智能体调用", 1000);
    const parent = new AbortController();
    parent.abort(reason);
    const merged = mergeAbortSignals([
      new AbortController().signal,
      parent.signal,
    ]);
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe(reason);
  });

  it("合并之后才 abort 的那一路会传到结果 signal", () => {
    const parent = new AbortController();
    const local = new AbortController();
    const merged = mergeAbortSignals([local.signal, parent.signal]);
    const reason = nodeTimeoutError("工具请求", 1000);
    parent.abort(reason);
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe(reason);
  });
});
