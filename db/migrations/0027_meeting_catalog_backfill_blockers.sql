-- A catalog backfill must never certify a complete index while an object-store
-- prefix could not be indexed safely. Keep only a one-way prefix reference in
-- this global blocker table; traversal-safe, owner-proven legacy prefixes also
-- receive the existing owner-linked manual-cleanup tombstone.

create table if not exists meeting_catalog_backfill_blockers (
  prefix_ref text primary key check (prefix_ref ~ '^[a-f0-9]{64}$'),
  owner_user_id text references users(id) on delete set null,
  reason text not null check (
    reason in (
      'legacy_noncanonical_owner_verified',
      'legacy_noncanonical_unattributed',
      'unsafe_object_prefix'
    )
  ),
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists meeting_catalog_backfill_blockers_unresolved_idx
  on meeting_catalog_backfill_blockers (detected_at asc)
  where resolved_at is null;

insert into ownminutes_schema_migrations (version)
values ('0027_meeting_catalog_backfill_blockers')
on conflict (version) do nothing;
