-- Non-canonical historical meeting ids cannot be sent to the ordinary object
-- cleanup path. Keep them quarantined for an explicit, owner-proven operator
-- review instead of guessing or sanitizing an object prefix.

alter table meeting_deletion_tombstones
  add column if not exists cleanup_disposition text not null default 'automatic',
  add column if not exists manual_cleanup_detected_at timestamptz,
  add column if not exists manual_cleanup_approved_at timestamptz,
  add column if not exists manual_cleanup_approved_by_ref text,
  add column if not exists manual_cleanup_proof text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_deletion_tombstones_cleanup_disposition_valid'
      and conrelid = 'meeting_deletion_tombstones'::regclass
  ) then
    alter table meeting_deletion_tombstones
      add constraint meeting_deletion_tombstones_cleanup_disposition_valid
      check (cleanup_disposition in ('automatic', 'pending_manual_cleanup', 'manual_cleanup_approved'));
  end if;
end
$$;

update meeting_deletion_tombstones
set cleanup_disposition = 'pending_manual_cleanup',
    manual_cleanup_detected_at = coalesce(manual_cleanup_detected_at, now()),
    cleanup_next_attempt_at = 'infinity'::timestamptz,
    cleanup_claimed_at = null,
    cleanup_claimed_by = null,
    cleanup_claim_token = null,
    cleanup_last_error = 'legacy_noncanonical_manual_cleanup_required'
where cleanup_pending = true
  and not (meeting_id ~ '^[A-Za-z0-9_-]{1,160}$');

create index if not exists meeting_deletion_tombstones_manual_cleanup_idx
  on meeting_deletion_tombstones (manual_cleanup_detected_at, deleted_at)
  where cleanup_pending = true
    and cleanup_disposition in ('pending_manual_cleanup', 'manual_cleanup_approved');

-- A completed cleanup keeps only a one-way deletion fence with no raw owner or
-- meeting identifier. This prevents late writes from recreating a meeting
-- without retaining those direct identifiers forever.
create table if not exists meeting_deletion_fences (
  meeting_ref text primary key check (meeting_ref ~ '^[a-f0-9]{64}$'),
  owner_proof_ref text not null check (owner_proof_ref ~ '^[a-f0-9]{64}$'),
  deleted_at timestamptz not null,
  cleaned_at timestamptz not null,
  cleanup_resolution text not null default 'automatic'
    check (cleanup_resolution in ('automatic', 'legacy_exact_manifest_owner_verified')),
  approved_at timestamptz,
  approved_by_ref text,
  proof_ref text,
  created_at timestamptz not null default now()
);

create index if not exists meeting_deletion_fences_cleaned_idx
  on meeting_deletion_fences (cleaned_at desc);

insert into ownminutes_schema_migrations (version)
values ('0022_legacy_deletion_cleanup_audit')
on conflict (version) do nothing;
