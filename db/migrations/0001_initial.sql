-- OwnMinutes PostgreSQL initial schema.
-- This migration is intentionally provider-neutral SQL for managed PostgreSQL.

create table if not exists ownminutes_schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  email text not null,
  name text not null,
  role text not null check (role in ('admin', 'user')),
  plan text not null check (plan in ('free', 'plus', 'pro')),
  official_minutes_total integer not null default 0 check (official_minutes_total >= 0),
  official_minutes_used integer not null default 0 check (official_minutes_used >= 0),
  password_salt text not null,
  password_hash text not null,
  created_at timestamptz not null,
  deleted_at timestamptz,
  constraint users_minutes_within_total check (official_minutes_used <= official_minutes_total)
);

create unique index if not exists users_active_email_unique
  on users (lower(email))
  where deleted_at is null;

create index if not exists users_created_at_idx on users (created_at desc);
create index if not exists users_plan_idx on users (plan) where deleted_at is null;

create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null
);

create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

create table if not exists provider_credentials (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  provider_id text not null,
  label text not null,
  fields jsonb not null default '{}'::jsonb,
  encrypted_secrets jsonb not null default '{}'::jsonb,
  secret_previews jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (user_id, provider_id)
);

create index if not exists provider_credentials_user_updated_idx on provider_credentials (user_id, updated_at desc);
create index if not exists provider_credentials_provider_idx on provider_credentials (provider_id);

create table if not exists usage_events (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  type text not null check (type in ('register_bonus', 'meeting_finalize', 'manual_adjustment')),
  minutes integer not null default 0 check (minutes >= 0),
  created_at timestamptz not null,
  note text not null
);

create index if not exists usage_events_user_created_idx on usage_events (user_id, created_at desc);
create index if not exists usage_events_type_idx on usage_events (type);

create table if not exists meetings (
  id text primary key,
  owner_user_id text not null references users(id) on delete cascade,
  title text not null,
  object_prefix text not null unique,
  project text,
  tags jsonb not null default '[]'::jsonb,
  share_visibility text not null default 'private' check (share_visibility in ('private', 'public')),
  share_include_transcript boolean not null default false,
  total_bytes bigint not null default 0 check (total_bytes >= 0),
  total_chunks integer not null default 0 check (total_chunks >= 0),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  transcript_count integer not null default 0 check (transcript_count >= 0),
  has_result boolean not null default false,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists meetings_owner_updated_idx on meetings (owner_user_id, updated_at desc) where deleted_at is null;
create index if not exists meetings_owner_project_idx on meetings (owner_user_id, project) where deleted_at is null;
create index if not exists meetings_public_share_idx on meetings (share_visibility, updated_at desc) where deleted_at is null;

create table if not exists meeting_objects (
  id text primary key,
  meeting_id text not null references meetings(id) on delete cascade,
  object_key text not null,
  object_kind text not null check (object_kind in ('chunk', 'manifest', 'result', 'obsidian_markdown')),
  byte_size bigint not null default 0 check (byte_size >= 0),
  content_type text,
  checksum_sha256 text,
  created_at timestamptz not null default now(),
  unique (meeting_id, object_key)
);

create index if not exists meeting_objects_meeting_kind_idx on meeting_objects (meeting_id, object_kind);

create table if not exists audit_events (
  id text primary key,
  user_id text references users(id) on delete set null,
  event_type text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_user_created_idx on audit_events (user_id, created_at desc);
create index if not exists audit_events_type_created_idx on audit_events (event_type, created_at desc);

insert into ownminutes_schema_migrations (version)
values ('0001_initial')
on conflict (version) do nothing;
