-- Durable, asynchronous object discovery/cleanup. Account authentication is
-- invalidated before any tenant-wide object-store scan begins.
create table if not exists account_deletion_cleanup_jobs (
  user_id text primary key references users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing')),
  attempt integer not null default 0 check (attempt >= 0),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  claim_token text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists account_deletion_cleanup_jobs_claim_idx
  on account_deletion_cleanup_jobs (available_at, created_at)
  where status in ('pending', 'processing');

insert into ownminutes_schema_migrations (version)
values ('0021_account_deletion_cleanup_jobs')
on conflict (version) do nothing;
