import { describe, expect, it } from "vitest";
import {
  buildEngineEventLogFileName,
  formatEngineEventDump,
  formatEngineEventLogStamp,
  sanitizeEngineEventLogRunId,
} from "@/lib/workflow-runtime/engine-event-log";

describe("formatEngineEventDump", () => {
  it("嵌套 messages 必须展开具体内容，不能收成 [Array] 或 [Object]", () => {
    const raw = {
      event: "on_chain_end",
      name: "agent-1",
      data: {
        output: {
          messages: [
            { role: "user", content: "hello-secret-token" },
            {
              role: "assistant",
              content: "world-nested-content",
              extra: { tool: "search", hits: [{ title: "hit-leaf-title" }] },
            },
          ],
        },
      },
    };
    const text = formatEngineEventDump(raw);
    expect(text).toContain("hello-secret-token");
    expect(text).toContain("world-nested-content");
    expect(text).toContain("hit-leaf-title");
    expect(text).not.toMatch(/\[Array\]/);
    expect(text).not.toMatch(/\[Object\]/);
  });

  it("空数组 / null / undefined 要能 dump，不能抛错", () => {
    expect(formatEngineEventDump([])).toBe("[]");
    expect(formatEngineEventDump(null)).toBe("null");
    expect(formatEngineEventDump(undefined)).toBe("undefined");
  });

  it("循环引用不能抛错，并保留 messages 叶子字段", () => {
    const raw: Record<string, unknown> = {
      event: "on_chat_model_stream",
      messages: [{ content: "circular-leaf" }],
    };
    raw.self = raw;
    const text = formatEngineEventDump(raw);
    expect(text).toContain("circular-leaf");
    expect(text).toMatch(/\[Circular/i);
  });

  it("非对象入参（数字、超长字符串）必须原样出现在文本里", () => {
    expect(formatEngineEventDump(0)).toBe("0");
    const long = "x".repeat(5000);
    expect(formatEngineEventDump(long)).toContain(long);
  });
});

describe("buildEngineEventLogFileName", () => {
  it("runId 含路径穿越字符时必须清洗，不能写出仓库外路径", () => {
    const name = buildEngineEventLogFileName("../etc/passwd", new Date("2026-09-17T04:27:00.123Z"));
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.startsWith("..")).toBe(false);
    expect(name).toMatch(/^__etc_passwd-/);
    expect(name).toContain("2026-09-17T04-27-00.123Z");
  });

  it("runId 缺失或非法类型时落到 unknown-run，而不是空文件名", () => {
    expect(sanitizeEngineEventLogRunId("")).toBe("unknown-run");
    expect(sanitizeEngineEventLogRunId("   ")).toBe("unknown-run");
    expect(sanitizeEngineEventLogRunId(null)).toBe("unknown-run");
    expect(sanitizeEngineEventLogRunId(123)).toBe("unknown-run");
    expect(buildEngineEventLogFileName("", new Date("2026-09-17T00:00:00.000Z"))).toMatch(
      /^unknown-run-/
    );
  });

  it("Invalid Date 不能生成空时间戳片段", () => {
    expect(formatEngineEventLogStamp(new Date("not-a-date"))).toBe("invalid-time");
    expect(buildEngineEventLogFileName("run-1", new Date(Number.NaN))).toBe(
      "run-1-invalid-time.log"
    );
  });
});
