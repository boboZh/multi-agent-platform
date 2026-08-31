// export default function Workflows() {
//   return <div>workflows</div>;
// }

"use client";

import React, { useCallback } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
} from "reactflow";
import "reactflow/dist/style.css";

// ==========================================================
// 1. 自定义节点：条件路由节点 (Router Node)
// 核心技巧：在这个节点里写两个输出端点 (source Handle)
// ==========================================================
const RouterNode = ({ data }: any) => {
  return (
    <div className="px-4 py-2 shadow-md rounded-md bg-white border-2 border-blue-400 min-w-[150px]">
      {/* 顶部：唯一的输入端点 */}
      <Handle type="target" position={Position.Top} className="w-3 h-3 bg-blue-500" />
      
      <div className="font-bold text-sm text-gray-700 text-center mb-2">
        {data.label}
      </div>
      
      <div className="flex justify-between text-xs text-gray-500 mt-4">
        <div>调工具</div>
        <div>结束</div>
      </div>

      {/* 底部左侧：输出端点 1 (条件满足) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="needs_tools"
        style={{ left: "25%" }}
        className="w-3 h-3 bg-orange-500"
      />
      {/* 底部右侧：输出端点 2 (条件不满足) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="end"
        style={{ left: "75%" }}
        className="w-3 h-3 bg-green-500"
      />
    </div>
  );
};

// ==========================================================
// 2. 注册自定义节点
// ==========================================================
const nodeTypes = {
  router: RouterNode,
};

// ==========================================================
// 3. 初始化数据 (Nodes 和 Edges)
// ==========================================================
const initialNodes = [
  {
    id: "agent",
    type: "default",
    data: { label: "🤖 Agent (思考)" },
    position: { x: 250, y: 50 },
    style: { backgroundColor: "#f0fdf4", border: "1px solid #22c55e" }
  },
  {
    id: "router",
    type: "router", // 使用上面定义的自定义节点
    data: { label: "🤔 是否需要调工具？" },
    position: { x: 250, y: 150 },
  },
  {
    id: "tools",
    type: "default",
    data: { label: "🛠️ Tools (执行工具)" },
    position: { x: 100, y: 300 },
    style: { backgroundColor: "#fff7ed", border: "1px solid #f97316" }
  },
  {
    id: "end",
    type: "output", // 官方自带的只进不出节点
    data: { label: "🏁 结束 (输出答案)" },
    position: { x: 400, y: 300 },
  }
];

const initialEdges = [
  // 1. Agent 思考完，进入路由判断
  { id: "e-agent-router", source: "agent", target: "router", animated: true },
  
  // 2. 【条件分支 1】：需要工具，连向 Tools
  // 核心：指定 sourceHandle 的 ID 为 'needs_tools'
  { 
    id: "e-router-tools", 
    source: "router", 
    sourceHandle: "needs_tools", 
    target: "tools", 
    label: "是", 
    style: { stroke: "#f97316" } 
  },
  
  // 3. 【条件分支 2】：不需要工具，连向 End
  // 核心：指定 sourceHandle 的 ID 为 'end'
  { 
    id: "e-router-end", 
    source: "router", 
    sourceHandle: "end", 
    target: "end", 
    label: "否", 
    style: { stroke: "#22c55e" } 
  },
  
  // 4. 【循环分支】：Tools 执行完，强行连回 Agent！
  // React Flow 原生支持从下往上画线，形成闭环
  { 
    id: "e-tools-agent", 
    source: "tools", 
    target: "agent", 
    label: "循环返回", 
    animated: true,
    type: "smoothstep" // 让折线更好看一点
  }
];

// ==========================================================
// 4. 主画布组件
// ==========================================================
export default function WorkflowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 处理用户手动连线
  const onConnect = useCallback(
    (params: any) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background gap={16} size={1} color="#e5e7eb" />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}