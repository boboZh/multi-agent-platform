import type { ToolRow } from "@/app/(dashboard)/agents/lib/types";
import {
  HTTP_METHODS,
  parseConnectionConfig,
  validateUrlTemplate,
  type HttpMethod,
  type ToolParamType,
} from "@/lib/agent-runtime/tool-config";

export type ParamDraft = {
  key: string;
  type: ToolParamType;
  description: string;
  required: boolean;
};

export type PairDraft = {
  key: string;
  value: string;
};

/** builtin 只用于还没写 executor 的旧行；新工具保存后就会带上 http 或 static。 */
export type ToolFormKind = "http" | "static" | "builtin";

export type ToolFormValues = {
  name: string;
  displayName: string;
  description: string;
  params: ParamDraft[];
  kind: ToolFormKind;
  method: HttpMethod;
  url: string;
  headers: PairDraft[];
  bodyText: string;
  picks: PairDraft[];
};

export type ToolWritePayload = {
  name: string;
  display_name: string | null;
  description: string | null;
  tool_type: "explicit";
  connection_config: Record<string, unknown>;
};

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function emptyToolForm(): ToolFormValues {
  return {
    name: "",
    displayName: "",
    description: "",
    params: [],
    kind: "http",
    method: "GET",
    url: "",
    headers: [],
    bodyText: "",
    picks: [],
  };
}

function isParamType(value: string): value is ToolParamType {
  return value === "string" || value === "number" || value === "boolean";
}

/**
 * 把库里的一行灌进表单。
 * 没有 executor 的旧工具标成 builtin，并允许这一次编辑继续保存成内置执行；
 * 一旦改成 http/static，再存就会带上 executor，之后不再回落到按名字写死的分支。
 */
export function formFromTool(
  row: Pick<ToolRow, "name" | "display_name" | "description" | "connection_config">,
): { values: ToolFormValues; allowBuiltin: boolean } {
  const base = emptyToolForm();
  base.name = row.name ?? "";
  base.displayName = row.display_name ?? "";
  base.description = row.description ?? "";

  const raw = isPlainObject(row.connection_config) ? row.connection_config : null;
  const parsed = parseConnectionConfig(row.connection_config);
  base.params = Object.entries(parsed.schema).map(([key, def]) => ({
    key,
    type: def.type,
    description: def.description ?? "",
    required: def.required,
  }));

  const executor = raw && isPlainObject(raw.executor) ? raw.executor : null;
  // 解析失败时仍停在 http/static 表单上，不能改标成 builtin：
  // 否则用户一点保存，坏配置会悄悄回到按名字执行。
  if (!executor) {
    return {
      values: { ...base, kind: parsed.rejected ? "http" : "builtin" },
      allowBuiltin: !parsed.rejected,
    };
  }

  if (executor.kind === "static") {
    return {
      values: {
        ...base,
        kind: "static",
        bodyText:
          "body" in executor ? JSON.stringify(executor.body, null, 2) : "",
      },
      allowBuiltin: false,
    };
  }

  const method =
    typeof executor.method === "string" &&
    (HTTP_METHODS as readonly string[]).includes(executor.method.toUpperCase())
      ? (executor.method.toUpperCase() as HttpMethod)
      : "GET";

  return {
    values: {
      ...base,
      kind: "http",
      method,
      url: typeof executor.url === "string" ? executor.url : "",
      headers: stringMapToPairs(executor.headers),
      bodyText: "body" in executor ? JSON.stringify(executor.body, null, 2) : "",
      picks: stringMapToPairs(executor.pick),
    },
    allowBuiltin: false,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringMapToPairs(value: unknown): PairDraft[] {
  if (!isPlainObject(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, entryValue]) => ({ key, value: entryValue }));
}

function parseJsonTemplate(text: string, label: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return {
      error: `${label}不是合法 JSON。占位符要写在字符串里，例如 "{{order_id}}"`,
    };
  }
}

