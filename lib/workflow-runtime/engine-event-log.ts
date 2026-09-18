import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import type { PendingRunCommand } from "@/lib/workflow-runtime/buffer";

const INSPECT_OPTIONS = {
  // 默认 depth=2 会把 messages 收成 [Array]/[Object]，调试并行 reduce 时必须看到叶子字段。
  depth: null,
  maxArrayLength: null,
  maxStringLength: null,
  compact: false,
  breakLength: 120,
} as const;

/**
 * 把 streamEvents 单条事件展开成完整文本。
 * 入参：LangGraph v2 StreamEvent 或任意嵌套值。
 * 出参：util.inspect 字符串（含循环引用标记，不截断数组/对象）。
 */
export function formatEngineEventDump(raw: unknown): string {
  return inspect(raw, INSPECT_OPTIONS);
}

/**
 * 文件名只保留安全字符：run.id 理论上是 UUID，但必须挡住 `../` 写到仓库外。
 */
export function sanitizeEngineEventLogRunId(runId: unknown): string {
  if (typeof runId !== "string" || !runId.trim()) return "unknown-run";
  const cleaned = runId
    .trim()
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown-run";
}

/** ISO 里的 `:` 在部分环境不能当文件名，统一换成 `-`。 */
export function formatEngineEventLogStamp(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    return "invalid-time";
  }
  return at.toISOString().replaceAll(":", "-");
}

export function buildEngineEventLogFileName(runId: unknown, at: Date): string {
  return `${sanitizeEngineEventLogRunId(runId)}-${formatEngineEventLogStamp(at)}.log`;
}

export type EngineEventLog = {
  filePath: string;
  write: (index: number, raw: unknown) => Promise<void>;
  close: () => Promise<void>;
};

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * 打开本次 execute 的 dump 文件（resume/retry 另开新文件，避免和上一轮混在一起）。
 * 写失败只吞掉，不能把正在跑的图杀掉。
 */
export async function openEngineEventLog(options: {
  runId: string;
  threadId: string;
  commandKind: PendingRunCommand["kind"];
  startedAt?: Date;
}): Promise<EngineEventLog | null> {
  const startedAt = options.startedAt ?? new Date();
  const dir = path.join(process.cwd(), "logs");
  const filePath = path.join(
    dir,
    buildEngineEventLogFileName(options.runId, startedAt)
  );

  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return null;
  }

  const stream = createWriteStream(filePath, { flags: "w" });
  const header = [
    `# runId=${options.runId}`,
    `# thread_id=${options.threadId}`,
    `# command=${options.commandKind}`,
    `# startedAt=${startedAt.toISOString()}`,
    "",
  ].join("\n");

  try {
    await writeChunk(stream, header);
  } catch {
    stream.destroy();
    return null;
  }

  return {
    filePath,
    write: async (index, raw) => {
      const rec =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const name = rec && "name" in rec ? String(rec.name ?? "") : "";
      const event = rec && "event" in rec ? String(rec.event ?? "") : "";
      try {
        const block = [
          `----- index=${index} event=${event} name=${name} -----`,
          formatEngineEventDump(raw),
          "",
          "",
        ].join("\n");
        await writeChunk(stream, block);
      } catch {
        // dump 丢一条不应中断引擎
      }
    },
    close: () =>
      new Promise((resolve) => {
        stream.end(() => resolve());
      }),
  };
}
