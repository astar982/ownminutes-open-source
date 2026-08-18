-- Keep the billing/idempotency identity on the authoritative PostgreSQL job.
-- Object-store processing state is a user-facing projection and may be lost or
-- temporarily unavailable without changing which audio revision a worker owns.

alter table meeting_finalization_jobs
  add column if not exists processing_operation_key text,
  add column if not exists audio_revision text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_finalization_jobs_processing_operation_key_valid'
      and conrelid = 'meeting_finalization_jobs'::regclass
  ) then
    alter table meeting_finalization_jobs
      add constraint meeting_finalization_jobs_processing_operation_key_valid
      check (
        processing_operation_key is null
        or char_length(processing_operation_key) between 1 and 240
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_finalization_jobs_audio_revision_valid'
      and conrelid = 'meeting_finalization_jobs'::regclass
  ) then
    alter table meeting_finalization_jobs
      add constraint meeting_finalization_jobs_audio_revision_valid
      check (audio_revision is null or audio_revision ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

insert into ownminutes_schema_migrations (version)
values ('0017_finalization_job_processing_identity')
on conflict (version) do nothing;
