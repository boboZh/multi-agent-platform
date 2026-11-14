import { redisClient } from "@/lib/redis";
import { runEventChannel } from "@/lib/workflow-runtime/pubsub";
import {
  PERSISTED_SSE_TYPES,
  type BufferedSseEvent,
  type WorkflowSseEvent,
} from "@/lib/workflow-runtime/sse";

const BUF_TTL_SECONDS = 86_400;
const BUF_MAX = 4000;
/** 每批原子分配 ID 并逐帧发布，裁剪和 TTL 也放在同一次往返里。 */
const APPEND_SSE_LUA = `
local rows = {}
for i, event in ipairs(ARGV) do
  local id = redis.call('INCR', KEYS[1])
  local packed = '{"id":' .. id .. ',"event":' .. event .. '}'
  redis.call('RPUSH', KEYS[2], packed)
  redis.call('PUBLISH', KEYS[3], packed)
  rows[i] = packed
end
redis.call('LTRIM', KEYS[2], -${BUF_MAX}, -1)
redis.call('EXPIRE', KEYS[2], ${BUF_TTL_SECONDS})
redis.call('EXPIRE', KEYS[1], ${BUF_TTL_SECONDS})
return rows
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

/** 单帧控制事件复用批量入口，保证与 token 使用同一套单调序号。 */
export async function appendSseBuffer(
  runId: string,
  event: WorkflowSseEvent
): Promise<BufferedSseEvent> {
  const [row] = await appendSseBufferBatch(runId, [event]);
  return row;
}

/**
 * 入参：runId 和有序事件批次。出参：Redis 分配 ID 后的独立帧。
 * 一次 Lua 完成整批入缓冲、逐帧发布和续期；空批次不访问 Redis。
 * 保留原始 SSE 协议，让重连回放和并行节点归属无需跟随传输批次改变。
 */
export async function appendSseBufferBatch(
  runId: string,
  events: readonly WorkflowSseEvent[]
): Promise<BufferedSseEvent[]> {
  if (events.length === 0) return [];
  const packed = await redisClient.eval(
    APPEND_SSE_LUA,
    3,
    seqKey(runId),
    bufKey(runId),
    runEventChannel(runId),
    ...events.map((event) => JSON.stringify(event))
  ) as string[];
  return packed.map((item) => {
    const row = JSON.parse(item) as BufferedSseEvent;
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !row.event) {
      throw new Error("Redis SSE Lua 返回的帧缺少合法 id");
    }
    return row;
  });
}

/** 回放缓冲内晚于游标的帧；Lua 每批裁剪列表，将读取范围限制在最近 4000 帧。 */
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
