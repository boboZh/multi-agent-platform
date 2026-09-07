import {
  MODEL_LABELS,
  MODEL_VALUES,
  type ModelValue,
  type ToolRow,
} from "./types";

// 将n限制在min~max之间
export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
// 四舍五入到小数点后一位
export function formatTemp(v: number) {
  const rounded = Math.round(v * 10) / 10;
  return rounded.toFixed(1);
}

export function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return null;
}

export function isModelValue(value: string | null): value is ModelValue {
  return MODEL_VALUES.includes(value as ModelValue);
}

export function modelLabel(model: string | null) {
  if (isModelValue(model)) return MODEL_LABELS[model];
  return "未知模型";
}

export function toolLabel(tool: ToolRow) {
  return tool.display_name?.trim() || tool.name;
}

// 截取提示词，如果超过maxLen，则截取前maxLen-1个字符并添加省略号
export function promptSnippet(
  prompt: string | null,
  emptyLabel: string,
  maxLen = 140,
) {
  const p = (prompt || "").trim().replaceAll(/\s+/g, " ");
  if (!p) return emptyLabel;
  return p.length <= maxLen ? p : `${p.slice(0, maxLen - 1)}…`;
}
