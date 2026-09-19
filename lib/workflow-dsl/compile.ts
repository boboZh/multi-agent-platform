import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  messagesStateReducer,
  type BaseCheckpointSaver,
  type CompiledStateGraph,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createChatModel } from "@/lib/agent-runtime/llm";
import { buildLangChainTools } from "@/lib/agent-runtime/tools";
import { createSupabaseAdmin } from "@/lib/supabase-admin";
import type {
  AgentRow,
  AgentToolRow,
  ToolRow,
} from "@/app/(dashboard)/agents/lib/types";
import {
  parseWorkflowDocument,
  type AgentNodeConfig,
  type ConditionNodeConfig,
  type HumanReviewNodeConfig,
  type ToolNodeConfig,
  type AssignNodeConfig,
  type WorkflowDocument,
  type WorkflowIssue,
} from "@/lib/workflow-dsl/schema";
import {
  buildBranchPathMap,
  collectStaticControlEdges,
  endNodeIds,
  evaluateAssignSets,
  evaluateExpressionRoute,
  lastAiText,
  messageContentToText,
  pickBranchKey,
  regionInteriorNodeIds,
  resolveInputMap,
  type AgentMessagesMode,
  type WorkflowGraphState,
} from "@/lib/workflow-dsl/compile-utils";

export type { WorkflowGraphState } from "@/lib/workflow-dsl/compile-utils";
export {
  collectStaticControlEdges,
  evaluateAssignSets,
  evaluateExpressionRoute,
  joinBarrierChannelName,
  pickBranchKey,
  regionInteriorNodeIds,
  resolveInputMap,
  resolveStatePath,
} from "@/lib/workflow-dsl/compile-utils";
export type { AgentMessagesMode } from "@/lib/workflow-dsl/compile-utils";

export const WorkflowGraphAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  vars: Annotation<Record<string, unknown>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  lastAgentText: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  /**
   * 条件节点写入的下一跳 key。路由函数只读这个字段，
   * 这样 LLM / 表达式的副作用发生在「节点」里，stream 的 updates 才能看到一次条件计算。
   */
  _route: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

export type AgentResource = {
  agent: AgentRow;
  tools: ToolRow[];
};

export type CompileResources = {
  agents: Map<string, AgentResource>;
  tools: Map<string, ToolRow>;
};

export type CompileOptions = {
  checkpointer?: BaseCheckpointSaver | false;
  /**
   * dry-run 只验证「图能编出来」，不 invoke。
   * HITL 的 checkpointer 是 resume 契约，校验/发布 API 不会挂 saver，
   * 不能和真正跑图走同一条「缺 saver 就失败」的门闩。
   */
  dryRun?: boolean;
  resources?: CompileResources;
  userId?: string;
  createModel?: typeof createChatModel;
};

/**
 * CompiledStateGraph<WorkflowGraphState, Partial<WorkflowGraphState>, string>
 * WorkflowGraphState (全局状态读取契约):约束了每一个节点在接收入参时，能读到什么结构的数据
 * Partial<WorkflowGraphState>: 节点执行完毕后，允许返回的数据结构（也就是 Update 补丁）
 * string: 标识工作流中各个节点的 ID 类型。
 */
export type CompiledWorkflowApp = CompiledStateGraph<
  WorkflowGraphState,
  Partial<WorkflowGraphState>,
  string
>;

export type CompileSuccess = {
  ok: true;
  document: WorkflowDocument;
  app: CompiledWorkflowApp;
};

export type CompileFailure = {
  ok: false;
  errors: WorkflowIssue[];
};

export type CompileResult = CompileSuccess | CompileFailure;

function asGraphState(
  state: typeof WorkflowGraphAnnotation.State
): WorkflowGraphState {
  return {
    messages: state.messages,
    vars: state.vars,
    lastAgentText: state.lastAgentText,
    _route: state._route,
  };
}

/**
 * 编译期把 agentId / toolId 解析成行数据，运行时节点闭包直接用，避免每步再打库。
 * 发布后的 flow_versions 钉死的是 DSL；智能体提示词仍以编译当下的 agents 行为准。
 */
