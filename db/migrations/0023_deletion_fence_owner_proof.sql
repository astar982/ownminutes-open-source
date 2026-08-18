-- Follow-up compatibility migration for environments that applied an early
-- 0022 draft before the complete manual-cleanup audit/fence schema landed.
-- New installs already receive these columns from 0022, so every statement is
-- deliberately idempotent.

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

alter table meeting_deletion_fences
  add column if not exists owner_proof_ref text,
  add column if not exists cleanup_resolution text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by_ref text,
  add column if not exists proof_ref text,
  add column if not exists created_at timestamptz not null default now();

-- A historical fence cannot be re-linked to its deleted raw owner. Give it an
-- intentionally unmatchable 64-hex value so the fence still blocks writes but
-- can never authorize the cleanup-reopen path.
update meeting_deletion_fences
set owner_proof_ref = md5('unavailable-owner-proof:' || meeting_ref)
  || md5('unavailable-owner-proof-2:' || meeting_ref)
where owner_proof_ref is null;

update meeting_deletion_fences
set cleanup_resolution = 'automatic'
where cleanup_resolution is null;

alter table meeting_deletion_fences
  alter column owner_proof_ref set not null,
  alter column cleanup_resolution set default 'automatic',
  alter column cleanup_resolution set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_deletion_fences_owner_proof_valid'
      and conrelid = 'meeting_deletion_fences'::regclass
  ) then
    alter table meeting_deletion_fences
      add constraint meeting_deletion_fences_owner_proof_valid
      check (owner_proof_ref ~ '^[a-f0-9]{64}$');
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_deletion_fences_cleanup_resolution_valid'
      and conrelid = 'meeting_deletion_fences'::regclass
  ) then
    alter table meeting_deletion_fences
      add constraint meeting_deletion_fences_cleanup_resolution_valid
      check (cleanup_resolution in ('automatic', 'legacy_exact_manifest_owner_verified'));
  end if;
end
$$;

create index if not exists meeting_deletion_fences_cleaned_idx
  on meeting_deletion_fences (cleaned_at desc);

insert into ownminutes_schema_migrations (version)
values ('0023_deletion_fence_owner_proof')
on conflict (version) do nothing;
