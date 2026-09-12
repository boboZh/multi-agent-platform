import { createRedisSubscriber } from "@/lib/redis";
import {
  jsonError,
  issue,
  mockUserId,
  sseHeaders,
} from "@/lib/workflow-runtime/http";
import { loadRunWithDsl } from "@/lib/workflow-runtime/load-run";
import { readSseBufferAfter } from "@/lib/workflow-runtime/buffer";
import { listPersistedEvents } from "@/lib/workflow-runtime/persist";
import {
  parsePublishedSse,
  runEventChannel,
  selectSseAfter,
} from "@/lib/workflow-runtime/pubsub";
import { isTerminalStatus } from "@/lib/workflow-runtime/run-status";
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
 * SSE 只做 Redis 订阅者：Last-Event-ID 回放缓冲 → SUBSCRIBE 转推。
 * 绝对不在这里 compile / invoke / streamEvents，否则控制流和执行流重新绑死。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
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

  // 原生的 EventSource 浏览器 API 断线重连时会带上 Last-Event-ID 请求头；但如果是前端用 fetch 手动接管流，通常会拼在 URL 参数 ?after= 里。这里取两者的最大值，确保绝对拿到最新的游标（Cursor）。
  const lastEventId = Math.max(
    parseLastEventId(request.headers.get("last-event-id")),
    parseLastEventId(new URL(request.url).searchParams.get("after"))
  );
  const encoder = new TextEncoder();
  const channel = runEventChannel(id);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = lastEventId;
      let closed = false;
      let sentDone = false;
      let subscriber: ReturnType<typeof createRedisSubscriber> | null = null;

      const send = (row: BufferedSseEvent) => {
        if (closed || row.id <= cursor) return;
        cursor = row.id;
        if (row.event.type === "done") sentDone = true;
        controller.enqueue(encoder.encode(encodeWorkflowSse(row)));
      };

      const closeStream = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      };

      const replayBuffer = async () => {
        const buffered = await readSseBufferAfter(id, cursor);
        for (const row of selectSseAfter(buffered, cursor)) {
          send(row);
        }
      };

      try {
        await replayBuffer();
        // 持久化兜底：Redis 缓冲过期时，仅在从头连接（cursor 仍为 0）才回放 Postgres 粗事件。
        if (cursor === 0) {
          const persisted = await listPersistedEvents(id);
          for (const row of persisted) {
            send({ id: row.seq, event: row.event });
          }
        }
        // 避免幽灵连接
        if (isTerminalStatus(loaded.run.status)) {
          if (!sentDone) {
            send({ id: cursor + 1, event: { type: "done" } });
          }
          closeStream();
          return;
        }

        subscriber = createRedisSubscriber();
        await subscriber.subscribe(channel);
        subscriber.on("message", (_ch: string, message: string) => {
          const parsed = parsePublishedSse(message);
          if (!parsed) return;
          send(parsed);
          if (parsed.event.type === "done") {
            closeStream();
          }
        });

        // 订阅后再扫一遍列表，补上 SUBSCRIBE 握手窗口里漏掉的帧。
        await replayBuffer();

        // Vercel Serverless/Edge 默认的 HTTP 请求超时是 60 秒
        const deadline = Date.now() + 55_000;
        while (!closed && Date.now() < deadline) {
          if (request.signal.aborted) break;
          // 注释帧保活，避免空闲时浏览器把连接当死链打 onerror。
          controller.enqueue(encoder.encode(`: ping\n\n`));
          await sleep(15_000);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "SSE 失败";
        if (!closed) {
          controller.enqueue(
            encoder.encode(
              encodeWorkflowSse({
                id: lastEventId + 1,
                event: { type: "error", message },
              })
            )
          );
        }
      } finally {
        if (subscriber) {
          await subscriber.quit().catch(() => undefined);
        }
        closeStream();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}
