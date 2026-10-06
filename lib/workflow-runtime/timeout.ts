/**
 * 调用超时不进 DSL。已发布的 flow_versions 没有超时字段，写进 schema 就要改草稿、发布和回放。
 * 时限是运行时常量：工具是单次 GET；智能体包住整段 ReAct。
 * 智能体时限必须小于 run 锁的 600s，否则锁先过期，另一路引擎会在同一 thread 上再跑一遍。
 */
export const TOOL_FETCH_TIMEOUT_MS = 15_000;
export const AGENT_INVOKE_TIMEOUT_MS = 120_000;

/**
 * 超时错误必须让 classifyNodeError 判成 timeout：name 用 TimeoutError，文案带「超时」。
 * 结果未知（请求可能没发出去，也可能对方已执行），不能伪装成成功或普通 5xx。
 */
export function nodeTimeoutError(scope: string, timeoutMs: number): Error {
  const error = new Error(`${scope}超时（${timeoutMs}ms）`);
  error.name = "TimeoutError";
  return error;
}

/**
 * 把多个 AbortSignal 合成一个。父级（智能体整体超时）和本次工具超时任一触发，底层 fetch 都要停。
 * 空列表返回一条不会 abort 的 signal，避免调用方把 undefined 传给 fetch。
 */
export function mergeAbortSignals(
  signals: Array<AbortSignal | undefined>
): AbortSignal {
  const live = signals.filter(
    (signal): signal is AbortSignal => signal != null
  );
  if (live.length === 0) return new AbortController().signal;
  if (live.length === 1) return live[0];

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of live) {
    if (signal.aborted) {
      abortFrom(signal);
      return controller.signal;
    }
    signal.addEventListener("abort", () => abortFrom(signal), { once: true });
  }
  return controller.signal;
}

/**
 * 给一次异步调用加时限。
 *
 * 入参：毫秒、错误文案里的调用名、收到 signal 后开始的任务。
 * 出参：任务的返回值。到点抛 nodeTimeoutError；任务自己的错误原样抛出。
 * 步骤：非法时限直接抛 → 起 AbortController 和定时器 → Promise.race。
 * signal 用来取消还在飞的 HTTP；race 保证调用方到点一定返回，即使底层没把 signal 传到连接上。
 * 成功或失败都清掉定时器，避免调用已经结束又补一次超时。
 */
export async function withTimeout<T>(
  timeoutMs: number,
  scope: string,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("超时毫秒数必须为正数");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = nodeTimeoutError(scope, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  const work = Promise.resolve()
    .then(() => run(controller.signal))
    .catch((err: unknown) => {
      console.log("work err", err);
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error
          ? reason
          : nodeTimeoutError(scope, timeoutMs);
      }
      throw err;
    });
  // race 若先采纳超时，被 abort 的 run 还会再 reject 一次。多挂一个空 catch，避免 UnhandledRejection。
  void work.catch(() => {});

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
