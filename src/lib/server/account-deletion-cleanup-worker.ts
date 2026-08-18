import crypto from "node:crypto";
import { deleteAllUserMeetings, refreshMeetingStorageIntegrityAudit } from "@/lib/server/meeting-audio-store";
import { getPostgresDatabaseUrl, getPostgresRuntimePool } from "@/lib/server/postgres-runtime";

const accountDeletionCleanupMaxAttempts = 12;
const accountDeletionCleanupStaleAgeMs = 5 * 60 * 1_000;
const accountDeletionCleanupInventoryLimit = 100;

export type AccountDeletionCleanupDiagnostics = {
  activeAccountJobCount: number;
  deadLetteredCount: number;
  expiredClaimCount: number;
  generatedAt: string;
  inventory: Array<{
    accountRef: string;
    attempt: number;
    availableAt: string;
    createdAt: string;
    deadLetteredAt: string | null;
    state: "dead_lettered" | "expired_claim" | "overdue" | "pending" | "processing";
  }>;
  inventoryLimit: number;
  maxAttempt: number;
  oldestCreatedAt: string | null;
  overdueRunnableCount: number;
  pendingCount: number;
  processingCount: number;
  releaseBlocked: boolean;
  supported: boolean;
  totalCount: number;
};

export async function runAccountDeletionObjectCleanupOnce(workerId: string) {
  if (!usesPostgresRepository()) return { claimed: false as const };
  const integrity = await refreshMeetingStorageIntegrityAudit();
  if (!integrity.ready) {
    return { claimed: false as const, integrityBlocked: true as const };
  }
  const claim = await claimCleanup(workerId);
  if (!claim) return { claimed: false as const };
  const abortController = new AbortController();
  let heartbeatInFlight = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || abortController.signal.aborted) return;
    heartbeatInFlight = true;
    void heartbeatCleanup(claim)
      .then((renewed) => {
        if (!renewed) abortController.abort(new Error("Account deletion cleanup lease was superseded."));
      })
      .catch(() => {
        abortController.abort(new Error("Account deletion cleanup lease heartbeat failed."));
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, 60_000);
  heartbeat.unref?.();
  try {
    const deleted = await deleteAllUserMeetings(claim.userId, { signal: abortController.signal });
    if (abortController.signal.aborted) {
      return { claimed: true as const, cleaned: false as const, superseded: true as const };
    }
    if (deleted.cleanupPending) {
      const retry = await retryCleanup(claim, "One or more meeting prefixes still require deletion.");
      return { claimed: true as const, cleaned: false as const, ...retry };
    }
    const completed = await getPostgresRuntimePool("PostgreSQL account deletion cleanup").query(
      "delete from account_deletion_cleanup_jobs where user_id = $1 and claim_token = $2",
      [claim.userId, claim.claimToken],
    );
    return completed.rowCount === 1
      ? { claimed: true as const, cleaned: true as const }
      : { claimed: true as const, cleaned: false as const, superseded: true as const };
  } catch (error) {
    if (abortController.signal.aborted) {
      return { claimed: true as const, cleaned: false as const, superseded: true as const };
    }
    const retry = await retryCleanup(claim, error instanceof Error ? error.message : "Account object cleanup failed.");
    return { claimed: true as const, cleaned: false as const, ...retry };
  } finally {
    clearInterval(heartbeat);
  }
}

async function heartbeatCleanup(claim: { claimToken: string; userId: string }) {
  const renewed = await getPostgresRuntimePool("PostgreSQL account deletion cleanup").query(
    `update account_deletion_cleanup_jobs
     set claimed_at = now(), updated_at = now()
     where user_id = $1 and claim_token = $2
       and status = 'processing' and dead_lettered_at is null`,
    [claim.userId, claim.claimToken],
  );
  return renewed.rowCount === 1;
}

