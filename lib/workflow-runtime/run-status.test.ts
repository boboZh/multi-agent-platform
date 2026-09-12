import { describe, expect, it } from "vitest";
import { isTerminalStatus } from "@/lib/workflow-runtime/run-status";

describe("isTerminalStatus", () => {
  it("pending 和 running 必须继续订阅，不能当成终态关掉 SSE", () => {
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("interrupted 算终态：resume 会另开一轮引擎，而不是挂着旧订阅 invoke", () => {
    expect(isTerminalStatus("interrupted")).toBe(true);
  });

  it("completed / failed / cancelled 都不再拉引擎", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });
});