async function loadResources(
  doc: WorkflowDocument,
  userId: string | undefined
): Promise<CompileResources> {
  const agentIds: string[] = [];
  const toolIds: string[] = [];
  for (const node of doc.nodes) {
    if (node.data.kind === "agent" && node.data.config.agentId) {
      agentIds.push(node.data.config.agentId);
    }
    if (node.data.kind === "tool" && node.data.config.toolId) {
      toolIds.push(node.data.config.toolId);
    }
  }
  const uniqueAgentIds = [...new Set(agentIds)];
  const uniqueToolIds = [...new Set(toolIds)];

  const agents = new Map<string, AgentResource>();
  const tools = new Map<string, ToolRow>();
  if (uniqueAgentIds.length === 0 && uniqueToolIds.length === 0) {
    return { agents, tools };
  }

  const supabase = createSupabaseAdmin();
  const owner = userId ?? process.env.NEXT_PUBLIC_MOCK_USER_ID;

  if (uniqueAgentIds.length > 0) {
    // 获取agent列表
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id,user_id,name,system_prompt,model_name,temperature,created_at")
      .in("id", uniqueAgentIds);
    const rows = (agentRows ?? []) as AgentRow[];
    // 获取上面agent列表绑定的tool列表
    const { data: links } = await supabase
      .from("agent_tools")
      .select("id,agent_id,tool_id")
      .in("agent_id", uniqueAgentIds);
    // 生成agentid -> toolId[]的映射
    const toolIdByAgent = new Map<string, string[]>();
    for (const link of (links ?? []) as AgentToolRow[]) {
      const list = toolIdByAgent.get(link.agent_id) ?? [];
      list.push(link.tool_id);
      toolIdByAgent.set(link.agent_id, list);
    }
    const boundToolIds = [...new Set([...toolIdByAgent.values()].flat())];
    const boundTools =
      boundToolIds.length === 0
        ? []
        : (((
            await supabase
              .from("tools")
              .select(
                "id,user_id,name,display_name,description,tool_type,connection_config"
              )
              .in("id", boundToolIds)
          ).data ?? []) as ToolRow[]);
    const boundById = new Map(boundTools.map((tool) => [tool.id, tool]));
    for (const agent of rows) {
      if (owner && agent.user_id !== owner) continue;
      const bound = (toolIdByAgent.get(agent.id) ?? [])
        .map((id) => boundById.get(id))
        .filter((tool): tool is ToolRow => Boolean(tool));
      agents.set(agent.id, { agent, tools: bound });
    }
  }

  if (uniqueToolIds.length > 0) {
    const { data: toolRows } = await supabase
      .from("tools")
      .select(
        "id,user_id,name,display_name,description,tool_type,connection_config"
      )
      .in("id", uniqueToolIds);
    for (const tool of (toolRows ?? []) as ToolRow[]) {
      if (owner && tool.user_id !== owner) continue;
      tools.set(tool.id, tool);
    }
  }

  return { agents, tools };
}

function missingResourceErrors(
  doc: WorkflowDocument,
  resources: CompileResources
): WorkflowIssue[] {
  const errors: WorkflowIssue[] = [];
  for (const node of doc.nodes) {
    if (node.data.kind === "agent" && node.data.config.agentId) {
      if (!resources.agents.has(node.data.config.agentId)) {
        errors.push({
          message: `找不到智能体 ${node.data.config.agentId}，无法编译`,
          path: ["nodes", node.id, "data", "config", "agentId"],
          nodeId: node.id,
        });
      }
    }
    if (node.data.kind === "tool" && node.data.config.toolId) {
      if (!resources.tools.has(node.data.config.toolId)) {
        errors.push({
          message: `找不到工具 ${node.data.config.toolId}，无法编译`,
          path: ["nodes", node.id, "data", "config", "toolId"],
          nodeId: node.id,
        });
      }
    }
  }
  return errors;
}

/**
 * 单次结构化工具调用：参数只来自 inputMap，不经过模型。
 * inherit 才把结果追加进 messages，让后续串行 agent 能在对话里看见；
 * isolated（并行区内）只写 vars，避免 N 路 tool 摘要按节点 id 交错进共享线程。
 */
