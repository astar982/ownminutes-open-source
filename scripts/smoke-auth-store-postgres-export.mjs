#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-auth-export-"));
const inputPath = path.join(tmpDir, "store.json");
const outputPath = path.join(tmpDir, "auth-store-import.sql");

const fixture = {
  users: [
    {
      id: "user_fixture",
      email: "fixture@example.com",
      name: "Fixture User",
      role: "admin",
      plan: "plus",
      freeTrialMinutesTotal: 60,
      freeTrialMinutesUsed: 7,
      freeTrialGrantedAt: "2026-06-28T23:00:00.000Z",
      officialMinutesTotal: 600,
      officialMinutesUsed: 12,
      createdAt: "2026-06-29T00:00:00.000Z",
      emailVerifiedAt: "2026-06-29T00:01:00.000Z",
      passwordSalt: "salt_fixture",
      passwordHash: "hash_fixture",
    },
  ],
  sessions: [
    {
      id: "session_fixture",
      userId: "user_fixture",
      tokenHash: "token_hash_fixture",
      createdAt: "2026-06-29T00:00:00.000Z",
      lastSeenAt: "2026-06-29T00:05:00.000Z",
      expiresAt: "2026-07-29T00:00:00.000Z",
    },
  ],
  emailVerificationTokens: [
    {
      id: "verify_fixture",
      userId: "user_fixture",
      tokenHash: "verify_hash_fixture",
      createdAt: "2026-06-29T00:00:30.000Z",
      expiresAt: "2026-06-30T00:00:30.000Z",
      usedAt: "2026-06-29T00:01:00.000Z",
    },
  ],
  passwordResetTokens: [
    {
      id: "reset_fixture",
      userId: "user_fixture",
      tokenHash: "reset_hash_fixture",
      createdAt: "2026-06-29T00:03:00.000Z",
      expiresAt: "2026-06-29T00:33:00.000Z",
      usedAt: undefined,
    },
  ],
  providerCredentials: [
    {
      id: "provider_fixture",
      userId: "user_fixture",
      providerId: "volcano-ark",
      label: "Fixture Ark",
      fields: { ARK_CHAT_MODEL: "fixture-model" },
      encryptedSecrets: { ARK_API_KEY: "v2.fixture.iv.fixturetag.fixtureciphertext" },
      secretPreviews: { ARK_API_KEY: "fix...text" },
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T00:06:00.000Z",
    },
  ],
  usageEvents: [
    {
      id: "usage_fixture",
      userId: "user_fixture",
      type: "meeting_finalize",
      minutes: 1,
      createdAt: "2026-06-29T00:07:00.000Z",
      note: "Finalized meeting:fixture",
    },
  ],
  growthEvents: [
    {
      id: "growth_fixture",
      userId: "user_fixture",
      type: "register",
      source: "share",
      shareId: "meeting-fixture",
      createdAt: "2026-06-29T00:02:00.000Z",
    },
  ],
  billingOrders: [
    {
      id: "order_fixture",
      userId: "user_fixture",
      createdByUserId: "user_fixture",
      provider: "admin_manual",
      status: "paid",
      plan: "plus",
      amountCents: 0,
      currency: "CNY",
      externalTransactionId: "tx_fixture",
      originalTransactionId: "otx_fixture",
      idempotencyKey: "admin_manual:user_fixture:fixture",
      entitlementGrantId: "grant_fixture",
      note: "fixture grant",
      createdAt: "2026-06-29T00:08:00.000Z",
    },
  ],
  entitlementGrants: [
    {
      id: "grant_fixture",
      userId: "user_fixture",
      billingOrderId: "order_fixture",
      grantedByUserId: "user_fixture",
      source: "admin_manual",
      status: "active",
      statusChangedByUserId: undefined,
      statusReason: undefined,
      statusUpdatedAt: undefined,
      previousPlan: "free",
      plan: "plus",
      officialMinutesTotal: 600,
      reason: "fixture grant",
      createdAt: "2026-06-29T00:08:00.000Z",
    },
  ],
};

fs.writeFileSync(inputPath, `${JSON.stringify(fixture, null, 2)}\n`);

