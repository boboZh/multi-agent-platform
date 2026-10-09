import {
  mergeAbortSignals,
  TOOL_FETCH_TIMEOUT_MS,
  withTimeout,
} from "@/lib/workflow-runtime/timeout";

/**
 * 工具 HTTP 的统一入口。超时抛 TimeoutError，由调用方继续往上抛，不改写成成功 JSON。
 * parent 是外层智能体 invoke 的 signal：整体先超时的时候，这次请求也要停。
 * init 里的 signal 会被丢掉：时限和父级 abort 必须盖过调用方自己传的 signal，否则配置里的工具可以绕过 15s 上限。
 */
export function fetchWithinTimeout(
  url: string,
  parent?: AbortSignal,
  init?: Omit<RequestInit, "signal">,
): Promise<Response> {
  return withTimeout(TOOL_FETCH_TIMEOUT_MS, "工具请求", (timeoutSignal) =>
    fetch(url, {
      ...init,
      signal: mergeAbortSignals([timeoutSignal, parent]),
    }),
  );
}