async function executeToolNode(
  state: WorkflowGraphState,
  config: ToolNodeConfig,
  resources: CompileResources,
  messagesMode: AgentMessagesMode
): Promise<Partial<WorkflowGraphState>> {
  console.log("executeToolNode", state);
  if (!config.toolId) {
    throw new Error("工具节点缺少 toolId");
  }
  const row = resources.tools.get(config.toolId);
  if (!row) throw new Error(`工具 ${config.toolId} 未在编译资源中`);

  const [lcTool] = buildLangChainTools([row]);
  const args = resolveInputMap(state, config.inputMap);
  const raw = await lcTool.invoke(args);
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);

  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  const vars = config.outputKey ? { [config.outputKey]: parsed } : {};
  if (messagesMode === "isolated") {
    return { vars };
  }
  return {
    messages: [
      new AIMessage({
        content: `[tool:${row.name}] ${text}`,
      }),
    ],
    vars,
  };
}

/**
 * Agent 节点：内部跑 createReactAgent（ReAct 留在节点里，不在画布上展开 tool 环）。
 * 不给内部 agent 挂 checkpointer —— 外层工作流图才是 checkpoint 的权威，两套 saver 会把同一 thread 写乱。
 *
 * messagesMode 由拓扑决定，不是 DSL 字段：
 * inherit — 读 state.messages，写回 newMessages 与 lastAgentText，并写 vars[outputKey]（区外旧图）。
 * isolated — 只吃 inputMap 展开的 HumanMessage + system，不读不写共享对话，只写 vars[outputKey]。
 * 不写摘要 AIMessage：摘要仍会按节点 id 字典序拼进 messages，和交错对话是同一类「确定但任意」。
 */
async function executeAgentNode(
  state: WorkflowGraphState,
  config: AgentNodeConfig,
  resources: CompileResources,
  createModel: typeof createChatModel,
  messagesMode: AgentMessagesMode
): Promise<Partial<WorkflowGraphState>> {
  console.log("executeAgentNode", state);
  if (!config.agentId) throw new Error("智能体节点缺少 agentId");
  const resource = resources.agents.get(config.agentId);
  if (!resource) throw new Error(`智能体 ${config.agentId} 未在编译资源中`);

  const { agent, tools } = resource;
  const llm = createModel(agent.model_name, Number(agent.temperature ?? 0.7), {
    streaming: false,
  });
  const mapped = resolveInputMap(state, config.inputMap);
  const mappedJson =
    Object.keys(mapped).length > 0 ? JSON.stringify(mapped, null, 2) : "";
  const basePrompt =
    agent.system_prompt?.trim() ||
    "You are a helpful AI agent. Use tools when they improve the answer.";
  const system = mappedJson
    ? `${basePrompt}\n\n【工作流注入的结构化数据】\n${mappedJson}`
    : basePrompt;

  const reactAgent = createReactAgent({
    llm,
    tools: buildLangChainTools(tools),
    prompt: system,
  });

  const injected = mappedJson
    ? [new HumanMessage(`工作流上下文：\n${mappedJson}`)]
    : [];
  // isolated 不挂共享线程；createReactAgent 仍需要至少一轮 Human，没有 inputMap 就给一条无业务含义的种子。
  const inbound =
    messagesMode === "isolated"
      ? injected.length > 0
        ? injected
        : [new HumanMessage("请根据系统提示完成任务。")]
      : [...state.messages, ...injected];
  const result = await reactAgent.invoke({
    messages: inbound,
  });
  const text = lastAiText(result.messages as BaseMessage[]);
  const vars = { [config.outputKey]: text };
  if (messagesMode === "isolated") {
    return { vars };
  }
  const newMessages = result.messages.slice(
    state.messages.length
  ) as BaseMessage[];
  return {
    messages: newMessages,
    lastAgentText: text,
    vars,
  };
}

/**
 * HITL：interrupt 把表单描述抛给运行时；resume 值合并进 vars。
 * 不要把 interrupt 包进 try/catch —— 它靠抛 GraphInterrupt 暂停图，吃掉就无法挂起。
 */
