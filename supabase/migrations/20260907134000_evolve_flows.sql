-- Evolve public.flows and add flow_versions / flow_runs (PLAN.md §1).
-- user_id is uuid without FK to auth.users: existing agents/tools follow the same
-- pattern, and this project currently has no auth.users rows (mock user ids).

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

alter table public.flows
  add column if not exists user_id uuid,
  add column if not exists description text,
  add column if not exists status text not null default 'draft',
  add column if not exists version integer not null default 1,
  add column if not exists dsl jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

update public.flows
set dsl = flow_data
where coalesce(dsl, '{}'::jsonb) = '{}'::jsonb
  and flow_data is not null;

alter table public.flows
  drop constraint if exists flows_status_check,
  drop constraint if exists flows_version_positive;

alter table public.flows
  add constraint flows_status_check
    check (status in ('draft', 'published', 'archived')),
  add constraint flows_version_positive
    check (version >= 1);

create index if not exists flows_user_updated_at_idx
  on public.flows (user_id, updated_at desc);

drop trigger if exists flows_set_updated_at on public.flows;
create trigger flows_set_updated_at
  before update on public.flows
  for each row
  execute function public.set_updated_at();

create table if not exists public.flow_versions (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete cascade,
  version integer not null,
  dsl jsonb not null,
  published_at timestamptz not null default now(),
  unique (flow_id, version),
  constraint flow_versions_version_positive check (version >= 1)
);

create table if not exists public.flow_runs (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows (id) on delete restrict,
  flow_version integer not null,
  user_id uuid not null,
  thread_id text not null unique,
  status text not null default 'pending',
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  interrupt_payload jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint flow_runs_status_check
    check (status in (
      'pending',
      'running',
      'interrupted',
      'completed',
      'failed',
      'cancelled'
    )),
  constraint flow_runs_flow_version_fkey
    foreign key (flow_id, flow_version)
    references public.flow_versions (flow_id, version)
);

create index if not exists flow_runs_flow_created_at_idx
  on public.flow_runs (flow_id, created_at desc);

create index if not exists flow_runs_user_status_idx
  on public.flow_runs (user_id, status);

drop trigger if exists flow_runs_set_updated_at on public.flow_runs;
create trigger flow_runs_set_updated_at
  before update on public.flow_runs
  for each row
  execute function public.set_updated_at();

alter table public.flows enable row level security;
alter table public.flow_versions enable row level security;
alter table public.flow_runs enable row level security;

-- Unused stub table; lock down until it is removed or replaced by flow_runs.
alter table public.executions enable row level security;

drop policy if exists flows_select_own on public.flows;
drop policy if exists flows_insert_own on public.flows;
drop policy if exists flows_update_own on public.flows;
drop policy if exists flows_delete_own on public.flows;

create policy flows_select_own
  on public.flows
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy flows_insert_own
  on public.flows
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy flows_update_own
  on public.flows
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy flows_delete_own
  on public.flows
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists flow_versions_select_own on public.flow_versions;
drop policy if exists flow_versions_insert_own on public.flow_versions;
drop policy if exists flow_versions_delete_own on public.flow_versions;

create policy flow_versions_select_own
  on public.flow_versions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.flows f
      where f.id = flow_versions.flow_id
        and f.user_id = (select auth.uid())
    )
  );

create policy flow_versions_insert_own
  on public.flow_versions
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.flows f
      where f.id = flow_versions.flow_id
        and f.user_id = (select auth.uid())
    )
  );

create policy flow_versions_delete_own
  on public.flow_versions
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.flows f
      where f.id = flow_versions.flow_id
        and f.user_id = (select auth.uid())
    )
  );

drop policy if exists flow_runs_select_own on public.flow_runs;
drop policy if exists flow_runs_insert_own on public.flow_runs;
drop policy if exists flow_runs_update_own on public.flow_runs;
drop policy if exists flow_runs_delete_own on public.flow_runs;

create policy flow_runs_select_own
  on public.flow_runs
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy flow_runs_insert_own
  on public.flow_runs
  for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.flows f
      where f.id = flow_runs.flow_id
        and f.user_id = (select auth.uid())
    )
  );

create policy flow_runs_update_own
  on public.flow_runs
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy flow_runs_delete_own
  on public.flow_runs
  for delete
  to authenticated
  using (user_id = (select auth.uid()));
