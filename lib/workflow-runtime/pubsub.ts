import type { BufferedSseEvent } from "@/lib/workflow-runtime/sse";
import { isWorkflowSseEvent } from "@/lib/workflow-runtime/sse";

/** 每条 run 一个频道：引擎 PUBLISH，SSE 只 SUBSCRIBE，互不共用 Redis 连接。 */
export function runEventChannel(runId: string) {
  return `wf:sse:${runId}:pub`;
}

/**
 * 入参：Pub/Sub 原文。出参：合法缓冲帧，脏数据丢弃。
 * 步骤：JSON.parse → 校验单调 id → 校验 WorkflowSseEvent。
 * 拒绝非法帧是为了避免一条坏消息把整条 SSE 订阅者打崩。
 */
export function parsePublishedSse(raw: unknown): BufferedSseEvent | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as { id?: unknown; event?: unknown };
  if (typeof rec.id !== "number" || !Number.isInteger(rec.id) || rec.id < 1) {
    return null;
  }
  if (!isWorkflowSseEvent(rec.event)) return null;
  return { id: rec.id, event: rec.event };
}

/**
 * Last-Event-ID 断点：只转发 id 更大的帧，并按 id 排序。
 * 乱序到达时仍保证前端动画按序号衔接；id 相等视为已送达，避免重放。
 */
export function selectSseAfter(
  rows: unknown,
  lastId: number,
): BufferedSseEvent[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const cursor =
    typeof lastId === "number" && Number.isFinite(lastId) && lastId > 0
      ? lastId
      : 0;
  const out: BufferedSseEvent[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as { id?: unknown; event?: unknown };
    if (typeof rec.id !== "number" || !Number.isInteger(rec.id) || rec.id <= cursor) {
      continue;
    }
    if (!isWorkflowSseEvent(rec.event)) continue;
    out.push({ id: rec.id, event: rec.event });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}