function collectParams(params: ParamDraft[]): {
  schema: Record<string, { type: ToolParamType; description?: string; required: boolean }>;
  errors: string[];
} {
  const schema: Record<
    string,
    { type: ToolParamType; description?: string; required: boolean }
  > = {};
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const param of params) {
    const key = param.key.trim();
    const description = param.description.trim();
    if (!key && !description) continue;
    if (!key) {
      errors.push("参数名不能为空");
      continue;
    }
    if (!NAME_PATTERN.test(key)) {
      errors.push(`参数名 ${key} 只能包含字母、数字和下划线，且不能以数字开头`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`参数名 ${key} 重复`);
      continue;
    }
    seen.add(key);
    if (!isParamType(param.type)) {
      errors.push(`参数 ${key} 的类型不合法`);
      continue;
    }
    schema[key] = {
      type: param.type,
      required: param.required,
      ...(description ? { description } : {}),
    };
  }

  return { schema, errors };
}

function collectPairs(
  pairs: PairDraft[],
  label: string,
  options: { allowEmptyValue: boolean },
): { map: Record<string, string>; errors: string[] } {
  const map: Record<string, string> = {};
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const pair of pairs) {
    const key = pair.key.trim();
    const value = pair.value;
    if (!key && !value.trim()) continue;
    if (!key) {
      errors.push(`${label}的名称不能为空`);
      continue;
    }
    if (!options.allowEmptyValue && !value.trim()) {
      errors.push(`${label} ${key} 的值不能为空`);
      continue;
    }
    const id = key.toLowerCase();
    if (seen.has(id)) {
      errors.push(`${label} ${key} 重复`);
      continue;
    }
    seen.add(id);
    map[key] = value;
  }

  return { map, errors };
}

/**
 * 表单 → 可入库的 connection_config。
 *
 * 入参：编辑弹窗的当前值。
 * 出参：错误列表，或 explicit 工具行上除 id / user_id 以外的字段。
 * 步骤：校验工具名和参数名 → 按 kind 组装 schema + executor → 再用运行时同一套解析器过一遍，避免页面和执行各认一套结构。
 */
export function formToToolPayload(
  form: ToolFormValues,
): { ok: true; payload: ToolWritePayload } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const name = form.name.trim();
  if (!name) errors.push("工具名称为必填项");
  else if (!NAME_PATTERN.test(name)) {
    errors.push("工具名称只能包含字母、数字和下划线，且不能以数字开头");
  }

  const { schema, errors: paramErrors } = collectParams(form.params);
  errors.push(...paramErrors);

  const connection_config: Record<string, unknown> = { schema };

  if (form.kind === "builtin") {
    // 不写 executor：运行时才会继续走按名字的旧实现。
  } else if (form.kind === "static") {
    const text = form.bodyText.trim();
    if (!text) errors.push("静态结果不能为空");
    else {
      const parsed = parseJsonTemplate(text, "静态结果");
      if ("error" in parsed) errors.push(parsed.error);
      else connection_config.executor = { kind: "static", body: parsed.value };
    }
  } else if (form.kind === "http") {
    if (!(HTTP_METHODS as readonly string[]).includes(form.method)) {
      errors.push("HTTP 方法不合法");
    }
    const urlError = validateUrlTemplate(form.url);
    if (urlError) errors.push(urlError);

    const headers = collectPairs(form.headers, "请求头", { allowEmptyValue: true });
    const picks = collectPairs(form.picks, "响应字段", { allowEmptyValue: false });
    errors.push(...headers.errors, ...picks.errors);

    const executor: Record<string, unknown> = {
      kind: "http",
      method: form.method,
      url: form.url.trim(),
    };
    if (Object.keys(headers.map).length > 0) executor.headers = headers.map;
    const bodyText = form.bodyText.trim();
    if (bodyText) {
      const parsed = parseJsonTemplate(bodyText, "请求体");
      if ("error" in parsed) errors.push(parsed.error);
      else executor.body = parsed.value;
    }
    if (Object.keys(picks.map).length > 0) executor.pick = picks.map;
    connection_config.executor = executor;
  } else {
    errors.push("未知的执行方式");
  }

  if (errors.length > 0) return { ok: false, errors };

  const checked = parseConnectionConfig(connection_config);
  if (checked.rejected || checked.errors.length > 0) {
    return {
      ok: false,
      errors: checked.errors.length > 0 ? checked.errors : ["工具配置无效"],
    };
  }

  return {
    ok: true,
    payload: {
      name,
      display_name: form.displayName.trim() || null,
      description: form.description.trim() || null,
      tool_type: "explicit",
      connection_config,
    },
  };
}
