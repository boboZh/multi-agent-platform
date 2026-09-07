import { redisClient } from "@/lib/redis";

export const CONVERSATION_TTL_SECONDS = 24 * 60 * 60;

export type StoredThreadConfig = {
  name: string;
  system_prompt: string | null;
  model_name: string | null;
  temperature: number | null;
  toolIds: string[];
};

export type StoredThreadMeta = {
  threadId: string;
  title: string;
  createdAt: string;
  config: StoredThreadConfig;
};

function agentThreadsKey(agentId: string) {
  return `agent:${agentId}:threads`;
}

function threadMetaKey(agentId: string, threadId: string) {
  return `agent:${agentId}:thread:${threadId}`;
}

export function titleFromMessage(text: string) {
  const compact = text.replaceAll(/\s+/g, " ").trim();
  if (!compact) return "新对话";
  return compact.length <= 24 ? compact : `${compact.slice(0, 23)}…`;
}

export async function ensureAgentConversation(
  agentId: string,
  meta: StoredThreadMeta,
): Promise<boolean> {
  const listKey = agentThreadsKey(agentId);
  const metaKey = threadMetaKey(agentId, meta.threadId);
  const created = await redisClient.set(
    metaKey,
    JSON.stringify(meta),
    "EX",
    CONVERSATION_TTL_SECONDS,
    "NX",
  );

  if (created !== "OK") return false;

  const score = Date.parse(meta.createdAt) || Date.now();
  const pipeline = redisClient.pipeline();
  pipeline.zadd(listKey, score, meta.threadId);
  pipeline.expire(listKey, CONVERSATION_TTL_SECONDS);
  await pipeline.exec();
  return true;
}

export async function listAgentConversations(
  agentId: string,
): Promise<StoredThreadMeta[]> {
  const listKey = agentThreadsKey(agentId);
  const threadIds = await redisClient.zrevrange(listKey, 0, -1);
  if (threadIds.length === 0) return [];

  const values = await redisClient.mget(
    ...threadIds.map((id) => threadMetaKey(agentId, id)),
  );
  const missing = threadIds.filter((_, index) => values[index] == null);
  if (missing.length > 0) {
    await redisClient.zrem(listKey, ...missing);
  }

  return values.flatMap((raw) => {
    if (!raw) return [];
    try {
      return [JSON.parse(raw) as StoredThreadMeta];
    } catch {
      return [];
    }
  });
}
