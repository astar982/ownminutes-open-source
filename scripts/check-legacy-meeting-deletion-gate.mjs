#!/usr/bin/env node

import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_LEGACY_CLEANUP_GATE_STRICT === "1";

if (!databaseUrl) {
  const summary = {
    ok: false,
    strict,
    schemaReady: false,
    unresolvedOwnedCount: null,
    error: "DATABASE_URL or POSTGRES_URL is required for the legacy deletion cleanup gate.",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (strict) process.exitCode = 1;
} else {
  await main();
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const schema = await pool.query(
      `select to_regclass('public.meeting_deletion_tombstones') is not null as tombstones,
              to_regclass('public.meeting_deletion_fences') is not null as fences,
              to_regclass('public.meeting_catalog_backfill_blockers') is not null as catalog_blockers,
              to_regclass('public.meeting_catalog_coverage_fences') is not null as catalog_coverage_fences,
              exists(
                select 1 from ownminutes_schema_migrations
                where version = '0031_meeting_catalog_purge'
              ) as catalog_purge,
              exists(
                select 1 from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'meeting_deletion_tombstones'
                  and column_name = 'cleanup_disposition'
              ) as disposition`,
    );
    const schemaReady =
      schema.rows[0]?.tombstones === true &&
      schema.rows[0]?.fences === true &&
      schema.rows[0]?.catalog_blockers === true &&
      schema.rows[0]?.catalog_coverage_fences === true &&
      schema.rows[0]?.catalog_purge === true &&
      schema.rows[0]?.disposition === true;
    if (!schemaReady) {
      const summary = {
        ok: false,
        strict,
        schemaReady: false,
        unresolvedOwnedCount: null,
        nextAction: "Apply migrations through 0031_meeting_catalog_purge before promotion.",
      };
      console.log(JSON.stringify(summary, null, 2));
      if (strict) process.exitCode = 1;
      return;
    }

    await quarantineLegacyRows(pool);
    let minimized = 0;
    while (true) {
      const batch = await minimizeCleanedRows(pool, 250);
      minimized += batch;
      if (batch < 250) break;
    }
    const unresolved = await pool.query(
      `select count(*) as unresolved_count,
              count(*) filter (where owner_user_id is not null) as unresolved_owned_count,
              count(*) filter (
                where coalesce(manual_cleanup_detected_at, deleted_at) < now() - interval '30 days'
              ) as overdue_count,
              min(coalesce(manual_cleanup_detected_at, deleted_at)) as oldest_detected_at
       from meeting_deletion_tombstones
       where cleanup_pending = true
         and (
           cleanup_disposition in ('pending_manual_cleanup', 'manual_cleanup_approved')
           or not (meeting_id ~ '^[A-Za-z0-9_-]{1,160}$')
         )`,
    );
    const row = unresolved.rows[0] || {};
    const unresolvedCount = Number(row.unresolved_count || 0);
    const unresolvedOwnedCount = Number(row.unresolved_owned_count || 0);
    const catalogBlockers = await pool.query(
      `select (
         (select count(*) from meeting_catalog_backfill_blockers where resolved_at is null) +
         (select count(*) from meeting_catalog_coverage_fences where resolved_at is null)
       ) as unresolved_count`,
    );
    const catalogBackfillBlockerCount = Number(catalogBlockers.rows[0]?.unresolved_count || 0);
    const summary = {
      ok: unresolvedCount === 0 && catalogBackfillBlockerCount === 0,
      strict,
      schemaReady: true,
      minimizedCompletedIdentifiers: minimized,
      unresolvedCount,
      unresolvedOwnedCount,
      catalogBackfillBlockerCount,
      overdueCount: Number(row.overdue_count || 0),
      oldestDetectedAt: row.oldest_detected_at ? new Date(row.oldest_detected_at).toISOString() : null,
      releaseBlocked: unresolvedCount > 0 || catalogBackfillBlockerCount > 0,
      nextAction: unresolvedCount > 0 || catalogBackfillBlockerCount > 0
        ? "Open the admin cleanup inventory and follow docs/legacy-meeting-deletion-cleanup-runbook.md. Do not promote production."
        : "No unresolved manual cleanup or catalog backfill blocker prevents production promotion.",
    };
    console.log(JSON.stringify(summary, null, 2));
    if (strict && !summary.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function quarantineLegacyRows(pool) {
  await pool.query(
    `update meeting_deletion_tombstones
     set cleanup_disposition = 'pending_manual_cleanup',
         manual_cleanup_detected_at = coalesce(manual_cleanup_detected_at, now()),
         cleanup_next_attempt_at = 'infinity'::timestamptz,
         cleanup_claimed_at = null,
         cleanup_claimed_by = null,
         cleanup_claim_token = null,
         cleanup_last_error = 'legacy_noncanonical_manual_cleanup_required'
     where cleanup_pending = true
       and not (meeting_id ~ '^[A-Za-z0-9_-]{1,160}$')`,
  );
}

async function minimizeCleanedRows(pool, limit) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const rows = await client.query(
      `select meeting_id, owner_user_id, deleted_at, cleaned_at
       from meeting_deletion_tombstones
       where cleanup_pending = false or cleaned_at is not null
       order by coalesce(cleaned_at, deleted_at) asc
       for update skip locked
       limit $1`,
      [limit],
    );
    for (const row of rows.rows) {
      await client.query(
        `insert into meeting_deletion_fences (meeting_ref, owner_proof_ref, deleted_at, cleaned_at)
         values ($1, $2, $3, coalesce($4::timestamptz, now()))
         on conflict (meeting_ref) do update
           set deleted_at = least(meeting_deletion_fences.deleted_at, excluded.deleted_at),
               cleaned_at = least(meeting_deletion_fences.cleaned_at, excluded.cleaned_at)`,
        [meetingRef(row.meeting_id), ownerProofRef(row.meeting_id, row.owner_user_id), row.deleted_at, row.cleaned_at],
      );
      await client.query("delete from meeting_deletion_tombstones where meeting_id = $1", [row.meeting_id]);
    }
    await client.query("commit");
    return rows.rowCount || 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function meetingRef(meetingId) {
  return crypto.createHash("sha256").update(`ownminutes-meeting-deletion-fence:v1:${meetingId}`).digest("hex");
}

function ownerProofRef(meetingId, ownerUserId) {
  return crypto.createHash("sha256").update(`ownminutes-meeting-deletion-owner-proof:v1:${meetingId}\u0000${ownerUserId}`).digest("hex");
}
