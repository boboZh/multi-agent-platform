/**
 * 解析工作流 checkpoint 用的 Postgres URI。
 * 入参：任意 env 字典（测试可注入，避免读 process.env）。
 * 出参：trim 后的连接串；三个键都空则 null。
 * 优先独立 URI，避免和以后可能出现的分析库 DATABASE_URL 抢同一个库。
 */
export function resolveCheckpointDatabaseUrl(
  env: Record<string, string | undefined>,
): string | null {
  if (!env || typeof env !== "object") return null;
  const keys = [
    "WORKFLOW_CHECKPOINT_DATABASE_URL",
    "DATABASE_URL",
    "SUPABASE_DB_URL",
  ] as const;
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const WORKFLOW_CHECKPOINT_SCHEMA = "langgraph";

/** Supabase 必须走 SSL；本地 docker 直连则不必。 */
export function workflowPgSsl(connectionString: string):
  | { rejectUnauthorized: boolean }
  | undefined {
  if (typeof connectionString !== "string" || !connectionString.trim()) {
    return undefined;
  }
  if (/supabase\.(co|com)/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  if (/sslmode=require/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}
