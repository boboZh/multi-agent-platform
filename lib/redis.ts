import { Redis } from "ioredis";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { createClient } from "redis";
import { readRedisConfig } from "@/lib/redis-config";

const redisConfig = readRedisConfig({
  REDIS_URL: process.env.REDIS_URL,
  REDIS_CA_CERT: process.env.REDIS_CA_CERT,
});

const globalForRedis = global as unknown as {
  redisClient: Redis;
  redisCheckpointer: RedisSaver | undefined;
  redisCheckpointerPromise: Promise<RedisSaver> | undefined;
};

export const redisClient =
  globalForRedis.redisClient ||
  new Redis(redisConfig.url, { tls: redisConfig.tls });

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

  if (!globalForRedis.redisCheckpointerPromise) {
    globalForRedis.redisCheckpointerPromise = createRedisCheckpointer().then((saver) => {
      globalForRedis.redisCheckpointer = saver;
      return saver;
    }).catch((error: unknown) => {
      // 允许下一次请求重试，避免一次证书或网络故障永久缓存 rejected Promise。
      globalForRedis.redisCheckpointerPromise = undefined;
      throw error;
    });
  }

  return globalForRedis.redisCheckpointerPromise;
}

/**
 * 无参，读取已校验的服务端连接配置，返回已连接的 RedisSaver。
 * 注入与 SSE 相同的 CA → 建立连接 → 交由 Saver 按需创建索引；失败则释放客户端。
 */
async function createRedisCheckpointer() {
  const client = createClient({
    url: redisConfig.url,
    socket: redisConfig.tls
      ? { tls: true, ...redisConfig.tls, connectTimeout: 10_000, reconnectStrategy: false }
      : { connectTimeout: 10_000, reconnectStrategy: false },
  });
  // node-redis 要求监听 error；仅记录错误码，避免连接参数进入日志。
  client.on("error", (error: NodeJS.ErrnoException) => {
    console.error("Redis checkpoint connection error", error.code ?? "UNKNOWN");
  });
  try {
    await client.connect();
    // 使用公开构造函数注入 CA；索引由 RedisSaver 的 list/put/putWrites 按需初始化。
    return new RedisSaver(client, ttlConfig);
  } catch (error) {
    if (client.isOpen) await client.disconnect();
    throw error;
  }
}
