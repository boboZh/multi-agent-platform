import { describe, expect, it } from "vitest";
import { nextAutoFollow } from "@/app/(dashboard)/runs/lib/auto-follow";

describe("nextAutoFollow", () => {
  it("正文增长而位置未变时继续跟随，不能把内容增高误判成用户上滑", () => {
    expect(nextAutoFollow(true, 500, {
      scrollTop: 500, scrollHeight: 1200, clientHeight: 400,
    })).toBe(true);
  });

  it("用户向上滚动时暂停，即使仍然处于底部容差内", () => {
    expect(nextAutoFollow(true, 600, {
      scrollTop: 595, scrollHeight: 1000, clientHeight: 400,
    })).toBe(false);
  });

  it("暂停后新正文继续增长也不能把用户拉回底部", () => {
    expect(nextAutoFollow(false, 200, {
      scrollTop: 200, scrollHeight: 2000, clientHeight: 400,
    })).toBe(false);
  });

  it("用户向下滚动但尚未到底时仍然暂停", () => {
    expect(nextAutoFollow(false, 200, {
      scrollTop: 400, scrollHeight: 1000, clientHeight: 400,
    })).toBe(false);
  });

  it("用户手动回到底部附近时恢复跟随", () => {
    expect(nextAutoFollow(false, 400, {
      scrollTop: 595, scrollHeight: 1000, clientHeight: 400,
    })).toBe(true);
  });

  it("内容为空或不足一屏时允许保持底部跟随", () => {
    expect(nextAutoFollow(true, 0, {
      scrollTop: 0, scrollHeight: 0, clientHeight: 400,
    })).toBe(true);
    expect(nextAutoFollow(true, 0, {
      scrollTop: 0, scrollHeight: 200, clientHeight: 400,
    })).toBe(true);
  });

  it("亚像素抖动不能意外关闭自动跟随", () => {
    expect(nextAutoFollow(true, 600, {
      scrollTop: 599.5, scrollHeight: 1000, clientHeight: 400,
    })).toBe(true);
  });

  it("非法尺寸及非数字位置保留原有开关而不自动恢复", () => {
    for (const invalid of [NaN, Infinity, "600" as unknown as number]) {
      expect(nextAutoFollow(false, 600, {
        scrollTop: invalid, scrollHeight: 1000, clientHeight: 400,
      })).toBe(false);
    }
    expect(nextAutoFollow(true, 600, {
      scrollTop: 100, scrollHeight: -1, clientHeight: 400,
    })).toBe(true);
  });

  it("触屏顶部回弹的负数位置按零处理，不影响已暂停的状态", () => {
    expect(nextAutoFollow(false, 0, {
      scrollTop: -20, scrollHeight: 1000, clientHeight: 400,
    })).toBe(false);
  });
});
