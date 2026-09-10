import {
  MODEL_LABELS,
  MODEL_VALUES,
  type ModelValue,
  type ToolRow,
} from "./types";

/** 把库里可能越界的 temperature（历史脏数据 / 手工改库）压回滑条合法区间，避免 Slider 受控值失控。 */
export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/** 展示用一位小数：滑条 step=0.1，避免 0.30000000004 这类浮点噪声出现在标签上。 */
export function formatTemp(v: number) {
  const rounded = Math.round(v * 10) / 10;
  return rounded.toFixed(1);
}

export function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return null;
}

/** 模型白名单守卫：库字段是自由文本，未识别的值不能写进受控 <select>。 */
export function isModelValue(value: string | null): value is ModelValue {
  return MODEL_VALUES.includes(value as ModelValue);
}

export function modelLabel(model: string | null) {
  if (isModelValue(model)) return MODEL_LABELS[model];
  return "未知模型";
}

/** 优先展示名；display_name 为空时回退内部 name，保证卡片/复选框不会出现空白标签。 */
export function toolLabel(tool: ToolRow) {
  return tool.display_name?.trim() || tool.name;
}

/**
 * 卡片摘要：压扁空白后截断，避免系统提示词把网格撑出参差不齐的行高。
 *
 * @param prompt 原始系统提示词，允许 null
 * @param emptyLabel 空提示时的占位文案
 * @param maxLen 卡片上可接受的大致字符宽度
 */
export function promptSnippet(
  prompt: string | null,
  emptyLabel: string,
  maxLen = 140,
) {
  const p = (prompt || "").trim().replaceAll(/\s+/g, " ");
  if (!p) return emptyLabel;
  return p.length <= maxLen ? p : `${p.slice(0, maxLen - 1)}…`;
}
