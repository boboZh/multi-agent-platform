/**
 * 是否在这次 append 后做 LTRIM/EXPIRE。
 * 每个 token 都裁 TTL 会多两趟 RTT；首帧、整除间隔、终态必须做，避免短跑或崩溃后 key 永不蒸发。
 */
export function shouldHousekeepSseBuffer(
  id: unknown,
  eventType: unknown,
  every: number,
): boolean {
  if (typeof every !== "number" || !Number.isInteger(every) || every < 1) {
    return false;
  }
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    return false;
  }
  if (eventType === "done" || eventType === "error") return true;
  if (id === 1) return true;
  return id % every === 0;
}
