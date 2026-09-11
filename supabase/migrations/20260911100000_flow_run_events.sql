-- Coarse-grained run timeline. Tokens stay in Redis SSE buffer, not here.
create table if not exists public.flow_run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.flow_runs (id) on delete cascade,
  seq bigint not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, seq),
  constraint flow_run_events_type_check
    check (type in (
      'run_status',
      'node_start',
      'node_end',
      'tool_start',
      'tool_end',
      'interrupt',
      'error'
    ))
);

create index if not exists flow_run_events_run_seq_idx
  on public.flow_run_events (run_id, seq);

alter table public.flow_run_events enable row level security;

drop policy if exists flow_run_events_select_own on public.flow_run_events;
drop policy if exists flow_run_events_insert_own on public.flow_run_events;
drop policy if exists flow_run_events_delete_own on public.flow_run_events;

create policy flow_run_events_select_own
  on public.flow_run_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.flow_runs r
      where r.id = flow_run_events.run_id
        and r.user_id = (select auth.uid())
    )
  );

create policy flow_run_events_insert_own
  on public.flow_run_events
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.flow_runs r
      where r.id = flow_run_events.run_id
        and r.user_id = (select auth.uid())
    )
  );

create policy flow_run_events_delete_own
  on public.flow_run_events
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.flow_runs r
      where r.id = flow_run_events.run_id
        and r.user_id = (select auth.uid())
    )
  );
