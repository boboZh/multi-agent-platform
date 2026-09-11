import { describe, expect, it } from "vitest";
import { nextPublishedVersion } from "./publish";

describe("nextPublishedVersion", () => {
  it("从未发布过时从 1 起钉第一版", () => {
    expect(nextPublishedVersion([])).toBe(1);
  });

  it("已有快照时取 max+1，避免和 flows.version 默认值打架", () => {
    expect(nextPublishedVersion([1])).toBe(2);
    expect(nextPublishedVersion([1, 3])).toBe(4);
  });

  it("边界：空迭代、非有限数字被忽略，不把 NaN 写进版本号", () => {
    expect(nextPublishedVersion(new Set())).toBe(1);
    expect(nextPublishedVersion([Number.NaN, 2])).toBe(3);
    expect(nextPublishedVersion([-1, 0])).toBe(1);
  });
});
