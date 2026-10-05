/**
 * 人工审核 enum 字段的选项，编辑器用逗号分隔字符串，DSL 里是 string[]。
 *
 * 规范化结果只适合当模型，不能当输入框的 value：每敲一个逗号就 split + filter
 * 再 join 回去，末尾逗号和空段会被立刻丢掉，第二项永远敲不进去。
 */

/** 把 options 收成输入框展示用的字符串。空数组展示为空，而不是 ", "。 */
export function formatEnumOptions(options: string[]): string {
  return options.join(", ");
}

/**
 * 入参：用户正在敲的原文（可能含末尾逗号、连续逗号、两端空格）。
 * 出参：去掉空段后的选项数组；全部都是空段时返回 []。
 * 步骤：按逗号切开 → trim → 丢掉空串。空段是输入中间态，不能写进 DSL。
 */
export function parseEnumOptions(raw: string): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

export function sameEnumOptions(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => option === right[index])
  );
}
