import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readRedisConfig } from "./redis-config";

const ca = readFileSync(new URL("./fixtures/redis-test-ca.crt", import.meta.url), "utf8").trim();

describe("Redis 服务端连接配置", () => {
  it("缺失或空白地址时拒绝连接，避免误连本机默认实例", () => {
    for (const REDIS_URL of [undefined, "", "   "]) {
      expect(() => readRedisConfig({ REDIS_URL })).toThrow("缺少 REDIS_URL");
    }
  });
  it("非法地址和非 Redis 协议不会在错误中泄露密码", () => {
    for (const REDIS_URL of ["bad-secret", "https://app:secret@example.com", "redis://"]) {
      expect(() => readRedisConfig({ REDIS_URL })).toThrow();
      try { readRedisConfig({ REDIS_URL }); } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    }
  });
  it("未配置私有 CA 时兼容原有普通连接和受信任 TLS 连接", () => {
    for (const url of ["redis://localhost:6379", "rediss://example.com:6380"]) {
      expect(readRedisConfig({ REDIS_URL: url })).toEqual({ url, tls: undefined });
    }
  });
  it("填写 CA 却使用明文协议时拒绝启动", () => {
    expect(() => readRedisConfig({ REDIS_URL: "redis://localhost", REDIS_CA_CERT: ca })).toThrow("必须使用 rediss://");
  });
  it("损坏证书或误填私钥时拒绝启动", () => {
    for (const REDIS_CA_CERT of ["not a certificate", "-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----", "-----BEGIN PRIVATE KEY-----\nbroken"]) {
      expect(() => readRedisConfig({ REDIS_URL: "rediss://127.0.0.1:6380", REDIS_CA_CERT })).toThrow("有效的 PEM");
    }
  });
  it("有效 CA 保留证书验证并接受公网 IP 地址", () => {
    expect(readRedisConfig({ REDIS_URL: "rediss://203.0.113.1:6380", REDIS_CA_CERT: ca }).tls).toEqual({ ca, rejectUnauthorized: true });
  });
  it("环境变量中的转义换行会还原为 PEM 换行", () => {
    expect(readRedisConfig({ REDIS_URL: "rediss://127.0.0.1:6380", REDIS_CA_CERT: ca.replace(/\n/g, "\\n") }).tls?.ca).toBe(ca);
  });
  it("空白 CA 不覆盖系统默认信任证书", () => {
    expect(readRedisConfig({ REDIS_URL: "rediss://example.com", REDIS_CA_CERT: "  " }).tls).toBeUndefined();
  });
});
