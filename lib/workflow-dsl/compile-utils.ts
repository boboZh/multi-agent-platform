import { Parser } from "expr-eval";
import { END, START } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { WorkflowDocument, WorkflowEdge } from "@/lib/workflow-dsl/schema";

/**
 * 编译器读到的运行时 state。
 * vars 用 reducer 做浅合并，所以节点只返回增量（`{ vars: { k: v } }`），不要把整个 vars 再铺回去，
 * 否则和 reducer 叠一次会让「删字段」这种操作无法表达。
 */
export type WorkflowGraphState = {
  messages: BaseMessage[];
  vars: Record<string, unknown>;
  lastAgentText: string;
  _route: string;
};

/** 与画布 inputMap 提示同一套形状：必须以 `state.` 开头，只允许标识符和下标。 */
export const STATE_PATH_RE = /^state(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])+$/;

/**
 * 按 `state.vars.order_id` / `state.messages[0]` 从运行时 state 取值。
 *
 * 入参：`graphState` — LangGraph 节点看到的 state；`path` — inputMap 的来源字符串。
 * 出参：路径上的值；路径非法或中途断开时返回 undefined（不要抛，让节点自己决定缺参怎么处理）。
 *
 * 不用 expr-eval / eval：inputMap 是用户可填的自由文本，求值器会把取值变成任意代码执行。
 * 这里只认点号和数字下标，和编辑器里的「可疑路径」黄字是同一套约束。
 */
export function resolveStatePath(
  graphState: WorkflowGraphState,
  path: string
): unknown {
  const trimmed = path.trim();
  // 如果用户输入了类似 state.vars.id + 1 这种带运算符的非法表达式，或者根本不是以 state 开头，直接返回 undefined，将恶意注入扼杀在摇篮里
  if (!STATE_PATH_RE.test(trimmed)) return undefined;

  // 提取合法的变量名和数字下标
  const tokens = trimmed.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) ?? [];
  // 对齐GraphState state.messages state.vars
  let current: unknown = { state: graphState };
  // 根据索引逐层取值
  for (const token of tokens) {
    // 运行时空指针守卫
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/**
 * 把 inputMap 展开成工具入参 / 注入给智能体的变量袋。
 * 缺路径的键仍会出现，值为 undefined —— 调用方能区分「没配这个键」和「配了但 state 里没有」。
 */
export function resolveInputMap(
  graphState: WorkflowGraphState,
  inputMap: Record<string, string> | undefined
): Record<string, unknown> {
  if (!inputMap) return {};
  const resolved: Record<string, unknown> = {};
  for (const [target, source] of Object.entries(inputMap)) {
    resolved[target] = resolveStatePath(graphState, source);
  }
  return resolved;
}

export function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("")
    .trim();
}

export function lastAiText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message._getType() === "ai") {
      return messageContentToText(message.content);
    }
  }
  return "";
}

/**
 * 从模型自由文本里抠出分支 key。
 *
 * 模型经常会输出 `yes.`、`分支：no`、前后空格；如果只做全等，几乎每次都掉进 defaultBranch，
 * 条件节点看起来像「LLM 路由没生效」。这里按从宽到严：整段 → 首 token → 独立单词命中。
 * 多个 key 同时出现时取列表里更靠前的（与 branches 声明顺序一致），避免随机。
 */
export function pickBranchKey(
  raw: string,
  keys: string[],
  fallback: string
): string {
  // 去掉首尾的换行、空格、引号
  const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (keys.includes(trimmed)) return trimmed;

  // 取第一个单词，把标点符号去掉
  const firstToken = trimmed
    .split(/\s+/)[0]
    ?.replace(/[.,;:!?。，；：！？]/g, "");
  if (firstToken && keys.includes(firstToken)) return firstToken;

  for (const key of keys) {
    // 把 key 转成正则表达式，避免特殊字符干扰（如用户定义的key中有正则特殊字符）
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // \b 表示单词边界，避免匹配到单词内部。找一个独立的单词
    if (new RegExp(`(?:^|\\b)${escaped}(?:\\b|$)`).test(trimmed)) return key;
  }
  return fallback;
}

/** 布尔真对应的分支同义词；只认这些，避免把任意非空字符串当成 yes。 */
const TRUTHY_BRANCH_ALIASES = new Set(["yes", "true", "1"]);
const FALSY_BRANCH_ALIASES = new Set(["no", "false", "0"]);

function isBooleanBit(value: unknown): value is boolean | 0 | 1 {
  return value === true || value === false || value === 0 || value === 1;
}