const result = spawnSync(process.execPath, ["scripts/export-auth-store-to-postgres.mjs", "--input", inputPath, "--output", outputPath], {
  cwd: process.cwd(),
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

const sql = fs.readFileSync(outputPath, "utf8");
const summary = {
  commandOk: result.status === 0,
  outputCreated: fs.existsSync(outputPath),
  hasTransaction: sql.includes("begin;") && sql.includes("commit;"),
  hasUsersInsert: sql.includes("insert into users"),
  hasSessionsInsert: sql.includes("insert into sessions"),
  hasEmailVerificationTokensInsert: sql.includes("insert into email_verification_tokens"),
  hasEmailVerifiedAt: sql.includes("email_verified_at"),
  hasLifetimeFreeTrialColumns:
    sql.includes("free_trial_minutes_total") &&
    sql.includes("free_trial_minutes_used") &&
    sql.includes("free_trial_granted_at"),
  preservesLifetimeFreeTrial:
    sql.includes("60, 7") &&
    sql.includes("2026-06-28T23:00:00.000Z"),
  requiresAppliedMigrations:
    sql.includes("select 1 from ownminutes_schema_migrations where version = '0014_lifetime_free_trial'") &&
    sql.includes("must be applied before auth-store import"),
  doesNotForgeMigrationHistory: !sql.includes("insert into ownminutes_schema_migrations"),
  hasPasswordResetTokensInsert: sql.includes("insert into password_reset_tokens"),
  hasProviderCredentialsInsert: sql.includes("insert into provider_credentials"),
  hasUsageEventsInsert: sql.includes("insert into usage_events"),
  hasGrowthEventsInsert: sql.includes("insert into growth_events"),
  hasBillingOrdersInsert: sql.includes("insert into billing_orders"),
  hasEntitlementGrantsInsert: sql.includes("insert into entitlement_grants"),
  hasEntitlementStatusColumns: sql.includes("status_changed_by_user_id") && sql.includes("status_updated_at"),
  hasPasswordResetTokenColumns: sql.includes("token_hash") && sql.includes("used_at"),
  hasBillingOrderColumns:
    sql.includes("idempotency_key") &&
    sql.includes("external_transaction_id") &&
    sql.includes("original_transaction_id") &&
    sql.includes("billing_order_id"),
  hasJsonbSecrets: sql.includes("encrypted_secrets") && sql.includes("::jsonb"),
  hasUpsert: sql.includes("on conflict"),
  preservesEncryptedSecret: sql.includes("v2.fixture.iv.fixturetag.fixtureciphertext"),
  preservesGrantReason: sql.includes("fixture grant"),
  preservesIdempotencyKey: sql.includes("admin_manual:user_fixture:fixture"),
  preservesOriginalTransactionId: sql.includes("otx_fixture"),
  preservesResetTokenHash: sql.includes("reset_hash_fixture"),
  preservesVerificationTokenHash: sql.includes("verify_hash_fixture"),
  preservesGrowthShareId: sql.includes("meeting-fixture"),
  leaksPlainSecret:
    sql.includes("sk-proj") ||
    sql.includes("AKL") ||
    sql.includes("plain-secret") ||
    result.stdout.includes("v2.fixture.iv.fixturetag.fixtureciphertext"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.commandOk ||
  !summary.outputCreated ||
  !summary.hasTransaction ||
  !summary.hasUsersInsert ||
  !summary.hasSessionsInsert ||
  !summary.hasEmailVerificationTokensInsert ||
  !summary.hasEmailVerifiedAt ||
  !summary.hasLifetimeFreeTrialColumns ||
  !summary.preservesLifetimeFreeTrial ||
  !summary.requiresAppliedMigrations ||
  !summary.doesNotForgeMigrationHistory ||
  !summary.hasPasswordResetTokensInsert ||
  !summary.hasProviderCredentialsInsert ||
  !summary.hasUsageEventsInsert ||
  !summary.hasGrowthEventsInsert ||
  !summary.hasBillingOrdersInsert ||
  !summary.hasEntitlementGrantsInsert ||
  !summary.hasEntitlementStatusColumns ||
  !summary.hasPasswordResetTokenColumns ||
  !summary.hasBillingOrderColumns ||
  !summary.hasJsonbSecrets ||
  !summary.hasUpsert ||
  !summary.preservesEncryptedSecret ||
  !summary.preservesGrantReason ||
  !summary.preservesIdempotencyKey ||
  !summary.preservesOriginalTransactionId ||
  !summary.preservesResetTokenHash ||
  !summary.preservesVerificationTokenHash ||
  !summary.preservesGrowthShareId ||
  summary.leaksPlainSecret
) {
  process.exitCode = 1;
}
