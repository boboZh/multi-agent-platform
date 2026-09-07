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
