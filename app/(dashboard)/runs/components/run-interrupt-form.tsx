"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReviewFormField } from "@/lib/workflow-dsl/schema";
import type { FlowRunInterruptPayload } from "@/lib/workflow-dsl/tables";
import { parseResumePayload } from "@/app/(dashboard)/runs/lib/resume-payload";

function fieldsFromPayload(payload: FlowRunInterruptPayload): ReviewFormField[] {
  return Array.isArray(payload.form) ? (payload.form as ReviewFormField[]) : [];
}

export function RunInterruptForm({
  payload,
  submitting,
  onSubmit,
}: {
  payload: FlowRunInterruptPayload;
  submitting: boolean;
  onSubmit: (resume: Record<string, unknown>) => Promise<void>;
}) {
  const fields = useMemo(() => fieldsFromPayload(payload), [payload]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseResumePayload(fields, values);
    if (!parsed.ok) {
      setError(parsed.errors[0]?.message ?? "表单未通过校验");
      return;
    }
    setError(null);
    await onSubmit(parsed.resume);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="shrink-0 space-y-3 border-t border-amber-500/30 bg-amber-500/5 px-4 py-3"
    >
      <div className="text-sm font-medium text-amber-900">
        人工干预 · {payload.title ?? payload.nodeId}
      </div>
      {fields.map((field) => (
        <label key={field.name} className="block space-y-1 text-xs">
          <span className="text-muted-foreground">
            {field.label ?? field.name}
            {field.required ? " *" : ""}
          </span>
          {field.type === "boolean" ? (
            <input
              type="checkbox"
              className="ml-2 align-middle"
              checked={Boolean(values[field.name])}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [field.name]: e.target.checked }))
              }
            />
          ) : field.type === "enum" ? (
            <select
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm"
              value={typeof values[field.name] === "string" ? String(values[field.name]) : ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
              }
            >
              <option value="">请选择</option>
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={typeof values[field.name] === "string" ? String(values[field.name]) : ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
              }
            />
          )}
        </label>
      ))}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" size="sm" disabled={submitting}>
        {submitting ? "提交中" : "恢复运行"}
      </Button>
    </form>
  );
}
