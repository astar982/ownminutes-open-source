-- Add a short-lived numeric email OTP alongside the legacy verification link.
-- OTP digests are HMAC-bound to their row/user identities by the application;
-- plaintext codes never reach PostgreSQL.

-- A pending account has not received its lifetime trial yet. Migration 0014
-- made this audit timestamp mandatory before email verification existed.
alter table users
  alter column free_trial_granted_at drop not null;

alter table email_verification_tokens
  add column if not exists credential_kind text not null default 'link',
  add column if not exists failed_attempts integer not null default 0,
  add column if not exists locked_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'email_verification_tokens_kind_valid'
  ) then
    alter table email_verification_tokens
      add constraint email_verification_tokens_kind_valid
      check (credential_kind in ('link', 'otp'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'email_verification_tokens_attempts_valid'
  ) then
    alter table email_verification_tokens
      add constraint email_verification_tokens_attempts_valid
      check (failed_attempts between 0 and 5);
  end if;
end $$;

create index if not exists email_verification_tokens_user_kind_created_idx
  on email_verification_tokens (user_id, credential_kind, created_at desc);

insert into ownminutes_schema_migrations (version)
values ('0018_email_verification_otp')
on conflict (version) do nothing;
