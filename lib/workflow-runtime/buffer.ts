import { redisClient } from "@/lib/redis";
import { runEventChannel } from "@/lib/workflow-runtime/pubsub";
import {
  PERSISTED_SSE_TYPES,
  type BufferedSseEvent,
  type WorkflowSseEvent,
} from "@/lib/workflow-runtime/sse";

const BUF_TTL_SECONDS = 86_400;
const BUF_MAX = 4000;

function bufKey(runId: string) {
  return `wf:sse:${runId}:buf`;
}
function seqKey(runId: string) {
  return `wf:sse:${runId}:seq`;
}
function lockKey(runId: string) {
  return `wf:lock:${runId}`;
}
function cmdKey(runId: string) {
  return `wf:cmd:${runId}`;
}

export type PendingRunCommand =
  | {
      kind: "start";
      input: { messages?: unknown[]; vars?: Record<string, unknown> };
    }
  | { kind: "resume"; resume: Record<string, unknown> }
  | { kind: "retry"; checkpointId: string };

/**
 * 把事件推进 Redis 列表并分配单调 id。
 * token 也进缓冲，供 Last-Event-ID 补发；是否落 Postgres 由调用方按类型决定。
 */
export async function appendSseBuffer(
  runId: string,
  event: WorkflowSseEvent
): Promise<BufferedSseEvent> {
  // 利用Redis单线程的原子递增特性，为当前工作流生成一个严格连续递增的唯一序号，即原生的last-event-id。为每一次事件打上唯一的ID，是前端断网后按图索骥找补发数据的唯一凭证
  const id = await redisClient.incr(seqKey(runId));
  const row: BufferedSseEvent = { id, event };
  const packed = JSON.stringify(row);
  // 将打包好的事件塞入一个Redis List尾部，为转瞬即逝的事件留下一个“物理快照缓冲池”
  await redisClient.rpush(bufKey(runId), packed);
  // ltrim：强行截断这个列表，使其永远保留最近的BUF_MAX条事件，防止Redis内存溢出（OOM）
  await redisClient.ltrim(bufKey(runId), -BUF_MAX, -1);
  // 为缓冲池和自增序号设置/刷新存活时间。确保工作流一旦结束，或者异常挂死，这些临时高频数据会随着时间自动蒸发，不用写任何清理脚本
  await redisClient.expire(bufKey(runId), BUF_TTL_SECONDS);
  await redisClient.expire(seqKey(runId), BUF_TTL_SECONDS);
  // 防竞态哲学（先入列，后发布）：订阅者漏接的帧仍能靠 Last-Event-ID 从 buf 补发。
  // 通过 Redis Pub/Sub（发布订阅机制）将事件广播出去。前端的 GET /events 接口作为一个旁观者，正监听着这个频道，一收到广播就会立刻转发给浏览器的打字机。
  await redisClient.publish(runEventChannel(runId), packed);
  return row;
}

/**
 * 在常规的后端开发中，全量拉取（类似于 SQL 里的 SELECT * 无 Limit）是大忌，极易引发内存溢出。
但这行代码极其安全，因为appendSseBuffer代码里的 ltrim 是它的天然护城河。ltrim 已经强行把这个列表的长度锁死在了 BUF_MAX（比如 500 条）。所以这里的 lrange 哪怕拉到底，撑死也就几百个轻量级的字符串，瞬间就能读完，绝对不会拖垮 Redis。

一推一拉（rpush + lrange），一裁一放（ltrim + expire），这四条 Redis 命令的组合，把 SSE 流式重连的容错做到了极致
 * @param runId 
 * @param lastId 
 * @returns 
 */
export async function readSseBufferAfter(
  runId: string,
  lastId: number
): Promise<BufferedSseEvent[]> {
  // 获取当前缓冲池的所有历史事件
  const raw = await redisClient.lrange(bufKey(runId), 0, -1);
  const out: BufferedSseEvent[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item) as BufferedSseEvent;
      if (typeof parsed.id === "number" && parsed.id > lastId && parsed.event) {
        out.push(parsed);
      }
    } catch {
      // 坏帧丢掉，不能让整条 SSE 挂掉
    }
  }
  return out;
}

export function shouldPersistEvent(event: WorkflowSseEvent) {
  return PERSISTED_SSE_TYPES.has(event.type);
}

export async function tryAcquireRunLock(runId: string) {
  const ok = await redisClient.set(lockKey(runId), "1", "EX", 600, "NX");
  return ok === "OK";
}

export async function releaseRunLock(runId: string) {
  await redisClient.del(lockKey(runId));
}

export async function setPendingCommand(
  runId: string,
  command: PendingRunCommand
) {
  await redisClient.set(
    cmdKey(runId),
    JSON.stringify(command),
    "EX",
    BUF_TTL_SECONDS
  );
}

export async function takePendingCommand(
  runId: string
): Promise<PendingRunCommand | null> {
  const key = cmdKey(runId);
  const raw = await redisClient.get(key);
  if (!raw) return null;
  await redisClient.del(key);
  try {
    const parsed = JSON.parse(raw) as PendingRunCommand;
    if (
      parsed.kind === "start" ||
      parsed.kind === "resume" ||
      parsed.kind === "retry"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}
