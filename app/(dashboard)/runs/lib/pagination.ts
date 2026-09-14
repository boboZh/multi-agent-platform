/** 监控列表固定页大小。过大一页会让轮询 payload 变重，过小又要点太多次。 */
export const RUN_LIST_PAGE_SIZE = 20;
export const RUN_LIST_MAX_PAGE_SIZE = 100;

export type RunListPagination = {
  page: number;
  pageSize: number;
};

export type RunListPaginationMeta = RunListPagination & {
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
};

function parsePositiveInt(raw: string | null | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const trimmed = raw.trim();
  // 拒绝小数、符号、混杂字母，避免 parseInt("20abc") 被当成 20 悄悄改页大小。
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return n;
}

/**
 * 入参：URL query 上的 page / pageSize（可为脏字符串）。
 * 出参：已经夹到合法正整数的页码与页大小。
 * 步骤：非数字回落默认值；pageSize 再封顶，防止一次把全表拉回来。
 */
export function parseRunListPagination(input: {
  page?: string | null;
  pageSize?: string | null;
}): RunListPagination {
  const page = parsePositiveInt(input.page, 1);
  const pageSize = Math.min(
    parsePositiveInt(input.pageSize, RUN_LIST_PAGE_SIZE),
    RUN_LIST_MAX_PAGE_SIZE,
  );
  return { page, pageSize };
}

/** supabase `.range(from, to)` 两端都包含，第 1 页必须是 0..pageSize-1。 */
export function toInclusiveRange(page: number, pageSize: number): { from: number; to: number } {
  const safePage = Math.max(1, page);
  const safeSize = Math.max(1, pageSize);
  const from = (safePage - 1) * safeSize;
  return { from, to: from + safeSize - 1 };
}

export function totalPageCount(total: number, pageSize: number): number {
  if (total <= 0 || pageSize <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * 总数变少时（筛选、记录被删）页码可能越界，夹回最后一页，避免 range 打到空窗口。
 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const totalPages = totalPageCount(total, pageSize);
  return Math.min(Math.max(page, 1), totalPages);
}

export function paginationMeta(
  page: number,
  pageSize: number,
  total: number,
): RunListPaginationMeta {
  const safeTotal = Math.max(0, total);
  const safeSize = Math.max(1, pageSize);
  const totalPages = totalPageCount(safeTotal, safeSize);
  const safePage = clampPage(page, safeTotal, safeSize);
  return {
    page: safePage,
    pageSize: safeSize,
    total: safeTotal,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safeTotal > 0 && safePage < totalPages,
  };
}

/**
 * 窗口化页码：两端始终露出，中间用 ellipsis，避免几百页时渲染一整排按钮。
 */
export function visiblePageItems(
  page: number,
  totalPages: number,
): Array<number | "ellipsis"> {
  const last = Math.max(1, totalPages);
  const current = Math.min(Math.max(page, 1), last);
  if (last <= 7) {
    return Array.from({ length: last }, (_, i) => i + 1);
  }

  const items: Array<number | "ellipsis"> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(last - 1, current + 1);
  if (start > 2) items.push("ellipsis");
  for (let n = start; n <= end; n += 1) items.push(n);
  if (end < last - 1) items.push("ellipsis");
  items.push(last);
  return items;
}