function executeHumanReviewNode(
  state: WorkflowGraphState,
  config: HumanReviewNodeConfig,
  nodeId: string
): Partial<WorkflowGraphState> {
  console.log("executeHumanReviewNode", state);
  const resume = interrupt({
    nodeId,
    kind: "human_review" as const,
    title: config.title,
    form: config.formFields,
    snapshot: state.vars,
  });
  console.log("executeHumanReviewNode2", resume);
  const patch =
    resume && typeof resume === "object" && !Array.isArray(resume)
      ? (resume as Record<string, unknown>)
      : { decision: resume };
  return { vars: patch };
}

/**
 * 赋值节点：表达式沙箱与条件节点相同，失败必须抛出。
 * 不 catch 成跳过某个 key，否则 round 停在旧值会死循环。
 */
async function executeAssignNode(
  state: WorkflowGraphState,
  config: AssignNodeConfig
): Promise<Partial<WorkflowGraphState>> {
  return { vars: evaluateAssignSets(config.sets, state) };
}

/**
 * 条件节点只负责算出 `_route`。真正的跳转在 addConditionalEdges 的 path 里读这个字段。
 *
 * LLM 模式把调用放在节点内而不是 path 回调里：path 在 LangGraph 里也可以 async，
 * 但条件计算一旦塞进边，stream 的 updates 就看不到「这个节点跑了一次路由」。
 */
async function executeConditionNode(
  state: WorkflowGraphState,
  config: ConditionNodeConfig,
  createModel: typeof createChatModel
): Promise<Partial<WorkflowGraphState>> {
  console.log("executeConditionNode", state);
  const keys = config.branches.map((branch) => branch.key);
  if (config.mode === "expression") {
    return {
      _route: evaluateExpressionRoute(
        config.expression,
        state,
        keys,
        config.defaultBranch
      ),
    };
  }

  const llm = createModel(config.modelName, config.temperature ?? 0, {
    streaming: false,
  });
  const snapshot = JSON.stringify(
    { vars: state.vars, lastAgentText: state.lastAgentText },
    null,
    2
  );
  const response = await llm.invoke([
    new SystemMessage(
      `你是工作流路由器。只能输出一个分支 key，必须是以下之一：${keys.join("、")}。不要输出解释、标点或 Markdown。无法判断时输出 ${config.defaultBranch}。`
    ),
    new HumanMessage(`${config.prompt}\n\n当前 state 快照：\n${snapshot}`),
  ]);
  return {
    _route: pickBranchKey(
      messageContentToText(response.content),
      keys,
      config.defaultBranch
    ),
  };
}

/**
 * 把 WorkflowDocument 编成可 invoke 的 LangGraph。
 *
 * 入参：画布文档；可选 checkpointer / 预加载的 agents·tools（单测注入，避免打库）。
 * 出参：`ok` 时带 compiled app；失败带回 schema/引用错误，不抛半成品图。
 * 步骤：compile 档校验 → 解析引用 → 注册非 start/end 节点（Fork/Join 恒等，Assign 写 vars，区内 Agent isolated）→
 * lane/普通边 addEdge、Join 数组屏障、条件边 addConditionalEdges → compile。
 */
