-- Durable finalization queue for long-running ASR and summary work.
-- Workers claim jobs with FOR UPDATE SKIP LOCKED and refresh a lease while processing.

create table if not exists meeting_finalization_jobs (
  id text primary key,
  meeting_id text not null,
  owner_user_id text not null references users(id) on delete cascade,
  title text not null,
  force_regenerate boolean not null default false,
  status text not null check (status in ('queued', 'processing', 'retry_wait', 'completed', 'failed', 'cancelled')),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meeting_finalization_jobs_claim_idx
  on meeting_finalization_jobs (status, available_at, created_at);

create index if not exists meeting_finalization_jobs_meeting_idx
  on meeting_finalization_jobs (meeting_id, created_at desc);

create index if not exists meeting_finalization_jobs_owner_idx
  on meeting_finalization_jobs (owner_user_id, created_at desc);

create index if not exists meeting_finalization_jobs_lease_idx
  on meeting_finalization_jobs (lease_expires_at)
  where status = 'processing';

insert into ownminutes_schema_migrations (version)
values ('0008_meeting_finalization_jobs')
on conflict (version) do nothing;
