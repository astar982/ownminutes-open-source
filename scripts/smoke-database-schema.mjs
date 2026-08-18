#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.join(process.cwd(), "db", "migrations");
const migrationFiles = fs.existsSync(migrationsDir)
  ? fs
      .readdirSync(migrationsDir)
      .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
      .sort()
  : [];
const sql = migrationFiles.map((fileName) => fs.readFileSync(path.join(migrationsDir, fileName), "utf8")).join("\n");

const requiredTables = [
  "ownminutes_schema_migrations",
  "users",
  "sessions",
  "password_reset_tokens",
  "email_verification_tokens",
  "provider_credentials",
  "usage_events",
  "meetings",
  "meeting_objects",
  "audit_events",
  "entitlement_grants",
  "billing_orders",
  "growth_events",
  "meeting_finalization_jobs",
  "meeting_deletion_tombstones",
  "meeting_deletion_fences",
  "meeting_catalog_backfill_blockers",
  "meeting_catalog_coverage_fences",
  "meeting_object_transfer_intents",
  "secret_audit_outbox",
  "apple_iap_account_bindings",
  "apple_subscriptions",
  "apple_notification_events",
  "meeting_processing_reservations",
  "account_deletion_provider_cost_aggregates",
  "account_deletion_cleanup_jobs",
  "meeting_storage_integrity_state",
];

