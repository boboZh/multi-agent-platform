"use client";

import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";
import {
  RunHighlightContext,
  workflowNodeTypes,
  type RunNodeHighlight,
} from "@/app/(dashboard)/workflows/components/workflow-nodes";

export function RunCanvas({
  dsl,
  highlight,
  selectedNodeId,
  onSelectNode,
}: {
  dsl: WorkflowDocument;
  highlight: RunNodeHighlight;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
}) {
  const nodes = useMemo(
    () =>
      dsl.nodes.map((node) => ({
        ...node,
        selected: node.id === selectedNodeId,
      })),
    [dsl.nodes, selectedNodeId],
  );
  const edges = useMemo(() => dsl.edges, [dsl.edges]);

  return (
    <RunHighlightContext.Provider value={highlight}>
      <ReactFlowProvider>
        <div className="min-h-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={workflowNodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            panOnDrag
            zoomOnScroll
            fitView
            onNodeClick={(_event, node) => onSelectNode(node.id)}
            onPaneClick={() => onSelectNode(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      </ReactFlowProvider>
    </RunHighlightContext.Provider>
  );
}
