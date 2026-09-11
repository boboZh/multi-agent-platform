import { createSupabaseAdmin } from "@/lib/supabase-admin";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";
import type { FlowRunRow, FlowVersionRow } from "@/lib/workflow-dsl/tables";
import { FLOW_RUN_SELECT_COLUMNS } from "@/lib/workflow-dsl/tables";

export type RunWithDsl = {
  run: FlowRunRow;
  dsl: WorkflowDocument;
  flowName: string;
};

export async function loadRunWithDsl(
  runId: string,
  userId: string,
): Promise<RunWithDsl | null> {
  const supabase = createSupabaseAdmin();
  const { data: run, error } = await supabase
    .from("flow_runs")
    .select(FLOW_RUN_SELECT_COLUMNS)
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!run) return null;
  const row = run as FlowRunRow;

  const { data: version, error: versionErr } = await supabase
    .from("flow_versions")
    .select("id,flow_id,version,dsl,published_at")
    .eq("flow_id", row.flow_id)
    .eq("version", row.flow_version)
    .maybeSingle();
  if (versionErr) throw new Error(versionErr.message);
  if (!version) return null;

  const { data: flow } = await supabase
    .from("flows")
    .select("name")
    .eq("id", row.flow_id)
    .maybeSingle();

  return {
    run: row,
    dsl: (version as FlowVersionRow).dsl,
    flowName: (flow as { name?: string } | null)?.name ?? "",
  };
}
