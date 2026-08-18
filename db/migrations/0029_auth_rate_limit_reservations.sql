-- Short-lived admission reservations prevent concurrent login requests from
-- bypassing the durable failure thresholds before password verification.

create table if not exists auth_login_rate_limit_reservations (
  reservation_token_hash text not null
    check (char_length(reservation_token_hash) between 32 and 128),
  identifier_hash text not null
    check (char_length(identifier_hash) between 32 and 128),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (reservation_token_hash, identifier_hash),
  check (expires_at > created_at)
);

create index if not exists auth_login_rate_limit_reservations_scope_expiry_idx
  on auth_login_rate_limit_reservations (identifier_hash, expires_at);

create index if not exists auth_login_rate_limit_reservations_expiry_idx
  on auth_login_rate_limit_reservations (expires_at);

insert into ownminutes_schema_migrations (version)
values ('0029_auth_rate_limit_reservations')
on conflict (version) do nothing;
