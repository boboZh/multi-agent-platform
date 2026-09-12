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
  event: WorkflowSseEvent,
): Promise<BufferedSseEvent> {
  const id = await redisClient.incr(seqKey(runId));
  const row: BufferedSseEvent = { id, event };
  const packed = JSON.stringify(row);
  await redisClient.rpush(bufKey(runId), packed);
  await redisClient.ltrim(bufKey(runId), -BUF_MAX, -1);
  await redisClient.expire(bufKey(runId), BUF_TTL_SECONDS);
  await redisClient.expire(seqKey(runId), BUF_TTL_SECONDS);
  // 先入列表再 PUBLISH：订阅者漏接的帧仍能靠 Last-Event-ID 从 buf 补发。
  await redisClient.publish(runEventChannel(runId), packed);
  return row;
}

export async function readSseBufferAfter(
  runId: string,
  lastId: number,
): Promise<BufferedSseEvent[]> {
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
  command: PendingRunCommand,
) {
  await redisClient.set(cmdKey(runId), JSON.stringify(command), "EX", BUF_TTL_SECONDS);
}

export async function takePendingCommand(
  runId: string,
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
