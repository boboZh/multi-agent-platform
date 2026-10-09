import { z, type ZodTypeAny } from "zod";

/**
 * `tools.connection_config` 的执行约定。
 * 页面只保存声明式配置，运行时用同一套解析拼出 LangChain tool。
 * 不执行配置里的脚本：工具行存在库里，任意代码会变成服务端 RCE。
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const PARAM_TYPES = ["string", "number", "boolean"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type ToolParamType = (typeof PARAM_TYPES)[number];

export type ToolParamDef = {
  type: ToolParamType;
  description?: string;
  required: boolean;
};

export type HttpExecutor = {
  kind: "http";
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  pick?: Record<string, string>;
};

export type StaticExecutor = {
  kind: "static";
  body: unknown;
};

export type ToolExecutor = HttpExecutor | StaticExecutor;

export type ParsedToolConfig = {
  schema: Record<string, ToolParamDef>;
  executor: ToolExecutor | null;
  /** 配置里写了 executor 但无法执行。为 true 时禁止回落到按名字写死的旧实现。 */
  rejected: boolean;
  errors: string[];
};

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/** 模型上下文装不下整页 HTML；截断后 JSON 可能不完整，调用方仍能看到 truncated。 */
export const MAX_TOOL_RESPONSE_CHARS = 32_000;
const MAX_SCHEMA_FIELDS = 40;
const MAX_HEADERS = 30;
const MAX_PICKS = 40;

/**
 * 这些头会改写连接本身，而不是业务内容。
 * Host / Content-Length 若交给配置，一条工具行就能把请求转到别的主机或拆开传输。
 */
const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isParamType(value: string): value is ToolParamType {
  return (PARAM_TYPES as readonly string[]).includes(value);
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * 把库里的 connection_config 收成可执行结构。
 *
 * 入参：`tools.connection_config`，历史行可能是 null、数组或只有 schema。
 * 出参：schema 始终是对象；没有 executor 时 executor 为 null 且 rejected 为 false（旧工具继续按名字执行）。
 * 步骤：先丢掉非对象 → 宽松解析 schema（未知 type 当 string，避免脏字段拆掉整个工具）→ 再严格解析 executor。
 */
export function parseConnectionConfig(raw: unknown): ParsedToolConfig {
  if (!isPlainObject(raw)) {
    return { schema: {}, executor: null, rejected: false, errors: [] };
  }

  const schemaResult = parseSchema(raw.schema);
  if (!("executor" in raw) || raw.executor == null) {
    return {
      schema: schemaResult.schema,
      executor: null,
      rejected: false,
      errors: schemaResult.errors,
    };
  }

  const executorResult = parseExecutor(raw.executor);
  return {
    schema: schemaResult.schema,
    executor: executorResult.executor,
    rejected: executorResult.executor == null,
    errors: [...schemaResult.errors, ...executorResult.errors],
  };
}

function parseSchema(raw: unknown): {
  schema: Record<string, ToolParamDef>;
  errors: string[];
} {
  if (raw == null) return { schema: {}, errors: [] };
  if (!isPlainObject(raw)) {
    return { schema: {}, errors: ["schema 必须是对象"] };
  }

  const keys = Object.keys(raw);
  if (keys.length > MAX_SCHEMA_FIELDS) {
    return {
      schema: {},
      errors: [`参数不能超过 ${MAX_SCHEMA_FIELDS} 个`],
    };
  }

  const schema: Record<string, ToolParamDef> = {};
  const errors: string[] = [];
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`参数名 ${key} 只能包含字母、数字和下划线`);
      continue;
    }
    const field = raw[key];
    if (!isPlainObject(field)) {
      errors.push(`参数 ${key} 的定义必须是对象`);
      continue;
    }
    const typeText = typeof field.type === "string" ? field.type : "string";
    // 未知 type 回落 string：旧数据只约定 string/number/boolean，多出来的值不能让模型入参整段失效。
    const type: ToolParamType = isParamType(typeText) ? typeText : "string";
    const description =
      typeof field.description === "string" && field.description.trim()
        ? field.description.trim()
        : undefined;
    schema[key] = {
      type,
      description,
      required: field.required !== false,
    };
  }
  return { schema, errors };
}

