/**
 * 从 LangGraph streamEvents v2 的单条事件推断画布 DSL 节点 id。
 * 并行时绝不能用 runner 上的全局游标：后启动的 lane 会把先启动那路的 token / tool 标错。
 *
 * Agent 节点内部会 invoke createReactAgent 子图，所以 LLM/工具帧上：
 * - langgraph_node 是子图节点名（几乎总是 "agent"），不是画布 id
 * - checkpoint_ns 是 `画布节点id:taskId`（再深一层会写成 `n_agent:uuid|agent:uuid`）
 * 因此归属优先取 namespace 第一段，且必须命中当前 DSL 的 nodeIds。
 */

export function isDslNodeName(
  name: string | undefined,
  nodeIds: Set<string>
): boolean {
  return Boolean(name && nodeIds.has(name));
}

function firstCheckpointNodeId(ns: unknown): string | undefined {
  if (typeof ns !== "string") return undefined;
  const trimmed = ns.trim();
  if (!trimmed) return undefined;
  const head = trimmed.split("|")[0] ?? "";
  const nodeId = head.split(":")[0]?.trim();
  return nodeId || undefined;
}

export function nodeIdFromStreamMetadata(
  metadata: unknown,
  nodeIds: Set<string>
): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const rec = metadata as {
    checkpoint_ns?: unknown;
    langgraph_checkpoint_ns?: unknown;
    langgraph_node?: unknown;
  };
  const fromNs =
    firstCheckpointNodeId(rec.checkpoint_ns) ??
    firstCheckpointNodeId(rec.langgraph_checkpoint_ns);
  if (fromNs && nodeIds.has(fromNs)) return fromNs;

  if (typeof rec.langgraph_node === "string") {
    const node = rec.langgraph_node.trim();
    if (node && nodeIds.has(node)) return node;
  }
  return undefined;
}

export type FailedTaskSnapshot = {
  next?: string[];
  tasks?: Array<{ name?: string; error?: unknown }>;
};

/**
 * 并行 superstep 里 currentNodeIds 可能有 N 个，error 必须落到真正带 task.error 的那一路。
 * 入参：getStateHistory 快照（新→旧）、当时还在跑的节点集合。
 * 出参：失败任务名；没有带 error 的任务则 undefined。
 */
export function pickFailedTaskName(
  snapshots: FailedTaskSnapshot[] | null | undefined,
  inflightNodeIds: Iterable<string>
): string | undefined {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return undefined;
  const inflight = new Set(
    [...inflightNodeIds].filter((id) => typeof id === "string" && id.length > 0)
  );

  for (const snap of snapshots) {
    const tasks = snap?.tasks;
    if (!Array.isArray(tasks)) continue;
    const inflightFailed = tasks.find(
      (task) =>
        typeof task?.name === "string" &&
        inflight.has(task.name) &&
        task.error != null
    );
    if (inflightFailed?.name) return inflightFailed.name;
  }

  for (const snap of snapshots) {
    const tasks = snap?.tasks;
    if (!Array.isArray(tasks)) continue;
    const anyFailed = tasks.find(
      (task) => typeof task?.name === "string" && task.error != null
    );
    if (anyFailed?.name) return anyFailed.name;
  }

  return undefined;
}
