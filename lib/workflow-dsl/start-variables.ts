import {
  parseWorkflowDocument,
  type StartVariable,
  type WorkflowDocument,
  type WorkflowIssue,
} from "@/lib/workflow-dsl/schema";

export type StartInputParseResult =
  | { ok: true; vars: Record<string, unknown> }
  | { ok: false; errors: WorkflowIssue[] };

/**
 * 从文档取出 start 节点上声明的入参。
 * 入参：任意 WorkflowDocument（含尚未走 compile 档的草稿）。
 * 出参：variables 数组；找不到 start 或未配置时返回空数组，调用方据此决定要不要弹窗。
 *
 * 步骤：优先用 startNodeId 定位入口，避免图里误放了第二个 start 时读错声明。
 */
export function startVariablesOf(doc: WorkflowDocument): StartVariable[] {
  const byId = doc.nodes.find((node) => node.id === doc.startNodeId);
  const start =
    byId?.data.kind === "start"
      ? byId
      : doc.nodes.find((node) => node.data.kind === "start");
  if (!start || start.data.kind !== "start") return [];
  return start.data.config.variables ?? [];
}

/**
 * 未确定是否已 parse 过的 DSL（例如 flow_versions.dsl 直出）先走 draft 档再取 variables。
 * draft 会给旧文档补上 config.variables: []，避免 {} 把运行弹窗和校验打崩。
 */
export function startVariablesFromDsl(dsl: unknown): StartVariable[] {
  const parsed = parseWorkflowDocument(dsl, "draft");
  if (!parsed.ok) return [];
  return startVariablesOf(parsed.document);
}

function isMissing(value: unknown): boolean {
  return value == null || value === "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/**
 * 按 start.variables 校验并裁剪运行入参。
 *
 * 入参：节点上的变量声明、用户填写/POST 的 vars。
 * 出参：只含声明过的 key；缺必填或类型对不上则带 path 的 errors。
 *
 * 步骤：
 * 1. 拒绝非对象，避免把字符串整段写进 state.vars。
 * 2. 逐字段按 type 收窄（表单数字框会交出字符串，这里顺便 coerce）。
 * 3. 丢掉未声明的多余键，防止调用方塞进干扰后续表达式的脏数据。
 */
export function parseStartInput(
  variables: StartVariable[],
  input: unknown,
): StartInputParseResult {
  if (input == null) {
    if (variables.every((variable) => variable.required !== true)) {
      return { ok: true, vars: {} };
    }
    return {
      ok: false,
      errors: [{ message: "运行入参必须是对象", path: ["input", "vars"] }],
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ message: "运行入参必须是对象", path: ["input", "vars"] }],
    };
  }

  const rec = input as Record<string, unknown>;
  const errors: WorkflowIssue[] = [];
  const vars: Record<string, unknown> = {};

  for (const variable of variables) {
    const value = rec[variable.key];
    const required = variable.required !== false;
    if (isMissing(value)) {
      if (required) {
        errors.push({
          message: `缺少必填入参 ${variable.label || variable.key}`,
          path: ["input", "vars", variable.key],
        });
      }
      continue;
    }

    if (variable.type === "number") {
      const n = asNumber(value);
      if (n === undefined) {
        errors.push({
          message: `${variable.label || variable.key} 必须是数字`,
          path: ["input", "vars", variable.key],
        });
        continue;
      }
      vars[variable.key] = n;
      continue;
    }

    if (variable.type === "boolean") {
      const b = asBoolean(value);
      if (b === undefined) {
        errors.push({
          message: `${variable.label || variable.key} 必须是布尔值`,
          path: ["input", "vars", variable.key],
        });
        continue;
      }
      vars[variable.key] = b;
      continue;
    }

    if (typeof value !== "string") {
      errors.push({
        message: `${variable.label || variable.key} 必须是字符串`,
        path: ["input", "vars", variable.key],
      });
      continue;
    }
    vars[variable.key] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, vars };
}
