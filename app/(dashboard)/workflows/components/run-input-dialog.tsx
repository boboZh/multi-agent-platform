"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { START_VARIABLE_TYPE_LABELS } from "@/lib/workflow-dsl/kinds";
import type { StartVariable } from "@/lib/workflow-dsl/schema";
import { parseStartInput } from "@/lib/workflow-dsl/start-variables";

function emptyValues(variables: StartVariable[]): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const variable of variables) {
    if (variable.type === "boolean") next[variable.key] = false;
    else next[variable.key] = "";
  }
  return next;
}

/**
 * 运行前按 start.variables 弹出动态表单。
 * 校验走 parseStartInput，和 POST /api/workflow/run 同一套规则，避免前端放行、后端 422。
 */
export function RunInputDialog({
  open,
  variables,
  submitting,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  variables: StartVariable[];
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (vars: Record<string, unknown>) => Promise<void>;
}) {
  const initial = emptyValues(variables);
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [error, setError] = useState<string | null>(null);

  function resetOnOpen(nextOpen: boolean) {
    if (nextOpen) {
      setValues(emptyValues(variables));
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseStartInput(variables, values);
    if (!parsed.ok) {
      setError(parsed.errors[0]?.message ?? "请填写运行入参");
      return;
    }
    setError(null);
    try {
      await onSubmit(parsed.vars);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "启动运行失败");
    }
  }

  return (
    <Dialog open={open} onOpenChange={resetOnOpen}>
      <DialogContent className="sm:max-w-md" showCloseButton={!submitting}>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>填写运行入参</DialogTitle>
            <DialogDescription>
              这些值会写入工作流的 state.vars，填写完成后再启动运行。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {variables.map((variable) => (
              <label key={variable.key} className="block space-y-1 text-xs">
                <span className="text-muted-foreground block pb-0.5">
                  {variable.label || variable.key}
                  <span className="ml-1  font-mono text-[10px]">
                    {variable.key} · {START_VARIABLE_TYPE_LABELS[variable.type]}
                  </span>
                  {variable.required !== false ? " *" : ""}
                </span>
                {variable.type === "boolean" ? (
                  <input
                    type="checkbox"
                    className="ml-2 align-middle"
                    checked={Boolean(values[variable.key])}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [variable.key]: e.target.checked,
                      }))
                    }
                  />
                ) : (
                  <Input
                    type={variable.type === "number" ? "number" : "text"}
                    value={
                      values[variable.key] == null
                        ? ""
                        : String(values[variable.key])
                    }
                    placeholder={variable.label}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [variable.key]: e.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ))}
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => resetOnOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "启动中" : "开始运行"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
