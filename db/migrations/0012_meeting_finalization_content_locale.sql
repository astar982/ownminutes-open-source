-- Preserve the requested meeting-content language across durable finalization jobs.
-- Existing jobs remain Simplified Chinese for backward compatibility.

alter table meeting_finalization_jobs
  add column if not exists content_locale text not null default 'zh-Hans'
  check (content_locale in ('en', 'zh-Hans', 'zh-Hant'));

insert into ownminutes_schema_migrations (version)
values ('0012_meeting_finalization_content_locale')
on conflict (version) do nothing;

