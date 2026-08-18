-- Cost-safe, idempotent quota reservations and provider-call fencing.
-- A reservation only holds capacity. Minutes are settled atomically when a unique
-- provider step moves from claimed to started, immediately before the provider call.

create table if not exists meeting_processing_reservations (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  meeting_id text not null,
  operation_key text not null,
  processing_route text not null check (processing_route in ('byok', 'hybrid', 'official_quota')),
  status text not null check (status in ('reserved', 'finalized')),
  processed_minutes integer not null default 0 check (processed_minutes >= 0),
  official_minutes_reserved integer not null default 0 check (official_minutes_reserved >= 0),
  official_minutes_settled integer not null default 0 check (
    official_minutes_settled >= 0 and official_minutes_settled <= official_minutes_reserved
  ),
  realtime_duration_ms bigint not null default 0 check (realtime_duration_ms >= 0),
  realtime_highest_sequence integer not null default 0 check (realtime_highest_sequence >= 0),
  reservation_expires_at timestamptz not null default (now() + interval '15 minutes'),
  released_at timestamptz,
  quota_period_source text,
  quota_period_start_at timestamptz,
  quota_billing_order_id text,
  result_generated_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, operation_key)
);

-- These ALTERs make the migration safe when an unreleased pre-fencing version of
-- this table was created during staging. Such rows were charged at reserve time,
-- so the additive backfill records them as already settled and never double bills.
alter table meeting_processing_reservations
  add column if not exists official_minutes_settled integer not null default 0;

alter table meeting_processing_reservations
  add column if not exists reservation_expires_at timestamptz;

alter table meeting_processing_reservations
  add column if not exists released_at timestamptz;

update meeting_processing_reservations
set official_minutes_settled = official_minutes_reserved
where official_minutes_settled = 0
  and official_minutes_reserved > 0;

update meeting_processing_reservations
set reservation_expires_at = coalesce(updated_at, created_at, now()) + interval '15 minutes'
where reservation_expires_at is null;

alter table meeting_processing_reservations
  alter column reservation_expires_at set default (now() + interval '15 minutes');

alter table meeting_processing_reservations
  alter column reservation_expires_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meeting_processing_reservations_settlement_check'
      and conrelid = 'meeting_processing_reservations'::regclass
  ) then
    alter table meeting_processing_reservations
      add constraint meeting_processing_reservations_settlement_check
      check (
        official_minutes_settled >= 0
        and official_minutes_settled <= official_minutes_reserved
      );
  end if;
end
$$;

create index if not exists meeting_processing_reservations_user_status_idx
  on meeting_processing_reservations (user_id, status, updated_at desc);

create index if not exists meeting_processing_reservations_meeting_idx
  on meeting_processing_reservations (meeting_id, updated_at desc);

create index if not exists meeting_processing_reservations_capacity_idx
  on meeting_processing_reservations (user_id, reservation_expires_at)
  where status = 'reserved' and released_at is null;

create table if not exists meeting_processing_provider_steps (
  id text primary key,
  reservation_id text not null references meeting_processing_reservations(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  stage_key text not null,
  stage_type text not null check (stage_type in ('realtime_asr', 'finalization_asr', 'finalization_summary')),
  sequence integer,
  status text not null check (status in ('claimed', 'started', 'completed', 'released')),
  claim_token_hash text not null,
  lease_expires_at timestamptz not null,
  official_minutes_settled integer not null default 0 check (official_minutes_settled >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reservation_id, stage_key),
  check (
    (stage_type = 'realtime_asr' and sequence is not null and sequence >= 0)
    or (stage_type in ('finalization_asr', 'finalization_summary') and sequence is null)
  )
);

create index if not exists meeting_processing_provider_steps_state_idx
  on meeting_processing_provider_steps (reservation_id, status, lease_expires_at);

alter table usage_events
  add column if not exists processing_reservation_id text references meeting_processing_reservations(id) on delete set null;

create unique index if not exists usage_events_processing_reservation_unique_idx
  on usage_events (processing_reservation_id)
  where processing_reservation_id is not null;

insert into ownminutes_schema_migrations (version)
values ('0015_meeting_processing_reservations')
on conflict (version) do nothing;