const requiredColumns = [
  "users.email",
  "users.password_hash",
  "users.deleted_at",
  "users.email_verified_at",
  "users.free_trial_minutes_total",
  "users.free_trial_minutes_used",
  "users.free_trial_granted_at",
  "users.official_minutes_period_start_at",
  "users.official_minutes_period_end_at",
  "users.official_minutes_period_source",
  "users.official_minutes_billing_order_id",
  "users.processing_mode",
  "sessions.token_hash",
  "password_reset_tokens.token_hash",
  "password_reset_tokens.used_at",
  "email_verification_tokens.token_hash",
  "email_verification_tokens.used_at",
  "email_verification_tokens.credential_kind",
  "email_verification_tokens.failed_attempts",
  "email_verification_tokens.locked_at",
  "provider_credentials.encrypted_secrets",
  "provider_credentials.secret_previews",
  "usage_events.type",
  "meetings.owner_user_id",
  "meetings.object_prefix",
  "meetings.share_visibility",
  "meetings.deleted_at",
  "meeting_objects.object_key",
  "audit_events.event_type",
  "entitlement_grants.granted_by_user_id",
  "entitlement_grants.previous_plan",
  "entitlement_grants.official_minutes_total",
  "entitlement_grants.status_changed_by_user_id",
  "entitlement_grants.status_reason",
  "entitlement_grants.status_updated_at",
  "entitlement_grants.billing_order_id",
  "entitlement_grants.starts_at",
  "entitlement_grants.expires_at",
  "billing_orders.idempotency_key",
  "billing_orders.external_transaction_id",
  "billing_orders.original_transaction_id",
  "billing_orders.entitlement_grant_id",
  "billing_orders.status_updated_at",
  "billing_orders.product_id",
  "billing_orders.environment",
  "billing_orders.price_milliunits",
  "billing_orders.storefront",
  "billing_orders.offer_type",
  "billing_orders.offer_identifier",
  "billing_orders.app_account_token",
  "billing_orders.signed_date",
  "billing_orders.status_signed_date",
  "growth_events.type",
  "growth_events.source",
  "growth_events.share_id",
  "meeting_finalization_jobs.meeting_id",
  "meeting_finalization_jobs.owner_user_id",
  "meeting_finalization_jobs.status",
  "meeting_finalization_jobs.attempt",
  "meeting_finalization_jobs.max_attempts",
  "meeting_finalization_jobs.available_at",
  "meeting_finalization_jobs.lease_expires_at",
  "meeting_finalization_jobs.processing_operation_key",
  "meeting_finalization_jobs.audio_revision",
  "meeting_finalization_jobs.processing_mode",
  "meeting_deletion_tombstones.meeting_id",
  "meeting_deletion_tombstones.owner_user_id",
  "meeting_deletion_tombstones.deleted_at",
  "meeting_deletion_tombstones.cleanup_disposition",
  "meeting_deletion_tombstones.manual_cleanup_detected_at",
  "meeting_deletion_tombstones.manual_cleanup_proof",
  "meeting_deletion_fences.meeting_ref",
  "meeting_deletion_fences.owner_proof_ref",
  "meeting_deletion_fences.cleaned_at",
  "meeting_deletion_fences.cleanup_resolution",
  "meeting_deletion_fences.proof_ref",
  "meeting_catalog_backfill_blockers.prefix_ref",
  "meeting_catalog_backfill_blockers.owner_user_id",
  "meeting_catalog_backfill_blockers.reason",
  "meeting_catalog_backfill_blockers.resolved_at",
  "meeting_catalog_coverage_fences.prefix_ref",
  "meeting_catalog_coverage_fences.owner_user_id",
  "meeting_catalog_coverage_fences.reason",
  "meeting_catalog_coverage_fences.resolved_at",
  "meeting_object_transfer_intents.intent_id",
  "meeting_object_transfer_intents.meeting_id",
  "meeting_object_transfer_intents.owner_user_id",
  "meeting_object_transfer_intents.transfer_kind",
  "meeting_object_transfer_intents.expires_at",
  "secret_audit_outbox.event_id",
  "secret_audit_outbox.payload",
  "secret_audit_outbox.available_at",
  "secret_audit_outbox.attempt_count",
  "secret_audit_outbox.locked_by",
  "secret_audit_outbox.claim_token",
  "secret_audit_outbox.lease_expires_at",
  "secret_audit_outbox.last_error_code",
  "secret_audit_outbox.delivered_at",
  "apple_iap_account_bindings.app_account_token",
  "apple_iap_account_bindings.user_id",
  "apple_iap_account_bindings.key_version",
  "apple_subscriptions.original_transaction_id",
  "apple_subscriptions.current_transaction_id",
  "apple_subscriptions.product_id",
  "apple_subscriptions.environment",
  "apple_subscriptions.status",
  "apple_subscriptions.expires_at",
  "apple_subscriptions.grace_expires_at",
  "apple_subscriptions.auto_renew_status",
  "apple_subscriptions.last_signed_date",
  "apple_notification_events.notification_uuid",
  "apple_notification_events.payload_sha256",
  "apple_notification_events.processing_status",
  "apple_notification_events.result_action",
  "apple_notification_events.error_code",
  "meeting_processing_reservations.operation_key",
  "meeting_processing_reservations.official_minutes_reserved",
  "meeting_processing_reservations.realtime_highest_sequence",
  "usage_events.processing_reservation_id",
  "account_deletion_provider_cost_aggregates.provider_steps",
  "account_deletion_provider_cost_aggregates.official_minutes_settled",
  "account_deletion_provider_cost_aggregates.free_trial_minutes_settled",
  "account_deletion_provider_cost_aggregates.source_ref",
  "account_deletion_cleanup_jobs.status",
  "account_deletion_cleanup_jobs.claim_token",
  "account_deletion_cleanup_jobs.dead_lettered_at",
  "account_deletion_cleanup_jobs.manual_replay_count",
  "account_deletion_cleanup_jobs.last_replayed_at",
  "account_deletion_cleanup_jobs.last_replayed_by_ref",
  "meeting_storage_integrity_state.integrity_key",
  "meeting_storage_integrity_state.audit_version",
  "meeting_storage_integrity_state.writer_invariant_version",
  "meeting_storage_integrity_state.unattributed_prefix_count",
  "meeting_storage_integrity_state.completed_at",
];

