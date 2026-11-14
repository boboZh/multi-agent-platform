import { createRedisSubscriber } from "@/lib/redis";
import {
  jsonError,
  issue,
  mockUserId,
  sseHeaders,
} from "@/lib/workflow-runtime/http";
import { readSseBufferAfter } from "@/lib/workflow-runtime/buffer";
import { listPersistedEvents, loadFlowRun } from "@/lib/workflow-runtime/persist";
import {
  parsePublishedSse,
  runEventChannel,
  mergeSseReplay,
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
 * SSE 只做 Redis 订阅者：先订阅暂存实时帧 → 回放快照并合并 → 实时转推。
 * 绝对不在这里 compile / invoke / streamEvents，否则控制流和执行流重新绑死。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const userId = mockUserId();
  const lookupStartedAt = performance.now();
  let run;
  try {
    // SSE 只需要校验所属用户和运行状态，不加载 DSL、版本和名称，减少首字前的跨区查询。
    run = await loadFlowRun(id, userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "读取运行失败";
    return jsonError([issue(message)], 500);
  }
  if (!run) {
    return jsonError([issue("运行不存在", ["id"])], 404);
  }
  const runStatus = run.status;

  // 原生的 EventSource 浏览器 API 断线重连时会带上 Last-Event-ID 请求头；但如果是前端用 fetch 手动接管流，通常会拼在 URL 参数 ?after= 里。这里取两者的最大值，确保绝对拿到最新的游标（Cursor）。
  const lastEventId = Math.max(
    parseLastEventId(request.headers.get("last-event-id")),
    parseLastEventId(new URL(request.url).searchParams.get("after"))
  );
  const encoder = new TextEncoder();
  const lookupMs = performance.now() - lookupStartedAt;
  const channel = runEventChannel(id);
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 鉴权完成即发注释帧，让响应头先抵达浏览器，不等 Redis 握手和回放才开始响应。
      controller.enqueue(encoder.encode(": connected\n\n"));
      let cursor = lastEventId;
      let closed = false;
      let sentDone = false;
      let subscriber: ReturnType<typeof createRedisSubscriber> | null = null;

      const send = (row: BufferedSseEvent) => {
        if (closed || canceled || row.id <= cursor) return;
        cursor = row.id;
        if (row.event.type === "done") sentDone = true;
        controller.enqueue(encoder.encode(encodeWorkflowSse(row)));
      };

      const closeStream = () => {
        if (closed || canceled) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已断开
        }
      };

      try {
        // 必须先订阅再回放，否则首批正文后会停在 SUBSCRIBE 握手，随后补发成大块。
        // 回放完成前禁止实时帧推进 cursor，避免新 ID 把旧快照中的帧挤掉。
        let replaying = true;
        const pending: BufferedSseEvent[] = [];
        if (!isTerminalStatus(runStatus)) {
          subscriber = createRedisSubscriber();
          subscriber.on("message", (_ch: string, message: string) => {
            if (closed || canceled) return;
            const parsed = parsePublishedSse(message);
            if (!parsed) return;
            if (replaying) {
              pending.push(parsed);
              return;
            }
            send(parsed);
            if (parsed.event.type === "done") closeStream();
          });
          await subscriber.subscribe(channel);
        }

        const buffered = await readSseBufferAfter(id, cursor);
        for (const row of mergeSseReplay(buffered, pending, cursor)) send(row);
        // 持久化兜底：Redis 缓冲过期时，仅在从头连接（cursor 仍为 0）才回放 Postgres 粗事件。
        if (cursor === 0) {
          const persisted = await listPersistedEvents(id);
          for (const row of mergeSseReplay(
            persisted.map((row) => ({ id: row.seq, event: row.event })),
            pending,
            cursor,
          )) {
            send(row);
          }
        }
        // 最后一次 await 期间也可能积累实时帧；同步清空后切换，没有漏帧窗口。
        for (const row of mergeSseReplay([], pending, cursor)) send(row);
        pending.length = 0;
        replaying = false;

        // 避免幽灵连接
        if (sentDone || isTerminalStatus(runStatus)) {
          if (!sentDone) {
            send({ id: cursor + 1, event: { type: "done" } });
          }
          closeStream();
          return;
        }

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
        if (!closed && !canceled) {
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
    cancel() {
      canceled = true;
    },
  });

  return new Response(stream, {
    headers: { ...sseHeaders(), "Server-Timing": `run_lookup;dur=${lookupMs.toFixed(1)}` },
  });
}
