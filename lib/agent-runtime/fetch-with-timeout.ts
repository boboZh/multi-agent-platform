import {
  mergeAbortSignals,
  TOOL_FETCH_TIMEOUT_MS,
  withTimeout,
} from "@/lib/workflow-runtime/timeout";

/**
 * 工具 HTTP 的统一入口。超时抛 TimeoutError，由调用方继续往上抛，不改写成成功 JSON。
 * parent 是外层智能体 invoke 的 signal：整体先超时的时候，这次 GET 也要停。
 */
export function fetchWithinTimeout(
  url: string,
  parent?: AbortSignal,
): Promise<Response> {
  return withTimeout(TOOL_FETCH_TIMEOUT_MS, "工具请求", (timeoutSignal) =>
    fetch(url, { signal: mergeAbortSignals([timeoutSignal, parent]) }),
  );
}
