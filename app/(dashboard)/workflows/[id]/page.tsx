"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CircleCheck,
  GitBranch,
  Loader2,
  Save,
  TriangleAlert,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NodeKind } from "@/lib/workflow-dsl/kinds";
import {
  createEmptyWorkflowDocument,
  parseWorkflowDocument,
  type WorkflowDocument,
  type WorkflowIssue,
} from "@/lib/workflow-dsl/schema";
import {
  FLOW_SELECT_COLUMNS,
  type EditorSelection,
  type FlowRecord,
} from "../types";
import {
  flowDisplayName,
  flowStatusLabel,
  formatRelativeTime,
  getErrorMessage,
  summarizeFlowDsl,
} from "../utils";
import { addNode, nextNodePosition, sanitizeDocumentForSave, type XY } from "../_lib/document";
import { NodePalette } from "../_components/node-palette";
import { WorkflowCanvas } from "../_components/workflow-canvas";
import {
  InspectorDrawer,
  type RefOption,
} from "../_components/inspector-drawer";

/**
 * 工作流编辑器：新增与编辑的唯一入口（列表页只负责跳进来）。
 *
 * 路由约定：`/workflows/new` 走「新建」态。flows.id 是 uuid，永远不会等于字面量 "new"，
 * 所以复用同一个动态段不会和真实工作流撞车，也省掉一份重复的编辑器壳。
 *
 * 落库时机：新建态**不在进入页面时插行**，必须点保存才写库。否则用户点一下「创建工作流」
 * 又返回，就会在目录里留下一堆空的草稿行。
 */

type FlowFormState = {
  name: string;
  description: string;
};

function formFromRow(row: FlowRecord): FlowFormState {
  return {
    name: row.name ?? "",
    description: row.description ?? "",
  };
}

