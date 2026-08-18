-- Durable Apple subscription lifecycle and period-scoped quota metadata.
-- Raw signed payloads and credentials are intentionally not stored here.

alter table users
  add column if not exists official_minutes_period_start_at timestamptz,
  add column if not exists official_minutes_period_end_at timestamptz,
  add column if not exists official_minutes_period_source text,
  add column if not exists official_minutes_billing_order_id text;

alter table billing_orders
  add column if not exists product_id text,
  add column if not exists environment text,
  add column if not exists price_milliunits bigint,
  add column if not exists storefront text,
  add column if not exists offer_type integer,
  add column if not exists offer_identifier text,
  add column if not exists app_account_token text,
  add column if not exists signed_date timestamptz,
  add column if not exists status_signed_date timestamptz;

-- Apple signs prices in currency milliunits. The legacy amount_cents field is
-- not exact for currencies without two fractional digits, so Apple rows may
-- leave it null and use (price_milliunits, currency) as the authority.
alter table billing_orders alter column amount_cents drop not null;

alter table entitlement_grants
  add column if not exists starts_at timestamptz,
  add column if not exists expires_at timestamptz;

create table if not exists apple_iap_account_bindings (
  app_account_token text primary key,
  user_id text not null references users(id) on delete restrict,
  key_version text not null default 'v1',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, key_version)
);

create table if not exists apple_subscriptions (
  original_transaction_id text primary key,
  user_id text not null references users(id) on delete restrict,
  current_transaction_id text not null,
  product_id text not null,
  environment text not null check (environment in ('Production', 'Sandbox', 'Xcode', 'LocalMock', 'production', 'sandbox', 'xcode', 'localmock')),
  status text not null check (status in ('active', 'grace', 'billing_retry', 'expired', 'revoked')),
  expires_at timestamptz,
  grace_expires_at timestamptz,
  auto_renew_status boolean,
  is_upgraded boolean not null default false,
  last_signed_date timestamptz,
  last_notification_uuid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists apple_subscriptions_user_status_idx
  on apple_subscriptions (user_id, status, expires_at desc);
create index if not exists apple_subscriptions_current_transaction_idx
  on apple_subscriptions (current_transaction_id);
create index if not exists apple_subscriptions_expiration_idx
  on apple_subscriptions (status, expires_at);

-- Reconcile Apple rows created before this lifecycle table existed. Product
-- mappings for live subscriptions are append-only; the fallback IDs match the
-- original Plus/Pro catalog used by OwnMinutes before this migration.
update billing_orders
set product_id = case plan
      when 'plus' then 'ownminutes.plus.monthly'
      when 'pro' then 'ownminutes.pro.monthly'
      else product_id
    end,
    environment = coalesce(environment, 'Sandbox')
where provider = 'apple_iap'
  and (product_id is null or environment is null);

update entitlement_grants
set starts_at = coalesce(starts_at, billing_orders.period_start_at, entitlement_grants.created_at),
    expires_at = coalesce(expires_at, billing_orders.period_end_at)
from billing_orders
where entitlement_grants.billing_order_id = billing_orders.id
  and billing_orders.provider = 'apple_iap';

insert into apple_subscriptions
  (original_transaction_id, user_id, current_transaction_id, product_id, environment, status, expires_at, last_signed_date, created_at, updated_at)
select distinct on (billing_orders.original_transaction_id)
  billing_orders.original_transaction_id,
  billing_orders.user_id,
  billing_orders.external_transaction_id,
  billing_orders.product_id,
  billing_orders.environment,
  case
    when entitlement_grants.status = 'active'
      and (billing_orders.period_end_at is null or billing_orders.period_end_at > now()) then 'active'
    when entitlement_grants.status = 'active' then 'expired'
    else 'revoked'
  end,
  billing_orders.period_end_at,
  billing_orders.signed_date,
  billing_orders.created_at,
  now()
from billing_orders
left join entitlement_grants on entitlement_grants.id = billing_orders.entitlement_grant_id
where billing_orders.provider = 'apple_iap'
  and billing_orders.original_transaction_id is not null
  and billing_orders.external_transaction_id is not null
  and billing_orders.product_id is not null
  and billing_orders.environment is not null
order by billing_orders.original_transaction_id,
         billing_orders.period_start_at desc nulls last,
         billing_orders.period_end_at desc nulls last,
         billing_orders.created_at desc
on conflict (original_transaction_id) do nothing;

create table if not exists apple_notification_events (
  notification_uuid text primary key,
  environment text,
  notification_type text not null,
  subtype text,
  signed_date timestamptz,
  transaction_id text,
  original_transaction_id text,
  payload_sha256 text not null,
  processing_status text not null check (processing_status in ('received', 'processed', 'ignored', 'failed')),
  result_action text,
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists apple_notification_events_transaction_idx
  on apple_notification_events (transaction_id, received_at desc);
create index if not exists apple_notification_events_original_transaction_idx
  on apple_notification_events (original_transaction_id, received_at desc);
create index if not exists apple_notification_events_status_idx
  on apple_notification_events (processing_status, received_at);

insert into ownminutes_schema_migrations (version)
values ('0013_apple_subscription_lifecycle')
on conflict (version) do nothing;