/**
 * 把表达式求值结果对齐到某个 branch key。
 * 入参：expr-eval 的 result、当前节点分支、兜底 key。
 * 步骤：字符串（含大小写差）精确匹配分支 → 仅布尔/0/1 走 yes|true|1 与 no|false|0 → 其余 default。
 * 同义词按 branches 声明顺序取第一个，避免 yes/true 并存时随机。
 */
export function pickExpressionBranchKey(
  result: unknown,
  branchKeys: string[],
  defaultBranch: string
): string {
  if (!Array.isArray(branchKeys) || branchKeys.length === 0) {
    return defaultBranch;
  }

  if (typeof result === "string") {
    if (branchKeys.includes(result)) return result;
    const lowered = result.trim().toLowerCase();
    if (lowered) {
      const hit = branchKeys.find((key) => key.toLowerCase() === lowered);
      if (hit) return hit;
    }
  }

  if (isBooleanBit(result)) {
    const aliases =
      result === true || result === 1
        ? TRUTHY_BRANCH_ALIASES
        : FALSY_BRANCH_ALIASES;
    const hit = branchKeys.find((key) => aliases.has(key.toLowerCase()));
    if (hit) return hit;
  }

  return defaultBranch;
}

/**
 * 表达式路由。
 *
 * 入参：DSL 上的 expression、当前 state、分支 key 列表、兜底分支。
 * 出参：某个 branch key。
 * 步骤：把 `===` 换成 expr-eval 能认的 `==` → 以 `{ state }` 为上下文求值 →
 * 字符串若是合法 key 则采用 → 布尔/0/1 映射到 yes|true|1 / no|false|0 → 其余 defaultBranch。
 *
 * 画布默认表达式写的是 `===`，而 expr-eval 不认严格相等；静默替换是为了让默认草稿能跑，
 * 不是为了支持任意 JS。求值失败同样回落 defaultBranch，避免把一次脏表达式变成整图崩溃。
 */
export function evaluateExpressionRoute(
  expression: string,
  graphState: WorkflowGraphState,
  branchKeys: string[],
  defaultBranch: string
): string {
  // 语法降级，底层的解析库 expr-eval 是一个偏向数学逻辑的求值引擎，它只认识 == !=
  const normalized = expression.replaceAll("===", "==").replaceAll("!==", "!=");
  try {
    const parser = new Parser();
    // 上下文沙箱隔离。只把纯粹的 JSON 数据（vars、lastAgentText、_route）暴露给表达式去读取，
    // expr-eval 的 Value 不能装 BaseMessage；
    // expr-eval 处理不了复杂的类实例（比如 LangChain 的 BaseMessage 对象）。如果把整个 graphState 塞进去，求值器会崩溃。
    // 表达式只该读 vars / lastAgentText，消息列表不进求值上下文。
    const result = parser.parse(normalized).evaluate({
      state: {
        vars: graphState.vars,
        lastAgentText: graphState.lastAgentText,
        _route: graphState._route,
      },
    } as never);
    return pickExpressionBranchKey(result, branchKeys, defaultBranch);
  } catch {
    return defaultBranch;
  }
}

export function graphSourceId(
  nodeId: string,
  startNodeId: string
): typeof START | string {
  return nodeId === startNodeId ? START : nodeId;
}

export function graphTargetId(
  nodeId: string,
  endIds: ReadonlySet<string>
): typeof END | string {
  return endIds.has(nodeId) ? END : nodeId;
}

/**
 * 条件节点的 pathMap：key = branchKey，value = LangGraph 目标（节点 id 或 END）。
 *
 * 必须用边的 data.branchKey，而不是假设只有 yes/no —— 用户可以叫 approve/reject。
 * 同一 key 多条边时后者覆盖：schema 的 compile 档会拦，这里再兜一次以免半成品文档把 compile 打崩。
 */
export function buildBranchPathMap(
  edges: WorkflowEdge[],
  sourceId: string,
  endIds: ReadonlySet<string>
): Record<string, typeof END | string> {
  const pathMap: Record<string, typeof END | string> = {};
  for (const edge of edges) {
    if (edge.source !== sourceId || edge.data.kind !== "branch") continue;
    pathMap[edge.data.branchKey] = graphTargetId(edge.target, endIds);
  }
  return pathMap;
}

export function endNodeIds(doc: WorkflowDocument): Set<string> {
  return new Set(
    doc.nodes.filter((node) => node.data.kind === "end").map((node) => node.id)
  );
}
