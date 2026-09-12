import { Pool } from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  resolveCheckpointDatabaseUrl,
  WORKFLOW_CHECKPOINT_SCHEMA,
  workflowPgSsl,
} from "@/lib/workflow-runtime/checkpoint-url";

const globalForWorkflowPg = global as unknown as {
  workflowCheckpointPool: Pool | undefined;
  workflowCheckpointer: PostgresSaver | undefined;
  workflowCheckpointerReady: Promise<PostgresSaver> | undefined;
};

function createPool(connectionString: string) {
  return new Pool({
    connectionString,
    // Next 路由并发不高，限制连接避免占满 Supabase 会话槽
    max: 8,
    ssl: workflowPgSsl(connectionString),
  });
}

/**
 * 工作流专用 Postgres checkpointer。Chat 继续用 Redis，禁止混 thread_id。
 * 入参：无（读 env）。出参：已 setup 的 PostgresSaver。
 * 步骤：解析 URI → 复用全局 Pool → PostgresSaver.setup 建 langgraph.checkpoints*。
 */
export async function getWorkflowCheckpointer(): Promise<PostgresSaver> {
  if (globalForWorkflowPg.workflowCheckpointer) {
    return globalForWorkflowPg.workflowCheckpointer;
  }
  if (globalForWorkflowPg.workflowCheckpointerReady) {
    return globalForWorkflowPg.workflowCheckpointerReady;
  }

  const url = resolveCheckpointDatabaseUrl(process.env);
  if (!url) {
    throw new Error(
      "缺少 DATABASE_URL（或 WORKFLOW_CHECKPOINT_DATABASE_URL / SUPABASE_DB_URL）。工作流 checkpoint 必须写 Postgres，不能再用 Redis。",
    );
  }

  globalForWorkflowPg.workflowCheckpointerReady = (async () => {
    const pool =
      globalForWorkflowPg.workflowCheckpointPool ?? createPool(url);
    globalForWorkflowPg.workflowCheckpointPool = pool;
    const saver = new PostgresSaver(pool, undefined, {
      schema: WORKFLOW_CHECKPOINT_SCHEMA,
    });
    await saver.setup();
    globalForWorkflowPg.workflowCheckpointer = saver;
    return saver;
  })();

  try {
    return await globalForWorkflowPg.workflowCheckpointerReady;
  } catch (error) {
    globalForWorkflowPg.workflowCheckpointerReady = undefined;
    throw error;
  }
}
