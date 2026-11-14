import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { createClient } from "redis";

// 手动运行的部署验收：实际验证两种客户端、IP 证书和检查点所需的模块。
const url = process.env.REDIS_URL;
const ca = process.env.REDIS_CA_CERT?.replace(/\\n/g, "\n").trim();
if (!url?.startsWith("rediss://") || !ca) {
  throw new Error("请提供 REDIS_URL=rediss://… 和 REDIS_CA_CERT");
}
const tls = { ca, rejectUnauthorized: true };
const io = new Redis(url, { tls, lazyConnect: true, retryStrategy: () => null, connectTimeout: 10_000 });
const client = createClient({ url, socket: { tls: true, ...tls, reconnectStrategy: false, connectTimeout: 10_000 } });
io.on("error", () => {});
client.on("error", () => {});
const prefix = `deployment-check:${randomUUID()}:`;
const key = `${prefix}document`;
const index = `${prefix}index`;
let indexCreated = false;
try {
  await io.connect();
  if (await io.ping() !== "PONG") throw new Error("ioredis PING 失败");
  await client.connect();
  if (await client.ping() !== "PONG") throw new Error("node-redis PING 失败");
  await client.sendCommand(["FT.CREATE", index, "ON", "JSON", "PREFIX", "1", prefix, "SCHEMA", "$.status", "AS", "status", "TAG"]);
  indexCreated = true;
  await client.sendCommand(["JSON.SET", key, "$", JSON.stringify({ status: "ok" })]);
  await client.expire(key, 60);
  let found = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await client.sendCommand(["FT.SEARCH", index, "@status:{ok}", "LIMIT", "0", "1"]);
    if (Array.isArray(result) && Number(result[0]) === 1) { found = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!found) throw new Error("JSON/Search 读写验证失败");
  console.log("通过：ioredis、node-redis 的 TLS/认证，以及 JSON 写入和 Search 索引查询。");
} catch (error) {
  console.error("连接验证失败：", error.code ?? error.name, "。检查证书 SAN、CA、密码、端口及模块；未输出连接密码。");
  process.exitCode = 1;
} finally {
  if (client.isReady) {
    if (indexCreated) await client.sendCommand(["FT.DROPINDEX", index]).catch(() => {});
    await client.del(key).catch(() => {});
  }
  if (client.isOpen) await client.disconnect();
  io.disconnect();
}
