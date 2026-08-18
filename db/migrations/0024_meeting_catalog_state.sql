-- The original object-store implementation discovered meetings by scanning the
-- entire bucket on every history, upload-budget, deletion, and analytics read.
-- Keep the existing meetings table as the durable lookup catalog and record
-- when the one-time legacy object backfill has completed.

create table if not exists meeting_catalog_state (
  catalog_key text primary key,
  catalog_version integer not null check (catalog_version > 0),
  indexed_meetings integer not null default 0 check (indexed_meetings >= 0),
  completed_at timestamptz not null
);

alter table meetings
  add column if not exists share_expires_at timestamptz;

create table if not exists meeting_share_analytics (
  meeting_id text primary key references meetings(id) on delete cascade,
  view_count bigint not null default 0 check (view_count >= 0),
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists meeting_share_analytics_last_viewed_idx
  on meeting_share_analytics (last_viewed_at desc)
  where view_count > 0;

insert into ownminutes_schema_migrations (version)
values ('0024_meeting_catalog_state')
on conflict (version) do nothing;
