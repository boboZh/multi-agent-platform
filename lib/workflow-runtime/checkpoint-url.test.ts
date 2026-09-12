import { describe, expect, it } from "vitest";
import {
  resolveCheckpointDatabaseUrl,
  workflowPgSsl,
} from "@/lib/workflow-runtime/checkpoint-url";

describe("resolveCheckpointDatabaseUrl", () => {
  it("三个键都缺失或空字符串时返回 null，避免用脏 URI 连库", () => {
    expect(resolveCheckpointDatabaseUrl({})).toBeNull();
    expect(
      resolveCheckpointDatabaseUrl({
        DATABASE_URL: "",
        SUPABASE_DB_URL: "   ",
        WORKFLOW_CHECKPOINT_DATABASE_URL: undefined,
      }),
    ).toBeNull();
  });

  it("非字符串的 env 值直接跳过，防止把对象塞进 pg Pool", () => {
    expect(
      resolveCheckpointDatabaseUrl({
        DATABASE_URL: { host: "x" } as unknown as string,
        SUPABASE_DB_URL: "postgresql://ok",
      }),
    ).toBe("postgresql://ok");
    expect(resolveCheckpointDatabaseUrl(null as unknown as Record<string, string | undefined>)).toBeNull();
  });

  it("独立 WORKFLOW_CHECKPOINT_DATABASE_URL 优先于通用 DATABASE_URL", () => {
    expect(
      resolveCheckpointDatabaseUrl({
        WORKFLOW_CHECKPOINT_DATABASE_URL: " postgresql://wf ",
        DATABASE_URL: "postgresql://generic",
        SUPABASE_DB_URL: "postgresql://sb",
      }),
    ).toBe("postgresql://wf");
  });
});

describe("workflowPgSsl", () => {
  it("空串和本地 URI 不强制 SSL", () => {
    expect(workflowPgSsl("")).toBeUndefined();
    expect(workflowPgSsl("postgresql://postgres@localhost:5432/db")).toBeUndefined();
  });

  it("Supabase 主机必须 SSL，否则直连会被拒绝", () => {
    expect(
      workflowPgSsl("postgresql://postgres@db.abc.supabase.co:5432/postgres"),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("显式 sslmode=require 时同样打开 TLS", () => {
    expect(
      workflowPgSsl("postgresql://u:p@host:5432/db?sslmode=require"),
    ).toEqual({ rejectUnauthorized: false });
  });
});
