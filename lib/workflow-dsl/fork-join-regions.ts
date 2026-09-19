import { DEFAULT_AGENT_OUTPUT_KEY } from "@/lib/workflow-dsl/kinds";
import type {
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from "@/lib/workflow-dsl/schema";

/**
 * 一对 Fork–Join 的静态并行区。
 * predecessors 就是编译器 `addEdge(sortedPredecessors, joinId)` 的屏障名单，
 * 必须和校验用同一份，否则会出现「graph 过了但 Join 少等一路」。
 */
export type ForkJoinRegion = {
  forkId: string;
  joinId: string;
  lanes: ForkJoinLaneTrace[];
  /** 屏障 names：各 lane 链尾，已排序去重。 */
  predecessors: string[];
  /** Fork/Join 之间的节点（不含两端）。 */
  interiorNodeIds: string[];
};

/**
 * 单条通道的追踪信息：一条通道对应一条链
 * laneKey：通道的 key，fork的哪个端口
 * entryId：通道的入口节点，从fork出去的第一个节点
 * predecessorId：通道的链尾节点，最后一条进Join节点的source
 * nodeIds：这条通道上Fork和Join之间的全部节点，不含两端
 */
export type ForkJoinLaneTrace = {
  laneKey: string;
  entryId: string;
  predecessorId: string;
  nodeIds: string[];
};

export type ForkJoinIssue = {
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type ForkJoinAnalysis = {
  regions: ForkJoinRegion[];
  issues: ForkJoinIssue[];
};

const LAST_AGENT_TEXT_PATH = "state.lastAgentText";

/**
 * 并行区写入 vars 的 key：Agent/Tool 的 outputKey 与 Assign 的 sets[].key 共用冲突表。
 * 两路同时写同一个槽时 reducer 后写覆盖前写，结果取决于节点 id 字典序。
 */
export function regionWriteKeys(node: WorkflowNode): string[] {
  if (node.data.kind === "agent") {
    return [node.data.config.outputKey];
  }
  if (node.data.kind === "tool" && node.data.config.outputKey) {
    return [node.data.config.outputKey];
  }
  if (node.data.kind === "assign") {
    return node.data.config.sets.map((item) => item.key);
  }
  return [];
}

function outgoing(edges: WorkflowEdge[], nodeId: string) {
  return edges.filter((edge) => edge.source === nodeId);
}

function incoming(edges: WorkflowEdge[], nodeId: string) {
  return edges.filter((edge) => edge.target === nodeId);
}

function handleOf(edge: WorkflowEdge) {
  return edge.sourceHandle ?? undefined;
}

/**
 * 入参：已过 shape 校验的文档（lanes 长度、key 形态由 schema 保证）。
 * 出参：成功配对的 region 列表 + 拓扑问题（写冲突另算，见 collectRegionWriteIssues）。
 *
 * 步骤：
 * 1. 从每个 Fork 的每条 lane 边 BFS，碰到 Join 就停，不穿过它。
 * 2. 各 lane 必须到达同一个 Join；显式 joinId 只用来和推断结果对账。
 * 3. 屏障名单 = 各 lane 直连该 Join 的链尾；必须与 Join 的全部入边来源恰好一致。
 */
export function analyzeForkJoinRegions(
  doc: WorkflowDocument
): ForkJoinAnalysis {
  const issues: ForkJoinIssue[] = [];
  const regions: ForkJoinRegion[] = [];
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node]));
  const joinClaimedBy = new Map<string, string>();

  for (const node of doc.nodes) {
    if (node.data.kind !== "fork") continue;
    const region = analyzeOneFork(doc, node, nodeById, joinClaimedBy, issues);
    if (region) regions.push(region);
  }

  for (const node of doc.nodes) {
    if (node.data.kind !== "join") continue;
    if (!joinClaimedBy.has(node.id)) {
      issues.push({
        message: "Join 必须恰好配对一个 Fork",
        nodeId: node.id,
      });
    }
  }

  for (const edge of doc.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source?.data.kind === "start" && target?.data.kind === "join") {
      issues.push({
        message: "Start 不能直连 Join",
        nodeId: target.id,
        edgeId: edge.id,
      });
    }
  }

  return { regions, issues };
}

/**
 * Fork–Join 之间的节点（不含两端）。
 * 编译器用它强制 isolated；抽屉用同一份名单决定要不要警示 lastAgentText。
 */
export function regionInteriorNodeIds(doc: WorkflowDocument): Set<string> {
  const ids = new Set<string>();
  for (const region of analyzeForkJoinRegions(doc).regions) {
    for (const id of region.interiorNodeIds) ids.add(id);
  }
  return ids;
}

