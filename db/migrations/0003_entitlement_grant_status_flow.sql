-- OwnMinutes entitlement grant status workflow.
-- Keeps audit details when a manual/IAP entitlement is revoked or refunded.

alter table entitlement_grants
  add column if not exists status_changed_by_user_id text references users(id) on delete set null,
  add column if not exists status_reason text,
  add column if not exists status_updated_at timestamptz;

create index if not exists entitlement_grants_status_updated_idx
  on entitlement_grants (status, status_updated_at desc);

create index if not exists entitlement_grants_status_changed_by_idx
  on entitlement_grants (status_changed_by_user_id, status_updated_at desc);

insert into ownminutes_schema_migrations (version)
values ('0003_entitlement_grant_status_flow')
on conflict (version) do nothing;
