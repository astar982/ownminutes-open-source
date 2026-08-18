-- Stop permanently failing account cleanup from hammering object storage while
-- keeping the durable job present so deletion status can never become a false
-- positive. Operators can alert on and explicitly replay dead-lettered work.

alter table account_deletion_cleanup_jobs
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists manual_replay_count integer not null default 0
    check (manual_replay_count >= 0),
  add column if not exists last_replayed_at timestamptz,
  add column if not exists last_replayed_by_ref text
    check (last_replayed_by_ref is null or last_replayed_by_ref ~ '^operator_[a-f0-9]{20}$');

create index if not exists account_deletion_cleanup_jobs_health_idx
  on account_deletion_cleanup_jobs (available_at, claimed_at, created_at)
  where dead_lettered_at is null;

create index if not exists account_deletion_cleanup_jobs_dead_letter_idx
  on account_deletion_cleanup_jobs (dead_lettered_at)
  where dead_lettered_at is not null;

create table if not exists meeting_storage_integrity_state (
  integrity_key text primary key,
  audit_version integer not null check (audit_version > 0),
  writer_invariant_version integer not null check (writer_invariant_version > 0),
  unattributed_prefix_count integer not null check (unattributed_prefix_count >= 0),
  completed_at timestamptz not null
);

insert into ownminutes_schema_migrations (version)
values ('0033_account_deletion_cleanup_observability')
on conflict (version) do nothing;