const requiredIndexes = [
  "users_active_email_unique",
  "password_reset_tokens_user_created_idx",
  "password_reset_tokens_expires_idx",
  "email_verification_tokens_user_created_idx",
  "email_verification_tokens_user_kind_created_idx",
  "email_verification_tokens_expires_idx",
  "provider_credentials_user_updated_idx",
  "usage_events_user_created_idx",
  "meetings_owner_updated_idx",
  "meetings_owner_deletion_idx",
  "meetings_public_share_idx",
  "meeting_objects_meeting_kind_idx",
  "audit_events_user_created_idx",
  "entitlement_grants_user_created_idx",
  "entitlement_grants_source_status_idx",
  "entitlement_grants_status_updated_idx",
  "billing_orders_user_created_idx",
  "billing_orders_provider_status_idx",
  "billing_orders_external_transaction_idx",
  "billing_orders_original_transaction_idx",
  "billing_orders_apple_transaction_unique_idx",
  "entitlement_grants_billing_order_idx",
  "growth_events_user_created_idx",
  "growth_events_source_share_idx",
  "growth_events_type_source_idx",
  "meeting_finalization_jobs_claim_idx",
  "meeting_finalization_jobs_meeting_idx",
  "meeting_finalization_jobs_owner_idx",
  "meeting_finalization_jobs_lease_idx",
  "meeting_deletion_tombstones_owner_idx",
  "meeting_deletion_tombstones_manual_cleanup_idx",
  "meeting_deletion_fences_cleaned_idx",
  "meeting_catalog_backfill_blockers_unresolved_idx",
  "meeting_catalog_coverage_fences_unresolved_idx",
  "meeting_object_transfer_intents_owner_idx",
  "meeting_object_transfer_intents_meeting_idx",
  "meeting_object_transfer_intents_catalog_expiry_idx",
  "secret_audit_outbox_claim_idx",
  "secret_audit_outbox_lease_idx",
  "secret_audit_outbox_delivered_idx",
  "apple_subscriptions_user_status_idx",
  "apple_subscriptions_current_transaction_idx",
  "apple_subscriptions_expiration_idx",
  "apple_notification_events_transaction_idx",
  "apple_notification_events_original_transaction_idx",
  "apple_notification_events_status_idx",
  "meeting_processing_reservations_user_status_idx",
  "meeting_processing_reservations_meeting_idx",
  "usage_events_processing_reservation_unique_idx",
  "account_deletion_cleanup_jobs_claim_idx",
  "account_deletion_cleanup_jobs_health_idx",
  "account_deletion_cleanup_jobs_dead_letter_idx",
  "account_deletion_provider_cost_source_ref_idx",
];

