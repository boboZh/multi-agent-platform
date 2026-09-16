import { regionInteriorNodeIds } from "@/lib/workflow-dsl/fork-join-regions";
import { referencesLastAgentText } from "@/lib/workflow-dsl/fork-join-regions";
import { DEFAULT_AGENT_OUTPUT_KEY } from "@/lib/workflow-dsl/kinds";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";

/**
 * 抽屉用的并行区判定。必须和编译器 isolated 名单同一份 interior，
 * 否则会出现「抽屉不警告但 compile 失败」或反过来的假阳性。
 *
 * Fork / Join 本身不在 interior 里：它们是恒等节点，没有 inputMap / outputKey。
 * 配对尚未成功时 interior 为空——半成品图不该一拖进来就刷红。
 */
export function isParallelInteriorNode(
  doc: WorkflowDocument,
  nodeId: string,
): boolean {
  return regionInteriorNodeIds(doc).has(nodeId);
}

/**
 * 区内禁止把输出写进默认的 lastAgentText：N 路同时写时下游拿到的是节点 id 字典序最大的那一路。
 * `undefined` / 空串表示 Tool 选择不写回，那是合法的，不按默认 key 处理。
 */
export function parallelOutputKeyWarning(
  outputKey: string | undefined,
): string | null {
  if (!outputKey) return null;
  if (outputKey === DEFAULT_AGENT_OUTPUT_KEY) {
    return "并行区内不能使用默认输出键 lastAgentText，请改成独立的 vars key。";
  }
  return null;
}

/** 区内不再写入共享 lastAgentText，inputMap 读它会拿到并行前的旧值或空串。 */
export function parallelInputMapSourceWarning(source: string): string | null {
  if (!source.trim()) return null;
  if (referencesLastAgentText(source)) {
    return "并行区内不能引用 state.lastAgentText，请改读 state.vars 里各通道自己的输出键。";
  }
  return null;
}
