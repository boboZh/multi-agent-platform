/**
 * Checkpoint 时间旅行：找到「目标节点即将执行」那一帧，用它的 checkpoint_id 续跑，
 * 这样失败节点写进去的 messages 不会跟着进新分支。
 *
 * 入参：getStateHistory 拉到的快照（通常新→旧）；nodeId 为要重试的图节点。
 * 出参：可交给 stream 的 checkpoint_id；找不到则 null。
 */

export type RetrySnapshot = {
  next: string[];
  config?: { configurable?: { checkpoint_id?: string } };
  parentConfig?: { configurable?: { checkpoint_id?: string } };
  tasks?: Array<{ name?: string; error?: unknown }>;
};

export function checkpointIdOf(snapshot: RetrySnapshot): string | null {
  const id = snapshot.config?.configurable?.checkpoint_id;
  return typeof id === "string" && id ? id : null;
}

export function findRetryCheckpointId(
  snapshots: RetrySnapshot[],
  nodeId: string,
): string | null {
  if (!nodeId.trim()) return null;
  const aboutToRun = snapshots.find((snap) => snap.next.includes(nodeId));
  if (aboutToRun) return checkpointIdOf(aboutToRun);

  // 节点已经跑失败：next 可能空了，回退到父 checkpoint（执行前一帧）。
  const failed = snapshots.find((snap) =>
    (snap.tasks ?? []).some(
      (task) => task.name === nodeId && task.error != null,
    ),
  );
  if (failed) {
    const parent =
      failed.parentConfig?.configurable?.checkpoint_id ??
      checkpointIdOf(failed);
    return parent && parent.length > 0 ? parent : null;
  }
  return null;
}
