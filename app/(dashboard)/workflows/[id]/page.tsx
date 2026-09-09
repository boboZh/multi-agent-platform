"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  GitBranch,
  Loader2,
  Save,
  TriangleAlert,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createEmptyWorkflowDocument,
  parseWorkflowDocument,
  type WorkflowDocument,
} from "@/lib/workflow-dsl/schema";
import { FLOW_SELECT_COLUMNS, type FlowRecord } from "../types";
import {
  flowDisplayName,
  flowStatusLabel,
  formatRelativeTime,
  getErrorMessage,
  summarizeFlowDsl,
} from "../utils";

/**
 * 工作流编辑器：新增与编辑的唯一入口（列表页只负责跳进来）。
 *
 * 路由约定：`/workflows/new` 走「新建」态。flows.id 是 uuid，永远不会等于字面量 "new"，
 * 所以复用同一个动态段不会和真实工作流撞车，也省掉一份重复的编辑器壳。
 *
 * 落库时机：新建态**不在进入页面时插行**，必须点保存才写库。否则用户点一下「创建工作流」
 * 又返回，就会在目录里留下一堆空的草稿行。
 */

/** 表单快照：只含本页可编辑的字段，用来和已保存值比对出 dirty。 */
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
  /**
   * 画布图的权威来源。新建态先给一张 start→end 空图，保证第一次保存进库的 dsl
   * 就能过 schema 校验、能被列表页正常统计，而不是一个 `{}`。
   */
  const [doc, setDoc] = useState<WorkflowDocument>(() =>
    createEmptyWorkflowDocument("未命名工作流"),
  );
  /** 旧数据（迁移自 flow_data）过不了当前 schema：不能直接喂画布，只能提示重置。 */
  const [dslBroken, setDslBroken] = useState(false);
  /** 图被本地改过（目前只有「重置为空图」）。单独记一个标志，否则只改图不改表单时保存按钮会一直禁用。 */
  const [docDirty, setDocDirty] = useState(false);

  const summary = useMemo(() => summarizeFlowDsl(doc), [doc]);

  const dirty = useMemo(() => {
    if (isNew) return true;
    if (docDirty) return true;
    if (!savedForm) return false;
    return (
      form.name !== savedForm.name || form.description !== savedForm.description
    );
  }, [isNew, docDirty, form, savedForm]);

  /**
   * 编辑态首屏：按 id + mock 用户读一行 flows。
   *
   * 出参：灌 row / form / savedForm / document；查不到时置 notFound。
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
   * 出参：新建成功后把 URL replace 成真实 id（用 replace 而非 push，避免用户按返回
   * 又回到 /workflows/new 再建一行）；编辑成功则刷新本地快照。
   * 步骤：
   * 1. 名称留空按「未命名工作流」入库，防止目录里出现无字卡片。
   * 2. dsl.name 与行上的 name 同步写：两者一旦漂移，编辑器标题和列表标题会各说一套。
   * 3. 新建必须显式带 flow_data —— 那是迁移期遗留列，NOT NULL 且没有默认值，
   *    漏掉会被数据库以 23502 拒掉。新代码只读写 dsl，这里只是塞个空对象占位。
   */
  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    const mockUserId = process.env.NEXT_PUBLIC_MOCK_USER_ID;
    const name = form.name.trim() || "未命名工作流";
    const description = form.description.trim();
    const nextDocument: WorkflowDocument = { ...doc, name };

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
      <header className="flex shrink-0 flex-col gap-3 border-b border-primary/15 bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="icon-sm" aria-label="返回目录">
            <Link href="/workflows">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold tracking-tight text-foreground">
              {isNew ? "新建工作流" : flowDisplayName(form.name)}
            </div>
            <div className="text-xs text-muted-foreground">
              {isNew
                ? "尚未保存 · 点击保存后写入目录"
                : `${flowStatusLabel(row?.status)} · v${row?.version ?? 1} · 最近更新 ${formatRelativeTime(row?.updated_at)}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saveMessage ? (
            <span className="text-xs text-muted-foreground">{saveMessage}</span>
          ) : null}
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

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          {error ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {dslBroken ? (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  这条工作流的 DSL 不符合当前 schema（多为旧 flow_data 迁移数据），已用空图占位。保存会覆盖原数据。
                </span>
              </div>
              <Button variant="outline" size="sm" onClick={resetDoc}>
                重置为空图
              </Button>
            </div>
          ) : null}

          {loading ? (
            <div className="space-y-4">
              <div className="h-24 animate-pulse rounded-xl bg-muted" />
              <div className="h-40 animate-pulse rounded-xl bg-muted" />
            </div>
          ) : (
            <>
              <section className="space-y-4 rounded-xl border border-primary/15 bg-card p-5">
                <div className="space-y-2">
                  <label
                    htmlFor="flow-name"
                    className="text-sm font-medium text-foreground"
                  >
                    名称
                  </label>
                  <Input
                    id="flow-name"
                    value={form.name}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder="例如：客服升级工作流"
                  />
                </div>
                <div className="space-y-2">
                  <label
                    htmlFor="flow-description"
                    className="text-sm font-medium text-foreground"
                  >
                    描述
                  </label>
                  <Textarea
                    id="flow-description"
                    value={form.description}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    }
                    placeholder="这条编排解决什么问题？目录卡片会展示这段摘要。"
                    rows={3}
                  />
                </div>
                {/* status 只读：发布要写 flow_versions 快照并升 version（PLAN Phase 2），不能在这里直接改字段假装发布。 */}
                <div className="text-xs text-muted-foreground">
                  状态：{isNew ? "草稿（保存后创建）" : flowStatusLabel(row?.status)}
                  ；发布与版本快照在后续阶段接入。
                </div>
              </section>

              <section className="rounded-xl border border-dashed border-primary/25 bg-card p-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-foreground">
                    画布编排
                  </div>
                  <div className="inline-flex rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                    {summary.nodeCount} 节点 · {summary.edgeCount} 边
                  </div>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  当前图为 start → end 空骨架。节点面板、连线与右侧配置抽屉尚未接入，
                  保存只会写入这份骨架 DSL 与上面的元数据。
                </p>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
