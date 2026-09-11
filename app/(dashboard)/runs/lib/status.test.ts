import { describe, expect, it } from "vitest";
import {
  isListStatusFilter,
  mapListStatus,
  runStatusLabel,
} from "@/app/(dashboard)/runs/lib/status";

describe("mapListStatus", () => {
  it("运行中筛选项要把尚未被 SSE 拉起的 pending 算进去", () => {
    expect(mapListStatus("running")).toEqual(["pending", "running"]);
  });

  it("成功/失败/挂起按库字段精确匹配，不夹带 cancelled", () => {
    expect(mapListStatus("completed")).toEqual(["completed"]);
    expect(mapListStatus("failed")).toEqual(["failed"]);
    expect(mapListStatus("interrupted")).toEqual(["interrupted"]);
    expect(mapListStatus("completed").includes("cancelled")).toBe(false);
  });

  it("非法 query 不能当成筛选项；cancelled 有展示文案但不进四态", () => {
    expect(isListStatusFilter(null)).toBe(false);
    expect(isListStatusFilter("cancelled")).toBe(false);
    expect(isListStatusFilter("running")).toBe(true);
    expect(runStatusLabel("cancelled")).toBe("已取消");
    expect(runStatusLabel("pending")).toBe("运行中");
    expect(runStatusLabel("not-a-status")).toBe("未知");
  });
});
