-- Track Apple original transaction ids for subscription renewals.

alter table billing_orders
  add column if not exists original_transaction_id text;

create index if not exists billing_orders_original_transaction_idx on billing_orders (provider, original_transaction_id);

insert into ownminutes_schema_migrations (version)
values ('0005_billing_order_original_transaction')
on conflict (version) do nothing;
