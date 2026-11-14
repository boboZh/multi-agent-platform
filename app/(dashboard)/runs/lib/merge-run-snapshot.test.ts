import { describe, expect, it } from "vitest";
import type { FlowRunRow } from "@/lib/workflow-dsl/tables";
import { mergeRunSnapshot } from "@/app/(dashboard)/runs/lib/merge-run-snapshot";

const snapshot: FlowRunRow = {
  id: "run-a", flow_id: "flow-a", flow_version: 1, user_id: "user-a",
  thread_id: "thread-a", status: "pending", input: {}, output: null,
  interrupt_payload: null, error: null, created_at: "2026-11-14", updated_at: "2026-11-14",
};

describe("mergeRunSnapshot", () => {
  it("SSE 还没有事件时保留 HTTP 快照的全部字段", () => {
    expect(mergeRunSnapshot(snapshot, [])).toEqual(snapshot);
  });

  it("只有正文且缺少状态事件时不臆造运行状态", () => {
    expect(mergeRunSnapshot(snapshot, [{ type: "token", content: "" }]).status)
      .toBe("pending");
  });

  it("较晚返回的 pending 快照不能覆盖 SSE 已收到的完成状态", () => {
    expect(mergeRunSnapshot(snapshot, [{ type: "run_status", status: "completed" }]).status)
      .toBe("completed");
  });

  it("回放到一半的 running 不能撤回快照中的完成状态", () => {
    expect(mergeRunSnapshot({ ...snapshot, status: "completed" }, [
      { type: "run_status", status: "running" },
    ]).status).toBe("completed");
  });

  it("SSE 比快照更晚失败时保留实时错误及失败状态", () => {
    const result = mergeRunSnapshot(snapshot, [{ type: "error", message: "模型超时" }]);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("模型超时");
  });

  it("挂起已到达时保留表单且不修改冻结的快照", () => {
    const payload = { nodeId: "review", kind: "human_review" as const };
    const frozen = Object.freeze({ ...snapshot });
    const result = mergeRunSnapshot(frozen, [{ type: "interrupt", payload }]);
    expect(result.interrupt_payload).toEqual(payload);
    expect(result.status).toBe("interrupted");
    expect(frozen.status).toBe("pending");
  });
});
