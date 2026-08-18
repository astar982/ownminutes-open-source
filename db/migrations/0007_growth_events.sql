-- OwnMinutes growth attribution events.
-- Stores low-sensitivity registration attribution for admin growth metrics.

create table if not exists growth_events (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  type text not null check (type in ('register')),
  source text not null check (source in ('direct', 'share')),
  share_id text,
  created_at timestamptz not null
);

create index if not exists growth_events_user_created_idx on growth_events (user_id, created_at desc);
create index if not exists growth_events_source_share_idx on growth_events (source, share_id);
create index if not exists growth_events_type_source_idx on growth_events (type, source);

insert into ownminutes_schema_migrations (version)
values ('0007_growth_events')
on conflict (version) do nothing;
