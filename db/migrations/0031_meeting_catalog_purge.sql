-- A meeting catalog row is a lookup projection, not a deletion receipt.
-- Keep the raw owner/id tombstone only while physical object cleanup is pending;
-- successful cleanup retains the existing one-way deletion fence and removes
-- meeting metadata, analytics, object inventory, and processing identity.

create index if not exists meetings_owner_deletion_idx
  on meetings (owner_user_id, id);

-- Finish historical rows whose tombstone already proves object cleanup
-- completed before catalog purge became part of the completion protocol.
update usage_events usage
set note = 'Deleted meeting usage retained without meeting identity.',
    processing_reservation_id = null
from meetings meeting
join meeting_deletion_tombstones tombstone
  on tombstone.meeting_id = meeting.id
 and tombstone.owner_user_id = meeting.owner_user_id
where usage.user_id = meeting.owner_user_id
  and usage.type = 'meeting_finalize'
  and (tombstone.cleanup_pending = false or tombstone.cleaned_at is not null)
  and (
    left(
      usage.note,
      char_length('Finalized meeting:' || meeting.id || ' ')
    ) = 'Finalized meeting:' || meeting.id || ' '
    or exists (
      select 1
      from meeting_processing_reservations reservation
      where reservation.id = usage.processing_reservation_id
        and reservation.user_id = meeting.owner_user_id
        and reservation.meeting_id = meeting.id
    )
  );

delete from meeting_finalization_jobs job
using meetings meeting, meeting_deletion_tombstones tombstone
where job.meeting_id = meeting.id
  and job.owner_user_id = meeting.owner_user_id
  and tombstone.meeting_id = meeting.id
  and tombstone.owner_user_id = meeting.owner_user_id
  and (tombstone.cleanup_pending = false or tombstone.cleaned_at is not null);

delete from meeting_processing_reservations reservation
using meetings meeting, meeting_deletion_tombstones tombstone
where reservation.meeting_id = meeting.id
  and reservation.user_id = meeting.owner_user_id
  and tombstone.meeting_id = meeting.id
  and tombstone.owner_user_id = meeting.owner_user_id
  and (tombstone.cleanup_pending = false or tombstone.cleaned_at is not null);

delete from meetings meeting
using meeting_deletion_tombstones tombstone
where meeting.id = tombstone.meeting_id
  and meeting.owner_user_id = tombstone.owner_user_id
  and (tombstone.cleanup_pending = false or tombstone.cleaned_at is not null);

-- Failed object cleanup must retain its raw tombstone/owner retry fence, but the
-- catalog projection itself no longer needs title, project, tags, prefix, byte,
-- chunk, duration, transcript, result, share, or search metadata.
update meetings
set title = '',
    object_prefix = 'deleted-' || md5(
      random()::text || clock_timestamp()::text || id || owner_user_id
    ),
    project = null,
    tags = '[]'::jsonb,
    share_visibility = 'private',
    share_include_transcript = false,
    share_expires_at = null,
    total_bytes = 0,
    total_chunks = 0,
    duration_ms = 0,
    transcript_count = 0,
    has_result = false,
    generated_at = null,
    metadata_search_text = '',
    result_search_text = '',
    updated_at = now()
where deleted_at is not null;

delete from meeting_catalog_coverage_fences
where resolved_at is not null;

delete from meeting_catalog_backfill_blockers
where resolved_at is not null;

insert into ownminutes_schema_migrations (version)
values ('0031_meeting_catalog_purge')
on conflict (version) do nothing;
