import { jsonError, issue, mockUserId, sseHeaders } from "@/lib/workflow-runtime/http";
import { loadRunWithDsl } from "@/lib/workflow-runtime/load-run";
import {
  readSseBufferAfter,
  releaseRunLock,
  takePendingCommand,
  tryAcquireRunLock,
} from "@/lib/workflow-runtime/buffer";
import { listPersistedEvents } from "@/lib/workflow-runtime/persist";
import { executeWorkflowRun, isTerminalStatus } from "@/lib/workflow-runtime/runner";
import {
  encodeWorkflowSse,
  parseLastEventId,
  type BufferedSseEvent,
} from "@/lib/workflow-runtime/sse";

export const runtime = "nodejs";
export const maxDuration = 60;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SSE：先按 Last-Event-ID 回放 Redis（token 在这里），缓冲空则回放 Postgres 粗事件。
 * 抢到锁且有 pending 命令时才真正 invoke，其它连接只跟缓冲，避免双跑。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const userId = mockUserId();
  let loaded;
  try {
    loaded = await loadRunWithDsl(id, userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取运行失败";
    return jsonError([issue(message)], 500);
  }
  if (!loaded) {
    return jsonError([issue("运行不存在", ["id"])], 404);
  }

  const lastEventId = Math.max(
    parseLastEventId(request.headers.get("last-event-id")),
    parseLastEventId(new URL(request.url).searchParams.get("after")),
  );
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (row: BufferedSseEvent) => {
        controller.enqueue(encoder.encode(encodeWorkflowSse(row)));
      };

      try {
        let cursor = lastEventId;
        const buffered = await readSseBufferAfter(id, cursor);
        if (buffered.length > 0) {
          for (const row of buffered) {
            send(row);
            cursor = row.id;
          }
        } else if (cursor === 0) {
          const persisted = await listPersistedEvents(id);
          for (const row of persisted) {
            send({ id: row.seq, event: row.event });
            cursor = Math.max(cursor, row.seq);
          }
        }

        const locked = await tryAcquireRunLock(id);
        let executing: Promise<unknown> | null = null;
        if (locked) {
          const fresh = await loadRunWithDsl(id, userId);
          const command =
            (await takePendingCommand(id)) ??
            (fresh?.run.status === "pending"
              ? {
                  kind: "start" as const,
                  input: (fresh.run.input ?? {}) as {
                    messages?: unknown[];
                    vars?: Record<string, unknown>;
                  },
                }
              : null);
          if (fresh && command) {
            executing = executeWorkflowRun({
              run: fresh.run,
              dsl: fresh.dsl,
              command,
              userId,
            }).finally(() => {
              void releaseRunLock(id);
            });
          } else {
            await releaseRunLock(id);
          }
        }

        const deadline = Date.now() + 55_000;
        while (Date.now() < deadline) {
          const more = await readSseBufferAfter(id, cursor);
          for (const row of more) {
            send(row);
            cursor = row.id;
          }
          if (more.some((row) => row.event.type === "done")) {
            break;
          }
          const latest = await loadRunWithDsl(id, userId);
          if (
            latest &&
            isTerminalStatus(latest.run.status) &&
            more.length === 0
          ) {
            break;
          }
          if (executing) {
            const settled = await Promise.race([
              executing.then(() => "done" as const),
              sleep(350).then(() => "wait" as const),
            ]);
            if (settled === "done") {
              const tail = await readSseBufferAfter(id, cursor);
              for (const row of tail) {
                send(row);
                cursor = row.id;
              }
              break;
            }
          } else {
            await sleep(400);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "SSE 失败";
        controller.enqueue(
          encoder.encode(
            encodeWorkflowSse({
              id: lastEventId + 1,
              event: { type: "error", message },
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
