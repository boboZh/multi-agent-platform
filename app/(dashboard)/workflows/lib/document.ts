import {
  BRANCH_KEY_RE,
  MAX_FORK_LANES,
  MIN_FORK_LANES,
  NODE_TYPE_BY_KIND,
  type NodeKind,
} from "@/lib/workflow-dsl/kinds";
import {
  createNodeData,
  workflowDocumentShapeSchema,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeData,
} from "@/lib/workflow-dsl/schema";

/**
 * 画布的文档操作层：全是纯函数，输入输出都是 WorkflowDocument。
 *
 * 这里刻意不 import reactflow —— 一是单测不该拉起 React/DOM，二是这些规则
 * （端口约束、分支与边的一致性）属于 DSL 语义，换掉画布库也不该重写。
 * 画布组件只负责把用户手势翻译成对这些函数的调用。
 */

/** 与 reactflow 的 Connection 同形，但不依赖它的类型，保持本模块可脱离 UI 测试。 */
export type CanvasConnection = {
  source: string | null;
  target: string | null;
  sourceHandle: string | null;
  targetHandle: string | null;
};

export type XY = { x: number; y: number };

/** 操作结果：失败带上给用户看的中文原因，画布据此弹提示而不是静默吞掉手势。 */
export type DocumentResult =
  | { ok: true; doc: WorkflowDocument }
  | { ok: false; reason: string };

function nodeById(doc: WorkflowDocument, id: string | null | undefined) {
  if (!id) return undefined;
  return doc.nodes.find((node) => node.id === id);
}

/**
 * 生成图节点 id。
 *
 * 入参：节点 kind、已占用 id 集合。
 * 出参：形如 `n_agent` / `n_agent_2` 的标识符。
 * 之所以不用 uuid：节点 id 会直接当 LangGraph 节点名和表达式里的引用，
 * 必须满足 `[a-zA-Z_][a-zA-Z0-9_]*` 且人眼可读，调试时才认得出是哪个节点。
 */
