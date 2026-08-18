-- OwnMinutes billing order ledger.
-- Stores manual orders now and future Apple IAP / external billing transaction metadata.

create table if not exists billing_orders (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  created_by_user_id text references users(id) on delete set null,
  provider text not null check (provider in ('admin_manual', 'apple_iap', 'external_billing')),
  status text not null check (status in ('paid', 'refunded', 'voided')),
  plan text not null check (plan in ('free', 'plus', 'pro')),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  currency text not null default 'CNY',
  external_transaction_id text,
  idempotency_key text not null,
  period_start_at timestamptz,
  period_end_at timestamptz,
  entitlement_grant_id text,
  note text not null default '',
  status_reason text,
  status_updated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (idempotency_key)
);

alter table entitlement_grants
  add column if not exists billing_order_id text references billing_orders(id) on delete set null;

create index if not exists billing_orders_user_created_idx on billing_orders (user_id, created_at desc);
create index if not exists billing_orders_provider_status_idx on billing_orders (provider, status);
create index if not exists billing_orders_external_transaction_idx on billing_orders (provider, external_transaction_id);
create index if not exists billing_orders_status_updated_idx on billing_orders (status, status_updated_at desc);
create index if not exists entitlement_grants_billing_order_idx on entitlement_grants (billing_order_id);

insert into ownminutes_schema_migrations (version)
values ('0004_billing_orders')
on conflict (version) do nothing;