function parseExecutor(raw: unknown): {
  executor: ToolExecutor | null;
  errors: string[];
} {
  if (!isPlainObject(raw)) {
    return { executor: null, errors: ["executor 必须是对象"] };
  }
  if (raw.kind === "static") {
    if (!("body" in raw)) {
      return { executor: null, errors: ["静态工具缺少 body"] };
    }
    return { executor: { kind: "static", body: raw.body }, errors: [] };
  }
  if (raw.kind !== "http") {
    return {
      executor: null,
      errors: ["executor.kind 只能是 http 或 static"],
    };
  }

  const errors: string[] = [];
  const methodText = typeof raw.method === "string" ? raw.method.toUpperCase() : "";
  if (!isHttpMethod(methodText)) {
    errors.push("HTTP 方法只能是 GET、POST、PUT、PATCH、DELETE");
  }
  if (typeof raw.url !== "string" || !raw.url.trim()) {
    errors.push("HTTP 工具缺少 url");
  } else {
    const urlError = validateUrlTemplate(raw.url);
    if (urlError) errors.push(urlError);
  }

  let headers: Record<string, string> | undefined;
  if (raw.headers != null) {
    const parsed = parseStringMap(raw.headers, "请求头", MAX_HEADERS);
    errors.push(...parsed.errors);
    headers = parsed.map;
  }

  let pick: Record<string, string> | undefined;
  if (raw.pick != null) {
    const parsed = parseStringMap(raw.pick, "响应字段", MAX_PICKS);
    errors.push(...parsed.errors);
    pick = parsed.map;
  }

  if (errors.length > 0 || typeof raw.url !== "string" || !isHttpMethod(methodText)) {
    return { executor: null, errors };
  }

  const executor: HttpExecutor = {
    kind: "http",
    method: methodText,
    url: raw.url.trim(),
  };
  if (headers && Object.keys(headers).length > 0) executor.headers = headers;
  if ("body" in raw && raw.body !== undefined) executor.body = raw.body;
  if (pick && Object.keys(pick).length > 0) executor.pick = pick;
  return { executor, errors: [] };
}

function parseStringMap(
  raw: unknown,
  label: string,
  max: number,
): { map?: Record<string, string>; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { errors: [`${label}必须是对象`] };
  }
  const entries = Object.entries(raw);
  if (entries.length > max) {
    return { errors: [`${label}不能超过 ${max} 项`] };
  }
  const map: Record<string, string> = {};
  const errors: string[] = [];
  for (const [key, value] of entries) {
    const name = key.trim();
    if (!name) {
      errors.push(`${label}的名称不能为空`);
      continue;
    }
    if (label === "请求头" && BLOCKED_HEADERS.has(name.toLowerCase())) {
      errors.push(`不允许设置请求头 ${name}`);
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`${label} ${name} 的值必须是字符串`);
      continue;
    }
    map[name] = value;
  }
  return { map, errors };
}

/**
 * 保存前检查 URL 模板。占位符先换成样例字符再解析：
 * `https://example.com/{{city}}` 在真正调用前还不是合法 URL，但结构必须已经合法。
 */
export function validateUrlTemplate(template: string): string | null {
  const trimmed = template.trim();
  if (!trimmed) return "URL 为必填";
  const sample = trimmed.replace(PLACEHOLDER, "x");
  if (sample.includes("{{") || sample.includes("}}")) {
    return "URL 里有无法识别的占位符，请使用 {{参数名}}";
  }
  return assertHttpUrl(sample);
}

/**
 * 只允许 http(s)，并拒绝把账号写进 URL。
 * 云元数据地址单独挡住：工具由服务端代发，这条配置不能把实例凭证带回模型。
 */
export function assertHttpUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL 无法解析";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "只允许 http 或 https";
  }
  if (parsed.username || parsed.password) {
    return "URL 不能包含账号或密码";
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    return "不允许请求云元数据地址";
  }
  return null;
}

function stringifyParam(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * 替换 `{{name}}`。缺失的键换成空字符串：可选参数没传时，不能把占位符原文送到对方接口。
 * encode 只用于 URL。请求头和 JSON 文本里编码会把空格变成 %20，对方按原文解析会失败。
 */
export function interpolateString(
  template: string,
  input: Record<string, unknown>,
  encode: boolean,
): string {
  return template.replace(PLACEHOLDER, (_, key: string) => {
    const raw = stringifyParam(input[key]);
    return encode ? encodeURIComponent(raw) : raw;
  });
}

/**
 * 深度替换 JSON 模板。
 * 整个字符串刚好是 `{{name}}` 时保留原始类型，这样 `"{{amount}}"` 在入参是数字时仍是数字，而不是 `"2000"`。
 */
export function interpolateValue(
  value: unknown,
  input: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole) {
      const key = whole[1];
      if (!Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined) {
        return "";
      }
      return input[key];
    }
    return interpolateString(value, input, false);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, input));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = interpolateValue(item, input);
    }
    return out;
  }
  return value;
}

export type PreparedHttpCall = {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
};

/**
 * 入参：已通过解析的 HTTP 执行器，以及模型这次传入的参数。
 * 出参：可直接交给 fetch 的 url/method/headers/body，或一条给模型看的错误。
 * 步骤：编码替换 URL → 再校验协议 → 替换请求头 → GET/HEAD 丢弃 body（不少客户端会静默丢掉，配置里写了也不应让人以为发出去了）。
 */
