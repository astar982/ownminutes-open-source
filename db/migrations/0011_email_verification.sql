-- Existing accounts are grandfathered; new production registrations explicitly insert NULL until verified.

alter table users
  add column if not exists email_verified_at timestamptz;

update users
set email_verified_at = created_at
where email_verified_at is null;

create table if not exists email_verification_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create index if not exists email_verification_tokens_user_created_idx
  on email_verification_tokens (user_id, created_at desc);

create index if not exists email_verification_tokens_expires_idx
  on email_verification_tokens (expires_at);

insert into ownminutes_schema_migrations (version)
values ('0011_email_verification')
on conflict (version) do nothing;
