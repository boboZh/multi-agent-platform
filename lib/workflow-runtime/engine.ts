import { after } from "next/server";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";
import type { FlowRunRow } from "@/lib/workflow-dsl/tables";
import {
  releaseRunLock,
  tryAcquireRunLock,
  type PendingRunCommand,
} from "@/lib/workflow-runtime/buffer";
import { executeWorkflowRun } from "@/lib/workflow-runtime/runner";

export type EngineKickoff = {
  run: FlowRunRow;
  dsl: WorkflowDocument;
  command: PendingRunCommand;
  userId: string;
};

/**
 * 控制面在响应返回后拉起引擎：抢 run 锁 → LangGraph streamEvents → 事件走 Redis Pub/Sub。
 * 入参：已落库的 flow_runs 行 + 发布快照 DSL + start/resume/retry 命令。
 * 出参：无；失败只打日志，状态由 executeWorkflowRun 写成 failed。
 * 锁失败说明另一路已经在跑，绝不能再 invoke，否则同一 thread_id 双跑。
 */
export async function startWorkflowEngine(options: EngineKickoff) {
  const { run, dsl, command, userId } = options;
  const locked = await tryAcquireRunLock(run.id);
  if (!locked) return;
  try {
    await executeWorkflowRun({ run, dsl, command, userId });
  } catch (error) {
    console.error("[workflow-engine]", run.id, error);
  } finally {
    await releaseRunLock(run.id);
  }
}

/**
 * POST run/resume/retry 用：先返回 200，真正的LangGraph执行（可能很久，会调LLM）放到after() 里再 invoke，避免API被引擎拖死。
 * 只调度一次；重复 kick 会在锁释放后把同一 thread 再跑一遍。
 * after：把回调推迟到当前HTTP响应结束之后再执行,避免响应发出后任务被立刻掐掉。(Next.js 部署在 serverless 上响应一结束，运行时就可以冻结这次调用。前面随手丢出去的 startWorkflowEngine 可能刚开始调模型就被掐断。after 把这段工作登记成「响应之后还要做完」，平台会用 waitUntil 把实例留到它结束，用户这边已经拿到响应了。)
 * after 只能在请求上下文里用，若在请求作用域外调用会抛错
 */
export function scheduleWorkflowEngine(options: EngineKickoff) {
  try {
    after(() => {
      void startWorkflowEngine(options);
    });
  } catch {
    void startWorkflowEngine(options);
  }
}
