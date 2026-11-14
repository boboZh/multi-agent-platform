import { describe, expect, it } from "vitest";
import {
  buildNodeStateQueryKey,
  isNodeStateQueryLoading,
  reconcileResolvedNodeStateKey,
} from "@/app/(dashboard)/runs/lib/node-state-query";

describe("buildNodeStateQueryKey", () => {
  it("未选中节点时不能生成查询身份，避免空面板也进入 loading", () => {
    expect(buildNodeStateQueryKey("run-1", null, "running")).toBeNull();
    expect(buildNodeStateQueryKey("run-1", undefined, "running")).toBeNull();
    expect(buildNodeStateQueryKey("run-1", "", "running")).toBeNull();
  });

  it("runId 缺失或非法时不能生成查询身份，避免拿空 id 去打 /nodes/:id/state", () => {
    expect(buildNodeStateQueryKey("", "n_a", "running")).toBeNull();
    expect(
      buildNodeStateQueryKey(null as unknown as string, "n_a", "running")
    ).toBeNull();
  });

  it("status 从 running 变为 failed 必须换 key，否则会继续展示旧 checkpoint", () => {
    const running = buildNodeStateQueryKey("run-1", "n_a", "running");
    const failed = buildNodeStateQueryKey("run-1", "n_a", "failed");
    expect(running).toBe("run-1:n_a:running");
    expect(failed).toBe("run-1:n_a:failed");
    expect(running).not.toBe(failed);
  });

  it("status 为 undefined 时与空字符串编成同一 key，避免 snapshot 尚未带 status 时反复 loading", () => {
    expect(buildNodeStateQueryKey("run-1", "n_a", undefined)).toBe(
      buildNodeStateQueryKey("run-1", "n_a", "")
    );
  });
});

describe("reconcileResolvedNodeStateKey / isNodeStateQueryLoading", () => {
  it("查询身份尚未落地时必须 loading", () => {
    const queryKey = buildNodeStateQueryKey("run-1", "n_a", "running");
    expect(isNodeStateQueryLoading(queryKey, null)).toBe(true);
  });

  it("查询身份与 resolved 一致时不能 loading", () => {
    const queryKey = buildNodeStateQueryKey("run-1", "n_a", "running");
    expect(isNodeStateQueryLoading(queryKey, queryKey)).toBe(false);
  });

  it("取消选中必须清空 resolved，否则再点同一节点会漏掉 loading", () => {
    const previous = buildNodeStateQueryKey("run-1", "n_a", "running");
    const reconciled = reconcileResolvedNodeStateKey(null, previous);
    expect(reconciled).toBeNull();
    const again = buildNodeStateQueryKey("run-1", "n_a", "running");
    expect(isNodeStateQueryLoading(again, reconciled)).toBe(true);
  });

  it("换节点时保留旧 resolved，用 key 不相等派生 loading，而不是在 effect 里 setState(true)", () => {
    const oldKey = buildNodeStateQueryKey("run-1", "n_a", "running");
    const newKey = buildNodeStateQueryKey("run-1", "n_b", "running");
    const reconciled = reconcileResolvedNodeStateKey(newKey, oldKey);
    expect(reconciled).toBe(oldKey);
    expect(isNodeStateQueryLoading(newKey, reconciled)).toBe(true);
  });

  it("queryKey 与 resolved 都为 null 时不 loading，也不要在 render 阶段重复 setState", () => {
    expect(reconcileResolvedNodeStateKey(null, null)).toBeNull();
    expect(isNodeStateQueryLoading(null, null)).toBe(false);
  });
});
