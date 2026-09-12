import { Redis } from "ioredis";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";

const globalForRedis = global as unknown as {
  redisClient: Redis;
  redisCheckpointer: RedisSaver | undefined;
  redisCheckpointerPromise: Promise<RedisSaver> | undefined;
};

export const redisClient =
  globalForRedis.redisClient || new Redis(process.env.REDIS_URL!);

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisClient = redisClient;
}

/**
 * Pub/Sub 订阅必须用独立连接：ioredis 进入 subscriber 模式后不能再 GET/RPUSH。
 * 每次 SSE 打开 duplicate 一条，关闭时 quit，避免和引擎 publish 抢同一 socket。
 */
export function createRedisSubscriber() {
  return redisClient.duplicate();
}

const ttlConfig = {
  defaultTTL: 1440,
  refreshOnRead: true,
};

export async function getRedisCheckpointer() {
  if (globalForRedis.redisCheckpointer) {
    return globalForRedis.redisCheckpointer;
  }

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required");
  }

  if (!globalForRedis.redisCheckpointerPromise) {
    globalForRedis.redisCheckpointerPromise = RedisSaver.fromUrl(
      url,
      ttlConfig,
    ).then((saver) => {
      globalForRedis.redisCheckpointer = saver;
      return saver;
    });
  }

  return globalForRedis.redisCheckpointerPromise;
}
