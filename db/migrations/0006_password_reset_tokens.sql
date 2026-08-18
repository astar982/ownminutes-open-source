-- Password reset tokens are single-use and stored as hashes only.

create table if not exists password_reset_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists password_reset_tokens_user_created_idx on password_reset_tokens (user_id, created_at desc);
create index if not exists password_reset_tokens_expires_idx on password_reset_tokens (expires_at);

insert into ownminutes_schema_migrations (version)
values ('0006_password_reset_tokens')
on conflict (version) do nothing;
