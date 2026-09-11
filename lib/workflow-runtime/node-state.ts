export type NodeStateView = {
  vars: Record<string, unknown>;
  lastAgentText: string;
  messagesPreview: string[];
  checkpointTs?: string;
};

type HistorySnap = {
  values?: {
    vars?: Record<string, unknown>;
    lastAgentText?: string;
    messages?: unknown;
  };
  metadata?: {
    writes?: Record<string, unknown> | null;
    created_at?: string;
  } & Record<string, unknown>;
  createdAt?: string;
};

function previewMessages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-8)
    .map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const rec = item as { content?: unknown; type?: string };
      const content =
        typeof rec.content === "string"
          ? rec.content
          : rec.content == null
            ? ""
            : JSON.stringify(rec.content);
      return content.slice(0, 500);
    })
    .filter((text) => text.length > 0);
}

function viewFromValues(
  values: HistorySnap["values"],
  checkpointTs?: string,
): NodeStateView {
  return {
    vars: (values?.vars as Record<string, unknown> | undefined) ?? {},
    lastAgentText:
      typeof values?.lastAgentText === "string" ? values.lastAgentText : "",
    messagesPreview: previewMessages(values?.messages),
    checkpointTs,
  };
}

/**
 * 从 history（新→旧）里找该节点最后一次 writes 之后的 channel 快照。
 * 从未执行返回 null，API 层转成 200 + state:null，避免前端当 404。
 */
export function nodeStateFromHistory(
  snapshots: HistorySnap[],
  nodeId: string,
): NodeStateView | null {
  if (!nodeId.trim()) return null;
  for (const snap of snapshots) {
    const writes = snap.metadata?.writes;
    if (writes && Object.prototype.hasOwnProperty.call(writes, nodeId)) {
      return viewFromValues(
        snap.values,
        snap.createdAt ??
          (typeof snap.metadata?.created_at === "string"
            ? snap.metadata.created_at
            : undefined),
      );
    }
  }
  return null;
}
