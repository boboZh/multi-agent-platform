/**
 * 节点 checkpoint 请求的身份。
 * 入参：runId、选中节点、运行 status；出参：无可查询节点时为 null。
 * 把 status 编进 key，是因为运行态变化后 checkpoint 可能已更新，必须让「已解析」标记失效。
 */
export function buildNodeStateQueryKey(
  runId: string,
  selectedNodeId: string | null | undefined,
  status: string | undefined
): string | null {
  if (typeof selectedNodeId !== "string" || selectedNodeId.length === 0) {
    return null;
  }
  if (typeof runId !== "string" || runId.length === 0) {
    return null;
  }
  return `${runId}:${selectedNodeId}:${status ?? ""}`;
}

/**
 * 取消选中时在 render 阶段丢掉旧 resolvedKey。
 * 若不清空，再次点开同一节点时 queryKey 与旧 resolved 相同，会漏掉 loading。
 * 换节点 / 换 status 时故意保留旧 resolved，用不相等在 render 期派生 loading，避免 effect 里同步 setState。
 */
export function reconcileResolvedNodeStateKey(
  queryKey: string | null,
  resolvedKey: string | null
): string | null {
  if (queryKey === null) return null;
  return resolvedKey;
}

export function isNodeStateQueryLoading(
  queryKey: string | null,
  resolvedKey: string | null
): boolean {
  return queryKey !== null && queryKey !== resolvedKey;
}
