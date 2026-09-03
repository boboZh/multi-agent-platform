"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MODEL_LABELS,
  MODEL_VALUES,
  type AgentWithTools,
  type ModelValue,
  type ToolRow,
  type UUID,
} from "./types";
import {
  clamp,
  formatTemp,
  getErrorMessage,
  isModelValue,
  toolLabel,
} from "./utils";

type AgentEditorDialogProps = {
  open: boolean;
  agent: AgentWithTools | null;
  explicitTools: ToolRow[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
  onError: (message: string | null) => void;
};

function emptyForm() {
  return {
    name: "",
    systemPrompt: "",
    modelName: MODEL_VALUES[0] as ModelValue,
    temperature: 0.7,
    selectedToolIds: new Set<UUID>(),
  };
}

export function AgentEditorDialog({
  open,
  agent,
  explicitTools,
  onOpenChange,
  onSaved,
  onError,
}: AgentEditorDialogProps) {
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [modelName, setModelName] = useState<ModelValue>(MODEL_VALUES[0]);
  const [temperature, setTemperature] = useState(0.7);
  const [selectedToolIds, setSelectedToolIds] = useState<Set<UUID>>(new Set());
  const [saving, setSaving] = useState(false);

  const isEditing = Boolean(agent);
  const userId = process.env.NEXT_PUBLIC_MOCK_USER_ID;

  useEffect(() => {
    if (!open) return;
    if (agent) {
      setName(agent.name || "");
      setSystemPrompt(agent.system_prompt || "");
      setModelName(
        isModelValue(agent.model_name) ? agent.model_name : MODEL_VALUES[0],
      );
      setTemperature(clamp(agent.temperature ?? 0.7, 0, 1));
      setSelectedToolIds(new Set(agent.explicitTools.map((tool) => tool.id)));
      return;
    }
    const next = emptyForm();
    setName(next.name);
    setSystemPrompt(next.systemPrompt);
    setModelName(next.modelName);
    setTemperature(next.temperature);
    setSelectedToolIds(next.selectedToolIds);
  }, [open, agent]);

  function close() {
    onOpenChange(false);
  }

  function toggleTool(toolId: UUID) {
    setSelectedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }

  async function upsertAgent() {
    if (saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      onError("智能体名称为必填项。");
      return;
    }

    setSaving(true);
    onError(null);
    try {
      // const { data: userRes, error: userErr } = await supabase.auth.getUser();
      // if (userErr) throw userErr;
      // const user = userRes.user;
      // if (!user) {
      //   onError("未登录。");
      //   return;
      // }

      const payload = {
        name: trimmedName,
        system_prompt: systemPrompt.trim(),
        model_name: modelName,
        temperature: clamp(temperature, 0, 1),
      };

      let agentId = agent?.id ?? null;
      if (agent) {
        const { error: updErr } = await supabase
          .from("agents")
          .update(payload)
          .eq("id", agent.id)
          .eq("user_id", userId);
        if (updErr) throw updErr;
      } else {
        const { data: insData, error: insErr } = await supabase
          .from("agents")
          .insert({ user_id: userId, ...payload })
          .select("id")
          .single();
        if (insErr) throw insErr;
        agentId = (insData as { id: UUID } | null)?.id ?? null;
      }

      if (!agentId) {
        onError("无法解析智能体 ID。");
        return;
      }

      const selected = Array.from(selectedToolIds);
      const { error: delErr } = await supabase
        .from("agent_tools")
        .delete()
        .eq("agent_id", agentId);
      if (delErr) throw delErr;

      if (selected.length > 0) {
        const rows = selected.map((tool_id) => ({
          agent_id: agentId,
          tool_id,
        }));
        const { error: bindErr } = await supabase
          .from("agent_tools")
          .insert(rows);
        if (bindErr) throw bindErr;
      }

      close();
      await onSaved();
    } catch (e: unknown) {
      onError(getErrorMessage(e) ?? "保存智能体失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? "修改智能体" : "创建智能体"}</DialogTitle>
          <DialogDescription>
            配置角色设定、模型参数和显式工具集成。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="agent-name">
              名称
            </label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：客户支持助手"
              className="h-9"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium" htmlFor="agent-prompt">
                系统提示词
              </label>
              <span className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                角色 + 约束
              </span>
            </div>
            <Textarea
              id="agent-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="描述智能体的职责、风格与边界…"
              rows={8}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="agent-model">
                模型
              </label>
              <select
                id="agent-model"
                value={modelName}
                onChange={(e) => {
                  const value = e.target.value;
                  if (isModelValue(value)) setModelName(value);
                }}
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30"
              >
                {MODEL_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {MODEL_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium" htmlFor="agent-temp">
                  温度
                </label>
                <span className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                  {formatTemp(temperature)}
                </span>
              </div>
              <Slider
                id="agent-temp"
                min={0}
                max={1}
                step={0.1}
                value={[temperature]}
                onValueChange={(v) => setTemperature(clamp(v[0] ?? 0.7, 0, 1))}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>0.0 确定性</span>
                <span>1.0 创造性</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">显式工具集成</div>
                <div className="text-xs text-muted-foreground">
                  绑定/解绑真实世界执行权限（邮件、Webhook、代理等）。
                </div>
              </div>
              <span className="inline-flex rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                已选 {selectedToolIds.size} 项
              </span>
            </div>

            {explicitTools.length === 0 ? (
              <div className="rounded-xl border border-dashed border-primary/25 bg-primary/5 p-4 text-sm text-muted-foreground">
                暂无可用显式工具。请先创建工具，再返回此处授予智能体权限。
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {explicitTools.map((tool) => {
                  const checked = selectedToolIds.has(tool.id);
                  return (
                    <label
                      key={tool.id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors",
                        checked
                          ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                          : "hover:bg-primary/5",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTool(tool.id)}
                        className="mt-1 h-4 w-4 accent-primary"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="truncate text-sm font-semibold">
                            {toolLabel(tool)}
                          </div>
                          <span className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                            显式
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {tool.description?.trim()
                            ? tool.description
                            : "暂无描述。"}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="items-center justify-between sm:justify-between">
          <div className="mr-auto text-xs text-muted-foreground">
            隐式工具始终启用，不会在此显示。
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={close} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void upsertAgent()} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  保存中
                </>
              ) : isEditing ? (
                "保存更改"
              ) : (
                "创建智能体"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
