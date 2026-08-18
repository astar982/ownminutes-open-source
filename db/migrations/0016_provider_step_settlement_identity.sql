-- Persist the exact quota period that was charged when a provider call started.
-- A later rejection may arrive after a subscription upgrade or renewal; in that
-- case the current period's usage counter must not be decremented. Free-trial
-- usage is lifetime state, so its step-specific delta is recorded separately.

alter table meeting_processing_provider_steps
  add column if not exists settlement_period_identity text;

alter table meeting_processing_provider_steps
  add column if not exists free_trial_minutes_settled integer not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_processing_provider_steps_free_trial_settlement_check'
      and conrelid = 'meeting_processing_provider_steps'::regclass
  ) then
    alter table meeting_processing_provider_steps
      add constraint meeting_processing_provider_steps_free_trial_settlement_check
      check (free_trial_minutes_settled >= 0);
  end if;
end
$$;

insert into ownminutes_schema_migrations (version)
values ('0016_provider_step_settlement_identity')
on conflict (version) do nothing;
