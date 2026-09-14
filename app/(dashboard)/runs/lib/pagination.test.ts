import { describe, expect, it } from "vitest";
import {
  RUN_LIST_MAX_PAGE_SIZE,
  RUN_LIST_PAGE_SIZE,
  clampPage,
  paginationMeta,
  parseRunListPagination,
  toInclusiveRange,
  visiblePageItems,
} from "@/app/(dashboard)/runs/lib/pagination";

describe("parseRunListPagination", () => {
  it("缺省、空字符串、空白都回落到第 1 页且每页 20 条", () => {
    expect(parseRunListPagination({})).toEqual({
      page: 1,
      pageSize: RUN_LIST_PAGE_SIZE,
    });
    expect(parseRunListPagination({ page: "", pageSize: "   " })).toEqual({
      page: 1,
      pageSize: RUN_LIST_PAGE_SIZE,
    });
  });

  it("非法类型（小数、负数、混杂字母、非数字）不能改写分页", () => {
    expect(
      parseRunListPagination({ page: "1.5", pageSize: "20abc" }),
    ).toEqual({ page: 1, pageSize: RUN_LIST_PAGE_SIZE });
    expect(parseRunListPagination({ page: "-3", pageSize: "0" })).toEqual({
      page: 1,
      pageSize: RUN_LIST_PAGE_SIZE,
    });
    expect(parseRunListPagination({ page: "foo", pageSize: null })).toEqual({
      page: 1,
      pageSize: RUN_LIST_PAGE_SIZE,
    });
  });

  it("pageSize 超过上限时封顶，防止一次把全表拉回来", () => {
    expect(parseRunListPagination({ page: "3", pageSize: "9999" })).toEqual({
      page: 3,
      pageSize: RUN_LIST_MAX_PAGE_SIZE,
    });
  });
});

describe("toInclusiveRange / clampPage / paginationMeta", () => {
  it("第 1 页的 supabase range 必须从 0 开始且两端包含", () => {
    expect(toInclusiveRange(1, 20)).toEqual({ from: 0, to: 19 });
    expect(toInclusiveRange(2, 20)).toEqual({ from: 20, to: 39 });
  });

  it("总数为 0 时页码夹回 1，且没有下一页", () => {
    expect(clampPage(9, 0, 20)).toBe(1);
    const meta = paginationMeta(9, 20, 0);
    expect(meta).toMatchObject({
      page: 1,
      total: 0,
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
    });
  });

  it("筛选后总数变少、当前页越界时夹到最后一页", () => {
    expect(clampPage(9, 25, 20)).toBe(2);
    const meta = paginationMeta(9, 20, 25);
    expect(meta.page).toBe(2);
    expect(meta.totalPages).toBe(2);
    expect(meta.hasPrev).toBe(true);
    expect(meta.hasNext).toBe(false);
  });
});

describe("visiblePageItems", () => {
  it("页数很少时直接列出全部页码，不插入省略号", () => {
    expect(visiblePageItems(1, 1)).toEqual([1]);
    expect(visiblePageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("页数为 0 或负数时仍至少给出第 1 页", () => {
    expect(visiblePageItems(1, 0)).toEqual([1]);
    expect(visiblePageItems(1, -4)).toEqual([1]);
  });

  it("中间页用省略号窗口化，两端始终露出", () => {
    expect(visiblePageItems(6, 12)).toEqual([
      1,
      "ellipsis",
      5,
      6,
      7,
      "ellipsis",
      12,
    ]);
  });
});
