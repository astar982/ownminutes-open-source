#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_ACCOUNT_CLEANUP_GATE_STRICT === "1";
const staleJobAgeMs = 5 * 60 * 1_000;
const integrityMaxAgeMs = 10 * 60 * 1_000;
const expectedIntegrityAuditVersion = 1;
const expectedWriterInvariantVersion = 1;

const summary = {
  ok: false,
  strict,
  databaseConfigured: Boolean(databaseUrl),
  databaseConnected: false,
  querySucceeded: false,
  schemaReady: false,
  migration0033Applied: false,
  deletedUserJobCount: null,
  deadLetteredCount: null,
  expiredClaimCount: null,
  overdueRunnableCount: null,
  integrityStatePresent: false,
  integrityFresh: false,
  integrityAuditVersionCurrent: false,
  integrityWriterInvariantVersionCurrent: false,
  unattributedPrefixCount: null,
  integrityCompletedAt: null,
  checkedAt: new Date().toISOString(),
  releaseBlocked: true,
};

if (databaseUrl) await runGate();

console.log(JSON.stringify(summary, null, 2));
if (strict && !summary.ok) process.exitCode = 1;

async function runGate() {
  let client;
  let transactionOpen = false;
  try {
    client = new Client({
      application_name: "ownminutes-account-cleanup-release-gate",
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 8_000,
    });
    await client.connect();
    summary.databaseConnected = true;
    await client.query("begin transaction isolation level repeatable read read only");
    transactionOpen = true;

    const schemaResult = await client.query(
      `with required_columns(table_name, column_name) as (
         values
           ('account_deletion_cleanup_jobs', 'user_id'),
           ('account_deletion_cleanup_jobs', 'status'),
           ('account_deletion_cleanup_jobs', 'available_at'),
           ('account_deletion_cleanup_jobs', 'claimed_at'),
           ('account_deletion_cleanup_jobs', 'dead_lettered_at'),
           ('account_deletion_cleanup_jobs', 'manual_replay_count'),
           ('account_deletion_cleanup_jobs', 'last_replayed_at'),
           ('account_deletion_cleanup_jobs', 'last_replayed_by_ref'),
           ('users', 'id'),
           ('users', 'deleted_at'),
           ('meeting_storage_integrity_state', 'integrity_key'),
           ('meeting_storage_integrity_state', 'audit_version'),
           ('meeting_storage_integrity_state', 'writer_invariant_version'),
           ('meeting_storage_integrity_state', 'unattributed_prefix_count'),
           ('meeting_storage_integrity_state', 'completed_at')
       )
       select
         to_regclass('public.ownminutes_schema_migrations') is not null as migrations_table_ready,
         to_regclass('public.account_deletion_cleanup_jobs') is not null as cleanup_jobs_table_ready,
         to_regclass('public.users') is not null as users_table_ready,
         to_regclass('public.meeting_storage_integrity_state') is not null as integrity_state_table_ready,
         to_regclass('public.account_deletion_cleanup_jobs_health_idx') is not null as health_index_ready,
         to_regclass('public.account_deletion_cleanup_jobs_dead_letter_idx') is not null as dead_letter_index_ready,
         not exists (
           select 1
           from required_columns required
           left join information_schema.columns actual
             on actual.table_schema = 'public'
            and actual.table_name = required.table_name
            and actual.column_name = required.column_name
           where actual.column_name is null
         ) as required_columns_ready`,
    );
    const schema = schemaResult.rows[0] || {};
    const baseSchemaReady =
      schema.migrations_table_ready === true &&
      schema.cleanup_jobs_table_ready === true &&
      schema.users_table_ready === true &&
      schema.integrity_state_table_ready === true &&
      schema.health_index_ready === true &&
      schema.dead_letter_index_ready === true &&
      schema.required_columns_ready === true;

    if (schema.migrations_table_ready === true) {
      const migrationResult = await client.query(
        `select exists (
           select 1
           from ownminutes_schema_migrations
           where version = '0033_account_deletion_cleanup_observability'
         ) as migration_applied`,
      );
      summary.migration0033Applied = migrationResult.rows[0]?.migration_applied === true;
    }
    summary.schemaReady = baseSchemaReady && summary.migration0033Applied;

    if (summary.schemaReady) {
      const jobsResult = await client.query(
        `select
           count(*)::int as deleted_user_job_count,
           count(*) filter (where job.dead_lettered_at is not null)::int as dead_lettered_count,
           count(*) filter (
             where job.dead_lettered_at is null
               and job.status = 'processing'
               and job.claimed_at < now() - ($1::bigint * interval '1 millisecond')
           )::int as expired_claim_count,
           count(*) filter (
             where job.dead_lettered_at is null
               and job.status = 'pending'
               and job.available_at < now() - ($1::bigint * interval '1 millisecond')
           )::int as overdue_runnable_count
         from account_deletion_cleanup_jobs job
         join users on users.id = job.user_id
         where users.deleted_at is not null`,
        [staleJobAgeMs],
      );
      const jobs = jobsResult.rows[0] || {};
      summary.deletedUserJobCount = finiteCount(jobs.deleted_user_job_count);
      summary.deadLetteredCount = finiteCount(jobs.dead_lettered_count);
      summary.expiredClaimCount = finiteCount(jobs.expired_claim_count);
      summary.overdueRunnableCount = finiteCount(jobs.overdue_runnable_count);

      const integrityResult = await client.query(
        `select
           audit_version = $2::int as audit_version_current,
           writer_invariant_version = $3::int as writer_invariant_version_current,
           unattributed_prefix_count,
           completed_at,
           completed_at >= now() - ($1::bigint * interval '1 millisecond')
             and completed_at <= now() as integrity_fresh
         from meeting_storage_integrity_state
         where integrity_key = 'meeting-storage-integrity'`,
        [integrityMaxAgeMs, expectedIntegrityAuditVersion, expectedWriterInvariantVersion],
      );
      const integrity = integrityResult.rows[0];
      summary.integrityStatePresent = integrityResult.rowCount === 1;
      summary.integrityFresh = integrity?.integrity_fresh === true;
      summary.integrityAuditVersionCurrent = integrity?.audit_version_current === true;
      summary.integrityWriterInvariantVersionCurrent = integrity?.writer_invariant_version_current === true;
      summary.unattributedPrefixCount = integrity ? finiteCount(integrity.unattributed_prefix_count) : null;
      summary.integrityCompletedAt = integrity?.completed_at ? safeIso(integrity.completed_at) : null;
    }

    await client.query("commit");
    transactionOpen = false;
    summary.querySucceeded = true;
    summary.ok =
      summary.schemaReady &&
      summary.deadLetteredCount === 0 &&
      summary.expiredClaimCount === 0 &&
      summary.overdueRunnableCount === 0 &&
      summary.integrityStatePresent &&
      summary.integrityFresh &&
      summary.integrityAuditVersionCurrent &&
      summary.integrityWriterInvariantVersionCurrent &&
      summary.unattributedPrefixCount === 0;
    summary.releaseBlocked = !summary.ok;
  } catch {
    summary.ok = false;
    summary.releaseBlocked = true;
  } finally {
    if (client && transactionOpen) await client.query("rollback").catch(() => undefined);
    if (client) await client.end().catch(() => undefined);
  }
}

function finiteCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeIso(value) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}
