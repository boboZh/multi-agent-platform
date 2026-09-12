import { redisClient } from "@/lib/redis";
import { runEventChannel } from "@/lib/workflow-runtime/pubsub";
import { shouldHousekeepSseBuffer } from "@/lib/workflow-runtime/sse-housekeep";
import {
  PERSISTED_SSE_TYPES,
  type BufferedSseEvent,
  type WorkflowSseEvent,
} from "@/lib/workflow-runtime/sse";

const BUF_TTL_SECONDS = 86_400;
const BUF_MAX = 4000;
/** token 热路径上隔这么多帧才 LTRIM/EXPIRE，与 Lua 追加拆开省 RTT。 */
const HOUSEKEEP_EVERY = 32;

/**
 * 一次 EVAL：INCR 序号 → 拼帧 → RPUSH → PUBLISH。
 * id 必须在 Redis 里生成后再入 payload，所以不能拆成客户端 pipeline 三次往返。
 */
const APPEND_SSE_LUA = `
local id = redis.call('INCR', KEYS[1])
local packed = '{"id":' .. id .. ',"event":' .. ARGV[1] .. '}'
redis.call('RPUSH', KEYS[2], packed)
redis.call('PUBLISH', KEYS[3], packed)
return packed
`;

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
 * 热路径一次 EVAL（INCR+RPUSH+PUBLISH）；LTRIM/EXPIRE 按间隔做，避免每个 token 六趟 RTT。
 */
export async function appendSseBuffer(
  runId: string,
  event: WorkflowSseEvent,
): Promise<BufferedSseEvent> {
  const packed = (await redisClient.eval(
    APPEND_SSE_LUA,
    3,
    seqKey(runId),
    bufKey(runId),
    runEventChannel(runId),
    JSON.stringify(event),
  )) as string;

  let row: BufferedSseEvent;
  try {
    row = JSON.parse(packed) as BufferedSseEvent;
  } catch {
    throw new Error("Redis SSE Lua 返回了无法解析的帧");
  }
  if (typeof row.id !== "number" || !row.event) {
    throw new Error("Redis SSE Lua 返回的帧缺少 id");
  }

  if (shouldHousekeepSseBuffer(row.id, event.type, HOUSEKEEP_EVERY)) {
    await redisClient
      .pipeline()
      .ltrim(bufKey(runId), -BUF_MAX, -1)
      .expire(bufKey(runId), BUF_TTL_SECONDS)
      .expire(seqKey(runId), BUF_TTL_SECONDS)
      .exec();
  }

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