function analyzeOneFork(
  doc: WorkflowDocument,
  fork: WorkflowNode,
  nodeById: Map<string, WorkflowNode>,
  joinClaimedBy: Map<string, string>,
  issues: ForkJoinIssue[]
): ForkJoinRegion | null {
  if (fork.data.kind !== "fork") return null;
  const { lanes, joinId: assertedJoinId } = fork.data.config;
  const traces: Array<{
    laneKey: string;
    entryId?: string;
    reachedJoinIds: Set<string>;
    interiorIds: string[];
  }> = [];

  // 遍历fork的每条通道，生成追踪信息
  for (const lane of lanes) {
    const matches = outgoing(doc.edges, fork.id).filter(
      (edge) => handleOf(edge) === lane.key
    );
    if (matches.length !== 1) {
      traces.push({
        laneKey: lane.key,
        reachedJoinIds: new Set(),
        interiorIds: [],
      });
      continue;
    }
    const edge = matches[0]!;
    traces.push(walkLane(doc, fork.id, lane.key, edge, nodeById, issues));
  }

  const inferred = inferJoinId(fork.id, traces, assertedJoinId, issues);
  if (!inferred) return null;

  const owner = joinClaimedBy.get(inferred);
  if (owner && owner !== fork.id) {
    issues.push({
      message: "一个 Join 只能配对一个 Fork",
      nodeId: inferred,
    });
    return null;
  }
  joinClaimedBy.set(inferred, fork.id);

  const laneResults: ForkJoinLaneTrace[] = [];
  const interiorSet = new Set<string>();
  const predByLane: string[] = [];

  for (const trace of traces) {
    if (!trace.entryId) continue;
    if (trace.entryId === inferred) {
      issues.push({
        message: `通道「${trace.laneKey}」不能直接连到 Join，每条通道至少要有一个节点`,
        nodeId: fork.id,
      });
      continue;
    }
    if (!trace.reachedJoinIds.has(inferred)) {
      issues.push({
        message: `通道「${trace.laneKey}」无法到达配对的 Join`,
        nodeId: fork.id,
      });
      continue;
    }

    const tails = trace.interiorIds.filter((id) =>
      outgoing(doc.edges, id).some((edge) => edge.target === inferred)
    );
    if (tails.length !== 1) {
      issues.push({
        message: `通道「${trace.laneKey}」必须恰好有一个链尾连到 Join`,
        nodeId: fork.id,
      });
      continue;
    }
    const predecessorId = tails[0]!;
    laneResults.push({
      laneKey: trace.laneKey,
      entryId: trace.entryId,
      predecessorId,
      nodeIds: trace.interiorIds,
    });
    predByLane.push(predecessorId);
    for (const id of trace.interiorIds) interiorSet.add(id);
  }

  if (laneResults.length !== lanes.length) return null;

  const predecessors = [...new Set(predByLane)].sort();
  if (predecessors.length !== lanes.length) {
    issues.push({
      message: "Join 的直接前驱必须恰好覆盖每条通道的链尾",
      nodeId: inferred,
    });
  }
  const joinIns = incoming(doc.edges, inferred).map((edge) => edge.source);
  const incomingSet = new Set(joinIns);
  const predSet = new Set(predecessors);
  if (
    incomingSet.size !== predSet.size ||
    [...incomingSet].some((id) => !predSet.has(id))
  ) {
    issues.push({
      message: "Join 的直接前驱必须恰好覆盖每条通道的链尾",
      nodeId: inferred,
    });
  }

  checkLaneExclusivity(laneResults, issues);
  checkInteriorKindsAndFanIn(doc, interiorSet, nodeById, issues);

  if (outgoing(doc.edges, inferred).some((edge) => edge.target === fork.id)) {
    issues.push({
      message: "Join 不能直接连回自己配对的 Fork",
      nodeId: inferred,
    });
  }

  return {
    forkId: fork.id,
    joinId: inferred,
    lanes: laneResults,
    predecessors,
    interiorNodeIds: [...interiorSet],
  };
}
//
function walkLane(
  doc: WorkflowDocument,
  forkId: string,
  laneKey: string,
  startEdge: WorkflowEdge,
  nodeById: Map<string, WorkflowNode>,
  issues: ForkJoinIssue[]
): {
  laneKey: string;
  entryId: string;
  reachedJoinIds: Set<string>;
  interiorIds: string[];
} {
  const reachedJoinIds = new Set<string>();
  const interiorIds: string[] = [];
  const interiorSet = new Set<string>();
  const visited = new Set<string>();
  const queue = [startEdge.target];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const node = nodeById.get(id);
    if (!node) continue;

    if (node.data.kind === "join") {
      reachedJoinIds.add(id);
      continue;
    }

    if (id === forkId) {
      issues.push({
        message: "并行区内出现回到自身 Fork 的环",
        nodeId: forkId,
      });
      continue;
    }

    if (!interiorSet.has(id)) {
      interiorSet.add(id);
      interiorIds.push(id);
    }

    if (
      node.data.kind === "human_review" ||
      node.data.kind === "condition" ||
      node.data.kind === "fork" ||
      node.data.kind === "end" ||
      node.data.kind === "start"
    ) {
      const label =
        node.data.kind === "fork"
          ? "嵌套 Fork"
          : node.data.kind === "human_review"
            ? "人工审核"
            : node.data.kind === "condition"
              ? "条件节点"
              : node.data.kind;
      issues.push({
        message: `并行通道内不允许出现${label}`,
        nodeId: id,
      });
      continue;
    }

    for (const edge of outgoing(doc.edges, id)) {
      queue.push(edge.target);
    }
  }

  return {
    laneKey,
    entryId: startEdge.target,
    reachedJoinIds,
    interiorIds,
  };
}
// 校验单个fork的joinId:是否汇入一个Join节点，是否和用户填写的JoinId一致
function inferJoinId(
  forkId: string,
  traces: Array<{ laneKey: string; reachedJoinIds: Set<string> }>,
  assertedJoinId: string | undefined,
  issues: ForkJoinIssue[]
): string | null {
  const perLane = traces.map((trace) => [...trace.reachedJoinIds]);
  if (perLane.some((ids) => ids.length === 0)) {
    issues.push({
      message: "每条通道都必须到达同一个 Join",
      nodeId: forkId,
    });
    return null;
  }
  if (perLane.some((ids) => ids.length !== 1)) {
    issues.push({
      message: "通道到达了多个 Join，无法唯一推断配对",
      nodeId: forkId,
    });
    return null;
  }
  const unique = new Set(perLane.map((ids) => ids[0]!));
  if (unique.size !== 1) {
    issues.push({
      message: "各通道没有汇合到同一个 Join",
      nodeId: forkId,
    });
    return null;
  }
  const inferred = [...unique][0]!;
  if (assertedJoinId && assertedJoinId !== inferred) {
    issues.push({
      message: `joinId 断言为 ${assertedJoinId}，与推断结果 ${inferred} 不一致`,
      nodeId: forkId,
    });
    return null;
  }
  return inferred;
}
// 校验单个fork的每条通道的独特性
function checkLaneExclusivity(
  lanes: ForkJoinLaneTrace[],
  issues: ForkJoinIssue[]
) {
  for (let i = 0; i < lanes.length; i += 1) {
    const left = new Set(lanes[i]!.nodeIds);
    for (let j = i + 1; j < lanes.length; j += 1) {
      const shared = lanes[j]!.nodeIds.filter((id) => left.has(id));
      if (shared.length > 0) {
        issues.push({
          message: `通道「${lanes[i]!.laneKey}」与「${lanes[j]!.laneKey}」共享节点，屏障会失效`,
          nodeId: shared[0],
        });
      }
    }
  }
}
//
function checkInteriorKindsAndFanIn(
  doc: WorkflowDocument,
  interior: Set<string>,
  nodeById: Map<string, WorkflowNode>,
  issues: ForkJoinIssue[]
) {
  for (const id of interior) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (
      node.data.kind !== "agent" &&
      node.data.kind !== "tool" &&
      node.data.kind !== "assign"
    ) {
      issues.push({
        message: "并行通道内只允许智能体、工具或赋值节点",
        nodeId: id,
      });
    }
    const ins = incoming(doc.edges, id);
    if (ins.length !== 1) {
      issues.push({
        message: "并行区内除 Join 外禁止扇入",
        nodeId: id,
      });
    }
  }
}

