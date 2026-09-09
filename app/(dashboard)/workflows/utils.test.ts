import { describe, expect, it } from "vitest";
import { createEmptyWorkflowDocument } from "@/lib/workflow-dsl/schema";
import {
  descriptionSnippet,
  flowDisplayName,
  flowStatusLabel,
  formatRelativeTime,
  summarizeFlowDsl,
} from "./utils";

/**
 * 列表页展示层的纯函数。这些函数吃的是 flows 表里的 jsonb / 自由文本列，
 * 用例重点覆盖「库里可能出现但不该显示成崩溃或空白」的脏数据。
 */

describe("summarizeFlowDsl", () => {
  it("合法 Document 按解析结果统计节点与边数量", () => {
    const summary = summarizeFlowDsl(createEmptyWorkflowDocument("测试"));
    expect(summary).toEqual({ state: "valid", nodeCount: 2, edgeCount: 1 });
  });

  // 新建的行默认 dsl 是 '{}'::jsonb，属于「还没编排」，不能标成错误。
  it("边界：空对象视为尚未编排而非非法 DSL", () => {
    expect(summarizeFlowDsl({})).toEqual({
      state: "empty",
      nodeCount: 0,
      edgeCount: 0,
    });
  });

  it("边界：null 与非对象（字符串、数组）都归为 empty，不抛异常", () => {
    for (const input of [null, undefined, "", "abc", 42, []]) {
      expect(summarizeFlowDsl(input).state).toBe("empty");
    }
  });

  // 旧 flow_data 迁过来的节点没有 position / data.kind，喂给画布会渲染出坏节点，必须标 invalid。
  it("边界：旧版结构过不了 draft 校验时标为 invalid 并回落到防御式计数", () => {
    const legacy = {
      nodes: [
        { id: "1", type: "researcher", label: "Search Agent" },
        { id: "2", type: "writer", label: "Blogger Agent" },
      ],
      edges: [{ id: "e1-2", source: "1", target: "2" }],
    };
    expect(summarizeFlowDsl(legacy)).toEqual({
      state: "invalid",
      nodeCount: 2,
      edgeCount: 1,
    });
  });

  it("边界：invalid 且 nodes/edges 不是数组时计数为 0", () => {
    expect(summarizeFlowDsl({ nodes: "oops", edges: null })).toEqual({
      state: "invalid",
      nodeCount: 0,
      edgeCount: 0,
    });
  });
});

describe("flowStatusLabel", () => {
  it("已知状态映射为中文文案", () => {
    expect(flowStatusLabel("draft")).toBe("草稿");
    expect(flowStatusLabel("published")).toBe("已发布");
    expect(flowStatusLabel("archived")).toBe("已归档");
  });

  // status 只有 CHECK 约束，手工改库或将来加值时不能让卡片显示空白。
  it("边界：未知状态与空值回落为「未知状态」", () => {
    expect(flowStatusLabel("running")).toBe("未知状态");
    expect(flowStatusLabel(null)).toBe("未知状态");
    expect(flowStatusLabel(undefined)).toBe("未知状态");
  });
});

describe("flowDisplayName", () => {
  it("边界：空名称与纯空白名称都回落为「未命名工作流」", () => {
    expect(flowDisplayName("")).toBe("未命名工作流");
    expect(flowDisplayName("   ")).toBe("未命名工作流");
    expect(flowDisplayName(null)).toBe("未命名工作流");
  });

  it("正常名称去掉首尾空白后原样返回", () => {
    expect(flowDisplayName("  客服升级  ")).toBe("客服升级");
  });
});

describe("descriptionSnippet", () => {
  it("把换行与连续空格压成单空格，避免撑坏卡片行高", () => {
    expect(descriptionSnippet("第一行\n\n  第二行", "空")).toBe("第一行 第二行");
  });

  it("边界：空描述返回调用方给的占位文案", () => {
    expect(descriptionSnippet(null, "暂无描述。")).toBe("暂无描述。");
    expect(descriptionSnippet("   ", "暂无描述。")).toBe("暂无描述。");
  });

  it("边界：超长描述截断到 maxLen 且以省略号结尾", () => {
    const result = descriptionSnippet("哈".repeat(50), "空", 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");

  it("按分 / 时 / 天分档给出中文相对时间", () => {
    expect(formatRelativeTime("2026-09-08T11:59:30.000Z", now)).toBe("刚刚");
    expect(formatRelativeTime("2026-09-08T11:30:00.000Z", now)).toBe("30 分钟前");
    expect(formatRelativeTime("2026-09-08T09:00:00.000Z", now)).toBe("3 小时前");
    expect(formatRelativeTime("2026-09-05T12:00:00.000Z", now)).toBe("3 天前");
  });

  // 超过 7 天用绝对日期：「38 天前」对用户没有信息量。
  it("超过 7 天退化为绝对日期而非继续累加天数", () => {
    const result = formatRelativeTime("2026-08-01T12:00:00.000Z", now);
    expect(result).not.toContain("天前");
    expect(result).toMatch(/2026/);
  });

  it("边界：null / 空串 / 非法日期字符串都返回占位符而非 Invalid Date", () => {
    expect(formatRelativeTime(null, now)).toBe("—");
    expect(formatRelativeTime("", now)).toBe("—");
    expect(formatRelativeTime("not-a-date", now)).toBe("—");
  });

  // 数据库时钟略快于浏览器时会算出负差值，不能显示成「-1 分钟前」。
  it("边界：未来时间（库时钟超前）按「刚刚」处理", () => {
    expect(formatRelativeTime("2026-09-08T12:05:00.000Z", now)).toBe("刚刚");
  });
});
