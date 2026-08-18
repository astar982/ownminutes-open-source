#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const defaultInput = path.join(process.cwd(), ".data", "auth", "store.json");
const defaultOutput = path.join(process.cwd(), ".data", "db", "auth-store-import.sql");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input || defaultInput);
  const outputPath = path.resolve(args.output || defaultOutput);
  const store = readStore(inputPath);
  const sql = renderImportSql(store);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, sql, { mode: 0o600 });

  const summary = {
    input: redactPath(inputPath),
    output: redactPath(outputPath),
    users: store.users.length,
    sessions: store.sessions.length,
    emailVerificationTokens: store.emailVerificationTokens.length,
    passwordResetTokens: store.passwordResetTokens.length,
    providerCredentials: store.providerCredentials.length,
    usageEvents: store.usageEvents.length,
    growthEvents: store.growthEvents.length,
    billingOrders: store.billingOrders.length,
    entitlementGrants: store.entitlementGrants.length,
    bytes: Buffer.byteLength(sql),
  };
  console.log(JSON.stringify(summary, null, 2));
}

function renderImportSql(store) {
  const lines = [
    "-- OwnMinutes auth-store PostgreSQL import.",
    "-- Generated from local JSON. Run real migrations first and review before production import.",
    "begin;",
    "set constraints all immediate;",
    "do $$",
    "begin",
    "  if not exists (select 1 from ownminutes_schema_migrations where version = '0014_lifetime_free_trial') then",
    "    raise exception 'OwnMinutes schema migrations through 0014_lifetime_free_trial must be applied before auth-store import';",
    "  end if;",
    "end $$;",
    "",
  ];

  for (const user of store.users) {
    const freeTrial = normalizeFreeTrial(user);
    lines.push(
      `insert into users (id, email, name, role, plan, free_trial_minutes_total, free_trial_minutes_used, free_trial_granted_at, official_minutes_total, official_minutes_used, password_salt, password_hash, created_at, email_verified_at, deleted_at) values (${[
        sqlString(user.id),
        sqlString(user.email),
        sqlString(user.name),
        sqlString(user.role),
        sqlString(user.plan),
        sqlInteger(freeTrial.total),
        sqlInteger(freeTrial.used),
        sqlTimestamp(freeTrial.grantedAt),
        sqlInteger(user.officialMinutesTotal),
        sqlInteger(user.officialMinutesUsed),
        sqlString(user.passwordSalt),
        sqlString(user.passwordHash),
        sqlTimestamp(user.createdAt),
        sqlTimestamp(user.emailVerifiedAt || user.createdAt),
        sqlNullableTimestamp(user.deletedAt),
      ].join(", ")}) on conflict (id) do update set email = excluded.email, name = excluded.name, role = excluded.role, plan = excluded.plan, free_trial_minutes_total = excluded.free_trial_minutes_total, free_trial_minutes_used = excluded.free_trial_minutes_used, free_trial_granted_at = excluded.free_trial_granted_at, official_minutes_total = excluded.official_minutes_total, official_minutes_used = excluded.official_minutes_used, password_salt = excluded.password_salt, password_hash = excluded.password_hash, created_at = excluded.created_at, email_verified_at = excluded.email_verified_at, deleted_at = excluded.deleted_at;`,
    );
  }

  lines.push("");

  for (const session of store.sessions) {
    if (!store.users.some((user) => user.id === session.userId)) continue;
    lines.push(
      `insert into sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at) values (${[
        sqlString(session.id),
        sqlString(session.userId),
        sqlString(session.tokenHash),
        sqlTimestamp(session.createdAt),
        sqlTimestamp(session.lastSeenAt),
        sqlTimestamp(session.expiresAt),
      ].join(", ")}) on conflict (id) do update set user_id = excluded.user_id, token_hash = excluded.token_hash, created_at = excluded.created_at, last_seen_at = excluded.last_seen_at, expires_at = excluded.expires_at;`,
    );
  }

  lines.push("");

  for (const token of store.emailVerificationTokens) {
    if (!store.users.some((user) => user.id === token.userId)) continue;
    lines.push(
      `insert into email_verification_tokens (id, user_id, token_hash, created_at, expires_at, used_at) values (${[
        sqlString(token.id),
        sqlString(token.userId),
        sqlString(token.tokenHash),
        sqlTimestamp(token.createdAt),
        sqlTimestamp(token.expiresAt),
        sqlNullableTimestamp(token.usedAt),
      ].join(", ")}) on conflict (id) do update set user_id = excluded.user_id, token_hash = excluded.token_hash, created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = excluded.used_at;`,
    );
  }

  lines.push("");

  for (const token of store.passwordResetTokens) {
    if (!store.users.some((user) => user.id === token.userId)) continue;
    lines.push(
      `insert into password_reset_tokens (id, user_id, token_hash, created_at, expires_at, used_at) values (${[
        sqlString(token.id),
        sqlString(token.userId),
        sqlString(token.tokenHash),
        sqlTimestamp(token.createdAt),
        sqlTimestamp(token.expiresAt),
        sqlNullableTimestamp(token.usedAt),
      ].join(", ")}) on conflict (id) do update set user_id = excluded.user_id, token_hash = excluded.token_hash, created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = excluded.used_at;`,
    );
  }

  lines.push("");

  for (const credential of store.providerCredentials) {
    if (!store.users.some((user) => user.id === credential.userId)) continue;
    lines.push(
      `insert into provider_credentials (id, user_id, provider_id, label, fields, encrypted_secrets, secret_previews, created_at, updated_at) values (${[
        sqlString(credential.id),
        sqlString(credential.userId),
        sqlString(credential.providerId),
        sqlString(credential.label),
        sqlJsonb(credential.fields),
        sqlJsonb(credential.encryptedSecrets),
        sqlJsonb(credential.secretPreviews),
        sqlTimestamp(credential.createdAt),
        sqlTimestamp(credential.updatedAt),
      ].join(", ")}) on conflict (user_id, provider_id) do update set label = excluded.label, fields = excluded.fields, encrypted_secrets = excluded.encrypted_secrets, secret_previews = excluded.secret_previews, updated_at = excluded.updated_at;`,
    );
  }

  lines.push("");

  for (const event of store.usageEvents) {
    if (!store.users.some((user) => user.id === event.userId)) continue;
    lines.push(
      `insert into usage_events (id, user_id, type, minutes, created_at, note) values (${[
        sqlString(event.id),
        sqlString(event.userId),
        sqlString(event.type),
        sqlInteger(event.minutes),
        sqlTimestamp(event.createdAt),
        sqlString(event.note),
      ].join(", ")}) on conflict (id) do update set user_id = excluded.user_id, type = excluded.type, minutes = excluded.minutes, created_at = excluded.created_at, note = excluded.note;`,
    );
  }

  lines.push("");

  for (const event of store.growthEvents) {
    if (!store.users.some((user) => user.id === event.userId)) continue;
    lines.push(
      `insert into growth_events (id, user_id, type, source, share_id, created_at) values (${[
        sqlString(event.id),
        sqlString(event.userId),
        sqlString(event.type),
        sqlString(event.source),
        sqlNullableString(event.shareId),
        sqlTimestamp(event.createdAt),
      ].join(", ")}) on conflict (id) do update set user_id = excluded.user_id, type = excluded.type, source = excluded.source, share_id = excluded.share_id, created_at = excluded.created_at;`,
    );
  }

  lines.push("");

  for (const order of store.billingOrders) {
    if (!store.users.some((user) => user.id === order.userId)) continue;
    lines.push(
      `insert into billing_orders (id, user_id, created_by_user_id, provider, status, plan, amount_cents, currency, external_transaction_id, original_transaction_id, idempotency_key, period_start_at, period_end_at, entitlement_grant_id, note, status_reason, status_updated_at, created_at) values (${[
        sqlString(order.id),
        sqlString(order.userId),
        sqlNullableString(order.createdByUserId),
        sqlString(order.provider),
        sqlString(order.status),
        sqlString(order.plan),
        order.provider === "apple_iap" && order.amountCents === undefined ? "null" : sqlInteger(order.amountCents),
        sqlString(order.currency),
        sqlNullableString(order.externalTransactionId),
        sqlNullableString(order.originalTransactionId),
        sqlString(order.idempotencyKey),
        sqlNullableTimestamp(order.periodStartAt),
        sqlNullableTimestamp(order.periodEndAt),
        sqlNullableString(order.entitlementGrantId),
        sqlString(order.note),
        sqlNullableString(order.statusReason),
        sqlNullableTimestamp(order.statusUpdatedAt),
        sqlTimestamp(order.createdAt),
      ].join(", ")}) on conflict (id) do update set user_id = excluded.user_id, created_by_user_id = excluded.created_by_user_id, provider = excluded.provider, status = excluded.status, plan = excluded.plan, amount_cents = excluded.amount_cents, currency = excluded.currency, external_transaction_id = excluded.external_transaction_id, original_transaction_id = excluded.original_transaction_id, idempotency_key = excluded.idempotency_key, period_start_at = excluded.period_start_at, period_end_at = excluded.period_end_at, entitlement_grant_id = excluded.entitlement_grant_id, note = excluded.note, status_reason = excluded.status_reason, status_updated_at = excluded.status_updated_at, created_at = excluded.created_at;`,
    );
  }

  lines.push("");

  for (const grant of store.entitlementGrants) {
    if (!store.users.some((user) => user.id === grant.userId)) continue;
    lines.push(
      `insert into entitlement_grants (id, user_id, billing_order_id, granted_by_user_id, source, status, status_changed_by_user_id, status_reason, status_updated_at, previous_plan, plan, official_minutes_total, reason, created_at) values (${[
        sqlString(grant.id),
        sqlString(grant.userId),
        sqlNullableString(grant.billingOrderId),
        sqlNullableString(grant.grantedByUserId),
        sqlString(grant.source),
        sqlString(grant.status),
        sqlNullableString(grant.statusChangedByUserId),
        sqlNullableString(grant.statusReason),
        sqlNullableTimestamp(grant.statusUpdatedAt),
        sqlString(grant.previousPlan),
        sqlString(grant.plan),
        sqlInteger(grant.officialMinutesTotal),
        sqlString(grant.reason),
        sqlTimestamp(grant.createdAt),
      ].join(", ")}) on conflict (id) do update set user_id = excluded.user_id, billing_order_id = excluded.billing_order_id, granted_by_user_id = excluded.granted_by_user_id, source = excluded.source, status = excluded.status, status_changed_by_user_id = excluded.status_changed_by_user_id, status_reason = excluded.status_reason, status_updated_at = excluded.status_updated_at, previous_plan = excluded.previous_plan, plan = excluded.plan, official_minutes_total = excluded.official_minutes_total, reason = excluded.reason, created_at = excluded.created_at;`,
    );
  }

  lines.push(
    "",
    "commit;",
    "",
  );

  return lines.join("\n");
}

