-- LangGraph PostgresSaver tables. Isolated from public so PostgREST / chat never see binary checkpoints.
-- 把引擎的二进制状态放在一个独立的 langgraph schema 里，意味着这部分庞杂的机器数据绝对不会污染你业务层（UI）的 API 视图。
create schema if not exists langgraph;

create table if not exists langgraph.checkpoint_migrations (
  v integer primary key
);

create table if not exists langgraph.checkpoints (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_checkpoint_id text,
  type text,
  checkpoint jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create table if not exists langgraph.checkpoint_blobs (
  thread_id text not null,
  checkpoint_ns text not null default '',
  channel text not null,
  version text not null,
  type text not null,
  blob bytea,
  primary key (thread_id, checkpoint_ns, channel, version)
);

create table if not exists langgraph.checkpoint_writes (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id text not null,
  idx integer not null,
  channel text not null,
  type text,
  blob bytea not null,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

insert into langgraph.checkpoint_migrations (v)
values (0), (1), (2), (3), (4)
on conflict (v) do nothing;

revoke all on schema langgraph from anon, authenticated;
grant usage on schema langgraph to postgres, service_role;
grant all on all tables in schema langgraph to postgres, service_role;
alter default privileges in schema langgraph
  grant all on tables to postgres, service_role;