export default function WorkflowEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const isNew = id === "new";
  const router = useRouter();

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [row, setRow] = useState<FlowRecord | null>(null);
  const [form, setForm] = useState<FlowFormState>({
    name: "未命名工作流",
    description: "",
  });
  /** 已落库的表单值；新建态为 null，用来把「没存过」和「存过但没改」区分开。 */
  const [savedForm, setSavedForm] = useState<FlowFormState | null>(null);
  /** 画布图的权威来源，同时直接作为 ReactFlow 的受控数据源。 */
  const [doc, setDoc] = useState<WorkflowDocument>(() =>
    createEmptyWorkflowDocument("未命名工作流"),
  );
  /** 旧数据（迁移自 flow_data）过不了当前 schema：不能直接喂画布，只能提示重置。 */
  const [dslBroken, setDslBroken] = useState(false);
  const [docDirty, setDocDirty] = useState(false);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  /** 校验结果默认只显示计数；展开后才在节点上打红框，避免边搭图边被红圈刷屏。 */
  const [showIssues, setShowIssues] = useState(false);

  const [agents, setAgents] = useState<RefOption[]>([]);
  const [tools, setTools] = useState<RefOption[]>([]);

  /**
   * 实时拓扑校验（graph 档：不要求绑定 agentId，但连线必须成立）。
   * schema 是前后端共用的纯函数，本地跑一遍即可即时反馈，不必来回打 validate 接口。
   */
  const issues = useMemo<WorkflowIssue[]>(() => {
    const parsed = parseWorkflowDocument(doc, "graph");
    return parsed.ok ? [] : parsed.errors;
  }, [doc]);

  const issueNodeIds = useMemo(() => {
    if (!showIssues) return new Set<string>();
    return new Set(
      issues.map((issue) => issue.nodeId).filter((v): v is string => Boolean(v)),
    );
  }, [issues, showIssues]);

  /** 节点卡上要显示「绑定的是哪个智能体/工具」，DSL 里只有 UUID，这里补上名字。 */
  const refNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of agents) map.set(item.id, item.label);
    for (const item of tools) map.set(item.id, item.label);
    return map;
  }, [agents, tools]);

  const dirty = useMemo(() => {
    if (isNew) return true;
    if (docDirty) return true;
    if (!savedForm) return false;
    return (
      form.name !== savedForm.name || form.description !== savedForm.description
    );
  }, [isNew, docDirty, form, savedForm]);

  /**
   * 画布/抽屉的每一次改动都经过这里，统一打脏标记并清掉上一条提示。
   * transient（选中态、reactflow 量出来的宽高）只更新数据不标脏，
   * 否则刚打开页面或点一下节点，保存按钮就会亮起来误导用户。
   */
  const handleDocChange = useCallback(
    (next: WorkflowDocument, options?: { transient?: boolean }) => {
      setDoc(next);
      if (options?.transient) return;
      setDocDirty(true);
      setSaveMessage(null);
    },
    [],
  );

  const handleAddNode = useCallback(
    (kind: NodeKind, position: XY) => {
      setDoc((prev) => {
        const { doc: next, nodeId } = addNode(prev, kind, position);
        // 新节点顺手选中：拖进来十有八九下一步就是配置它。
        setSelection({ type: "node", id: nodeId });
        return next;
      });
      setDocDirty(true);
      setSaveMessage(null);
      setError(null);
    },
    [],
  );

  /** 面板点击（非拖拽）落点由文档算，不依赖画布视口，见 nextNodePosition 说明。 */
  const handlePaletteClick = useCallback(
    (kind: NodeKind) => {
      handleAddNode(kind, nextNodePosition(doc));
    },
    [doc, handleAddNode],
  );

  /** 目录：智能体与显式工具，供 agent / tool 节点绑定。与工作流本身无关，失败不阻塞编辑。 */
  useEffect(() => {
    let cancelled = false;
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;

    async function loadRefs() {
      const [agentsRes, toolsRes] = await Promise.all([
        supabase
          .from("agents")
          .select("id,name")
          .eq("user_id", mockUserId)
          .order("created_at", { ascending: false }),
        supabase
          .from("tools")
          .select("id,name,display_name")
          .eq("user_id", mockUserId)
          .eq("tool_type", "explicit")
          .order("display_name", { ascending: true }),
      ]);
      if (cancelled) return;

      setAgents(
        (agentsRes.data ?? []).map((item) => ({
          id: item.id as string,
          label: (item.name as string) || "未命名智能体",
        })),
      );
      setTools(
        (toolsRes.data ?? []).map((item) => ({
          id: item.id as string,
          label:
            ((item.display_name as string | null) || (item.name as string)) ??
            "未命名工具",
        })),
      );
    }

    void loadRefs();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 编辑态首屏：按 id + mock 用户读一行 flows。
   *
   * 步骤：
   * 1. 带上 user_id 过滤，避免通过改 URL 打开别人的编排（RLS 暂关，这层是唯一防线）。
   * 2. dsl 走 draft 校验：过得了就作为画布初值；过不了保留一张空图并标记 dslBroken，
   *    这样用户仍能改名保存，而不是被一份坏 JSON 卡死在页面上。
   */
  useEffect(() => {
    if (isNew) return;
    let cancelled = false;

    async function loadFlow() {
      setLoading(true);
      setError(null);
      const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
      try {
        const { data, error: selectErr } = await supabase
          .from("flows")
          .select(FLOW_SELECT_COLUMNS)
          .eq("id", id)
          .eq("user_id", mockUserId)
          .maybeSingle();
        if (selectErr) throw selectErr;
        if (cancelled) return;

        if (!data) {
          setNotFound(true);
          return;
        }

        const flow = data as FlowRecord;
        setRow(flow);
        const nextForm = formFromRow(flow);
        setForm(nextForm);
        setSavedForm(nextForm);

        const parsed = parseWorkflowDocument(flow.dsl, "draft");
        if (parsed.ok) {
          setDoc(parsed.document);
          setDslBroken(false);
        } else {
          const empty = summarizeFlowDsl(flow.dsl).state === "empty";
          setDoc(createEmptyWorkflowDocument(nextForm.name || "未命名工作流"));
          setDslBroken(!empty);
        }
        setDocDirty(false);
      } catch (e: unknown) {
        if (!cancelled) setError(getErrorMessage(e) ?? "加载工作流失败。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadFlow();
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  /**
   * 保存。
   *
   * 步骤：
   * 1. 先 sanitize：剥掉 reactflow 挂在节点上的 selected/dragging 等瞬时字段，
   *    顺带确认文档形状合法。不做这一步，选中态会被一起写进 dsl。
   * 2. 名称留空按「未命名工作流」入库；dsl.name 与行上的 name 同步，避免两处标题打架。
   * 3. 新建必须显式带 flow_data —— 迁移期遗留列，NOT NULL 且无默认值，漏掉会被 23502 拒。
   *
   * 注意这里**不拦截拓扑错误**：草稿本来就允许半成品，能不能跑由后续 compile 档把关。
   */
  async function handleSave() {
    if (saving) return;
    const sanitized = sanitizeDocumentForSave(doc);
    if (!sanitized.ok) {
      setError(sanitized.reason);
      return;
    }

    setSaving(true);
    setError(null);
    setSaveMessage(null);
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
    const name = form.name.trim() || "未命名工作流";
    const description = form.description.trim();
    const nextDocument: WorkflowDocument = { ...sanitized.doc, name };

    try {
      if (isNew) {
        const { data, error: insertErr } = await supabase
          .from("flows")
          .insert({
            user_id: mockUserId,
            name,
            description: description || null,
            status: "draft",
            dsl: nextDocument,
            flow_data: {},
          })
          .select("id")
          .single();
        if (insertErr) throw insertErr;

        setDoc(nextDocument);
        router.replace(`/workflows/${(data as { id: string }).id}`);
        return;
      }

      const { data, error: updateErr } = await supabase
        .from("flows")
        .update({
          name,
          description: description || null,
          dsl: nextDocument,
        })
        .eq("id", id)
        .eq("user_id", mockUserId)
        .select(FLOW_SELECT_COLUMNS)
        .single();
      if (updateErr) throw updateErr;

      const flow = data as FlowRecord;
      setRow(flow);
      setDoc(nextDocument);
      const nextForm = formFromRow(flow);
      setForm(nextForm);
      setSavedForm(nextForm);
      setDslBroken(false);
      setDocDirty(false);
      setSaveMessage("已保存。");
    } catch (e: unknown) {
      setError(getErrorMessage(e) ?? "保存工作流失败。");
    } finally {
      setSaving(false);
    }
  }

  /** 用一张干净空图覆盖坏 DSL。仅改本地状态，用户仍需点保存才会落库。 */
  function resetDoc() {
    setDoc(createEmptyWorkflowDocument(form.name.trim() || "未命名工作流"));
    setDslBroken(false);
    setDocDirty(true);
    setSelection(null);
    setSaveMessage(null);
  }

  if (notFound) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="rounded-2xl border border-dashed border-primary/25 bg-card p-10 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <GitBranch className="h-6 w-6 text-primary" />
          </div>
          <div className="mt-4 text-lg font-semibold text-foreground">
            工作流不存在
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            它可能已被删除，或不属于当前用户。
          </div>
          <div className="mt-5 flex justify-center">
            <Button asChild variant="outline">
              <Link href="/workflows">
                <ArrowLeft className="h-4 w-4" />
                返回目录
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-primary/15 bg-card px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon-sm" aria-label="返回目录">
            <Link href="/workflows">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="truncate text-base font-semibold tracking-tight text-foreground">
              {isNew ? "新建工作流" : flowDisplayName(form.name)}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {isNew
                ? "尚未保存 · 点击保存后写入目录"
                : `${flowStatusLabel(row?.status)} · v${row?.version ?? 1} · 最近更新 ${formatRelativeTime(row?.updated_at)}`}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {saveMessage ? (
            <span className="text-xs text-muted-foreground">{saveMessage}</span>
          ) : null}
          <button
            type="button"
            onClick={() => setShowIssues((open) => !open)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              issues.length === 0
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700",
            )}
            aria-expanded={showIssues}
          >
            {issues.length === 0 ? (
              <>
                <CircleCheck className="h-3.5 w-3.5" />
                拓扑校验通过
              </>
            ) : (
              <>
                <TriangleAlert className="h-3.5 w-3.5" />
                {issues.length} 个问题
              </>
            )}
          </button>
          <Button onClick={handleSave} disabled={saving || loading || !dirty}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                保存中
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                {isNew ? "创建并保存" : "保存"}
              </>
            )}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {dslBroken ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-sm text-amber-800">
          <span>
            这条工作流的 DSL 不符合当前 schema（多为旧 flow_data 迁移数据），已用空图占位。保存会覆盖原数据。
          </span>
          <Button variant="outline" size="sm" onClick={resetDoc}>
            重置为空图
          </Button>
        </div>
      ) : null}

      {showIssues && issues.length > 0 ? (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b border-amber-500/30 bg-amber-500/5 px-5 py-2">
          <ul className="space-y-1 text-xs text-amber-800">
            {issues.map((issue, index) => (
              <li key={index} className="flex gap-2">
                <span className="font-mono opacity-70">
                  {issue.nodeId ?? issue.edgeId ?? issue.path.join(".")}
                </span>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <NodePalette onAdd={handlePaletteClick} />
          <WorkflowCanvas
            doc={doc}
            onDocChange={handleDocChange}
            selection={selection}
            onSelectionChange={setSelection}
            onAddNode={handleAddNode}
            issueNodeIds={issueNodeIds}
            refNames={refNames}
            onError={setError}
          />
          <InspectorDrawer
            doc={doc}
            onDocChange={handleDocChange}
            selection={selection}
            onSelectionChange={setSelection}
            name={form.name}
            description={form.description}
            onNameChange={(value) =>
              setForm((prev) => ({ ...prev, name: value }))
            }
            onDescriptionChange={(value) =>
              setForm((prev) => ({ ...prev, description: value }))
            }
            agents={agents}
            tools={tools}
            onError={setError}
          />
        </div>
      )}
    </div>
  );
}
