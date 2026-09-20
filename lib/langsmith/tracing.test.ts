import { describe, expect, it } from "vitest";
import {
  chatLangSmithConfig,
  isLangSmithTracingEnabled,
  workflowLangSmithConfig,
} from "@/lib/langsmith/tracing";

describe("isLangSmithTracingEnabled", () => {
  it("两个 tracing 开关都缺失或空字符串时必须关闭，避免测试误打云端", () => {
    expect(isLangSmithTracingEnabled({})).toBe(false);
    expect(
      isLangSmithTracingEnabled({
        LANGSMITH_TRACING: "",
        LANGCHAIN_TRACING_V2: "   ",
      })
    ).toBe(false);
  });

  it("非字符串或非 true 字面量一律视为关闭，防止对象/1 被当成开启", () => {
    expect(
      isLangSmithTracingEnabled({
        LANGSMITH_TRACING: "1",
        LANGCHAIN_TRACING_V2: "yes",
      })
    ).toBe(false);
    expect(
      isLangSmithTracingEnabled({
        LANGSMITH_TRACING: { on: true } as unknown as string,
      })
    ).toBe(false);
  });

  it("LANGSMITH_TRACING 或旧名 LANGCHAIN_TRACING_V2 为 true（忽略大小写）时开启", () => {
    expect(isLangSmithTracingEnabled({ LANGSMITH_TRACING: "true" })).toBe(true);
    expect(isLangSmithTracingEnabled({ LANGCHAIN_TRACING_V2: "TRUE" })).toBe(
      true
    );
    expect(
      isLangSmithTracingEnabled({
        LANGSMITH_TRACING: " false ",
        LANGCHAIN_TRACING_V2: " True ",
      })
    ).toBe(true);
  });
});

describe("workflowLangSmithConfig", () => {
  const run = {
    id: "run-1",
    flow_id: "flow-1",
    flow_version: 3,
    thread_id: "thread-1",
  };

  it("start 命令不写 checkpoint_id，防止空字段污染 LangSmith 过滤", () => {
    const cfg = workflowLangSmithConfig({
      run,
      command: { kind: "start", input: { vars: {} } },
      userId: "user-1",
    });
    expect(cfg.runName).toBe("workflow:start");
    expect(cfg.tags).toEqual(["workflow-engine", "start"]);
    expect(cfg.metadata).toEqual({
      surface: "workflow-engine",
      flow_run_id: "run-1",
      flow_id: "flow-1",
      flow_version: 3,
      thread_id: "thread-1",
      command: "start",
      user_id: "user-1",
    });
    expect(cfg.metadata).not.toHaveProperty("checkpoint_id");
  });

  it("retry 必须带上 checkpoint_id，才能和引擎 configurable 对齐", () => {
    const cfg = workflowLangSmithConfig({
      run,
      command: { kind: "retry", checkpointId: "ckpt-9" },
      userId: "user-1",
    });
    expect(cfg.runName).toBe("workflow:retry");
    expect(cfg.metadata.checkpoint_id).toBe("ckpt-9");
  });

  it("userId / thread_id 为空字符串时从 metadata 丢掉，避免按空串检索", () => {
    const cfg = workflowLangSmithConfig({
      run: { ...run, thread_id: "  " },
      command: { kind: "resume", resume: { ok: true } },
      userId: "",
    });
    expect(cfg.metadata).not.toHaveProperty("user_id");
    expect(cfg.metadata).not.toHaveProperty("thread_id");
    expect(cfg.metadata.command).toBe("resume");
  });
});

describe("chatLangSmithConfig", () => {
  it("modelName 为 null 或空时不写入 model_name", () => {
    expect(
      chatLangSmithConfig({
        agentId: "a1",
        threadId: "t1",
        modelName: null,
      }).metadata
    ).not.toHaveProperty("model_name");
    expect(
      chatLangSmithConfig({
        agentId: "a1",
        threadId: "t1",
        modelName: "  ",
      }).metadata
    ).not.toHaveProperty("model_name");
  });
});
