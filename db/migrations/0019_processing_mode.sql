-- Persist the user's explicit processing-cost choice and freeze that choice on
-- queued finalization work. Hybrid remains readable on historical usage, but
-- is not a user-selectable mode for new meetings.

alter table users
  add column if not exists processing_mode text;

update users
set processing_mode = case
  when exists (
    select 1
    from provider_credentials asr
    where asr.user_id = users.id
      and asr.provider_id = 'volcano-asr'
      and (
        asr.encrypted_secrets ? 'VOLCANO_ASR_API_KEY'
        or (
          asr.fields ? 'VOLCANO_ASR_APP_ID'
          and asr.encrypted_secrets ? 'VOLCANO_ASR_TOKEN'
        )
      )
  )
  and exists (
    select 1
    from provider_credentials ark
    where ark.user_id = users.id
      and ark.provider_id = 'volcano-ark'
      and ark.fields ? 'ARK_CHAT_MODEL'
      and ark.encrypted_secrets ? 'ARK_API_KEY'
  ) then 'byok'
  else 'official_quota'
end
where processing_mode is null;

alter table users
  alter column processing_mode set default 'official_quota',
  alter column processing_mode set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_processing_mode_valid'
      and conrelid = 'users'::regclass
  ) then
    alter table users
      add constraint users_processing_mode_valid
      check (processing_mode in ('official_quota', 'byok'));
  end if;
end
$$;

alter table meeting_finalization_jobs
  add column if not exists processing_mode text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_finalization_jobs_processing_mode_valid'
      and conrelid = 'meeting_finalization_jobs'::regclass
  ) then
    alter table meeting_finalization_jobs
      add constraint meeting_finalization_jobs_processing_mode_valid
      check (processing_mode is null or processing_mode in ('official_quota', 'byok'));
  end if;
end
$$;

-- A meeting becomes inaccessible as soon as its tombstone is committed. Keep
-- object cleanup durable and claimable so a transient S3 failure cannot leave
-- private audio behind forever after the UI has hidden the meeting.
alter table meeting_deletion_tombstones
  add column if not exists cleanup_pending boolean not null default true,
  add column if not exists cleanup_attempts integer not null default 0,
  add column if not exists cleanup_next_attempt_at timestamptz not null default now(),
  add column if not exists cleanup_claimed_at timestamptz,
  add column if not exists cleanup_claimed_by text,
  add column if not exists cleanup_claim_token text,
  add column if not exists cleaned_at timestamptz,
  add column if not exists cleanup_last_error text;

create index if not exists meeting_deletion_tombstones_cleanup_idx
  on meeting_deletion_tombstones (cleanup_pending, cleanup_next_attempt_at, deleted_at)
  where cleanup_pending = true;

insert into ownminutes_schema_migrations (version)
values ('0019_processing_mode')
on conflict (version) do nothing;
