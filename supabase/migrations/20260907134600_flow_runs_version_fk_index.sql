create index if not exists flow_runs_flow_id_version_idx
  on public.flow_runs (flow_id, flow_version);
