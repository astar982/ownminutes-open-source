-- Persist the registration trial independently from the active plan quota.
-- Free users keep their currently visible remainder once; legacy paid users
-- are conservatively marked exhausted because historic paid/free usage cannot
-- be separated reliably from the old shared counters.

alter table users
  add column if not exists free_trial_minutes_total integer,
  add column if not exists free_trial_minutes_used integer,
  add column if not exists free_trial_granted_at timestamptz;

update users
set free_trial_minutes_total = 60,
    free_trial_minutes_used = case
      when deleted_at is not null then 60
      when plan = 'free' then greatest(
        0,
        least(
          60,
          60 - least(60, greatest(0, official_minutes_total - official_minutes_used))
        )
      )
      else 60
    end,
    free_trial_granted_at = coalesce(free_trial_granted_at, created_at)
where free_trial_minutes_total is null
   or free_trial_minutes_used is null
   or free_trial_granted_at is null;

alter table users
  alter column free_trial_minutes_total set default 60,
  alter column free_trial_minutes_total set not null,
  -- Registrations made by the immediately preceding app version during a
  -- tightly controlled migration window still start with an unused trial.
  -- Existing paid/deleted rows were already backfilled to 60 above.
  alter column free_trial_minutes_used set default 0,
  alter column free_trial_minutes_used set not null,
  alter column free_trial_granted_at set default now(),
  alter column free_trial_granted_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_free_trial_minutes_valid'
  ) then
    alter table users
      add constraint users_free_trial_minutes_valid check (
        free_trial_minutes_total >= 0
        and free_trial_minutes_used >= 0
        and free_trial_minutes_used <= free_trial_minutes_total
      );
  end if;
end $$;

-- Remove the legacy monthly deadline without changing the user's visible
-- remainder. Application refresh will rename the source to free_trial.
update users
set official_minutes_period_end_at = null
where plan = 'free'
  and official_minutes_period_source = 'free';

insert into ownminutes_schema_migrations (version)
values ('0014_lifetime_free_trial')
on conflict (version) do nothing;
