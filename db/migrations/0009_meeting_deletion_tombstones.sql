create table if not exists meeting_deletion_tombstones (
  meeting_id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  deleted_at timestamptz not null default now()
);

create index if not exists meeting_deletion_tombstones_owner_idx
  on meeting_deletion_tombstones (owner_user_id, deleted_at desc);

insert into ownminutes_schema_migrations (version)
values ('0009_meeting_deletion_tombstones')
on conflict (version) do nothing;
