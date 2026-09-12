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
 * POST run/resume/retry 用：先返回 200，after() 里再 invoke，避免控制接口被 LLM 拖死。
 * 只调度一次；重复 kick 会在锁释放后把同一 thread 再跑一遍。
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