export function nextNodeId(kind: NodeKind, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = `n_${kind}`;
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

export function nextEdgeId(existing: Iterable<string>): string {
  const taken = new Set(existing);
  let index = 1;
  while (taken.has(`e_${index}`)) index += 1;
  return `e_${index}`;
}

/**
 * 点击面板（而非拖拽）添加节点时的落点。
 *
 * 放在现有节点的最下方再往下一格，而不是视口中心：视口中心可能已经压着别的节点，
 * 新节点会叠上去看不见；顺着往下排至少保证每次都能看到新加的那个。
 */
export function nextNodePosition(doc: WorkflowDocument): XY {
  if (doc.nodes.length === 0) return { x: 80, y: 40 };
  const lowest = doc.nodes.reduce((acc, node) =>
    node.position.y > acc.position.y ? node : acc
  );
  return { x: lowest.position.x, y: lowest.position.y + 140 };
}

/** 在指定坐标落一个新节点。config 走 createNodeData，保证刚拖进来就是合法形状。 */
export function addNode(
  doc: WorkflowDocument,
  kind: NodeKind,
  position: XY
): { doc: WorkflowDocument; nodeId: string } {
  const nodeId = nextNodeId(
    kind,
    doc.nodes.map((node) => node.id)
  );
  const node: WorkflowNode = {
    id: nodeId,
    type: NODE_TYPE_BY_KIND[kind],
    position,
    data: createNodeData(kind),
  };
  return { doc: { ...doc, nodes: [...doc.nodes, node] }, nodeId };
}

/**
 * 删除节点，并级联删掉挂在它身上的边。
 *
 * start 节点会被跳过：它是 startNodeId 指向的运行入口，删掉之后整张图既跑不了、
 * 也无法在画布上重新指定入口，属于不可恢复的误操作。
 */
export function removeNodes(
  doc: WorkflowDocument,
  nodeIds: Iterable<string>
): WorkflowDocument {
  const requested = new Set(nodeIds);
  const removable = new Set(
    doc.nodes
      .filter((node) => requested.has(node.id) && node.data.kind !== "start")
      .map((node) => node.id)
  );
  if (removable.size === 0) return doc;

  return {
    ...doc,
    nodes: doc.nodes.filter((node) => !removable.has(node.id)),
    edges: doc.edges.filter(
      (edge) => !removable.has(edge.source) && !removable.has(edge.target)
    ),
  };
}

export function removeEdges(
  doc: WorkflowDocument,
  edgeIds: Iterable<string>
): WorkflowDocument {
  const removable = new Set(edgeIds);
  if (removable.size === 0) return doc;
  return { ...doc, edges: doc.edges.filter((edge) => !removable.has(edge.id)) };
}

/**
 * 连线合法性检查（拖拽过程中实时调用，必须便宜）。
 *
 * 入参：当前文档 + reactflow 给的连接意图。
 * 出参：`{ ok }` 或带中文原因的拒绝。
 * 规则来自 NODE_PORT_SPEC 与 DSL 约束：
 * 1. 端点必须存在；自环直接拒（LangGraph 上就是死循环，且没有任何 UI 能表达它的退出条件）。
 * 2. start 无入边、end 无出边。
 * 3. 条件节点必须从某个 branch handle 拉出；Fork 必须从某个 lane handle 拉出；
 *    其余节点反过来不允许带 handle（匿名单出口）。
 * 4. 禁止 fork→fork：嵌套并行本期不做，画布层先挡住，避免画出校验必挂的图。
 * 5. 同一对端点 + 同一 handle 不重复连。
 *
 * 注意：「该端口已有出边」不算非法 —— connect() 会用新边替换旧边，
 * 否则用户改连线时得先手动删旧边，交互很别扭。
 */
export function canConnect(
  doc: WorkflowDocument,
  connection: CanvasConnection
): { ok: true } | { ok: false; reason: string } {
  const source = nodeById(doc, connection.source);
  const target = nodeById(doc, connection.target);
  if (!source || !target) return { ok: false, reason: "连线端点不存在。" };
  if (source.id === target.id) {
    return { ok: false, reason: "节点不能连接到自身。" };
  }
  if (target.data.kind === "start") {
    return { ok: false, reason: "开始节点不能有入边。" };
  }
  if (source.data.kind === "end") {
    return { ok: false, reason: "结束节点不能有出边。" };
  }
  if (source.data.kind === "fork" && target.data.kind === "fork") {
    return { ok: false, reason: "并行扇出不能直接连到另一个并行扇出。" };
  }

  const handle = connection.sourceHandle ?? null;
  if (source.data.kind === "condition") {
    const keys = source.data.config.branches.map((branch) => branch.key);
    if (!handle || !keys.includes(handle)) {
      return { ok: false, reason: "条件节点必须从某个分支端口拉出连线。" };
    }
  } else if (source.data.kind === "fork") {
    const keys = source.data.config.lanes.map((lane) => lane.key);
    if (!handle || !keys.includes(handle)) {
      return { ok: false, reason: "并行扇出必须从某个通道端口拉出连线。" };
    }
  } else if (handle) {
    return { ok: false, reason: "该节点只有一个默认出口。" };
  }

  const duplicated = doc.edges.some(
    (edge) =>
      edge.source === source.id &&
      edge.target === target.id &&
      (edge.sourceHandle ?? null) === handle
  );
  if (duplicated) return { ok: false, reason: "这两个节点已经连过了。" };

  return { ok: true };
}

/**
 * 建立连线。
 *
 * 出参：新文档，或拒绝原因。
 * 步骤：先过 canConnect → 再按「一个出口只能有一条边」清掉同源同 handle 的旧边 →
 * 追加新边。边的 data.kind 由源节点决定：条件写 branch、Fork 写 lane、其余写 normal。
 * sourceHandle 必须与 branchKey / laneKey 同时写且相等，这是编译器选边的唯一依据。
 *
 * 只按 (source, handle) 替换，不按 source 清全部出边：Fork 的 N 个 named handle
 * 必须能并存，否则连第二条 lane 会把第一条删掉。也不按 target 清入边：Join 要收
 * 多路扇入，环/驳回走的也是同一条入端口（OR），清掉其它入边会把图拆坏。
 */
export function connect(
  doc: WorkflowDocument,
  connection: CanvasConnection
): DocumentResult {
  console.log("connect", connection);
  const check = canConnect(doc, connection);
  if (!check.ok) return check;

  const source = nodeById(doc, connection.source)!;
  const handle = connection.sourceHandle ?? null;

  const kept = doc.edges.filter(
    (edge) =>
      !(edge.source === source.id && (edge.sourceHandle ?? null) === handle)
  );

  const data: WorkflowEdge["data"] =
    source.data.kind === "condition"
      ? { kind: "branch", branchKey: handle! }
      : source.data.kind === "fork"
        ? { kind: "lane", laneKey: handle! }
        : { kind: "normal" };

  const edge: WorkflowEdge = {
    id: nextEdgeId(doc.edges.map((item) => item.id)),
    source: source.id,
    target: connection.target!,
    sourceHandle: handle,
    data,
  };

  return { ok: true, doc: { ...doc, edges: [...kept, edge] } };
}

/** 以 updater 替换某个节点的 data。调用方按 kind 自行收窄，避免在这里穷举六种 config。 */
export function updateNode(
  doc: WorkflowDocument,
  nodeId: string,
  updater: (data: WorkflowNodeData) => WorkflowNodeData
): WorkflowDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === nodeId ? { ...node, data: updater(node.data) } : node
    ),
  };
}

