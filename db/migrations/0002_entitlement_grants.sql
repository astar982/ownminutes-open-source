-- OwnMinutes entitlement grant ledger.
-- Records manual grants and future payment/IAP-backed entitlement changes.

create table if not exists entitlement_grants (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  granted_by_user_id text references users(id) on delete set null,
  source text not null check (source in ('admin_manual', 'apple_iap', 'manual_order')),
  status text not null check (status in ('active', 'revoked', 'refunded')),
  previous_plan text not null check (previous_plan in ('free', 'plus', 'pro')),
  plan text not null check (plan in ('free', 'plus', 'pro')),
  official_minutes_total integer not null default 0 check (official_minutes_total >= 0),
  reason text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists entitlement_grants_user_created_idx on entitlement_grants (user_id, created_at desc);
create index if not exists entitlement_grants_granted_by_created_idx on entitlement_grants (granted_by_user_id, created_at desc);
create index if not exists entitlement_grants_source_status_idx on entitlement_grants (source, status);
create index if not exists entitlement_grants_created_idx on entitlement_grants (created_at desc);

insert into ownminutes_schema_migrations (version)
values ('0002_entitlement_grants')
on conflict (version) do nothing;
