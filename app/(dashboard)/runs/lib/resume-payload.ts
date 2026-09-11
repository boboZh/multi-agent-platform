import type { ReviewFormField, WorkflowIssue } from "@/lib/workflow-dsl/schema";

export type ResumeParseResult =
  | { ok: true; resume: Record<string, unknown> }
  | { ok: false; errors: WorkflowIssue[] };

/**
 * 按审核节点 formFields 校验 resume 对象。
 * 防的是随便 POST 一个 string / 缺必填 / enum 不在 options 把 vars 写脏。
 */
export function parseResumePayload(
  formFields: ReviewFormField[],
  resume: unknown,
): ResumeParseResult {
  if (resume == null || typeof resume !== "object" || Array.isArray(resume)) {
    return {
      ok: false,
      errors: [{ message: "resume 必须是对象", path: ["resume"] }],
    };
  }
  const rec = resume as Record<string, unknown>;
  const errors: WorkflowIssue[] = [];
  const out: Record<string, unknown> = {};

  for (const field of formFields) {
    const value = rec[field.name];
    const missing = value == null || value === "";
    if (field.required === true && missing) {
      errors.push({
        message: `缺少必填字段 ${field.name}`,
        path: ["resume", field.name],
      });
      continue;
    }
    if (missing) continue;

    if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push({
          message: `${field.name} 必须是布尔值`,
          path: ["resume", field.name],
        });
        continue;
      }
      out[field.name] = value;
      continue;
    }

    if (field.type === "enum") {
      if (typeof value !== "string" || !(field.options ?? []).includes(value)) {
        errors.push({
          message: `${field.name} 不在可选值中`,
          path: ["resume", field.name],
        });
        continue;
      }
      out[field.name] = value;
      continue;
    }

    if (typeof value !== "string") {
      errors.push({
        message: `${field.name} 必须是文本`,
        path: ["resume", field.name],
      });
      continue;
    }
    out[field.name] = value;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, resume: out };
}
