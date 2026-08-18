-- Durable, cross-instance throttling for login, registration, password reset,
-- and email verification endpoints.

create table if not exists auth_rate_limit_entries (
  bucket text not null check (bucket in ('email_verification', 'login', 'password_reset', 'register')),
  identifier_hash text not null check (char_length(identifier_hash) between 32 and 128),
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  first_attempt_at timestamptz not null,
  last_attempt_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (bucket, identifier_hash)
);

create index if not exists auth_rate_limit_entries_expires_idx
  on auth_rate_limit_entries (expires_at);

insert into ownminutes_schema_migrations (version)
values ('0025_auth_rate_limits')
on conflict (version) do nothing;