async function claimCleanup(workerId: string) {
  const client = await getPostgresRuntimePool("PostgreSQL account deletion cleanup").connect();
  try {
    await client.query("begin");
    const selected = await client.query<{ attempt: number | string; user_id: string }>(
      `select job.user_id, job.attempt
       from account_deletion_cleanup_jobs job
       join users on users.id = job.user_id
       where users.deleted_at is not null
         and job.dead_lettered_at is null
         and job.available_at <= now()
         and (job.claimed_at is null or job.claimed_at < now() - interval '5 minutes')
       order by job.available_at asc, job.created_at asc
       for update of job skip locked
       limit 1`,
    );
    const userId = selected.rows[0]?.user_id;
    if (!userId) {
      await client.query("commit");
      return null;
    }
    const claimToken = crypto.randomUUID();
    await client.query(
      `update account_deletion_cleanup_jobs
       set status = 'processing', attempt = attempt + 1, claimed_at = now(),
           claimed_by = $2, claim_token = $3, updated_at = now()
       where user_id = $1`,
      [userId, workerId, claimToken],
    );
    await client.query("commit");
    return { attempt: Number(selected.rows[0]?.attempt || 0) + 1, claimToken, userId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function retryCleanup(
  claim: { attempt: number; claimToken: string; userId: string },
  error: string,
) {
  const sanitizedError = sanitize(error);
  if (claim.attempt >= accountDeletionCleanupMaxAttempts) {
    const deadLettered = await getPostgresRuntimePool("PostgreSQL account deletion cleanup").query(
      `update account_deletion_cleanup_jobs
       set status = 'pending', available_at = now(), claimed_at = null,
           claimed_by = null, claim_token = null, last_error = $3,
           dead_lettered_at = now(), updated_at = now()
       where user_id = $1 and claim_token = $2`,
      [claim.userId, claim.claimToken, sanitizedError],
    );
    if (deadLettered.rowCount !== 1) {
      return { deadLettered: false as const, retryAfterMs: null, superseded: true as const };
    }
    console.error("[account-deletion-cleanup] retry budget exhausted; manual replay required.");
    return { deadLettered: true as const, retryAfterMs: null };
  }
  const retryAfterMs = accountDeletionCleanupRetryDelayMs(claim.attempt);
  const retried = await getPostgresRuntimePool("PostgreSQL account deletion cleanup").query(
    `update account_deletion_cleanup_jobs
     set status = 'pending', available_at = now() + ($4::bigint * interval '1 millisecond'),
         claimed_at = null, claimed_by = null, claim_token = null,
         last_error = $3, dead_lettered_at = null, updated_at = now()
     where user_id = $1 and claim_token = $2`,
    [claim.userId, claim.claimToken, sanitizedError, retryAfterMs],
  );
  if (retried.rowCount !== 1) {
    return { deadLettered: false as const, retryAfterMs: null, superseded: true as const };
  }
  return { deadLettered: false as const, retryAfterMs };
}

export function accountDeletionCleanupRetryDelayMs(attempt: number) {
  return Math.min(60 * 60 * 1_000, 15_000 * 2 ** Math.max(0, Math.min(8, attempt - 1)));
}

export async function getAccountDeletionCleanupDiagnostics(
  requestedLimit = 25,
): Promise<AccountDeletionCleanupDiagnostics> {
  const generatedAt = new Date().toISOString();
  if (!usesPostgresRepository()) {
    return {
      activeAccountJobCount: 0,
      deadLetteredCount: 0,
      expiredClaimCount: 0,
      generatedAt,
      inventory: [],
      inventoryLimit: 0,
      maxAttempt: 0,
      oldestCreatedAt: null,
      overdueRunnableCount: 0,
      pendingCount: 0,
      processingCount: 0,
      releaseBlocked: false,
      supported: false,
      totalCount: 0,
    };
  }
  const limit = Math.max(1, Math.min(accountDeletionCleanupInventoryLimit, Math.round(requestedLimit)));
  const pool = getPostgresRuntimePool("PostgreSQL account deletion cleanup diagnostics");
  const [totals, jobs] = await Promise.all([
    pool.query<{
      active_account_job_count: number | string;
      dead_lettered_count: number | string;
      expired_claim_count: number | string;
      max_attempt: number | string;
      oldest_created_at: Date | string | null;
      overdue_runnable_count: number | string;
      pending_count: number | string;
      processing_count: number | string;
      total_count: number | string;
    }>(
      `select
         count(*) filter (where users.deleted_at is not null)::int as total_count,
         count(*) filter (where users.deleted_at is null)::int as active_account_job_count,
         count(*) filter (where users.deleted_at is not null and job.status = 'pending')::int as pending_count,
         count(*) filter (where users.deleted_at is not null and job.status = 'processing')::int as processing_count,
         count(*) filter (where users.deleted_at is not null and job.dead_lettered_at is not null)::int as dead_lettered_count,
         count(*) filter (
           where users.deleted_at is not null and job.dead_lettered_at is null and job.status = 'processing'
             and job.claimed_at < now() - ($1::bigint * interval '1 millisecond')
         )::int as expired_claim_count,
         count(*) filter (
           where users.deleted_at is not null and job.dead_lettered_at is null and job.status = 'pending'
             and job.available_at < now() - ($1::bigint * interval '1 millisecond')
         )::int as overdue_runnable_count,
         coalesce(max(job.attempt) filter (where users.deleted_at is not null), 0)::int as max_attempt,
         min(job.created_at) filter (where users.deleted_at is not null) as oldest_created_at
       from account_deletion_cleanup_jobs job
       join users on users.id = job.user_id`,
      [accountDeletionCleanupStaleAgeMs],
    ),
    pool.query<{
      attempt: number | string;
      available_at: Date | string;
      created_at: Date | string;
      dead_lettered_at: Date | string | null;
      state: AccountDeletionCleanupDiagnostics["inventory"][number]["state"];
      user_id: string;
    }>(
      `select job.user_id, job.attempt, job.available_at, job.created_at, job.dead_lettered_at,
              case
                when job.dead_lettered_at is not null then 'dead_lettered'
                when job.status = 'processing'
                  and job.claimed_at < now() - ($1::bigint * interval '1 millisecond') then 'expired_claim'
                when job.status = 'pending'
                  and job.available_at < now() - ($1::bigint * interval '1 millisecond') then 'overdue'
                else job.status
              end as state
       from account_deletion_cleanup_jobs job
       join users on users.id = job.user_id
       where users.deleted_at is not null
         and (
           job.dead_lettered_at is not null
           or (job.status = 'processing' and job.claimed_at < now() - ($1::bigint * interval '1 millisecond'))
           or (job.status = 'pending' and job.available_at < now() - ($1::bigint * interval '1 millisecond'))
         )
       order by job.dead_lettered_at desc nulls last, job.created_at asc
       limit $2`,
      [accountDeletionCleanupStaleAgeMs, limit],
    ),
  ]);
  const aggregate = totals.rows[0];
  const deadLetteredCount = Number(aggregate?.dead_lettered_count || 0);
  const expiredClaimCount = Number(aggregate?.expired_claim_count || 0);
  const overdueRunnableCount = Number(aggregate?.overdue_runnable_count || 0);
  return {
    activeAccountJobCount: Number(aggregate?.active_account_job_count || 0),
    deadLetteredCount,
    expiredClaimCount,
    generatedAt,
    inventory: jobs.rows.map((job) => ({
      accountRef: shortRef("account", job.user_id),
      attempt: Number(job.attempt || 0),
      availableAt: toIso(job.available_at),
      createdAt: toIso(job.created_at),
      deadLetteredAt: job.dead_lettered_at ? toIso(job.dead_lettered_at) : null,
      state: job.state,
    })),
    inventoryLimit: limit,
    maxAttempt: Number(aggregate?.max_attempt || 0),
    oldestCreatedAt: aggregate?.oldest_created_at ? toIso(aggregate.oldest_created_at) : null,
    overdueRunnableCount,
    pendingCount: Number(aggregate?.pending_count || 0),
    processingCount: Number(aggregate?.processing_count || 0),
    releaseBlocked: deadLetteredCount > 0 || expiredClaimCount > 0 || overdueRunnableCount > 0,
    supported: true,
    totalCount: Number(aggregate?.total_count || 0),
  };
}

export async function replayDeadLetteredAccountDeletionCleanup(input: {
  approvedBy: string;
  userId: string;
}) {
  if (!usesPostgresRepository()) {
    throw new Error("Account deletion cleanup replay requires PostgreSQL repository mode.");
  }
  const userId = validatePrivateIdentifier(input.userId, "account cleanup user id");
  const approvedBy = validateOperatorLabel(input.approvedBy);
  const pool = getPostgresRuntimePool("PostgreSQL account deletion cleanup replay");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const job = await client.query<{ attempt: number | string; user_id: string }>(
      `select job.user_id, job.attempt
       from account_deletion_cleanup_jobs job
       join users on users.id = job.user_id
       where job.user_id = $1
         and users.deleted_at is not null
         and job.dead_lettered_at is not null
       for update of job`,
      [userId],
    );
    if (job.rowCount !== 1) {
      throw new Error("A dead-lettered cleanup job was not found for the supplied deleted account.");
    }
    const operatorRef = shortRef("operator", approvedBy);
    const accountRef = shortRef("account", userId);
    await client.query(
      `insert into audit_events (
         id, user_id, event_type, target_type, target_id, metadata, created_at
       ) values ($1, null, 'account_deletion_cleanup_replayed',
                 'account_deletion_cleanup_job', $2, $3::jsonb, now())`,
      [
        `audit_${crypto.randomUUID()}`,
        accountRef,
        JSON.stringify({
          operatorRef,
          previousAttempt: Number(job.rows[0]?.attempt || 0),
          reasonCode: "manual_dead_letter_replay",
        }),
      ],
    );
    const replayed = await client.query(
      `update account_deletion_cleanup_jobs
       set status = 'pending', attempt = 0, available_at = now(),
           claimed_at = null, claimed_by = null, claim_token = null,
           last_error = null, dead_lettered_at = null,
           manual_replay_count = manual_replay_count + 1,
           last_replayed_at = now(), last_replayed_by_ref = $2,
           updated_at = now()
       where user_id = $1 and dead_lettered_at is not null`,
      [userId, operatorRef],
    );
    if (replayed.rowCount !== 1) throw new Error("Account cleanup replay state changed before confirmation.");
    await client.query("commit");
    return { accountRef, replayed: true as const };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function usesPostgresRepository() {
  return process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(getPostgresDatabaseUrl());
}

function sanitize(value: string) {
  const redacted = value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url]")
    .replace(/(password|secret|token|key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 2_000);
  const category = /prefix|owner|catalog|manifest/i.test(redacted)
    ? "ownership_cleanup_pending"
    : /timeout|timed out|abort/i.test(redacted)
      ? "cleanup_timeout"
      : "cleanup_failed";
  const errorRef = crypto
    .createHmac("sha256", referenceKey())
    .update("ownminutes-account-cleanup-error:v1\u0000")
    .update(redacted)
    .digest("hex")
    .slice(0, 20);
  return `${category};errorRef=${errorRef}`;
}

function shortRef(kind: "account" | "operator", value: string) {
  return `${kind}_${crypto.createHmac("sha256", referenceKey()).update(`ownminutes-${kind}-ref:v1\u0000`).update(value).digest("hex").slice(0, 20)}`;
}

function referenceKey() {
  const key = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (key) return key;
  if (process.env.NODE_ENV === "production") {
    throw new Error("Account cleanup references require the application secret.");
  }
  return "ownminutes-local-reference-key";
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function validatePrivateIdentifier(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function validateOperatorLabel(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_.@ -]{3,80}$/.test(normalized)) {
    throw new Error("A bounded operator label is required for the replay audit record.");
  }
  return normalized;
}
