-- Prevent one Apple transaction from being claimed by two accounts under concurrency.

create unique index if not exists billing_orders_apple_transaction_unique_idx
  on billing_orders (external_transaction_id)
  where provider = 'apple_iap' and external_transaction_id is not null;

insert into ownminutes_schema_migrations (version)
values ('0010_apple_iap_transaction_uniqueness')
on conflict (version) do nothing;
