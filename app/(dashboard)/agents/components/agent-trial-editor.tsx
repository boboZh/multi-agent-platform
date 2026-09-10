"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MODEL_LABELS,
  MODEL_VALUES,
  type ModelValue,
  type ToolRow,
  type UUID,
} from "../lib/types";
import { clamp, formatTemp, isModelValue, toolLabel } from "../lib/utils";

/**
 * 试运行侧栏的可编辑快照。与 DB 行刻意拆开：
 * 左侧改草稿不应立刻改 `agents` 表，也不应改已经 freeze 在各 thread.config 里的参数。
 * `selectedToolIds` 用数组而非 Set，便于 JSON 进 /api/chat 以及 draftsEqual 做浅比较。
 */
export type AgentDraft = {
  name: string;
  systemPrompt: string;
  modelName: ModelValue;
  temperature: number;
  selectedToolIds: UUID[];
};

/**
 * DB 行 → 表单草稿。把可空/越界字段洗成编辑器能受控的值，避免 Slider/select 拿到 null。
 *
 * 入参：智能体行 + 已绑定显式工具。
 * 出参：始终合法的 AgentDraft（未知模型回落 MODEL_VALUES[0]，温度 clamp 到 0–1）。
 */
export function draftFromAgent(agent: {
  name: string;
  system_prompt: string | null;
  model_name: string | null;
  temperature: number | null;
  explicitTools: ToolRow[];
}): AgentDraft {
  return {
    name: agent.name || "",
    systemPrompt: agent.system_prompt || "",
    modelName: isModelValue(agent.model_name)
      ? agent.model_name
      : MODEL_VALUES[0],
    temperature: clamp(agent.temperature ?? 0.7, 0, 1),
    selectedToolIds: agent.explicitTools.map((tool) => tool.id),
  };
}

/**
 * 脏检查。工具 id 先排序再比，避免「勾选顺序不同」被当成未保存；
 * name 只比 trim，防止仅尾随空格就点亮保存按钮。
 */
export function draftsEqual(a: AgentDraft, b: AgentDraft) {
  const aIds = [...a.selectedToolIds].sort();
  const bIds = [...b.selectedToolIds].sort();
  return (
    a.name.trim() === b.name.trim() &&
    a.systemPrompt === b.systemPrompt &&
    a.modelName === b.modelName &&
    clamp(a.temperature, 0, 1) === clamp(b.temperature, 0, 1) &&
    aIds.length === bIds.length &&
    aIds.every((id, i) => id === bIds[i])
  );
}

type AgentTrialEditorProps = {
  draft: AgentDraft;
  availableTools: ToolRow[];
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<AgentDraft>) => void;
  onSave: () => void;
};

export function AgentTrialEditor({
  draft,
  availableTools,
  dirty,
  saving,
  disabled,
  onChange,
  onSave,
}: AgentTrialEditorProps) {
  function toggleTool(toolId: UUID) {
    const selected = new Set(draft.selectedToolIds);
    if (selected.has(toolId)) selected.delete(toolId);
    else selected.add(toolId);
    // 回传新数组：父组件用 spread 合并 patch，原地 mutate draft.selectedToolIds 不会触发 dirty 重算。
    onChange({ selectedToolIds: Array.from(selected) });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="trial-agent-name">
            名称
          </label>
          <Input
            id="trial-agent-name"
            value={draft.name}
            disabled={disabled}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="例如：客户支持助手"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="trial-agent-model">
            模型
          </label>
          <select
            id="trial-agent-model"
            value={draft.modelName}
            disabled={disabled}
            onChange={(e) => {
              const value = e.target.value;
              if (isModelValue(value)) onChange({ modelName: value });
            }}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30"
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
            <label className="text-sm font-medium" htmlFor="trial-agent-temp">
              温度
            </label>
            <span className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {formatTemp(draft.temperature)}
            </span>
          </div>
          <Slider
            id="trial-agent-temp"
            min={0}
            max={1}
            step={0.1}
            disabled={disabled}
            value={[draft.temperature]}
            onValueChange={(v) =>
              onChange({ temperature: clamp(v[0] ?? 0.7, 0, 1) })
            }
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>0.0 确定性</span>
            <span>1.0 创造性</span>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="trial-agent-prompt">
            系统提示词
          </label>
          <Textarea
            id="trial-agent-prompt"
            value={draft.systemPrompt}
            disabled={disabled}
            onChange={(e) => onChange({ systemPrompt: e.target.value })}
            placeholder="描述智能体的职责、风格与边界…"
            rows={8}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">显式工具</div>
            <span className="text-xs text-muted-foreground">
              已选 {draft.selectedToolIds.length} 项
            </span>
          </div>
          {availableTools.length === 0 ? (
            <p className="rounded-xl border border-dashed border-primary/25 bg-primary/5 p-3 text-xs text-muted-foreground">
              暂无可用显式工具。
            </p>
          ) : (
            <div className="space-y-2">
              {availableTools.map((tool) => {
                const checked = draft.selectedToolIds.includes(tool.id);
                return (
                  <label
                    key={tool.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm transition-colors",
                      checked
                        ? "border-primary bg-primary/10 ring-1 ring-primary/20"
                        : "hover:bg-primary/5",
                      disabled && "pointer-events-none opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleTool(tool.id)}
                      className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {toolLabel(tool)}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {tool.description?.trim() || "暂无描述"}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="border-t p-4">
        <Button
          className="w-full"
          // 流式中禁用：保存会立刻开新对话，不能和 in-flight SSE 抢同一份 threads state。
          disabled={disabled || saving || !dirty || !draft.name.trim()}
          onClick={onSave}
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              保存中
            </>
          ) : (
            "保存"
          )}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          {dirty
            ? "当前为草稿。不保存则发消息仍用原参数；保存后发消息会用新参数开启新对话。"
            : "配置已与已保存版本一致。新对话会使用这里保存的参数。"}
        </p>
      </div>
    </div>
  );
}
