/**
 * inputMap 的行/记录互转。
 *
 * DSL 里 inputMap 是 `Record<目标键, state 取值路径>`，但对象不适合直接驱动表单：
 * 用户逐字符改目标键时，`{ order_id: ... }` 会经过 `{ o: ... }`、`{ or: ... }` 等中间态，
 * 每一步都在文档里留下一个残缺键，还会因为对象键重排导致输入框失焦。
 * 所以编辑器以「行数组」为权威，只在收敛成合法键值对时才折叠回 record。
 */

export type InputMapRow = {
  /** 仅用于 React key：目标键可以为空、可以重复，不能拿来当身份。 */
  id: string;
  /** 目标：工具入参名，或注入给智能体的变量名。 */
  target: string;
  /** 来源：从运行时 state 上取值的路径，如 `state.vars.order_id`。 */
  source: string;
};

/**
 * state 取值路径的形状检查。
 *
 * 只做提示不做拦截：编译器（lib/workflow-dsl/compile.ts）还没定最终取值语法，
 * 将来可能支持字面量或函数调用。现在硬拦会把用户卡在一个尚未确定的规则上，
 * 所以这里只负责把「明显不像路径」的输入标黄。
 */
export const STATE_PATH_RE =
  /^state(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[\d+\])+$/;

/** 目标键沿用标识符规则：它最终会变成工具入参名或模板变量名。 */
export const INPUT_MAP_TARGET_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isLikelyStatePath(source: string): boolean {
  return STATE_PATH_RE.test(source.trim());
}

export function isValidInputMapTarget(target: string): boolean {
  return INPUT_MAP_TARGET_RE.test(target.trim());
}

/**
 * record → 行数组。id 按下标生成，保证同一份 inputMap 每次展开顺序一致。
 * 传 undefined（未配置映射）时给出空数组，而不是塞一行空白占位 —— 让「没配」和「配了一行空的」在 UI 上可区分。
 */
export function rowsFromInputMap(
  map: Record<string, string> | undefined,
): InputMapRow[] {
  return Object.entries(map ?? {}).map(([target, source], index) => ({
    id: `row_${index}`,
    target,
    source,
  }));
}

/**
 * 行数组 → record。
 *
 * 入参：编辑器里的行（可能含空行、重复键、前后空格）。
 * 出参：合法的 inputMap；一条都没有时返回 undefined。
 * 步骤：
 * 1. trim 两端 —— 复制路径时很容易带上空格，留着会让编译器取值失败且极难看出原因。
 * 2. 丢掉目标键为空或形状非法的行：那是用户正在敲的半成品，不该进 DSL。
 * 3. 来源为空的行同样丢掉：只有键没有取值路径的映射没有任何意义。
 * 4. 重复键后者覆盖前者，与 JS 对象字面量的行为一致，避免用户看到的结果和直觉相反。
 *
 * 返回 undefined 而不是 `{}`：schema 里 inputMap 是 optional，写一个空对象进去会让
 * 「从未配置」和「配过又删空」在 dsl 里长得不一样，白白制造 diff 和无谓的脏标记。
 */
export function inputMapFromRows(
  rows: InputMapRow[],
): Record<string, string> | undefined {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const target = row.target.trim();
    const source = row.source.trim();
    if (!isValidInputMapTarget(target) || !source) continue;
    map[target] = source;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * 找出重复的目标键，供 UI 标红。
 *
 * 重复本身不阻塞保存（折叠时后者胜出），但必须让用户看见：
 * 否则他会以为两条映射都生效，实际上前一条被静默丢掉了。
 */
export function duplicateInputMapTargets(rows: InputMapRow[]): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const row of rows) {
    const target = row.target.trim();
    if (!target) continue;
    if (seen.has(target)) duplicated.add(target);
    seen.add(target);
  }
  return duplicated;
}