function conditionNode(doc: WorkflowDocument, nodeId: string) {
  const node = nodeById(doc, nodeId);
  if (!node || node.data.kind !== "condition") return null;
  return node;
}

/** 追加一个分支。key 用 branch_N 递增，保证符合 BRANCH_KEY_RE 且不与现有 key 撞。 */
export function addConditionBranch(
  doc: WorkflowDocument,
  nodeId: string
): DocumentResult {
  const node = conditionNode(doc, nodeId);
  if (!node || node.data.kind !== "condition") {
    return { ok: false, reason: "只有条件节点可以增删分支。" };
  }

  const taken = new Set(node.data.config.branches.map((branch) => branch.key));
  let index = taken.size + 1;
  while (taken.has(`branch_${index}`)) index += 1;
  const key = `branch_${index}`;

  return {
    ok: true,
    doc: updateNode(doc, nodeId, (data) =>
      data.kind === "condition"
        ? {
            ...data,
            config: {
              ...data.config,
              branches: [...data.config.branches, { key, label: key }],
            },
          }
        : data
    ),
  };
}

/**
 * 删除分支，并连带删掉挂在该分支端口上的边。
 *
 * 两条护栏：schema 要求至少两个分支，删到只剩一个会让文档直接非法；
 * 被删的若是 defaultBranch，必须改指到剩下的第一个，否则「兜底分支」会指向不存在的 key。
 */
export function removeConditionBranch(
  doc: WorkflowDocument,
  nodeId: string,
  key: string
): DocumentResult {
  const node = conditionNode(doc, nodeId);
  if (!node || node.data.kind !== "condition") {
    return { ok: false, reason: "只有条件节点可以增删分支。" };
  }
  const { branches, defaultBranch } = node.data.config;
  if (!branches.some((branch) => branch.key === key)) {
    return { ok: false, reason: `分支「${key}」不存在。` };
  }
  if (branches.length <= 2) {
    return { ok: false, reason: "条件节点至少需要保留两个分支。" };
  }

  const remaining = branches.filter((branch) => branch.key !== key);
  const withBranches = updateNode(doc, nodeId, (data) =>
    data.kind === "condition"
      ? {
          ...data,
          config: {
            ...data.config,
            branches: remaining,
            defaultBranch:
              defaultBranch === key ? remaining[0].key : defaultBranch,
          },
        }
      : data
  );

  return {
    ok: true,
    doc: {
      ...withBranches,
      edges: withBranches.edges.filter(
        (edge) =>
          !(edge.source === nodeId && (edge.sourceHandle ?? null) === key)
      ),
    },
  };
}

