"use client";

import { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { REVIEW_FIELD_TYPES, NODE_KIND_LABELS } from "@/lib/workflow-dsl/kinds";
import type {
  WorkflowDocument,
  WorkflowNodeData,
} from "@/lib/workflow-dsl/schema";
import { MODEL_LABELS, MODEL_VALUES } from "../../agents/lib/types";
import {
  addConditionBranch,
  removeConditionBranch,
  renameConditionBranch,
  setConditionBranchLabel,
  updateNode,
} from "../lib/document";
import {
  duplicateInputMapTargets,
  inputMapFromRows,
  isLikelyStatePath,
  isValidInputMapTarget,
  rowsFromInputMap,
  type InputMapRow,
} from "../lib/input-map";
import type { EditorSelection } from "../types";

/**
 * 右侧配置抽屉。
 *
 * 交互上刻意不做全屏遮罩：编排时经常要一边看画布连线一边改配置，
 * 遮罩会把画布锁死。这里是常驻的一列，宽度固定，画布自己缩。
 */

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/30";

export type RefOption = { id: string; label: string };

type InspectorProps = {
  doc: WorkflowDocument;
  onDocChange: (doc: WorkflowDocument) => void;
  selection: EditorSelection | null;
  onSelectionChange: (selection: EditorSelection | null) => void;
  name: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  agents: RefOption[];
  tools: RefOption[];
  onError: (message: string | null) => void;
};

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * 分支 key 输入框。
 *
 * 用本地态 + 失焦提交，而不是边打字边改文档：key 同时被 sourceHandle、data.branchKey
 * 和 defaultBranch 引用，逐字符改名会在中间态（比如把 "yes" 打成 "y"）反复重连边，
 * 既闪烁又可能撞上「key 已存在」的校验。
 *
 * 不需要 effect 同步外部值：调用方以 branch.key 作 key，改名成功后组件整体重挂，
 * draft 自然拿到新值；改名被拒时反而应该保留用户输入，让他就地改而不是被悄悄回滚。
 */
function BranchKeyInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  function commit() {
    const next = draft.trim();
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    onCommit(next);
  }

  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(value);
      }}
      className="h-8 font-mono text-xs"
      aria-label="分支 key"
    />
  );
}

/**
 * inputMap 行编辑器。
 *
 * 入参：DSL 里的映射、目标键文案；出参：只含完整键值对的 Record 或 undefined。
 * 执行步骤：
 * 1. 初次挂载时把 record 展成有稳定 id 的行，保证逐字符改目标键时输入框不失焦。
 * 2. 每次编辑先保留本地半成品，再把完整行折叠回 record 通知文档。
 * 3. 重复键、非法目标键和可疑路径就地提示；路径只警告不拦截，因为编译器语法尚未最终确定。
 *
 * 调用方必须以 node.id 作为本组件祖先的 React key：用户切到另一个同 kind 节点时，
 * 需要重新从那个节点的 inputMap 建立行状态，不能沿用上一个节点的本地半成品。
 */
