import { describe, expect, it } from "vitest";
import { shouldHousekeepSseBuffer } from "@/lib/workflow-runtime/sse-housekeep";

describe("shouldHousekeepSseBuffer", () => {
  it("非法 id / every 不裁 TTL，避免把脏序号当成第 32 帧", () => {
    expect(shouldHousekeepSseBuffer(0, "token", 32)).toBe(false);
    expect(shouldHousekeepSseBuffer(-32, "token", 32)).toBe(false);
    expect(shouldHousekeepSseBuffer(1.5, "token", 32)).toBe(false);
    expect(shouldHousekeepSseBuffer("32", "token", 32)).toBe(false);
    expect(shouldHousekeepSseBuffer(32, "token", 0)).toBe(false);
    expect(shouldHousekeepSseBuffer(32, "token", 3.2)).toBe(false);
  });

  it("done 和 error 即使 id 对不上间隔也要刷新 TTL，防止终态 key 常驻", () => {
    expect(shouldHousekeepSseBuffer(7, "done", 32)).toBe(true);
    expect(shouldHousekeepSseBuffer(7, "error", 32)).toBe(true);
    expect(shouldHousekeepSseBuffer(7, "token", 32)).toBe(false);
  });

  it("首帧和整除间隔才裁 List；中间 token 跳过以省 RTT", () => {
    expect(shouldHousekeepSseBuffer(1, "token", 32)).toBe(true);
    expect(shouldHousekeepSseBuffer(32, "token", 32)).toBe(true);
    expect(shouldHousekeepSseBuffer(64, "node_end", 32)).toBe(true);
    expect(shouldHousekeepSseBuffer(31, "token", 32)).toBe(false);
    expect(shouldHousekeepSseBuffer(33, "run_status", 32)).toBe(false);
  });
});
