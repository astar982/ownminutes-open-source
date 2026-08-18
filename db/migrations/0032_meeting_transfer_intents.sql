-- Durable intent rows close the gap between a lock-free object PUT and its
-- postflight database publication. Account deletion cannot report completion
-- while an intent exists, and a crashed writer still leaves enough
-- meeting/owner evidence for the deletion worker to remove late objects.

create table if not exists meeting_object_transfer_intents (
  intent_id text primary key
    check (intent_id ~ '^meeting_transfer_[A-Za-z0-9_-]{16,80}$'),
  meeting_id text not null
    check (meeting_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  owner_user_id text not null references users(id) on delete restrict,
  transfer_kind text not null check (
    transfer_kind in (
      'asr_transient',
      'catalog_manifest',
      'recording_commit',
      'recording_staging'
    )
  ),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index if not exists meeting_object_transfer_intents_owner_idx
  on meeting_object_transfer_intents (owner_user_id, created_at asc);

create index if not exists meeting_object_transfer_intents_meeting_idx
  on meeting_object_transfer_intents (meeting_id, created_at asc);

create index if not exists meeting_object_transfer_intents_catalog_expiry_idx
  on meeting_object_transfer_intents (expires_at asc)
  where transfer_kind = 'catalog_manifest';

-- Replace the earlier hash-only in-flight manifest marker. Tokenized intents
-- carry an exact writer lifetime and can be recovered or tied to deletion.
delete from meeting_catalog_coverage_fences
where reason = 'canonical_catalog_write_pending';

-- Give anonymous cost aggregation an idempotency identity. The value is a
-- one-way source reference and never stores a raw user or meeting id.
alter table account_deletion_provider_cost_aggregates
  add column if not exists source_ref text;

create unique index if not exists account_deletion_provider_cost_source_ref_idx
  on account_deletion_provider_cost_aggregates (source_ref)
  where source_ref is not null;

-- Existing logically-deleted meetings must not keep share analytics, queued
-- work, provider-step identity, or a usage note containing the meeting id just
-- because object storage is temporarily unavailable.
insert into account_deletion_provider_cost_aggregates (
  id,
  source_ref,
  provider_steps,
  official_minutes_settled,
  free_trial_minutes_settled,
  recorded_at
)
select
  'meeting-delete-migration-' || md5(random()::text || clock_timestamp()::text),
  'migration:0032:pending-meeting-deletion-ledger',
  count(*)::integer,
  coalesce(sum(step.official_minutes_settled), 0)::bigint,
  coalesce(sum(step.free_trial_minutes_settled), 0)::bigint,
  now()
from meeting_processing_provider_steps step
join meeting_processing_reservations reservation
  on reservation.id = step.reservation_id
join meeting_deletion_tombstones tombstone
  on tombstone.meeting_id = reservation.meeting_id
 and tombstone.owner_user_id = reservation.user_id
having count(*) > 0
on conflict (source_ref) where source_ref is not null do nothing;

update usage_events usage
set note = 'Deleted meeting usage retained without meeting identity.',
    processing_reservation_id = null
from meeting_processing_reservations reservation
join meeting_deletion_tombstones tombstone
  on tombstone.meeting_id = reservation.meeting_id
 and tombstone.owner_user_id = reservation.user_id
where usage.user_id = reservation.user_id
  and usage.type = 'meeting_finalize'
  and (
    usage.processing_reservation_id = reservation.id
    or left(
      usage.note,
      char_length('Finalized meeting:' || reservation.meeting_id || ' ')
    ) = 'Finalized meeting:' || reservation.meeting_id || ' '
  );

delete from meeting_finalization_jobs job
using meeting_deletion_tombstones tombstone
where job.meeting_id = tombstone.meeting_id
  and job.owner_user_id = tombstone.owner_user_id;

delete from meeting_share_analytics analytics
using meetings meeting, meeting_deletion_tombstones tombstone
where analytics.meeting_id = meeting.id
  and meeting.id = tombstone.meeting_id
  and meeting.owner_user_id = tombstone.owner_user_id;

delete from meeting_processing_reservations reservation
using meeting_deletion_tombstones tombstone
where reservation.meeting_id = tombstone.meeting_id
  and reservation.user_id = tombstone.owner_user_id;

-- Corrupt legacy owner conflicts are not safe to auto-complete. Keep the raw
-- tombstone as a manual-cleanup fence and make account deletion remain pending.
update meeting_deletion_tombstones tombstone
set cleanup_pending = true,
    cleanup_next_attempt_at = 'infinity'::timestamptz,
    cleanup_claimed_at = null,
    cleanup_claimed_by = null,
    cleanup_claim_token = null,
    cleaned_at = null,
    cleanup_disposition = 'pending_manual_cleanup',
    manual_cleanup_detected_at = coalesce(manual_cleanup_detected_at, now()),
    cleanup_last_error = 'meeting_catalog_owner_conflict_manual_cleanup_required'
where exists (
  select 1
  from meetings meeting
  where meeting.id = tombstone.meeting_id
    and meeting.owner_user_id <> tombstone.owner_user_id
);

insert into ownminutes_schema_migrations (version)
values ('0032_meeting_transfer_intents')
on conflict (version) do nothing;
