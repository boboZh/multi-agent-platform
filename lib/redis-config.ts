import { X509Certificate } from "node:crypto";

/**
 * 输入服务端环境变量，输出两个 Redis 客户端共享的 URL 和 TLS 配置。
 * 先校验协议，再解析 CA；显式配置 CA 时禁止退回明文或关闭证书验证，
 * 避免环境变量填错后聊天检查点与 SSE 使用不同的信任规则。
 */
export function readRedisConfig(env: {
  REDIS_URL?: string;
  REDIS_CA_CERT?: string;
}) {
  const url = env.REDIS_URL?.trim();
  if (!url) throw new Error("缺少 REDIS_URL");
  let protocol: string;
  try {
    const parsed = new URL(url);
    protocol = parsed.protocol;
    if (!parsed.hostname) throw new Error();
  } catch {
    // 不回显 URL，避免把连接密码写入 Vercel 日志。
    throw new Error("REDIS_URL 不是有效的 Redis 地址");
  }
  if (protocol !== "redis:" && protocol !== "rediss:") {
    throw new Error("REDIS_URL 必须使用 redis:// 或 rediss://");
  }
  const ca = env.REDIS_CA_CERT?.replace(/\\n/g, "\n").trim();
  if (!ca) return { url, tls: undefined };
  if (protocol !== "rediss:") {
    throw new Error("配置 REDIS_CA_CERT 时必须使用 rediss://");
  }
  try {
    if (!new X509Certificate(ca).ca) throw new Error();
  } catch {
    throw new Error("REDIS_CA_CERT 必须是有效的 PEM 格式 CA 证书");
  }
  return { url, tls: { ca, rejectUnauthorized: true as const } };
}
