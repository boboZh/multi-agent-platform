import { createSupabaseAdmin } from "@/lib/supabase-admin";
import type {
  FlowRunEventRow,
  FlowRunPersistedEventType,
  FlowRunRow,
  FlowRunStatus,
  FlowRunInterruptPayload,
} from "@/lib/workflow-dsl/tables";
import { FLOW_RUN_SELECT_COLUMNS } from "@/lib/workflow-dsl/tables";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";

export type FlowRunPatch = {
  status?: FlowRunStatus;
  output?: Record<string, unknown> | null;
  interrupt_payload?: FlowRunInterruptPayload | null;
  error?: string | null;
};

/**
 * 入参：runId + 要合并的列。出参：更新后的行，失败抛错。
 * 只写运行态字段，避免误改 thread_id / flow_version。
 */
export async function patchFlowRun(
  runId: string,
  patch: FlowRunPatch,
): Promise<FlowRunRow> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("flow_runs")
    .update(patch)
    .eq("id", runId)
    .select(FLOW_RUN_SELECT_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "更新 flow_runs 失败");
  }
  return data as FlowRunRow;
}

export async function loadFlowRun(
  runId: string,
  userId: string,
): Promise<FlowRunRow | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("flow_runs")
    .select(FLOW_RUN_SELECT_COLUMNS)
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FlowRunRow | null) ?? null;
}

function payloadOf(event: WorkflowSseEvent): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  return rest as Record<string, unknown>;
}

export async function insertPersistedEvent(
  runId: string,
  seq: number,
  event: WorkflowSseEvent,
) {
  if (event.type === "token" || event.type === "done") return;
  const supabase = createSupabaseAdmin();
  const { error } = await supabase.from("flow_run_events").insert({
    run_id: runId,
    seq,
    type: event.type as FlowRunPersistedEventType,
    payload: payloadOf(event),
  });
  if (error) {
    throw new Error(error.message);
  }
}

export async function listPersistedEvents(
  runId: string,
): Promise<{ seq: number; event: WorkflowSseEvent }[]> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("flow_run_events")
    .select("id,run_id,seq,type,payload,created_at")
    .eq("run_id", runId)
    .order("seq", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as FlowRunEventRow[]).map((row) => ({
    seq: Number(row.seq),
    event: { type: row.type, ...row.payload } as WorkflowSseEvent,
  }));
}
