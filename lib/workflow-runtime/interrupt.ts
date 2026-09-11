import { isGraphInterrupt, type GraphInterrupt } from "@langchain/langgraph";
import type { FlowRunInterruptPayload } from "@/lib/workflow-dsl/tables";

/**
 * interrupt() 抛出的 value 必须带 nodeId，否则控制台不知道该高亮哪个审核节点。
 */
export function interruptPayloadFromValue(
  value: unknown,
): FlowRunInterruptPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const nodeId = typeof rec.nodeId === "string" ? rec.nodeId.trim() : "";
  if (!nodeId) return null;
  return {
    nodeId,
    kind: rec.kind === "debug" ? "debug" : "human_review",
    title: typeof rec.title === "string" ? rec.title : undefined,
    form: rec.form,
    snapshot:
      rec.snapshot && typeof rec.snapshot === "object" && !Array.isArray(rec.snapshot)
        ? (rec.snapshot as Record<string, unknown>)
        : undefined,
    resumeSchema:
      typeof rec.resumeSchema === "string" ? rec.resumeSchema : undefined,
  };
}

export function interruptPayloadFromError(
  err: unknown,
): FlowRunInterruptPayload | null {
  if (!isGraphInterrupt(err)) return null;
  const first = (err as GraphInterrupt).interrupts[0];
  return interruptPayloadFromValue(first?.value);
}

type TaskLike = {
  name?: string;
  interrupts?: Array<{ value?: unknown }>;
};

export function interruptPayloadFromState(state: {
  tasks?: TaskLike[];
}): FlowRunInterruptPayload | null {
  for (const task of state.tasks ?? []) {
    for (const item of task.interrupts ?? []) {
      const payload = interruptPayloadFromValue(item.value);
      if (payload) return payload;
      if (typeof task.name === "string" && task.name) {
        return { nodeId: task.name, kind: "human_review", form: item.value };
      }
    }
  }
  return null;
}
