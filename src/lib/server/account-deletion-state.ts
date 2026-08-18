import { reconcileLocalAccountDeletionProcessing } from "@/lib/server/auth-repository";
import { archiveAndDeletePostgresProcessingLedger } from "@/lib/server/account-deletion-processing-ledger";
import {
  hasMeetingCatalogRowsForOwner,
  hasPendingMeetingCatalogCoverageForOwner,
} from "@/lib/server/meeting-catalog";
import { hasPendingMeetingDeletionCleanupForOwner } from "@/lib/server/meeting-write-lock";
import { hasPendingMeetingObjectTransfersForOwner } from "@/lib/server/meeting-transfer-intent";
import { getPostgresDatabaseUrl, getPostgresRuntimePool } from "@/lib/server/postgres-runtime";

export type AccountDeletionStatus = "active" | "pending_cleanup" | "deleted";

export async function resolveAccountDeletionStatus(userId: string): Promise<AccountDeletionStatus> {
  const processing = await reconcileAccountDeletionProcessing(userId);
  if (processing.active) return "active";
  const objectCleanupPending = await hasPendingMeetingDeletionCleanupForOwner(userId);
  const discoveryPending = await hasPendingAccountDeletionCleanup(userId);
  const catalogCleanupPending = await hasMeetingCatalogRowsForOwner(userId);
  const catalogCoveragePending = await hasPendingMeetingCatalogCoverageForOwner(userId);
  const transferPending = await hasPendingMeetingObjectTransfersForOwner(userId);
  return processing.pending || objectCleanupPending || discoveryPending || catalogCleanupPending || catalogCoveragePending || transferPending
    ? "pending_cleanup"
    : "deleted";
}

export async function scheduleAccountDeletionCleanup(userId: string) {
  if (!usesPostgresRepository()) return { scheduled: false as const };
  await getPostgresRuntimePool("PostgreSQL account deletion cleanup").query(
    `insert into account_deletion_cleanup_jobs (user_id, status, attempt, available_at, created_at, updated_at)
     values ($1, 'pending', 0, now(), now(), now())
     on conflict (user_id) do update
       set status = 'pending', attempt = 0, available_at = now(),
           claimed_at = null, claimed_by = null, claim_token = null,
           last_error = null, dead_lettered_at = null, updated_at = now()`,
    [userId],
  );
  return { scheduled: true as const };
}

export async function cancelAccountDeletionCleanupForActiveUser(userId: string) {
  if (!usesPostgresRepository()) return { cancelled: false as const };
  const result = await getPostgresRuntimePool("PostgreSQL account deletion cleanup").query(
    `delete from account_deletion_cleanup_jobs job
     using users
     where job.user_id = $1
       and users.id = job.user_id
       and users.deleted_at is null`,
    [userId],
  );
  return { cancelled: result.rowCount === 1 };
}

async function hasPendingAccountDeletionCleanup(userId: string) {
  if (!usesPostgresRepository()) return false;
  const result = await getPostgresRuntimePool("PostgreSQL account deletion cleanup").query<{ pending: boolean }>(
    "select exists(select 1 from account_deletion_cleanup_jobs where user_id = $1) as pending",
    [userId],
  );
  return result.rows[0]?.pending === true;
}

export async function runAccountDeletionProcessingCleanupOnce() {
  if (!usesPostgresRepository()) return { claimed: false as const };
  const candidate = await getPostgresRuntimePool("PostgreSQL account deletion processing cleanup").query<{ id: string }>(
    `select users.id
     from users
     where users.deleted_at is not null
       and exists (
         select 1 from meeting_processing_reservations reservation where reservation.user_id = users.id
       )
     order by users.deleted_at asc
     limit 1`,
  );
  const userId = candidate.rows[0]?.id;
  if (!userId) return { claimed: false as const };
  await reconcilePostgresAccountDeletionProcessing(userId);
  return { claimed: true as const };
}

async function reconcileAccountDeletionProcessing(userId: string) {
  return usesPostgresRepository()
    ? reconcilePostgresAccountDeletionProcessing(userId)
    : reconcileLocalAccountDeletionProcessing(userId);
}

function usesPostgresRepository() {
  return process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(getPostgresDatabaseUrl());
}

async function reconcilePostgresAccountDeletionProcessing(userId: string) {
  const pool = getPostgresRuntimePool("PostgreSQL account deletion processing cleanup");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const user = await client.query<{ deleted_at: Date | string | null }>(
      "select deleted_at from users where id = $1 for update",
      [userId],
    );
    if (!user.rows[0]) {
      await client.query("commit");
      return { active: false, pending: false };
    }
    if (!user.rows[0].deleted_at) {
      await client.query("commit");
      return { active: true, pending: false };
    }

    await client.query(
      `update meeting_processing_provider_steps
       set status = 'released', released_at = coalesce(released_at, now()), updated_at = now()
       where user_id = $1 and status = 'claimed'`,
      [userId],
    );
    // Account deletion has already invalidated every session and installed the
    // user/meeting write fences. A provider call that was already accepted may
    // still finish, but its result can no longer be published. Waiting for that
    // `started` row would leave deletion pending forever because there is no
    // surviving meeting operation that may safely complete it. Archive the
    // settled cost below, then remove the ledger; any late callback fails closed.
    await archiveAndDeletePostgresProcessingLedger(client, userId);
    await client.query("commit");
    return { active: false, pending: false };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
