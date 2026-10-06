import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithinTimeout } from "@/lib/agent-runtime/fetch-with-timeout";
import { nodeTimeoutError, TOOL_FETCH_TIMEOUT_MS } from "@/lib/workflow-runtime/timeout";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWithinTimeout", () => {
  it("边界：fetch 一直不返回时抛 TimeoutError，并 abort 传给 fetch 的 signal", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { signal: AbortSignal }) => {
        seen = init.signal;
        return new Promise(() => {});
      }),
    );
    const pending = fetchWithinTimeout("https://example.test/weather");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
      message: `工具请求超时（${TOOL_FETCH_TIMEOUT_MS}ms）`,
    });
    await vi.advanceTimersByTimeAsync(TOOL_FETCH_TIMEOUT_MS);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("边界：父 signal 已经超时则立即失败，不再等工具自己的时限", async () => {
    const parent = new AbortController();
    const reason = nodeTimeoutError("智能体调用", 1_000);
    parent.abort(reason);
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      if (init.signal.aborted) return Promise.reject(init.signal.reason);
      return Promise.resolve(new Response("ok"));
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchWithinTimeout("https://example.test/weather", parent.signal),
    ).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("边界：fetch 自己的网络错误原样抛出", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(fetchWithinTimeout("https://example.test/search")).rejects.toThrow(
      "fetch failed",
    );
  });

  it("时限内返回的响应原样交给调用方", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const response = await fetchWithinTimeout("https://example.test/weather");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
