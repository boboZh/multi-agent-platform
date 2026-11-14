import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

type TokenEvent = Extract<WorkflowSseEvent, { type: "token" }>;
const BATCH_SIZE = 32;
const FLUSH_INTERVAL_MS = 10;
export const MAX_PENDING_TOKENS = 4096;

/** 按上限拆分 token 快照，保留原始帧及节点归属，不合并不同 lane 的文本。 */
export function splitTokenBatches<T>(
  events: readonly T[],
  limit: number
): T[][] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("批次上限必须是正整数");
  }
  const batches: T[][] = [];
  for (let i = 0; i < events.length; i += limit) {
    batches.push(events.slice(i, i + limit));
  }
  return batches;
}

/**
 * 入参：有序批量发布函数。出参：运行独享的 token 队列。
 * token 入队后最多等待 20ms 启动发送；单个 worker 串行发送批次，Redis 慢时合并积压。
 * 控制事件前必须 flush，避免 node_end/done 越过 token；调用者达到积压上限时也需 flush。
 * 后台失败留到 flush 抛出，既不产生未处理拒绝，也不把传输失败伪装成完成。
 */
export function createTokenBatcher(
  publish: (events: TokenEvent[]) => Promise<void>
) {
  let pending: TokenEvent[] = [];
  let worker: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: { error: unknown } | undefined;

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const start = () => {
    clearTimer();
    if (worker || failure || pending.length === 0) return;
    worker = (async () => {
      while (pending.length > 0) {
        const snapshot = pending;
        pending = [];
        for (const batch of splitTokenBatches(snapshot, BATCH_SIZE)) {
          await publish(batch);
        }
      }
    })()
      .catch((error: unknown) => {
        failure = { error };
      })
      .finally(() => {
        worker = undefined;
        if (pending.length > 0 && !failure && timer === undefined) {
          timer = setTimeout(start, FLUSH_INTERVAL_MS);
        }
      });
  };

  return {
    push(event: TokenEvent) {
      if (failure) throw failure.error;
      pending.push(event);
      if (!worker && timer === undefined) {
        timer = setTimeout(start, FLUSH_INTERVAL_MS);
      }
    },
    get pendingCount() {
      return pending.length;
    },
    async flush() {
      do {
        start();
        if (worker) await worker;
      } while (!failure && (pending.length > 0 || worker));
      if (failure) throw failure.error;
    },
    // 失败路径已无法保证送达，停止定时任务后交给 runner 尝试发布失败终态。
    discard() {
      clearTimer();
      pending = [];
      failure = undefined;
    },
  };
}