/**
 * 识别对共享字段 `state.lastAgentText` 的引用。
 * `state.vars.lastAgentText` 不算：那是 vars 里一个普通 key，和共享字段不是同一条通道。
 */
export function referencesLastAgentText(path: string) {
  const trimmed = path.trim();
  return (
    trimmed === LAST_AGENT_TEXT_PATH ||
    trimmed.startsWith(`${LAST_AGENT_TEXT_PATH}.`) ||
    trimmed.startsWith(`${LAST_AGENT_TEXT_PATH}[`)
  );
}

/**
 * compile 档才跑：并行区不再写 lastAgentText / messages，下游只能读 vars。
 * 默认 outputKey 也是 lastAgentText，所以没改过的 Agent 放进 region 必须失败。
 */
export function collectRegionWriteIssues(
  doc: WorkflowDocument,
  regions: ForkJoinRegion[]
): ForkJoinIssue[] {
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node]));
  const issues: ForkJoinIssue[] = [];

  for (const region of regions) {
    const seenKeys = new Map<string, string>();
    for (const id of region.interiorNodeIds) {
      const node = nodeById.get(id);
      if (!node) continue;

      const writeKeys = regionWriteKeys(node);
      for (const key of writeKeys) {
        if (
          (node.data.kind === "agent" || node.data.kind === "tool") &&
          key === DEFAULT_AGENT_OUTPUT_KEY
        ) {
          issues.push({
            message:
              "并行区内节点不能使用默认 outputKey lastAgentText，须写入独立的 vars key",
            nodeId: id,
          });
        }
        const previous = seenKeys.get(key);
        if (previous) {
          issues.push({
            message: `并行区内 outputKey「${key}」冲突（${previous} 与 ${id}）`,
            nodeId: id,
          });
        } else {
          seenKeys.set(key, id);
        }
      }

      if (node.data.kind === "agent" || node.data.kind === "tool") {
        const inputMap = node.data.config.inputMap;
        if (inputMap) {
          for (const [target, source] of Object.entries(inputMap)) {
            if (referencesLastAgentText(source)) {
              issues.push({
                message: `并行区内 inputMap.${target} 不能引用 ${LAST_AGENT_TEXT_PATH}`,
                nodeId: id,
              });
            }
          }
        }
      }
    }
  }

  return issues;
}