function normalizeFreeTrial(user) {
  const total = Number.isFinite(Number(user.freeTrialMinutesTotal))
    ? Math.max(0, Math.min(60, Math.floor(Number(user.freeTrialMinutesTotal))))
    : 60;
  let used = Number(user.freeTrialMinutesUsed);
  if (!Number.isFinite(used) || used < 0) {
    if (user.plan === "free") {
      const remaining = Math.max(0, Number(user.officialMinutesTotal || 0) - Number(user.officialMinutesUsed || 0));
      used = total - Math.min(total, remaining);
    } else {
      used = total;
    }
  }
  return {
    total,
    used: Math.max(0, Math.min(total, Math.floor(used))),
    grantedAt: user.freeTrialGrantedAt || user.createdAt,
  };
}

function readStore(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Auth store not found: ${redactPath(inputPath)}`);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const store = JSON.parse(raw);
  validateStore(store);
  return store;
}

function validateStore(store) {
  const arrays = ["users", "sessions", "providerCredentials", "usageEvents"];
  for (const key of arrays) {
    if (!Array.isArray(store[key])) {
      throw new Error(`Invalid auth store: ${key} must be an array.`);
    }
  }
  if (!Array.isArray(store.entitlementGrants)) {
    store.entitlementGrants = [];
  }
  if (!Array.isArray(store.billingOrders)) {
    store.billingOrders = [];
  }
  if (!Array.isArray(store.passwordResetTokens)) {
    store.passwordResetTokens = [];
  }
  if (!Array.isArray(store.emailVerificationTokens)) {
    store.emailVerificationTokens = [];
  }
  if (!Array.isArray(store.growthEvents)) {
    store.growthEvents = [];
  }

  for (const credential of store.providerCredentials) {
    for (const [key, value] of Object.entries(credential.encryptedSecrets ?? {})) {
      if (typeof value !== "string" || (!value.startsWith("v2.") && value.split(".").length !== 3)) {
        throw new Error(`Invalid encrypted secret format for ${credential.providerId}.${key}.`);
      }
    }
  }
}

function sqlString(value) {
  if (typeof value !== "string") return "''";
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNullableString(value) {
  if (typeof value !== "string" || value.length === 0) return "null";
  return sqlString(value);
}

function sqlInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return "0";
  return String(number);
}

function sqlTimestamp(value) {
  if (typeof value !== "string" || !value) return "now()";
  return `${sqlString(value)}::timestamptz`;
}

function sqlNullableTimestamp(value) {
  if (!value) return "null";
  return sqlTimestamp(value);
}

function sqlJsonb(value) {
  return `${sqlString(JSON.stringify(value ?? {}))}::jsonb`;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input") parsed.input = args[++index];
    if (arg === "--output") parsed.output = args[++index];
  }
  return parsed;
}

function redactPath(filePath) {
  return path.relative(process.cwd(), filePath) || ".";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