/**
 * 重命名分支 key，并把 sourceHandle、data.branchKey、defaultBranch 一起改掉。
 *
 * 这三处任何一处漏改，画布上线还连着、编译器却选不到边，属于最难排查的一类脏数据，
 * 所以改名只暴露这一个入口。
 */
export function renameConditionBranch(
  doc: WorkflowDocument,
  nodeId: string,
  oldKey: string,
  newKey: string
): DocumentResult {
  const node = conditionNode(doc, nodeId);
  if (!node || node.data.kind !== "condition") {
    return { ok: false, reason: "只有条件节点可以改分支。" };
  }
  if (oldKey === newKey) return { ok: true, doc };
  if (!BRANCH_KEY_RE.test(newKey)) {
    return {
      ok: false,
      reason: "分支 key 只能是字母、数字、下划线，且不能以数字开头。",
    };
  }
  const { branches, defaultBranch } = node.data.config;
  if (!branches.some((branch) => branch.key === oldKey)) {
    return { ok: false, reason: `分支「${oldKey}」不存在。` };
  }
  if (branches.some((branch) => branch.key === newKey)) {
    return { ok: false, reason: `分支「${newKey}」已存在。` };
  }

  const withBranches = updateNode(doc, nodeId, (data) =>
    data.kind === "condition"
      ? {
          ...data,
          config: {
            ...data.config,
            branches: data.config.branches.map((branch) =>
              branch.key === oldKey ? { ...branch, key: newKey } : branch
            ),
            defaultBranch: defaultBranch === oldKey ? newKey : defaultBranch,
          },
        }
      : data
  );

  return {
    ok: true,
    doc: {
      ...withBranches,
      edges: withBranches.edges.map((edge) =>
        edge.source === nodeId && (edge.sourceHandle ?? null) === oldKey
          ? {
              ...edge,
              sourceHandle: newKey,
              data: { kind: "branch", branchKey: newKey },
            }
          : edge
      ),
    },
  };
}

/** 改分支展示名。label 只影响画布与抽屉文案，不参与编译，所以不用同步边。 */
export function setConditionBranchLabel(
  doc: WorkflowDocument,
  nodeId: string,
  key: string,
  label: string
): WorkflowDocument {
  return updateNode(doc, nodeId, (data) =>
    data.kind === "condition"
      ? {
          ...data,
          config: {
            ...data.config,
            branches: data.config.branches.map((branch) =>
              branch.key === key ? { ...branch, label } : branch
            ),
          },
        }
      : data
  );
}

function forkNode(doc: WorkflowDocument, nodeId: string) {
  const node = nodeById(doc, nodeId);
  if (!node || node.data.kind !== "fork") return null;
  return node;
}

/**
 * 追加一条通道。key 用 lane_N 递增，与拖入时的默认 lane_1 / lane_2 同一命名空间。
 * 上限 16：Handle 挤在底边会点不准，同时 N 路 LLM 并发也要有硬护栏。
 */
export function addForkLane(
  doc: WorkflowDocument,
  nodeId: string
): DocumentResult {
  const node = forkNode(doc, nodeId);
  if (!node || node.data.kind !== "fork") {
    return { ok: false, reason: "只有并行扇出节点可以增删通道。" };
  }
  if (node.data.config.lanes.length >= MAX_FORK_LANES) {
    return { ok: false, reason: `并行扇出最多 ${MAX_FORK_LANES} 条通道。` };
  }

  const taken = new Set(node.data.config.lanes.map((lane) => lane.key));
  let index = taken.size + 1;
  while (taken.has(`lane_${index}`)) index += 1;
  const key = `lane_${index}`;

  return {
    ok: true,
    doc: updateNode(doc, nodeId, (data) =>
      data.kind === "fork"
        ? {
            ...data,
            config: {
              ...data.config,
              lanes: [...data.config.lanes, { key, label: `通道 ${index}` }],
            },
          }
        : data
    ),
  };
}

/**
 * 删除通道，并级联删掉该 handle 上的边。
 * schema 要求至少两条 lane，删到 1 条会让文档直接非法，所以这里先挡住。
 */
