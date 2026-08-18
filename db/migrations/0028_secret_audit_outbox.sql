-- Provider Secret changes and their redacted audit facts must commit together.
-- Delivery to the append-only audit sink is deliberately at-least-once: a
-- worker crash after append and before acknowledgement can repeat the same
-- stable event id, but can never erase the durable pending event.

create or replace function ownminutes_jsonb_text_array_is_unique(value jsonb)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
  select
    pg_catalog.jsonb_typeof(value) = 'array'
    and (
      select pg_catalog.count(*) = pg_catalog.count(distinct element)
      from pg_catalog.jsonb_array_elements_text(value) as item(element)
    )
$$;

create table if not exists secret_audit_outbox (
  event_id text primary key
    check (event_id ~ '^secret_audit_[A-Za-z0-9_-]{16,80}$'),
  payload jsonb not null,
  created_at timestamptz not null,
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0
    check (attempt_count between 0 and 1000000),
  locked_by text,
  claim_token text,
  lease_expires_at timestamptz,
  last_error_code text,
  delivered_at timestamptz,
  constraint secret_audit_outbox_payload_object
    check (jsonb_typeof(payload) = 'object'),
  constraint secret_audit_outbox_payload_required_fields
    check (
      payload ?& array[
        'id',
        'eventType',
        'userRef',
        'providerRef',
        'secretRefs',
        'metadata',
        'createdAt'
      ]
    ),
  constraint secret_audit_outbox_payload_id_matches
    check (
      jsonb_typeof(payload -> 'id') = 'string'
      and payload ->> 'id' = event_id
    ),
  constraint secret_audit_outbox_payload_event_type_valid
    check (
      jsonb_typeof(payload -> 'eventType') = 'string'
      and payload ->> 'eventType' in (
        'provider_secret_delete',
        'provider_secret_decrypt_failed',
        'provider_secret_rotate',
        'provider_secret_save'
      )
    ),
  constraint secret_audit_outbox_payload_user_ref_valid
    check (
      jsonb_typeof(payload -> 'userRef') = 'string'
      and (payload ->> 'userRef') ~ '^user_[a-f0-9]{24}$'
    ),
  constraint secret_audit_outbox_payload_provider_ref_valid
    check (
      jsonb_typeof(payload -> 'providerRef') = 'string'
      and (payload ->> 'providerRef') ~ '^provider_[a-f0-9]{24}$'
    ),
  constraint secret_audit_outbox_payload_secret_refs_valid
    check (
      jsonb_typeof(payload -> 'secretRefs') = 'array'
      and jsonb_array_length(payload -> 'secretRefs') <= 32
      and ownminutes_jsonb_text_array_is_unique(payload -> 'secretRefs')
      and not jsonb_path_exists(
        payload -> 'secretRefs',
        '$[*] ? (!(@ like_regex "^secret_[a-f0-9]{24}$"))'
      )
    ),
  constraint secret_audit_outbox_payload_metadata_valid
    check (
      jsonb_typeof(payload -> 'metadata') = 'object'
      and payload #>> '{metadata,reason}' in (
        'account_delete',
        'provider_auth_switch',
        'provider_delete',
        'provider_runtime_decrypt',
        'provider_save',
        'provider_update'
      )
      and payload -> 'metadata' = jsonb_build_object(
        'reason',
        payload #>> '{metadata,reason}'
      )
      and (
        (payload ->> 'eventType' = 'provider_secret_save'
          and payload #>> '{metadata,reason}' = 'provider_save')
        or
        (payload ->> 'eventType' = 'provider_secret_rotate'
          and payload #>> '{metadata,reason}' = 'provider_update')
        or
        (payload ->> 'eventType' = 'provider_secret_decrypt_failed'
          and payload #>> '{metadata,reason}' = 'provider_runtime_decrypt')
        or
        (payload ->> 'eventType' = 'provider_secret_delete'
          and payload #>> '{metadata,reason}' in (
            'account_delete',
            'provider_auth_switch',
            'provider_delete'
          ))
      )
    ),
  constraint secret_audit_outbox_payload_created_at_valid
    check (
      jsonb_typeof(payload -> 'createdAt') = 'string'
      and (payload ->> 'createdAt')
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      and (payload ->> 'createdAt')::timestamptz = created_at
    ),
  constraint secret_audit_outbox_payload_has_no_raw_identity
    check (
      payload - array[
        'id',
        'eventType',
        'userRef',
        'providerRef',
        'secretRefs',
        'metadata',
        'createdAt'
      ] = '{}'::jsonb
      and payload::text !~ '"(userId|user_id|providerId|provider_id|secretNames|secret_names|providerCredentialId|provider_credential_id|message|encryptedSecrets|encrypted_secrets|plaintext|rawSecret|raw_secret)"[[:space:]]*:'
    ),
  constraint secret_audit_outbox_delivery_claim_consistent
    check (
      (locked_by is null and claim_token is null and lease_expires_at is null)
      or
      (locked_by is not null and claim_token is not null and lease_expires_at is not null)
    ),
  constraint secret_audit_outbox_delivery_state_consistent
    check (
      delivered_at is null
      or (locked_by is null and claim_token is null and lease_expires_at is null)
    )
);

create index if not exists secret_audit_outbox_claim_idx
  on secret_audit_outbox (available_at, created_at, event_id)
  where delivered_at is null;

create index if not exists secret_audit_outbox_lease_idx
  on secret_audit_outbox (lease_expires_at)
  where delivered_at is null and lease_expires_at is not null;

create index if not exists secret_audit_outbox_delivered_idx
  on secret_audit_outbox (delivered_at)
  where delivered_at is not null;

insert into ownminutes_schema_migrations (version)
values ('0028_secret_audit_outbox')
on conflict (version) do nothing;
