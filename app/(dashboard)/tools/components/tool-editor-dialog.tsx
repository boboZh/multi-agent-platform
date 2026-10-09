"use client";

import { useState, type ReactNode } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ToolRow } from "@/app/(dashboard)/agents/lib/types";
import { getErrorMessage } from "@/app/(dashboard)/agents/lib/utils";
import { HTTP_METHODS, type HttpMethod } from "@/lib/agent-runtime/tool-config";
import {
  emptyToolForm,
  formFromTool,
  formToToolPayload,
  type PairDraft,
  type ParamDraft,
  type ToolFormValues,
} from "../lib/form";

type ToolEditorDialogProps = {
  open: boolean;
  tool: ToolRow | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
};

const selectClass =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30";

export function ToolEditorDialog({
  open,
  tool,
  onOpenChange,
  onSaved,
}: ToolEditorDialogProps) {
  const [form, setForm] = useState<ToolFormValues>(emptyToolForm);
  const [allowBuiltin, setAllowBuiltin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = process.env.NEXT_PUBLIC_MOCK_USER_ID;

  // 打开或换一条工具时在渲染期对齐表单。关窗不重置，避免退场动画里闪成空白。
  const openKey = open ? (tool?.id ?? "new") : null;
  const [syncedKey, setSyncedKey] = useState<string | null>(null);
  if (openKey !== syncedKey) {
    setSyncedKey(openKey);
    if (openKey) {
      if (tool) {
        const loaded = formFromTool(tool);
        setForm(loaded.values);
        setAllowBuiltin(loaded.allowBuiltin);
      } else {
        setForm(emptyToolForm());
        setAllowBuiltin(false);
      }
      setError(null);
    }
  }

  function patch(partial: Partial<ToolFormValues>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  async function save() {
    if (saving) return;
    const built = formToToolPayload(form);
    if (!built.ok) {
      setError(built.errors.join("\n"));
      return;
    }
    if (!userId) {
      setError("缺少 NEXT_PUBLIC_MOCK_USER_ID。");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { data: existing, error: existingErr } = await supabase
        .from("tools")
        .select("id")
        .eq("user_id", userId)
        .eq("name", built.payload.name);
      if (existingErr) throw existingErr;
      const conflict = (existing ?? []).some((item) => item.id !== tool?.id);
      if (conflict) {
        setError("已有同名工具。工具名会变成模型调用的函数名，不能重复。");
        return;
      }

      if (tool) {
        const { error: updErr } = await supabase
          .from("tools")
          .update(built.payload)
          .eq("id", tool.id)
          .eq("user_id", userId);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase.from("tools").insert({
          id: crypto.randomUUID(),
          user_id: userId,
          ...built.payload,
        });
        if (insErr) throw insErr;
      }

      onOpenChange(false);
      await onSaved();
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "保存工具失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tool ? "修改工具" : "创建工具"}</DialogTitle>
          <DialogDescription>
            填写参数和请求模板。服务端会按这份配置生成工具函数，不用再改代码。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {error ? (
            <div className="whitespace-pre-wrap rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="工具名称" htmlFor="tool-name">
              <Input
                id="tool-name"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="例如 get_order_info"
                className="h-9"
              />
            </Field>
            <Field label="展示名" htmlFor="tool-display">
              <Input
                id="tool-display"
                value={form.displayName}
                onChange={(e) => patch({ displayName: e.target.value })}
                placeholder="例如 获取订单信息"
                className="h-9"
              />
            </Field>
          </div>

          <Field label="给模型看的说明" htmlFor="tool-desc">
            <Textarea
              id="tool-desc"
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="说明这个工具做什么、什么时候该调用。"
              rows={3}
            />
          </Field>

          <ParamList
            params={form.params}
            onChange={(params) => patch({ params })}
          />

          <Field label="执行方式" htmlFor="tool-kind">
            <select
              id="tool-kind"
              className={selectClass}
              value={form.kind}
              onChange={(e) => {
                const value = e.target.value;
                if (value === "http" || value === "static" || value === "builtin") {
                  patch({ kind: value });
                }
              }}
            >
              <option value="http">HTTP 请求</option>
              <option value="static">静态 JSON</option>
              {allowBuiltin ? (
                <option value="builtin">内置执行（兼容旧工具）</option>
              ) : null}
            </select>
          </Field>

          {form.kind === "builtin" ? (
            <p className="text-xs text-muted-foreground">
              这条工具还没有请求配置，运行时仍按工具名走原来的内置实现。改成 HTTP 或静态 JSON 后，就会只按这里的配置执行。
            </p>
          ) : null}

          {form.kind === "http" ? (
            <HttpFields form={form} onChange={patch} />
          ) : null}

          {form.kind === "static" ? (
            <Field label="结果模板" htmlFor="tool-static-body">
              <Textarea
                id="tool-static-body"
                value={form.bodyText}
                onChange={(e) => patch({ bodyText: e.target.value })}
                rows={8}
                placeholder={'{\n  "order_id": "{{order_id}}",\n  "status": "pending"\n}'}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                必须是 JSON。占位符写成字符串 {"{{参数名}}"}
                ，整段正好是占位符时会保留数字和布尔类型。
              </p>
            </Field>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                保存中
              </>
            ) : tool ? (
              "保存更改"
            ) : (
              "创建工具"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

function ParamList({
  params,
  onChange,
}: {
  params: ParamDraft[];
  onChange: (params: ParamDraft[]) => void;
}) {
  function update(index: number, partial: Partial<ParamDraft>) {
    onChange(params.map((item, i) => (i === index ? { ...item, ...partial } : item)));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">参数</div>
          <div className="text-xs text-muted-foreground">
            模型调用时要填的字段，名称要能放进 {"{{参数名}}"}。
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange([
              ...params,
              { key: "", type: "string", description: "", required: true },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" />
          添加参数
        </Button>
      </div>
      {params.length === 0 ? (
        <div className="rounded-xl border border-dashed border-primary/25 px-3 py-3 text-xs text-muted-foreground">
          没有参数。适合不需要入参的查询。
        </div>
      ) : (
        <div className="space-y-2">
          {params.map((param, index) => (
            <div
              key={index}
              className="grid grid-cols-1 gap-2 rounded-xl border border-primary/15 p-3 sm:grid-cols-[1fr_7rem_1fr_auto_auto]"
            >
              <Input
                value={param.key}
                onChange={(e) => update(index, { key: e.target.value })}
                placeholder="参数名"
                className="h-9"
                aria-label={`参数 ${index + 1} 名称`}
              />
              <select
                className={selectClass}
                value={param.type}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "string" || value === "number" || value === "boolean") {
                    update(index, { type: value });
                  }
                }}
                aria-label={`参数 ${index + 1} 类型`}
              >
                <option value="string">字符串</option>
                <option value="number">数字</option>
                <option value="boolean">布尔</option>
              </select>
              <Input
                value={param.description}
                onChange={(e) => update(index, { description: e.target.value })}
                placeholder="给模型看的说明"
                className="h-9"
                aria-label={`参数 ${index + 1} 说明`}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={param.required}
                  onChange={(e) => update(index, { required: e.target.checked })}
                  className="h-4 w-4 accent-primary"
                />
                必填
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange(params.filter((_, i) => i !== index))}
                aria-label={`删除参数 ${index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HttpFields({
  form,
  onChange,
}: {
  form: ToolFormValues;
  onChange: (partial: Partial<ToolFormValues>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[8rem_1fr]">
        <Field label="方法" htmlFor="tool-method">
          <select
            id="tool-method"
            className={selectClass}
            value={form.method}
            onChange={(e) => {
              const value = e.target.value;
              if ((HTTP_METHODS as readonly string[]).includes(value)) {
                onChange({ method: value as HttpMethod });
              }
            }}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </Field>
        <Field label="URL" htmlFor="tool-url">
          <Input
            id="tool-url"
            value={form.url}
            onChange={(e) => onChange({ url: e.target.value })}
            placeholder="https://example.com/orders/{{order_id}}"
            className="h-9 font-mono text-xs"
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        用 {"{{参数名}}"} 引用参数。服务端会编码后填进 URL。只允许 http 和 https。
      </p>

      <PairList
        title="请求头"
        addLabel="添加请求头"
        pairs={form.headers}
        keyPlaceholder="Authorization"
        valuePlaceholder="Bearer {{token}}"
        onChange={(headers) => onChange({ headers })}
      />

      {form.method !== "GET" ? (
        <Field label="请求体" htmlFor="tool-body">
          <Textarea
            id="tool-body"
            value={form.bodyText}
            onChange={(e) => onChange({ bodyText: e.target.value })}
            rows={6}
            placeholder={'{\n  "order_id": "{{order_id}}"\n}'}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            留空则不发送请求体。有内容时必须是 JSON。
          </p>
        </Field>
      ) : null}

      <PairList
        title="响应字段"
        hint="从 JSON 里按点路径取值，例如 current_condition.0.temp_C。留空则把整个响应交给模型。"
        addLabel="添加字段"
        pairs={form.picks}
        keyPlaceholder="temperature_c"
        valuePlaceholder="current_condition.0.temp_C"
        onChange={(picks) => onChange({ picks })}
      />
    </div>
  );
}

function PairList({
  title,
  hint,
  addLabel,
  pairs,
  keyPlaceholder,
  valuePlaceholder,
  onChange,
}: {
  title: string;
  hint?: string;
  addLabel: string;
  pairs: PairDraft[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  onChange: (pairs: PairDraft[]) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{title}</div>
          {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...pairs, { key: "", value: "" }])}
        >
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </Button>
      </div>
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={pair.key}
            onChange={(e) =>
              onChange(
                pairs.map((item, i) =>
                  i === index ? { ...item, key: e.target.value } : item,
                ),
              )
            }
            placeholder={keyPlaceholder}
            className="h-9"
            aria-label={`${title} ${index + 1} 名称`}
          />
          <Input
            value={pair.value}
            onChange={(e) =>
              onChange(
                pairs.map((item, i) =>
                  i === index ? { ...item, value: e.target.value } : item,
                ),
              )
            }
            placeholder={valuePlaceholder}
            className="h-9 font-mono text-xs"
            aria-label={`${title} ${index + 1} 值`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            aria-label={`删除${title} ${index + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