export function removeForkLane(
  doc: WorkflowDocument,
  nodeId: string,
  key: string
): DocumentResult {
  const node = forkNode(doc, nodeId);
  if (!node || node.data.kind !== "fork") {
    return { ok: false, reason: "只有并行扇出节点可以增删通道。" };
  }
  const { lanes } = node.data.config;
  if (!lanes.some((lane) => lane.key === key)) {
    return { ok: false, reason: `通道「${key}」不存在。` };
  }
  if (lanes.length <= MIN_FORK_LANES) {
    return {
      ok: false,
      reason: `并行扇出至少需要保留 ${MIN_FORK_LANES} 条通道。`,
    };
  }

  const withLanes = updateNode(doc, nodeId, (data) =>
    data.kind === "fork"
      ? {
          ...data,
          config: {
            ...data.config,
            lanes: data.config.lanes.filter((lane) => lane.key !== key),
          },
        }
      : data
  );

  return {
    ok: true,
    doc: {
      ...withLanes,
      edges: withLanes.edges.filter(
        (edge) =>
          !(edge.source === nodeId && (edge.sourceHandle ?? null) === key)
      ),
    },
  };
}

/**
 * 重命名通道 key，并把 sourceHandle、data.laneKey 一起改掉。
 * 漏改任何一处都会让画布上线还连着、编译器却选不到边。
 */
export function renameForkLane(
  doc: WorkflowDocument,
  nodeId: string,
  oldKey: string,
  newKey: string
): DocumentResult {
  const node = forkNode(doc, nodeId);
  if (!node || node.data.kind !== "fork") {
    return { ok: false, reason: "只有并行扇出节点可以改通道。" };
  }
  if (oldKey === newKey) return { ok: true, doc };
  if (!BRANCH_KEY_RE.test(newKey)) {
    return {
      ok: false,
      reason: "通道 key 只能是字母、数字、下划线，且不能以数字开头。",
    };
  }
  const { lanes } = node.data.config;
  if (!lanes.some((lane) => lane.key === oldKey)) {
    return { ok: false, reason: `通道「${oldKey}」不存在。` };
  }
  if (lanes.some((lane) => lane.key === newKey)) {
    return { ok: false, reason: `通道「${newKey}」已存在。` };
  }

  const withLanes = updateNode(doc, nodeId, (data) =>
    data.kind === "fork"
      ? {
          ...data,
          config: {
            ...data.config,
            lanes: data.config.lanes.map((lane) =>
              lane.key === oldKey ? { ...lane, key: newKey } : lane
            ),
          },
        }
      : data
  );

  return {
    ok: true,
    doc: {
      ...withLanes,
      edges: withLanes.edges.map((edge) =>
        edge.source === nodeId && (edge.sourceHandle ?? null) === oldKey
          ? {
              ...edge,
              sourceHandle: newKey,
              data: { kind: "lane", laneKey: newKey },
            }
          : edge
      ),
    },
  };
}

/** 改通道展示名。label 不参与编译，不用同步边。 */
export function setForkLaneLabel(
  doc: WorkflowDocument,
  nodeId: string,
  key: string,
  label: string
): WorkflowDocument {
  return updateNode(doc, nodeId, (data) =>
    data.kind === "fork"
      ? {
          ...data,
          config: {
            ...data.config,
            lanes: data.config.lanes.map((lane) =>
              lane.key === key ? { ...lane, label } : lane
            ),
          },
        }
      : data
  );
}

/**
 * 落库前清洗。
 *
 * reactflow 会把 `selected`、`dragging`、`positionAbsolute` 等运行时字段直接挂在节点对象上；
 * 这些是画布的瞬时状态，存进 dsl 既没意义，还会让下次打开时带着上一次的选中态。
 * 这里借 zod object 默认剥离未知键的行为洗一遍，顺带确认文档形状仍然合法。
 */
export function sanitizeDocumentForSave(
  doc: WorkflowDocument
): { ok: true; doc: WorkflowDocument } | { ok: false; reason: string } {
  const parsed = workflowDocumentShapeSchema.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, reason: "画布数据不完整，无法保存。" };
  }
  return { ok: true, doc: parsed.data };
}