export async function compileWorkflow(
  input: unknown,
  options: CompileOptions = {}
): Promise<CompileResult> {
  const parsed = parseWorkflowDocument(input, "compile");
  if (!parsed.ok) return parsed;

  const doc = parsed.document;
  const resources =
    options.resources ?? (await loadResources(doc, options.userId));
  const missing = missingResourceErrors(doc, resources);
  if (missing.length > 0) return { ok: false, errors: missing };

  const hasHitl = doc.nodes.some((node) => node.data.kind === "human_review");
  // interrupt 依赖 checkpointer 把挂起态写回去；缺 saver 时 resume 永远对不上。
  // dry-run 不 invoke、不 resume，只确认节点/边能编进 StateGraph，因此跳过这条运行时门闩。
  if (hasHitl && !options.checkpointer && !options.dryRun) {
    return {
      ok: false,
      errors: [
        {
          message: "人工审核节点需要 checkpointer，否则 interrupt 无法恢复",
          path: ["nodes"],
        },
      ],
    };
  }

  const createModel = options.createModel ?? createChatModel;
  const ends = endNodeIds(doc);
  const isolatedNodeIds = regionInteriorNodeIds(doc);
  const graph = new StateGraph(WorkflowGraphAnnotation);
  // 节点 id 来自用户 DSL，TS 无法在循环里把 StateGraph 的 N 联合类型扩宽，边只能走宽松 builder。
  type GraphBuilder = {
    addNode: (
      id: string,
      fn: (
        state: typeof WorkflowGraphAnnotation.State
      ) => Promise<Partial<WorkflowGraphState>>
    ) => void;
    addEdge: (source: string | string[], target: string) => void;
    addConditionalEdges: (
      source: string,
      path: (state: typeof WorkflowGraphAnnotation.State) => string,
      pathMap: Record<string, string>
    ) => void;
    compile: (opts?: {
      checkpointer?: BaseCheckpointSaver | false;
    }) => CompiledWorkflowApp;
  };
  const builder = graph as unknown as GraphBuilder;

  for (const node of doc.nodes) {
    const { data } = node;
    if (data.kind === "start" || data.kind === "end") continue;

    builder.addNode(node.id, async (rawState) => {
      const state = asGraphState(rawState);
      const messagesMode: AgentMessagesMode = isolatedNodeIds.has(node.id)
        ? "isolated"
        : "inherit";
      switch (data.kind) {
        case "tool":
          return executeToolNode(state, data.config, resources, messagesMode);
        case "agent":
          return executeAgentNode(
            state,
            data.config,
            resources,
            createModel,
            messagesMode
          );
        case "human_review":
          return executeHumanReviewNode(state, data.config, node.id);
        case "condition":
          return executeConditionNode(state, data.config, createModel);
        case "assign":
          return executeAssignNode(state, data.config);
        case "fork":
        case "join":
          // 恒等：控制流只靠边。Join 的 AND 汇合来自数组 addEdge 的 NamedBarrierValue，节点本身不能写业务。
          return {};
        default: {
          const _exhaustive: never = data;
          return _exhaustive;
        }
      }
    });
  }

  for (const edge of collectStaticControlEdges(doc)) {
    builder.addEdge(edge.source, edge.target);
  }

  for (const node of doc.nodes) {
    if (node.data.kind !== "condition") continue;
    const pathMap = buildBranchPathMap(doc.edges, node.id, ends);
    const fallback = node.data.config.defaultBranch;
    // path 只读 _route：LLM/表达式已经在条件节点里跑完。缺省时用 defaultBranch，
    // 防止模型空输出或表达式抛错后 path 返回未知 key 把图卡住。
    builder.addConditionalEdges(
      node.id,
      (rawState) => {
        const key = asGraphState(rawState)._route;
        const keys = Object.keys(pathMap);
        if (key && keys.includes(key)) return key;
        return fallback;
      },
      pathMap
    );
  }

  const app = builder.compile({
    checkpointer: options.checkpointer,
  });

  return { ok: true, document: doc, app };
}

/**
 * dry-run：只验证「能编出图」，不 invoke、不把 StateGraph 塞进 JSON。
 * 校验/发布 API 走这条，避免把不可序列化的 compiled app 返回给浏览器。
 */
export async function dryRunCompile(
  input: unknown,
  options: CompileOptions = {}
): Promise<
  { ok: true; nodeCount: number; edgeCount: number } | CompileFailure
> {
  const result = await compileWorkflow(input, { ...options, dryRun: true });
  if (!result.ok) return result;
  return {
    ok: true,
    nodeCount: result.document.nodes.length,
    edgeCount: result.document.edges.length,
  };
}

/** 与骨架同名的入口，方便 API 层直接 `compile(doc)`。 */
export async function compile(
  input: unknown,
  options: CompileOptions = {}
): Promise<CompileResult> {
  return compileWorkflow(input, options);
}

export { START, END };
