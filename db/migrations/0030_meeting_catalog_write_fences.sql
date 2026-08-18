-- Unattributed canonical prefixes block catalog readiness and account cleanup.
-- In-flight manifest publication is tracked separately by tokenized transfer
-- intents (0032), so a crashed pre-PUT writer cannot leave an immortal hash-only
-- coverage fence.

create table if not exists meeting_catalog_coverage_fences (
  prefix_ref text primary key check (prefix_ref ~ '^[a-f0-9]{64}$'),
  owner_user_id text references users(id) on delete set null,
  reason text not null check (
    reason = 'canonical_unattributed'
  ),
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists meeting_catalog_coverage_fences_unresolved_idx
  on meeting_catalog_coverage_fences (detected_at asc)
  where resolved_at is null;

insert into ownminutes_schema_migrations (version)
values ('0030_meeting_catalog_write_fences')
on conflict (version) do nothing;