const normalized = sql.replace(/\s+/g, " ").toLowerCase();
const summary = {
  migrationExists: Boolean(sql),
  migrationCount: migrationFiles.length,
  hasMigrationTracking: normalized.includes("create table if not exists ownminutes_schema_migrations"),
  requiredTablesPresent: requiredTables.every((table) => normalized.includes(`create table if not exists ${table}`)),
  requiredColumnsPresent: requiredColumns.every((column) => {
    const [table, columnName] = column.split(".");
    return normalized.includes(`create table if not exists ${table}`) && normalized.includes(columnName);
  }),
  requiredIndexesPresent: requiredIndexes.every((indexName) => normalized.includes(indexName)),
  hasUniqueSessionToken: normalized.includes("token_hash text not null unique"),
  hasPasswordResetTokens: normalized.includes("create table if not exists password_reset_tokens") && normalized.includes("used_at timestamptz"),
  hasEmailVerification:
    normalized.includes("create table if not exists email_verification_tokens") &&
    normalized.includes("email_verified_at") &&
    normalized.includes("email_verification_tokens_expires_idx"),
  hasEmailVerificationOtp:
    normalized.includes("0018_email_verification_otp") &&
    normalized.includes("alter column free_trial_granted_at drop not null") &&
    normalized.includes("credential_kind text not null default 'link'") &&
    normalized.includes("email_verification_tokens_kind_valid") &&
    normalized.includes("email_verification_tokens_attempts_valid") &&
    normalized.includes("email_verification_tokens_user_kind_created_idx"),
  hasSoftDelete: normalized.includes("deleted_at"),
  hasTenantOwnership: normalized.includes("owner_user_id") && normalized.includes("user_id"),
  hasCascadeDelete: normalized.includes("on delete cascade"),
  hasAuditEvents: normalized.includes("create table if not exists audit_events"),
  hasEntitlementLedger: normalized.includes("create table if not exists entitlement_grants"),
  hasEntitlementStatusFlow: normalized.includes("status_changed_by_user_id") && normalized.includes("status_updated_at"),
  hasBillingOrders: normalized.includes("create table if not exists billing_orders") && normalized.includes("unique (idempotency_key)"),
  hasGrowthEvents:
    normalized.includes("create table if not exists growth_events") &&
    normalized.includes("check (source in ('direct', 'share'))") &&
    normalized.includes("check (type in ('register'))"),
  hasFinalizationQueue:
    normalized.includes("create table if not exists meeting_finalization_jobs") &&
    normalized.includes("retry_wait") &&
    normalized.includes("lease_expires_at") &&
    normalized.includes("max_attempts") &&
    normalized.includes("processing_operation_key") &&
    normalized.includes("audio_revision") &&
    normalized.includes("meeting_finalization_jobs_audio_revision_valid") &&
    normalized.includes("0017_finalization_job_processing_identity"),
  hasExplicitProcessingMode:
    normalized.includes("0019_processing_mode") &&
    normalized.includes("users_processing_mode_valid") &&
    normalized.includes("meeting_finalization_jobs_processing_mode_valid") &&
    normalized.includes("check (processing_mode in ('official_quota', 'byok'))"),
  hasMeetingDeletionFence:
    normalized.includes("create table if not exists meeting_deletion_tombstones") &&
    normalized.includes("meeting_deletion_tombstones_owner_idx"),
  hasAppleAccountBindings:
    normalized.includes("create table if not exists apple_iap_account_bindings") &&
    normalized.includes("app_account_token text primary key") &&
    normalized.includes("unique (user_id, key_version)"),
  hasAppleSubscriptionState:
    normalized.includes("create table if not exists apple_subscriptions") &&
    normalized.includes("last_signed_date timestamptz") &&
    normalized.includes("apple_subscriptions_expiration_idx"),
  hasAppleNotificationInbox:
    normalized.includes("create table if not exists apple_notification_events") &&
    normalized.includes("payload_sha256 text not null") &&
    normalized.includes("processing_status text not null") &&
    normalized.includes("apple_notification_events_status_idx"),
  hasPeriodScopedQuota:
    normalized.includes("official_minutes_period_start_at") &&
    normalized.includes("official_minutes_period_end_at") &&
    normalized.includes("official_minutes_billing_order_id") &&
    normalized.includes("starts_at timestamptz") &&
    normalized.includes("expires_at timestamptz"),
  hasLifetimeFreeTrial:
    normalized.includes("free_trial_minutes_total") &&
    normalized.includes("free_trial_minutes_used") &&
    normalized.includes("free_trial_granted_at") &&
    normalized.includes("users_free_trial_minutes_valid") &&
    normalized.includes("0014_lifetime_free_trial"),
  hasAppleLifecycleBackfill:
    normalized.includes("insert into apple_subscriptions") &&
    normalized.includes("select distinct on (billing_orders.original_transaction_id)") &&
    normalized.includes("update entitlement_grants") &&
    normalized.includes("from billing_orders"),
  hasCurrencySafeApplePricing:
    normalized.includes("price_milliunits bigint") &&
    normalized.includes("alter table billing_orders alter column amount_cents drop not null"),
  hasSecretStorage: normalized.includes("encrypted_secrets jsonb") && normalized.includes("secret_previews jsonb"),
  hasCostSafeProcessingReservations:
    normalized.includes("create table if not exists meeting_processing_reservations") &&
    normalized.includes("unique (user_id, operation_key)") &&
    normalized.includes("usage_events_processing_reservation_unique_idx") &&
    normalized.includes("0015_meeting_processing_reservations") &&
    normalized.includes("settlement_period_identity") &&
    normalized.includes("free_trial_minutes_settled") &&
    normalized.includes("0016_provider_step_settlement_identity"),
  hasAccountDeletionCostAggregation:
    normalized.includes("0020_account_deletion_provider_cost_aggregates") &&
    normalized.includes("create table if not exists account_deletion_provider_cost_aggregates") &&
    normalized.includes("official_minutes_settled bigint") &&
    normalized.includes("free_trial_minutes_settled bigint"),
  hasAsyncAccountDeletionCleanup:
    normalized.includes("0021_account_deletion_cleanup_jobs") &&
    normalized.includes("create table if not exists account_deletion_cleanup_jobs") &&
    normalized.includes("account_deletion_cleanup_jobs_claim_idx"),
  hasAccountDeletionCleanupObservability:
    normalized.includes("0033_account_deletion_cleanup_observability") &&
    normalized.includes("add column if not exists dead_lettered_at timestamptz") &&
    normalized.includes("add column if not exists manual_replay_count integer not null default 0") &&
    normalized.includes("add column if not exists last_replayed_at timestamptz") &&
    normalized.includes("add column if not exists last_replayed_by_ref text") &&
    normalized.includes("manual_replay_count >= 0") &&
    normalized.includes("^operator_[a-f0-9]{20}$") &&
    normalized.includes("create table if not exists meeting_storage_integrity_state") &&
    normalized.includes("writer_invariant_version integer not null") &&
    normalized.includes("unattributed_prefix_count integer not null") &&
    normalized.includes("account_deletion_cleanup_jobs_health_idx") &&
    normalized.includes("account_deletion_cleanup_jobs_dead_letter_idx") &&
    normalized.includes("where dead_lettered_at is null") &&
    normalized.includes("where dead_lettered_at is not null"),
  hasLegacyDeletionCleanupAudit:
    normalized.includes("0022_legacy_deletion_cleanup_audit") &&
    normalized.includes("0023_deletion_fence_owner_proof") &&
    normalized.includes("pending_manual_cleanup") &&
    normalized.includes("manual_cleanup_approved") &&
    normalized.includes("legacy_noncanonical_manual_cleanup_required") &&
    normalized.includes("create table if not exists meeting_deletion_fences") &&
    normalized.includes("legacy_exact_manifest_owner_verified") &&
    normalized.includes("meeting_deletion_tombstones_manual_cleanup_idx") &&
    normalized.includes("meeting_deletion_fences_cleaned_idx"),
  hasMeetingCatalogWriteFences:
    normalized.includes("0030_meeting_catalog_write_fences") &&
    normalized.includes("create table if not exists meeting_catalog_coverage_fences") &&
    normalized.includes("canonical_unattributed") &&
    normalized.includes("meeting_catalog_coverage_fences_unresolved_idx"),
  hasMeetingCatalogPurge:
    normalized.includes("0031_meeting_catalog_purge") &&
    normalized.includes("meetings_owner_deletion_idx") &&
    normalized.includes("deleted meeting usage retained without meeting identity") &&
    normalized.includes("delete from meetings meeting") &&
    normalized.includes("delete from meeting_catalog_coverage_fences") &&
    normalized.includes("delete from meeting_catalog_backfill_blockers"),
  hasMeetingTransferIntents:
    normalized.includes("0032_meeting_transfer_intents") &&
    normalized.includes("create table if not exists meeting_object_transfer_intents") &&
    normalized.includes("transfer_kind = 'catalog_manifest'") &&
    normalized.includes("account_deletion_provider_cost_source_ref_idx") &&
    normalized.includes("on conflict (source_ref) where source_ref is not null do nothing"),
  hasSecretAuditOutbox:
    normalized.includes("0028_secret_audit_outbox") &&
    normalized.includes("create table if not exists secret_audit_outbox") &&
    normalized.includes("secret_audit_outbox_payload_has_no_raw_identity") &&
    normalized.includes("secret_audit_outbox_payload_provider_ref_valid") &&
    normalized.includes("secret_audit_outbox_payload_secret_refs_valid") &&
    normalized.includes("'providerref'") &&
    normalized.includes("'secretrefs'") &&
    normalized.includes("secret_audit_outbox_delivery_claim_consistent") &&
    normalized.includes("secret_audit_outbox_claim_idx") &&
    normalized.includes("secret_audit_outbox_lease_idx"),
  leaksSecrets:
    sql.includes("postgres://") ||
    sql.includes("postgresql://") ||
    sql.includes("DATABASE_URL=") ||
    sql.includes("AKL") ||
    sql.includes("sk-proj"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.migrationExists ||
  !summary.hasMigrationTracking ||
  !summary.requiredTablesPresent ||
  !summary.requiredColumnsPresent ||
  !summary.requiredIndexesPresent ||
  !summary.hasUniqueSessionToken ||
  !summary.hasPasswordResetTokens ||
  !summary.hasEmailVerification ||
  !summary.hasEmailVerificationOtp ||
  !summary.hasSoftDelete ||
  !summary.hasTenantOwnership ||
  !summary.hasCascadeDelete ||
  !summary.hasAuditEvents ||
  !summary.hasEntitlementLedger ||
  !summary.hasEntitlementStatusFlow ||
  !summary.hasBillingOrders ||
  !summary.hasGrowthEvents ||
  !summary.hasFinalizationQueue ||
  !summary.hasExplicitProcessingMode ||
  !summary.hasMeetingDeletionFence ||
  !summary.hasAppleAccountBindings ||
  !summary.hasAppleSubscriptionState ||
  !summary.hasAppleNotificationInbox ||
  !summary.hasPeriodScopedQuota ||
  !summary.hasLifetimeFreeTrial ||
  !summary.hasAppleLifecycleBackfill ||
  !summary.hasCurrencySafeApplePricing ||
  !summary.hasSecretStorage ||
  !summary.hasCostSafeProcessingReservations ||
  !summary.hasAccountDeletionCostAggregation ||
  !summary.hasAsyncAccountDeletionCleanup ||
  !summary.hasAccountDeletionCleanupObservability ||
  !summary.hasLegacyDeletionCleanupAudit ||
  !summary.hasMeetingCatalogWriteFences ||
  !summary.hasMeetingCatalogPurge ||
  !summary.hasMeetingTransferIntents ||
  !summary.hasSecretAuditOutbox ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}
