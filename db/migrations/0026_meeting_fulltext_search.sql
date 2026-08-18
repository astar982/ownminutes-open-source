-- Keep searchable meeting text in PostgreSQL so history search does not scan
-- every object-store result. The simple dictionary preserves identifiers and
-- multilingual tokens; a bounded substring fallback is retained for CJK text.

alter table meetings
  add column if not exists metadata_search_text text not null default '',
  add column if not exists result_search_text text not null default '',
  add column if not exists search_document tsvector
    generated always as (
      to_tsvector('simple', coalesce(metadata_search_text, '') || ' ' || coalesce(result_search_text, ''))
    ) stored;

create index if not exists meetings_search_document_idx
  on meetings using gin (search_document)
  where deleted_at is null;

insert into ownminutes_schema_migrations (version)
values ('0026_meeting_fulltext_search')
on conflict (version) do nothing;
