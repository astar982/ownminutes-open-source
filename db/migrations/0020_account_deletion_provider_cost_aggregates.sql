-- Preserve non-identifying provider cost totals after account deletion while
-- removing per-user/per-meeting processing ledgers once every started provider
-- call has reached a terminal state.
create table if not exists account_deletion_provider_cost_aggregates (
  id text primary key,
  provider_steps integer not null check (provider_steps >= 0),
  official_minutes_settled bigint not null check (official_minutes_settled >= 0),
  free_trial_minutes_settled bigint not null check (free_trial_minutes_settled >= 0),
  recorded_at timestamptz not null default now()
);

insert into ownminutes_schema_migrations (version)
values ('0020_account_deletion_provider_cost_aggregates')
on conflict (version) do nothing;