function InputMapEditor({
  value,
  onChange,
  targetLabel,
  targetPlaceholder,
}: {
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
  targetLabel: string;
  targetPlaceholder: string;
}) {
  const [rows, setRows] = useState<InputMapRow[]>(() =>
    rowsFromInputMap(value),
  );
  const duplicates = duplicateInputMapTargets(rows);

  function sameMap(
    left: Record<string, string> | undefined,
    right: Record<string, string> | undefined,
  ) {
    const leftEntries = Object.entries(left ?? {});
    const rightEntries = Object.entries(right ?? {});
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([key, source]) => right?.[key] === source)
    );
  }

  function commitRows(nextRows: InputMapRow[]) {
    setRows(nextRows);
    const nextMap = inputMapFromRows(nextRows);
    // 添加一条空白行只是 UI 准备动作，不能把文档无意义地标成 dirty。
    if (!sameMap(value, nextMap)) onChange(nextMap);
  }

  function patchRow(id: string, patch: Partial<InputMapRow>) {
    commitRows(
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">输入映射</div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            从共享 state 取值并注入本节点。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() =>
            setRows((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                target: "",
                source: "",
              },
            ])
          }
        >
          <Plus className="h-3 w-3" />
          添加
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-primary/20 px-3 py-4 text-center text-xs text-muted-foreground">
          未配置映射，节点只使用默认上下文。
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_28px] gap-1.5 px-1 text-[10px] font-medium text-muted-foreground">
            <span>{targetLabel}</span>
            <span>state 取值路径</span>
            <span />
          </div>

          {rows.map((row) => {
            const target = row.target.trim();
            const source = row.source.trim();
            const targetInvalid = Boolean(target) && !isValidInputMapTarget(target);
            const sourceSuspicious = Boolean(source) && !isLikelyStatePath(source);
            const duplicated = Boolean(target) && duplicates.has(target);

            return (
              <div
                key={row.id}
                className="rounded-lg border border-primary/15 bg-muted/30 p-2"
              >
                <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_28px] items-center gap-1.5">
                  <Input
                    value={row.target}
                    placeholder={targetPlaceholder}
                    aria-label={targetLabel}
                    aria-invalid={targetInvalid || duplicated}
                    className="h-8 font-mono text-xs"
                    onChange={(event) =>
                      patchRow(row.id, { target: event.target.value })
                    }
                  />
                  <Input
                    value={row.source}
                    placeholder="state.vars.order_id"
                    aria-label="state 取值路径"
                    aria-invalid={sourceSuspicious}
                    className="h-8 font-mono text-xs"
                    onChange={(event) =>
                      patchRow(row.id, { source: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除输入映射 ${target || "空行"}`}
                    onClick={() =>
                      commitRows(rows.filter((item) => item.id !== row.id))
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {targetInvalid || duplicated || sourceSuspicious ? (
                  <div
                    className={cn(
                      "mt-1.5 text-[10px] leading-relaxed",
                      targetInvalid || duplicated
                        ? "text-destructive"
                        : "text-amber-700",
                    )}
                  >
                    {targetInvalid
                      ? "目标键只能使用字母、数字、下划线，且不能以数字开头；修正前不会写入 DSL。"
                      : duplicated
                        ? "目标键重复；当前 DSL 只会保留最后一条。"
                        : "路径通常应以 state. 开头；当前仅提示，不阻止保存。"}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StartEndForm() {
  return (
    <p className="text-sm text-muted-foreground">
      该节点没有可配置项，只作为流程的起点/终点。
    </p>
  );
}

function AgentForm({
  data,
  agents,
  onChange,
}: {
  data: Extract<WorkflowNodeData, { kind: "agent" }>;
  agents: RefOption[];
  onChange: (next: WorkflowNodeData) => void;
}) {
  return (
    <>
      <Field
        label="绑定智能体"
        htmlFor="node-agent"
        hint="只列出当前用户已创建的智能体；运行时按这个 id 加载它的提示词与工具。"
      >
        <select
          id="node-agent"
          className={SELECT_CLASS}
          value={data.config.agentId ?? ""}
          onChange={(e) =>
            onChange({
              ...data,
              config: {
                ...data.config,
                agentId: e.target.value || undefined,
              },
            })
          }
        >
          <option value="">未绑定</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label}
            </option>
          ))}
        </select>
      </Field>
      <InputMapEditor
        value={data.config.inputMap}
        targetLabel="注入变量名"
        targetPlaceholder="order"
        onChange={(inputMap) =>
          onChange({
            ...data,
            config: { ...data.config, inputMap },
          })
        }
      />
      <Field
        label="输出键"
        htmlFor="node-agent-output"
        hint="模型输出写进共享 state 的哪个键，下游条件表达式据此取值。"
      >
        <Input
          id="node-agent-output"
          value={data.config.outputKey}
          onChange={(e) =>
            onChange({
              ...data,
              config: { ...data.config, outputKey: e.target.value },
            })
          }
        />
      </Field>
    </>
  );
}

function ToolForm({
  data,
  tools,
  onChange,
}: {
  data: Extract<WorkflowNodeData, { kind: "tool" }>;
  tools: RefOption[];
  onChange: (next: WorkflowNodeData) => void;
}) {
  return (
    <>
      <Field label="绑定工具" htmlFor="node-tool">
        <select
          id="node-tool"
          className={SELECT_CLASS}
          value={data.config.toolId ?? ""}
          onChange={(e) =>
            onChange({
              ...data,
              config: { ...data.config, toolId: e.target.value || undefined },
            })
          }
        >
          <option value="">未绑定</option>
          {tools.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.label}
            </option>
          ))}
        </select>
      </Field>
      <InputMapEditor
        value={data.config.inputMap}
        targetLabel="工具参数名"
        targetPlaceholder="order_id"
        onChange={(inputMap) =>
          onChange({
            ...data,
            config: { ...data.config, inputMap },
          })
        }
      />
      <Field label="输出键" htmlFor="node-tool-output" hint="留空则不写回 state。">
        <Input
          id="node-tool-output"
          value={data.config.outputKey ?? ""}
          onChange={(e) =>
            onChange({
              ...data,
              config: {
                ...data.config,
                outputKey: e.target.value || undefined,
              },
            })
          }
        />
      </Field>
    </>
  );
}

function ConditionForm({
  doc,
  nodeId,
  data,
  onDocChange,
  onChange,
  onError,
}: {
  doc: WorkflowDocument;
  nodeId: string;
  data: Extract<WorkflowNodeData, { kind: "condition" }>;
  onDocChange: (doc: WorkflowDocument) => void;
  onChange: (next: WorkflowNodeData) => void;
  onError: (message: string | null) => void;
}) {
  const { config } = data;

  return (
    <>
      <Field
        label="判定方式"
        htmlFor="node-cond-mode"
        hint="表达式在服务端做白名单求值；LLM 路由则要求模型只输出某个分支 key。"
      >
        <select
          id="node-cond-mode"
          className={SELECT_CLASS}
          value={config.mode}
          onChange={(e) => {
            // 两种模式的字段完全不同，切换时按目标模式重建 config，
            // 否则会留下 expression 与 prompt 并存的半截数据，过不了 discriminatedUnion。
            const shared = {
              branches: config.branches,
              defaultBranch: config.defaultBranch,
            };
            onChange(
              e.target.value === "llm"
                ? {
                    ...data,
                    config: {
                      ...shared,
                      mode: "llm",
                      modelName: MODEL_VALUES[0],
                      prompt: "根据对话判断应该走哪个分支，只输出分支 key。",
                    },
                  }
                : {
                    ...data,
                    config: {
                      ...shared,
                      mode: "expression",
                      expression: "state.vars.need_human === true",
                    },
                  },
            );
          }}
        >
          <option value="expression">表达式</option>
          <option value="llm">LLM 路由</option>
        </select>
      </Field>

      {config.mode === "expression" ? (
        <Field label="表达式" htmlFor="node-cond-expr">
          <Textarea
            id="node-cond-expr"
            rows={3}
            className="font-mono text-xs"
            value={config.expression}
            onChange={(e) =>
              onChange({
                ...data,
                config: { ...config, expression: e.target.value },
              })
            }
          />
        </Field>
      ) : (
        <>
          <Field label="模型" htmlFor="node-cond-model">
            <select
              id="node-cond-model"
              className={SELECT_CLASS}
              value={config.modelName}
              onChange={(e) =>
                onChange({
                  ...data,
                  config: { ...config, modelName: e.target.value },
                })
              }
            >
              {MODEL_VALUES.map((value) => (
                <option key={value} value={value}>
                  {MODEL_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="路由提示词" htmlFor="node-cond-prompt">
            <Textarea
              id="node-cond-prompt"
              rows={3}
              value={config.prompt}
              onChange={(e) =>
                onChange({
                  ...data,
                  config: { ...config, prompt: e.target.value },
                })
              }
            />
          </Field>
        </>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">分支</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              const result = addConditionBranch(doc, nodeId);
              if (!result.ok) {
                onError(result.reason);
                return;
              }
              onError(null);
              onDocChange(result.doc);
            }}
          >
            <Plus className="h-3 w-3" />
            添加
          </Button>
        </div>
        {config.branches.map((branch) => (
          <div
            key={branch.key}
            className="space-y-1.5 rounded-lg border border-primary/15 bg-muted/40 p-2"
          >
            <div className="flex items-center gap-1.5">
              <BranchKeyInput
                value={branch.key}
                onCommit={(next) => {
                  const result = renameConditionBranch(
                    doc,
                    nodeId,
                    branch.key,
                    next,
                  );
                  if (!result.ok) {
                    onError(result.reason);
                    return;
                  }
                  onError(null);
                  onDocChange(result.doc);
                }}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除分支 ${branch.key}`}
                onClick={() => {
                  const result = removeConditionBranch(doc, nodeId, branch.key);
                  if (!result.ok) {
                    onError(result.reason);
                    return;
                  }
                  onError(null);
                  onDocChange(result.doc);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Input
              value={branch.label}
              placeholder="显示名"
              className="h-8"
              aria-label={`分支 ${branch.key} 的显示名`}
              onChange={(e) =>
                onDocChange(
                  setConditionBranchLabel(doc, nodeId, branch.key, e.target.value),
                )
              }
            />
          </div>
        ))}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          改 key 会同步改掉对应连线；删分支会连带删掉那条线。
        </p>
      </div>

      <Field
        label="兜底分支"
        htmlFor="node-cond-default"
        hint="表达式报错或 LLM 输出不在分支列表里时走这一条。"
      >
        <select
          id="node-cond-default"
          className={SELECT_CLASS}
          value={config.defaultBranch}
          onChange={(e) =>
            onChange({
              ...data,
              config: { ...config, defaultBranch: e.target.value },
            })
          }
        >
          {config.branches.map((branch) => (
            <option key={branch.key} value={branch.key}>
              {branch.label || branch.key}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function HumanReviewForm({
  data,
  onChange,
  onError,
}: {
  data: Extract<WorkflowNodeData, { kind: "human_review" }>;
  onChange: (next: WorkflowNodeData) => void;
  onError: (message: string | null) => void;
}) {
  const fields = data.config.formFields;

  function patchField(index: number, patch: Partial<(typeof fields)[number]>) {
    onChange({
      ...data,
      config: {
        ...data.config,
        formFields: fields.map((field, i) =>
          i === index ? { ...field, ...patch } : field,
        ),
      },
    });
  }

  return (
    <>
      <Field label="审核标题" htmlFor="node-review-title">
        <Input
          id="node-review-title"
          value={data.config.title}
          onChange={(e) =>
            onChange({
              ...data,
              config: { ...data.config, title: e.target.value },
            })
          }
        />
      </Field>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">表单字段</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              onChange({
                ...data,
                config: {
                  ...data.config,
                  formFields: [
                    ...fields,
                    { name: `field_${fields.length + 1}`, type: "text" },
                  ],
                },
              })
            }
          >
            <Plus className="h-3 w-3" />
            添加
          </Button>
        </div>

        {fields.map((field, index) => (
          <div
            key={index}
            className="space-y-1.5 rounded-lg border border-primary/15 bg-muted/40 p-2"
          >
            <div className="flex items-center gap-1.5">
              <Input
                value={field.name}
                className="h-8 font-mono text-xs"
                aria-label="字段名"
                onChange={(e) => patchField(index, { name: e.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`删除字段 ${field.name}`}
                onClick={() => {
                  // schema 要求至少一个字段，删空会让整份文档非法。
                  if (fields.length <= 1) {
                    onError("人工审核至少需要保留一个表单字段。");
                    return;
                  }
                  onError(null);
                  onChange({
                    ...data,
                    config: {
                      ...data.config,
                      formFields: fields.filter((_, i) => i !== index),
                    },
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <select
              className={`${SELECT_CLASS} h-8`}
              value={field.type}
              aria-label="字段类型"
              onChange={(e) => {
                const type = e.target.value as (typeof REVIEW_FIELD_TYPES)[number];
                // 从 enum 切走时清掉 options，避免留下一份没人读的死数据。
                patchField(index, {
                  type,
                  options: type === "enum" ? (field.options ?? ["approve"]) : undefined,
                });
              }}
            >
              {REVIEW_FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            {field.type === "enum" ? (
              <Input
                value={(field.options ?? []).join(", ")}
                placeholder="approve, reject"
                className="h-8"
                aria-label="枚举选项"
                onChange={(e) =>
                  patchField(index, {
                    options: e.target.value
                      .split(",")
                      .map((option) => option.trim())
                      .filter(Boolean),
                  })
                }
              />
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

/** 边只读展示：source/target 与 branchKey 都由画布连线决定，手改这里只会造成不一致。 */
function EdgeInspector({
  doc,
  edgeId,
}: {
  doc: WorkflowDocument;
  edgeId: string;
}) {
  const edge = doc.edges.find((item) => item.id === edgeId);
  if (!edge) return <p className="text-sm text-muted-foreground">连线已不存在。</p>;

  return (
    <div className="space-y-2 text-sm">
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">来源</span>
        <span className="font-mono text-xs">{edge.source}</span>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">目标</span>
        <span className="font-mono text-xs">{edge.target}</span>
      </div>
      <div className="flex justify-between gap-2">
        <span className="text-muted-foreground">类型</span>
        <span className="font-mono text-xs">{edge.data.kind}</span>
      </div>
      {edge.data.kind === "branch" ? (
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">分支</span>
          <span className="font-mono text-xs">{edge.data.branchKey}</span>
        </div>
      ) : null}
      <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
        连线的分支归属跟着端口走，要改请在画布上重新连，或到条件节点里改分支 key。
      </p>
    </div>
  );
}

export function InspectorDrawer({
  doc,
  onDocChange,
  selection,
  onSelectionChange,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  agents,
  tools,
  onError,
}: InspectorProps) {
  const node =
    selection?.type === "node"
      ? doc.nodes.find((item) => item.id === selection.id)
      : undefined;

  function updateData(next: WorkflowNodeData) {
    if (!node) return;
    onDocChange(updateNode(doc, node.id, () => next));
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-primary/15 bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-primary/10 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">
            {node
              ? NODE_KIND_LABELS[node.data.kind]
              : selection?.type === "edge"
                ? "连线"
                : "工作流设置"}
          </div>
          {node ? (
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {node.id}
            </div>
          ) : null}
        </div>
        {selection ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="取消选中"
            onClick={() => onSelectionChange(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="space-y-4 p-4">
        {!selection ? (
          <>
            <Field label="名称" htmlFor="flow-name">
              <Input
                id="flow-name"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="例如：客服升级工作流"
              />
            </Field>
            <Field
              label="描述"
              htmlFor="flow-description"
              hint="目录卡片会展示这段摘要。"
            >
              <Textarea
                id="flow-description"
                rows={4}
                value={description}
                onChange={(e) => onDescriptionChange(e.target.value)}
              />
            </Field>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              选中画布上的节点或连线可以配置它；点击空白处回到这里。
            </p>
          </>
        ) : selection.type === "edge" ? (
          <EdgeInspector doc={doc} edgeId={selection.id} />
        ) : !node ? (
          <p className="text-sm text-muted-foreground">节点已不存在。</p>
        ) : (
          <>
            <Field label="节点名称" htmlFor="node-label">
              <Input
                id="node-label"
                value={node.data.label}
                onChange={(e) =>
                  updateData({ ...node.data, label: e.target.value })
                }
              />
            </Field>

            {node.data.kind === "start" || node.data.kind === "end" ? (
              <StartEndForm />
            ) : null}
            {node.data.kind === "agent" ? (
              <AgentForm
                key={node.id}
                data={node.data}
                agents={agents}
                onChange={updateData}
              />
            ) : null}
            {node.data.kind === "tool" ? (
              <ToolForm
                key={node.id}
                data={node.data}
                tools={tools}
                onChange={updateData}
              />
            ) : null}
            {node.data.kind === "condition" ? (
              <ConditionForm
                doc={doc}
                nodeId={node.id}
                data={node.data}
                onDocChange={onDocChange}
                onChange={updateData}
                onError={onError}
              />
            ) : null}
            {node.data.kind === "human_review" ? (
              <HumanReviewForm
                data={node.data}
                onChange={updateData}
                onError={onError}
              />
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
