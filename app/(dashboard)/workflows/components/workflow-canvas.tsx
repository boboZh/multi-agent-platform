"use client";

import { useCallback, useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "reactflow";
import "reactflow/dist/style.css";
import type { NodeKind } from "@/lib/workflow-dsl/kinds";
import type {
  WorkflowDocument,
  WorkflowNodeData,
} from "@/lib/workflow-dsl/schema";
import {
  canConnect,
  connect,
  removeEdges,
  removeNodes,
  type XY,
} from "../lib/document";
import type { EditorSelection } from "../types";
import { NODE_KIND_MIME } from "./node-palette";
import {
  NodeIssuesContext,
  NodeRefNamesContext,
  workflowNodeTypes,
} from "./workflow-nodes";

/**
 * 画布本体。
 *
 * 设计前提：WorkflowDocument 的 nodes/edges 本身就是 reactflow 形状（PLAN §2.1），
 * 所以这里不再维护第二份画布状态 —— 直接把文档喂给 ReactFlow，再把变更写回文档。
 * 两份状态互相同步是这类编辑器最常见的 bug 源头（拖一下回弹、保存丢位置）。
 */

/**
 * `transient` 表示这次变更不是用户的编辑意图，调用方据此决定要不要标脏。
 * reactflow 在挂载时会把量出来的 width/height 写回节点，点选也会写 selected——
 * 不区分的话，页面刚打开、或只是点一下节点，保存按钮就亮了。
 */
export type DocChangeOptions = { transient?: boolean };

type WorkflowCanvasProps = {
  doc: WorkflowDocument;
  onDocChange: (doc: WorkflowDocument, options?: DocChangeOptions) => void;
  selection: EditorSelection | null;
  onSelectionChange: (selection: EditorSelection | null) => void;
  onAddNode: (kind: NodeKind, position: XY) => void;
  /** 校验失败的节点 id，用来在卡片上打红框。 */
  issueNodeIds: ReadonlySet<string>;
  /** agentId / toolId → 名称，节点卡展示用。 */
  refNames: ReadonlyMap<string, string>;
  onError: (message: string | null) => void;
};

function WorkflowCanvasInner({
  doc,
  onDocChange,
  selection,
  onSelectionChange,
  onAddNode,
  issueNodeIds,
  refNames,
  onError,
}: WorkflowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();

  /**
   * 喂给 ReactFlow 的节点。
   * `deletable` 只在这一层注入，不写进文档：它是画布行为，不是 DSL 的一部分，
   * 写进去还会被保存前的 zod 清洗掉，白白制造一次 diff。
   */
  const rfNodes = useMemo<Node<WorkflowNodeData>[]>(
    () =>
      doc.nodes.map((node) =>
        node.data.kind === "start" ? { ...node, deletable: false } : node,
      ),
    [doc.nodes],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      doc.edges.map((edge) => ({
        ...edge,
        // 条件边标上分支名，用户不点开抽屉也知道这条线走的哪个分支。
        label: edge.data.kind === "branch" ? edge.data.branchKey : undefined,
        animated: edge.data.kind === "branch",
      })),
    [doc.edges],
  );

  /**
   * 位置、选中、尺寸等增量变更直接回写文档。
   *
   * 两处讲究：
   * 1. 过滤掉 remove —— 删除统一走 onNodesDelete，那里才有「保护 start + 级联删边」的规则，
   *    让 applyNodeChanges 自己删会绕过这两条。
   * 2. select / dimensions 标成 transient —— 它们由画布自身产生而非用户编辑，见 DocChangeOptions。
   */
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const survivable = changes.filter((change) => change.type !== "remove");
      if (survivable.length === 0) return;
      const transient = survivable.every(
        (change) => change.type === "select" || change.type === "dimensions",
      );
      const next = applyNodeChanges(survivable, rfNodes);
      onDocChange(
        { ...doc, nodes: next as WorkflowDocument["nodes"] },
        { transient },
      );
    },
    [doc, rfNodes, onDocChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const survivable = changes.filter((change) => change.type !== "remove");
      if (survivable.length === 0) return;
      const transient = survivable.every((change) => change.type === "select");
      const next = applyEdgeChanges(survivable, rfEdges);
      onDocChange(
        { ...doc, edges: next as WorkflowDocument["edges"] },
        { transient },
      );
    },
    [doc, rfEdges, onDocChange],
  );

  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      onDocChange(
        removeNodes(
          doc,
          deleted.map((node) => node.id),
        ),
      );
      onSelectionChange(null);
    },
    [doc, onDocChange, onSelectionChange],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      onDocChange(
        removeEdges(
          doc,
          deleted.map((edge) => edge.id),
        ),
      );
      onSelectionChange(null);
    },
    [doc, onDocChange, onSelectionChange],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      const result = connect(doc, connection);
      if (!result.ok) {
        onError(result.reason);
        return;
      }
      onError(null);
      onDocChange(result.doc);
    },
    [doc, onDocChange, onError],
  );

  /** 拖拽过程中实时判定，非法连接直接不让落，省得连上再弹错误。 */
  const handleIsValidConnection = useCallback(
    (connection: Connection) => canConnect(doc, connection).ok,
    [doc],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(NODE_KIND_MIME) as NodeKind | "";
      if (!kind) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      onAddNode(kind, position);
    },
    [screenToFlowPosition, onAddNode],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  /**
   * 选中同步。用 onSelectionChange 而不是 onNodeClick：框选和键盘操作也要能打开抽屉。
   * 只取第一个：抽屉一次只配置一个对象，多选时按住不放地渲染多份表单没有意义。
   */
  const handleSelectionChange = useCallback(
    ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const next: EditorSelection | null = nodes[0]
        ? { type: "node", id: nodes[0].id }
        : edges[0]
          ? { type: "edge", id: edges[0].id }
          : null;
      const same =
        (next === null && selection === null) ||
        (next !== null &&
          selection !== null &&
          next.type === selection.type &&
          next.id === selection.id);
      if (!same) onSelectionChange(next);
    },
    [selection, onSelectionChange],
  );

  return (
    <div className="min-h-0 min-w-0 flex-1">
      <NodeIssuesContext.Provider value={issueNodeIds}>
        <NodeRefNamesContext.Provider value={refNames}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={workflowNodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onNodesDelete={handleNodesDelete}
            onEdgesDelete={handleEdgesDelete}
            onConnect={handleConnect}
            isValidConnection={handleIsValidConnection}
            onSelectionChange={handleSelectionChange}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            // 视口不回写文档：平移/缩放属于「看」而不是「改」，写回去会让保存按钮无端亮起。
            defaultViewport={doc.viewport ?? { x: 0, y: 0, zoom: 1 }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} color="#e5e7eb" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-muted" />
          </ReactFlow>
        </NodeRefNamesContext.Provider>
      </NodeIssuesContext.Provider>
    </div>
  );
}

/** screenToFlowPosition 需要 Provider 上下文，所以对外导出的是包好的版本。 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