export function prepareHttpCall(
  executor: HttpExecutor,
  input: Record<string, unknown>,
): { ok: true; call: PreparedHttpCall } | { ok: false; error: string } {
  const url = interpolateString(executor.url, input, true);
  const urlError = assertHttpUrl(url);
  if (urlError) return { ok: false, error: urlError };

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(executor.headers ?? {})) {
    if (BLOCKED_HEADERS.has(key.toLowerCase())) {
      return { ok: false, error: `不允许设置请求头 ${key}` };
    }
    headers[key] = interpolateString(value, input, false);
  }

  const call: PreparedHttpCall = {
    url,
    method: executor.method,
    headers,
  };
  // GET 的 body 会被多数客户端丢掉。这里直接不发，避免配置里写了筛选条件但请求其实是空的。
  if (executor.body !== undefined && executor.method !== "GET") {
    const interpolated = interpolateValue(executor.body, input);
    call.body =
      typeof interpolated === "string"
        ? interpolated
        : JSON.stringify(interpolated);
    const hasContentType = Object.keys(headers).some(
      (key) => key.toLowerCase() === "content-type",
    );
    if (!hasContentType && typeof interpolated !== "string") {
      headers["Content-Type"] = "application/json";
    }
  }
  return { ok: true, call };
}

/** 点路径取值。数组用数字下标（`current_condition.0.temp_C`）。缺任何一段都是 null，避免把 undefined 写进 JSON 时被丢掉。 */
export function pickPaths(
  data: unknown,
  pick: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(pick)) {
    if (!key.trim() || typeof path !== "string" || !path.trim()) continue;
    out[key] = readPath(data, path);
  }
  return out;
}

function readPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (current == null) return null;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return null;
      current = current[Number(part)];
      continue;
    }
    if (!isPlainObject(current)) return null;
    current = current[part];
  }
  return current === undefined ? null : current;
}

/**
 * 把 HTTP 响应收成工具结果字符串。
 * 非 2xx 也返回 JSON 而不是抛错：对方 4xx 是业务结果，工作流不该因此把整次 run 判失败。
 * 网络错误和超时仍由 fetchWithinTimeout 抛出。
 */
export function formatToolHttpResult(
  status: number,
  text: string,
  pick?: Record<string, string>,
): string {
  const truncated = text.length > MAX_TOOL_RESPONSE_CHARS;
  const slice = truncated ? text.slice(0, MAX_TOOL_RESPONSE_CHARS) : text;
  let body: unknown = slice;
  try {
    body = JSON.parse(slice);
  } catch {
    body = slice;
  }

  if (status < 200 || status >= 300) {
    return JSON.stringify({
      error: `HTTP ${status}`,
      status,
      body,
      ...(truncated ? { truncated: true } : {}),
    });
  }

  if (pick && Object.keys(pick).length > 0) {
    if (!isPlainObject(body) && !Array.isArray(body)) {
      return JSON.stringify({
        error: "响应不是 JSON，无法按字段提取",
        body,
      });
    }
    return JSON.stringify({
      ...pickPaths(body, pick),
      ...(truncated ? { truncated: true } : {}),
    });
  }

  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

export function renderStaticBody(
  body: unknown,
  input: Record<string, unknown>,
): string {
  return JSON.stringify(interpolateValue(body, input));
}

/**
 * 有 executor 且 schema 为空时不再塞一个自由 input：
 * 否则模型会编一个 input 字符串，而 HTTP 模板根本没有这个占位符。
 * 没有 executor 的旧工具仍保留可选 input，兼容当初没写 schema 的行。
 */
export function zodObjectFromConfig(raw: unknown) {
  const parsed = parseConnectionConfig(raw);
  const keys = Object.keys(parsed.schema);
  if (keys.length === 0) {
    if (parsed.executor || parsed.rejected) return z.object({});
    return z.object({
      input: z.string().optional().describe("Tool input"),
    });
  }

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, def] of Object.entries(parsed.schema)) {
    let field: ZodTypeAny =
      def.type === "number"
        ? z.number()
        : def.type === "boolean"
          ? z.boolean()
          : z.string();
    if (def.description) field = field.describe(def.description);
    if (!def.required) field = field.optional();
    shape[key] = field;
  }
  return z.object(shape);
}

export function summarizeExecutor(raw: unknown): string {
  const parsed = parseConnectionConfig(raw);
  if (parsed.rejected) return "配置无效";
  if (!parsed.executor) return "内置执行";
  if (parsed.executor.kind === "static") return "静态 JSON";
  return `${parsed.executor.method} ${parsed.executor.url}`;
}

export function asToolInput(input: unknown): Record<string, unknown> {
  if (isPlainObject(input)) return input;
  return {};
}
