/**
 * 节点失败分类：决定能不能退避重试。
 * timeout 单独一类，因为调用结果未知（可能没发出去，也可能对方已执行），不能和「明确 5xx」混成一次策略。
 * retryable 只覆盖瞬时故障（网络、429、5xx）；fatal 重试也不会变好（缺配置、4xx、Zod、以及看不出原因的空错误）。
 *
 * 不识别 GraphInterrupt。挂起是控制流，runner 在进失败分支之前就拆走了。
 *
 * 入参：任意抛出值（Error、字符串、普通对象、空值）。
 * 出参：kind + 给人看的 message；读到 HTTP 状态码时带 status。
 * 步骤：沿 cause 展开（防环）→ 每帧抽 name/code/status/Zod → 按 fatal 结构错误、timeout、retryable、其余 fatal 的顺序取第一类。
 */

export type NodeErrorKind = "timeout" | "retryable" | "fatal";

export type ClassifiedNodeError = {
  kind: NodeErrorKind;
  message: string;
  status?: number;
};

const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
]);

const MAX_CAUSE_DEPTH = 5;

type ErrorFrame = {
  message: string;
  name: string;
  code: string;
  status?: number;
  zod: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function readMessage(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  return typeof rec.message === "string" ? rec.message : "";
}

function readStatus(rec: Record<string, unknown>, message: string): number | undefined {
  const candidates = [rec.status, rec.statusCode];
  const response = asRecord(rec.response);
  if (response) candidates.push(response.status, response.statusCode);
  for (const candidate of candidates) {
    const status = coerceStatus(candidate);
    if (status != null) return status;
  }
  return statusFromMessage(message);
}

function coerceStatus(value: unknown): number | undefined {
  if (typeof value === "number" && value >= 400 && value <= 599) return value;
  if (typeof value === "string" && /^[45]\d{2}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** 只认看起来像 HTTP 的写法，避免把模型名里的数字当成状态码。 */
function statusFromMessage(message: string): number | undefined {
  const matched = message.match(
    /(?:\bHTTP\b|\bstatus(?:\s*code)?\b|\bfailed\b)\s*[:：(]?\s*([45]\d{2})\b/i,
  );
  if (!matched) return undefined;
  return Number(matched[1]);
}

function frameOf(value: unknown): ErrorFrame {
  const message = readMessage(value);
  const rec = asRecord(value);
  if (!rec) {
    return {
      message,
      name: "",
      code: "",
      status: typeof value === "number" ? coerceStatus(value) : statusFromMessage(message),
      zod: false,
    };
  }
  const name = typeof rec.name === "string" ? rec.name : "";
  const code = typeof rec.code === "string" ? rec.code : "";
  const zod =
    name === "ZodError" ||
    (Array.isArray(rec.issues) && name.toLowerCase().includes("zod"));
  return {
    message,
    name,
    code,
    status: readStatus(rec, message),
    zod,
  };
}

function framesOf(err: unknown): ErrorFrame[] {
  const frames: ErrorFrame[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth += 1) {
    if (typeof current === "object" && seen.has(current)) break;
    if (typeof current === "object" && current) seen.add(current);
    frames.push(frameOf(current));
    const rec = asRecord(current);
    current = rec ? rec.cause : undefined;
  }
  return frames;
}

function isTimeout(frame: ErrorFrame): boolean {
  if (TIMEOUT_NAMES.has(frame.name)) return true;
  if (TIMEOUT_CODES.has(frame.code)) return true;
  if (frame.status === 408 || frame.status === 504) return true;
  return /\btimeout\b|timed out|超时/i.test(frame.message);
}

function isRetryable(frame: ErrorFrame): boolean {
  if (frame.status === 429 || (frame.status != null && frame.status >= 500)) {
    return true;
  }
  if (RETRYABLE_CODES.has(frame.code.toUpperCase())) return true;
  return /\bfetch failed\b|\bnetwork\b|econnreset|econnrefused|enotfound/i.test(
    frame.message,
  );
}

function pickMessage(frames: ErrorFrame[]): string {
  for (const frame of frames) {
    const message = frame.message.trim();
    if (message) return message;
  }
  return "";
}

function pickStatus(frames: ErrorFrame[]): number | undefined {
  for (const frame of frames) {
    if (frame.status != null) return frame.status;
  }
  return undefined;
}

export function classifyNodeError(err: unknown): ClassifiedNodeError {
  const frames = framesOf(err);
  const message = pickMessage(frames);
  const status = pickStatus(frames);
  const withStatus = (kind: NodeErrorKind): ClassifiedNodeError =>
    status == null ? { kind, message } : { kind, message, status };

  if (frames.some((frame) => frame.zod)) return withStatus("fatal");
  if (frames.some(isTimeout)) return withStatus("timeout");
  if (frames.some(isRetryable)) return withStatus("retryable");
  return withStatus("fatal");
}
