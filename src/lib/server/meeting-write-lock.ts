import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { MeetingAccessError } from "@/lib/server/meeting-errors";
import { archiveAndDeletePostgresMeetingProcessingLedger } from "@/lib/server/account-deletion-processing-ledger";
import {
  meetingDeletionFenceRef,
  meetingDeletionOwnerProofRef,
} from "@/lib/server/meeting-deletion-proof";
import { getPostgresDatabaseUrl, getPostgresRuntimePool } from "@/lib/server/postgres-runtime";

export {
  meetingDeletionFenceRef,
  meetingDeletionOwnerProofRef,
} from "@/lib/server/meeting-deletion-proof";

export type MeetingWriteLockMode = "process" | "postgres-advisory";
export const MEETING_BACKUP_BARRIER_LOCK_KEY =
  "ownminutes-backup-object-barrier:v1";

export type MeetingDeletionCleanupClaim = {
  attempt: number;
  claimToken: string;
  meetingId: string;
  ownerUserId: string;
};

const localDeletionFences = new Map<string, string>();
const localMeetingWriteQueues = new Map<string, Promise<unknown>>();
const localRecordingUploadQueues = new Map<string, Promise<unknown>>();
const localUserWriteQueues = new Map<string, Promise<unknown>>();
const heldMeetingWriteLocks = new AsyncLocalStorage<Set<string>>();

export function getMeetingWriteCoordinatorInfo() {
  const configuredMode = process.env.OWNMINUTES_MEETING_WRITE_LOCK || "auto";
  const mode = getMeetingWriteLockMode();
  return {
    configuredMode,
    mode,
    crossInstance: mode === "postgres-advisory",
    durableDeletionFence: mode === "postgres-advisory",
    lockTimeoutMs: getLockTimeoutMs(),
  };
}

export function getMeetingWriteLockMode(): MeetingWriteLockMode {
  const configured = process.env.OWNMINUTES_MEETING_WRITE_LOCK;
  if (configured === "process") return "process";
  if (configured === "postgres-advisory") return "postgres-advisory";
  return process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(getPostgresDatabaseUrl()) ? "postgres-advisory" : "process";
}

export async function withMeetingWriteLock<T>(meetingId: string, operation: () => Promise<T>): Promise<T> {
  const key = canonicalMeetingId(meetingId);
  return withValidatedMeetingWriteLock(key, operation);
}

async function withValidatedMeetingWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (heldMeetingWriteLocks.getStore()?.has(key)) return operation();

  const previous = localMeetingWriteQueues.get(key) ?? Promise.resolve();
  const run = async () => {
    const held = new Set(heldMeetingWriteLocks.getStore() ?? []);
    held.add(key);
    const guardedOperation = () => heldMeetingWriteLocks.run(held, async () => {
      try {
        return await operation();
      } finally {
        held.delete(key);
      }
    });
    return getMeetingWriteLockMode() === "postgres-advisory"
      ? withPostgresAdvisoryLock(meetingLockKey(key), guardedOperation)
      : guardedOperation();
  };
  const next = previous.then(run, run);
  const tracked = next.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (localMeetingWriteQueues.get(key) === tracked) localMeetingWriteQueues.delete(key);
  });
  localMeetingWriteQueues.set(key, tracked);
  return next;
}

export async function withMeetingWriteFence<T>(
  meetingId: string,
  operation: (canonicalId: string) => Promise<T>,
): Promise<T> {
  const key = canonicalMeetingId(meetingId);
  return withMeetingWriteLock(key, async () => {
    if (!(await isMeetingWriteAllowed(key))) {
      throw new MeetingAccessError("This meeting was deleted and cannot accept more writes.", 410, {
        code: "meeting_deleted",
        retryable: false,
      });
    }
    return operation(key);
  });
}

export async function withUserWriteLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const previous = localUserWriteQueues.get(userId) ?? Promise.resolve();
  const run = () =>
    getMeetingWriteLockMode() === "postgres-advisory"
      ? withPostgresAdvisoryLock(`ownminutes-user-write:${userId}`, operation)
      : operation();
  const next = previous.then(run, run);
  const tracked = next.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (localUserWriteQueues.get(userId) === tracked) localUserWriteQueues.delete(userId);
  });
  localUserWriteQueues.set(userId, tracked);
  return next;
}

/**
 * Serializes one resumable upload without taking the meeting/user deletion
 * locks. Remote staging I/O can be slow; deletion is linearized only during
 * the short preflight and publish phases that surround this lock.
 */
export async function withRecordingUploadLock<T>(
  meetingId: string,
  uploadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${canonicalMeetingId(meetingId)}:${canonicalUploadId(uploadId)}`;
  const previous = localRecordingUploadQueues.get(key) ?? Promise.resolve();
  const run = () =>
    getMeetingWriteLockMode() === "postgres-advisory"
      ? withPostgresAdvisoryLock(`ownminutes-recording-upload:${key}`, operation)
      : operation();
  const next = previous.then(run, run);
  const tracked = next.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (localRecordingUploadQueues.get(key) === tracked) localRecordingUploadQueues.delete(key);
  });
  localRecordingUploadQueues.set(key, tracked);
  return next;
}

function canonicalUploadId(value: string) {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(value)) {
    throw new MeetingAccessError("Invalid recording upload id.", 400, {
      code: "invalid_recording_upload_id",
      retryable: false,
    });
  }
  return value;
}

async function withPostgresAdvisoryLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const client = await getPostgresRuntimePool("PostgreSQL meeting write lock").connect();
  let backupBarrierLocked = false;
  let locked = false;
  try {
    await client.query("select set_config('lock_timeout', $1, false)", [`${getLockTimeoutMs()}ms`]);
    try {
      await client.query(
        "select pg_advisory_lock_shared(hashtextextended($1, 0))",
        [MEETING_BACKUP_BARRIER_LOCK_KEY],
      );
      backupBarrierLocked = true;
      await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    } catch (error) {
      if (isPostgresLockTimeout(error)) {
        throw new MeetingAccessError("会议正在同步，请稍后重试。", 503, {
          code: "meeting_write_lock_timeout",
          retryable: true,
          retryAfterSeconds: Math.max(1, Math.ceil(getLockTimeoutMs() / 1000)),
        });
      }
      throw error;
    }
    locked = true;
    return await operation();
  } finally {
    if (locked) {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      } catch (error) {
        console.error(`[meeting-write-lock] unlock failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
      }
    }
    if (backupBarrierLocked) {
      try {
        await client.query(
          "select pg_advisory_unlock_shared(hashtextextended($1, 0))",
          [MEETING_BACKUP_BARRIER_LOCK_KEY],
        );
      } catch (error) {
        console.error(`[meeting-write-lock] backup barrier unlock failed: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
      }
    }
    client.release();
  }
}

function isPostgresLockTimeout(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "55P03" || /lock timeout|could not obtain.*lock/i.test(String(candidate.message || ""));
}

export async function isMeetingWriteAllowed(meetingId: string) {
  const key = canonicalMeetingId(meetingId);
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    return !localDeletionFences.has(key);
  }
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion fence").query<{ deleted: boolean }>(
    `select (
       exists(select 1 from meeting_deletion_tombstones where meeting_id = $1)
       or exists(select 1 from meeting_deletion_fences where meeting_ref = $2)
     ) as deleted`,
    [key, meetingDeletionFenceRef(key)],
  );
  return result.rows[0]?.deleted !== true;
}

export async function getMeetingDeletionOwner(meetingId: string) {
  const key = canonicalMeetingId(meetingId);
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    return localDeletionFences.get(key);
  }
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion fence").query<{ owner_user_id: string }>(
    "select owner_user_id from meeting_deletion_tombstones where meeting_id = $1 limit 1",
    [key],
  );
  return result.rows[0]?.owner_user_id;
}

export async function getLegacyMeetingDeletionOwner(meetingId: string) {
  if (!isTraversalSafeLegacyMeetingId(meetingId)) {
    throw new Error("Legacy deletion owner lookup requires one exact, non-canonical, traversal-safe object prefix.");
  }
  if (getMeetingWriteLockMode() !== "postgres-advisory") return undefined;
  const result = await getPostgresRuntimePool("PostgreSQL legacy deletion owner").query<{
    owner_user_id: string;
  }>(
    "select owner_user_id from meeting_deletion_tombstones where meeting_id = $1 limit 1",
    [meetingId],
  );
  return result.rows[0]?.owner_user_id;
}

export async function listMeetingDeletionIdsForOwner(ownerUserId: string) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    return [...localDeletionFences.entries()]
      .filter(([, owner]) => owner === ownerUserId)
      .map(([meetingId]) => meetingId);
  }
  await quarantineNonCanonicalMeetingDeletionTombstones(ownerUserId);
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion fence").query<{ meeting_id: string }>(
    `select meeting_id
     from meeting_deletion_tombstones
     where owner_user_id = $1
       and ${canonicalMeetingDeletionCleanupSqlPredicate("meeting_id")}
     order by deleted_at asc`,
    [ownerUserId],
  );
  return result.rows.map((row) => row.meeting_id);
}

export async function hasPendingMeetingDeletionCleanupForOwner(ownerUserId: string) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return false;
  await quarantineNonCanonicalMeetingDeletionTombstones(ownerUserId);
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion cleanup").query<{ pending: boolean }>(
    `select exists(
       select 1 from meeting_deletion_tombstones
       where owner_user_id = $1 and cleanup_pending = true
     ) as pending`,
    [ownerUserId],
  );
  return result.rows[0]?.pending === true;
}

export async function markMeetingDeleted(meetingId: string, ownerUserId: string) {
  const key = canonicalMeetingId(meetingId);
  return markValidatedMeetingDeleted(key, ownerUserId);
}

async function markValidatedMeetingDeleted(key: string, ownerUserId: string) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    const existingOwner = localDeletionFences.get(key);
    if (existingOwner && existingOwner !== ownerUserId) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }
    localDeletionFences.set(key, ownerUserId);
    return;
  }
  const durableFence = await getPostgresRuntimePool("PostgreSQL meeting deletion fence").query<{ deleted: boolean }>(
    "select exists(select 1 from meeting_deletion_fences where meeting_ref = $1) as deleted",
    [meetingDeletionFenceRef(key)],
  );
  if (durableFence.rows[0]?.deleted === true) {
    throw new MeetingAccessError("Meeting audio was not found.", 404);
  }
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion fence").query<{ owner_user_id: string }>(
    `insert into meeting_deletion_tombstones (
       meeting_id, owner_user_id, deleted_at, cleanup_pending, cleanup_attempts,
       cleanup_next_attempt_at, cleaned_at, cleanup_last_error
     ) values ($1, $2, now(), true, 0, now(), null, null)
     on conflict (meeting_id) do update
       set deleted_at = least(meeting_deletion_tombstones.deleted_at, excluded.deleted_at)
       where meeting_deletion_tombstones.owner_user_id = excluded.owner_user_id
     returning owner_user_id`,
    [key, ownerUserId],
  );
  if (result.rows[0]?.owner_user_id !== ownerUserId) {
    throw new MeetingAccessError("Meeting audio was not found.", 404);
  }
}

export async function claimMeetingDeletionCleanup(
  workerId: string,
  ownerUserId?: string,
): Promise<MeetingDeletionCleanupClaim | null> {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return null;
  await quarantineNonCanonicalMeetingDeletionTombstones(ownerUserId);
  const client = await getPostgresRuntimePool("PostgreSQL meeting deletion cleanup").connect();
  try {
    await client.query("begin");
    const selected = await client.query<{
      cleanup_attempts: number;
      meeting_id: string;
      owner_user_id: string;
    }>(
      `select meeting_id, owner_user_id, cleanup_attempts
       from meeting_deletion_tombstones
       where cleanup_pending = true
         and ${canonicalMeetingDeletionCleanupSqlPredicate("meeting_id")}
         and cleanup_disposition = 'automatic'
         and cleanup_next_attempt_at <= now()
         and (cleanup_claimed_at is null or cleanup_claimed_at < now() - interval '5 minutes')
         and ($1::text is null or owner_user_id = $1)
       order by cleanup_next_attempt_at asc, deleted_at asc
       for update skip locked
       limit 1`,
      [ownerUserId ?? null],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("commit");
      return null;
    }
    const claimToken = crypto.randomUUID();
    await client.query(
      `update meeting_deletion_tombstones
       set cleanup_attempts = cleanup_attempts + 1,
           cleanup_claimed_at = now(),
           cleanup_claimed_by = $2,
           cleanup_claim_token = $3
       where meeting_id = $1`,
      [row.meeting_id, workerId, claimToken],
    );
    await client.query("commit");
    return {
      attempt: row.cleanup_attempts + 1,
      claimToken,
      meetingId: row.meeting_id,
      ownerUserId: row.owner_user_id,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function quarantineMeetingDeletionOwnerConflict(
  meetingId: string,
  ownerUserId: string,
) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    return { quarantined: false as const };
  }
  const key = canonicalMeetingId(meetingId);
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion owner conflict").query(
    `update meeting_deletion_tombstones
     set cleanup_pending = true,
         cleanup_next_attempt_at = 'infinity'::timestamptz,
         cleanup_claimed_at = null,
         cleanup_claimed_by = null,
         cleanup_claim_token = null,
         cleaned_at = null,
         cleanup_disposition = 'pending_manual_cleanup',
         manual_cleanup_detected_at = coalesce(manual_cleanup_detected_at, now()),
         cleanup_last_error = 'meeting_catalog_owner_conflict_manual_cleanup_required'
     where meeting_id = $1 and owner_user_id = $2`,
    [key, ownerUserId],
  );
  return { quarantined: result.rowCount === 1 };
}

export async function purgeMeetingCatalogAfterObjectDeletion(
  meetingId: string,
  ownerUserId: string,
  claimToken?: string,
) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return;
  const key = canonicalMeetingId(meetingId);
  const client = await getPostgresRuntimePool("PostgreSQL meeting catalog purge").connect();
  try {
    await client.query("begin");
    const tombstone = await client.query<{ owner_user_id: string }>(
      `select owner_user_id
       from meeting_deletion_tombstones
       where meeting_id = $1
         and owner_user_id = $2
         and cleanup_pending = true
         and ($3::text is null or cleanup_claim_token = $3)
       for update`,
      [key, ownerUserId, claimToken ?? null],
    );
    if (!tombstone.rows[0]) {
      throw new Error("Meeting deletion cleanup lost its owner tombstone before catalog purge.");
    }
    await purgeMeetingRelationalData(client, key, ownerUserId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function purgeCompletedMeetingCatalogAfterObjectAbsence(
  meetingId: string,
  ownerUserId: string,
) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return { completedFence: false as const };
  const key = canonicalMeetingId(meetingId);
  const client = await getPostgresRuntimePool("PostgreSQL completed meeting catalog purge").connect();
  try {
    await client.query("begin");
    const fence = await client.query<{ matches: boolean }>(
      `select exists(
         select 1 from meeting_deletion_fences
         where meeting_ref = $1 and owner_proof_ref = $2
       ) as matches`,
      [meetingDeletionFenceRef(key), meetingDeletionOwnerProofRef(key, ownerUserId)],
    );
    if (fence.rows[0]?.matches !== true) {
      await client.query("commit");
      return { completedFence: false as const };
    }
    await purgeMeetingRelationalData(client, key, ownerUserId);
    await client.query("commit");
    return { completedFence: true as const };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeMeetingDeletionCleanup(
  meetingId: string,
  ownerUserId: string,
  claimToken?: string,
) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return;
  const key = canonicalMeetingId(meetingId);
  await moveCompletedMeetingDeletionToFence(key, ownerUserId, claimToken);
}

export async function minimizeCompletedMeetingDeletionIdentifiers(limit = 100) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return { minimized: 0 };
  const boundedLimit = Math.max(1, Math.min(500, Math.round(limit)));
  const client = await getPostgresRuntimePool("PostgreSQL meeting deletion privacy minimization").connect();
  try {
    await client.query("begin");
    const rows = await client.query<{
      cleaned_at: Date | string | null;
      deleted_at: Date | string;
      meeting_id: string;
      owner_user_id: string;
    }>(
      `select meeting_id, owner_user_id, deleted_at, cleaned_at
       from meeting_deletion_tombstones
       where cleanup_pending = false or cleaned_at is not null
       order by coalesce(cleaned_at, deleted_at) asc
       for update skip locked
       limit $1`,
      [boundedLimit],
    );
    for (const row of rows.rows) {
      await purgeMeetingRelationalData(client, row.meeting_id, row.owner_user_id);
      await client.query(
        `insert into meeting_deletion_fences (meeting_ref, owner_proof_ref, deleted_at, cleaned_at)
         values ($1, $2, $3, coalesce($4::timestamptz, now()))
         on conflict (meeting_ref) do update
           set deleted_at = least(meeting_deletion_fences.deleted_at, excluded.deleted_at),
               cleaned_at = least(meeting_deletion_fences.cleaned_at, excluded.cleaned_at)`,
        [
          meetingDeletionFenceRef(row.meeting_id),
          meetingDeletionOwnerProofRef(row.meeting_id, row.owner_user_id),
          row.deleted_at,
          row.cleaned_at,
        ],
      );
      await client.query("delete from meeting_deletion_tombstones where meeting_id = $1", [row.meeting_id]);
    }
    await client.query("commit");
    return { minimized: rows.rows.length };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function retryMeetingDeletionCleanup(
  meetingId: string,
  retryAfterMs: number,
  errorMessage: string,
  claimToken?: string,
) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return { scheduled: false as const };
  const key = canonicalMeetingId(meetingId);
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion cleanup").query(
    `update meeting_deletion_tombstones
     set cleanup_pending = true,
         cleanup_next_attempt_at = now() + ($2::bigint * interval '1 millisecond'),
         cleanup_claimed_at = null,
         cleanup_claimed_by = null,
         cleanup_claim_token = null,
         cleanup_last_error = $3
     where meeting_id = $1
       and ($4::text is null or cleanup_claim_token = $4)`,
    [
      key,
      Math.max(1_000, Math.min(60 * 60 * 1000, Math.round(retryAfterMs))),
      sanitizeMessage(errorMessage),
      claimToken ?? null,
    ],
  );
  return { scheduled: (result.rowCount ?? 0) > 0 };
}

function meetingLockKey(meetingId: string) {
  return `ownminutes-meeting-write:${canonicalMeetingId(meetingId)}`;
}

export function canonicalMeetingId(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) {
    throw new MeetingAccessError("Invalid meeting id.", 400, {
      code: "invalid_meeting_id",
      retryable: false,
    });
  }
  return value;
}

export function isCanonicalMeetingId(value: string) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

export function isTraversalSafeLegacyMeetingId(value: string) {
  return (
    typeof value === "string" &&
    !isCanonicalMeetingId(value) &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".")
  );
}

export async function quarantineLegacyMeetingDeletionForManualCleanup(
  meetingId: string,
  ownerUserId: string,
) {
  if (!isTraversalSafeLegacyMeetingId(meetingId)) {
    throw new Error("Legacy cleanup requires one exact, non-canonical, traversal-safe object prefix.");
  }
  if (!/^[A-Za-z0-9_-]{1,192}$/.test(ownerUserId)) {
    throw new Error("Invalid legacy cleanup owner id.");
  }
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    throw new Error("Legacy cleanup quarantine requires PostgreSQL advisory-lock mode.");
  }

  return withPostgresAdvisoryLock(`ownminutes-meeting-write:${meetingId}`, async () => {
    const result = await getPostgresRuntimePool("PostgreSQL legacy deletion cleanup quarantine").query<{
      owner_user_id: string;
    }>(
      `insert into meeting_deletion_tombstones (
         meeting_id, owner_user_id, deleted_at, cleanup_pending, cleanup_attempts,
         cleanup_next_attempt_at, cleanup_claimed_at, cleanup_claimed_by,
         cleanup_claim_token, cleaned_at, cleanup_last_error, cleanup_disposition,
         manual_cleanup_detected_at
       ) values (
         $1, $2, now(), true, 0, 'infinity'::timestamptz, null, null,
         null, null, 'legacy_noncanonical_manual_cleanup_required',
         'pending_manual_cleanup', now()
       )
       on conflict (meeting_id) do update
         set deleted_at = least(meeting_deletion_tombstones.deleted_at, excluded.deleted_at),
             cleanup_pending = true,
             cleanup_next_attempt_at = 'infinity'::timestamptz,
             cleanup_claimed_at = null,
             cleanup_claimed_by = null,
             cleanup_claim_token = null,
             cleaned_at = null,
             cleanup_last_error = 'legacy_noncanonical_manual_cleanup_required',
             cleanup_disposition = 'pending_manual_cleanup',
             manual_cleanup_detected_at = coalesce(
               meeting_deletion_tombstones.manual_cleanup_detected_at,
               now()
             )
         where meeting_deletion_tombstones.owner_user_id = excluded.owner_user_id
       returning owner_user_id`,
      [meetingId, ownerUserId],
    );
    if (result.rows[0]?.owner_user_id !== ownerUserId) {
      throw new Error("Legacy object prefix is already linked to a different owner.");
    }
    return { quarantined: true as const };
  });
}

function canonicalMeetingDeletionCleanupSqlPredicate(column: string) {
  return `${column} ~ '^[A-Za-z0-9_-]{1,160}$'`;
}

export async function quarantineNonCanonicalMeetingDeletionTombstones(ownerUserId?: string) {
  const result = await getPostgresRuntimePool("PostgreSQL meeting deletion cleanup").query(
    `update meeting_deletion_tombstones
     set cleanup_next_attempt_at = 'infinity'::timestamptz,
         cleanup_claimed_at = null,
         cleanup_claimed_by = null,
         cleanup_claim_token = null,
         cleanup_disposition = 'pending_manual_cleanup',
         manual_cleanup_detected_at = coalesce(manual_cleanup_detected_at, now()),
         cleanup_last_error = 'legacy_noncanonical_manual_cleanup_required'
     where cleanup_pending = true
       and not (${canonicalMeetingDeletionCleanupSqlPredicate("meeting_id")})
       and ($1::text is null or owner_user_id = $1)
       and (
         cleanup_next_attempt_at <> 'infinity'::timestamptz
         or cleanup_disposition <> 'pending_manual_cleanup'
         or cleanup_last_error is distinct from 'legacy_noncanonical_manual_cleanup_required'
       )`,
    [ownerUserId ?? null],
  );
  if ((result.rowCount ?? 0) > 0) {
    // Deliberately omit ids: a legacy value must never become an object-store
    // lookup oracle, even through a lossy/sanitized log representation.
    console.error(`[meeting-deletion-cleanup] quarantined ${result.rowCount} non-canonical tombstone(s) for manual audit.`);
  }
}

export async function reopenMeetingDeletionCleanup(
  meetingId: string,
  ownerUserId: string,
  errorMessage: string,
) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") return { reopened: false as const };
  const key = canonicalMeetingId(meetingId);
  return withMeetingWriteLock(key, async () => {
    const pool = getPostgresRuntimePool("PostgreSQL meeting deletion cleanup reopen");
    const owner = await pool.query<{ exists: boolean }>(
      "select exists(select 1 from users where id = $1) as exists",
      [ownerUserId],
    );
    if (owner.rows[0]?.exists !== true) return { reopened: false as const };
    const fence = await pool.query<{ matches: boolean }>(
      `select exists(
         select 1 from meeting_deletion_fences
         where meeting_ref = $1 and owner_proof_ref = $2
       ) as matches`,
      [meetingDeletionFenceRef(key), meetingDeletionOwnerProofRef(key, ownerUserId)],
    );
    if (fence.rows[0]?.matches !== true) return { reopened: false as const };
    const result = await pool.query(
      `insert into meeting_deletion_tombstones (
         meeting_id, owner_user_id, deleted_at, cleanup_pending, cleanup_attempts,
         cleanup_next_attempt_at, cleanup_disposition, cleaned_at, cleanup_last_error
       ) values ($1, $2, now(), true, 0, now(), 'automatic', null, $3)
       on conflict (meeting_id) do update
         set cleanup_pending = true,
             cleanup_next_attempt_at = now(),
             cleanup_disposition = 'automatic',
             cleanup_claimed_at = null,
             cleanup_claimed_by = null,
             cleanup_claim_token = null,
             cleaned_at = null,
             cleanup_last_error = excluded.cleanup_last_error
       where meeting_deletion_tombstones.owner_user_id = excluded.owner_user_id`,
      [key, ownerUserId, sanitizeMessage(errorMessage)],
    );
    return { reopened: (result.rowCount ?? 0) > 0 };
  });
}

async function moveCompletedMeetingDeletionToFence(
  meetingId: string,
  ownerUserId: string,
  claimToken?: string,
) {
  const client = await getPostgresRuntimePool("PostgreSQL meeting deletion cleanup").connect();
  try {
    await client.query("begin");
    const row = await client.query<{ deleted_at: Date | string; owner_user_id: string }>(
      `select deleted_at, owner_user_id
       from meeting_deletion_tombstones
       where meeting_id = $1
         and owner_user_id = $2
         and cleanup_pending = true
         and ($3::text is null or cleanup_claim_token = $3)
       for update`,
      [meetingId, ownerUserId, claimToken ?? null],
    );
    if (!row.rows[0]) {
      await client.query("commit");
      return;
    }
    const residualCatalog = await client.query(
      "select 1 from meetings where id = $1 limit 1",
      [meetingId],
    );
    if (residualCatalog.rowCount) {
      throw new Error("Meeting catalog must be purged after object deletion before cleanup completion.");
    }
    const residualTransfer = await client.query(
      "select 1 from meeting_object_transfer_intents where meeting_id = $1 limit 1",
      [meetingId],
    );
    if (residualTransfer.rowCount) {
      throw new Error("Meeting object transfer must settle before deletion cleanup can complete.");
    }
    await client.query(
      `insert into meeting_deletion_fences (meeting_ref, owner_proof_ref, deleted_at, cleaned_at)
       values ($1, $2, $3, now())
       on conflict (meeting_ref) do update
         set deleted_at = least(meeting_deletion_fences.deleted_at, excluded.deleted_at),
             cleaned_at = least(meeting_deletion_fences.cleaned_at, excluded.cleaned_at)`,
      [
        meetingDeletionFenceRef(meetingId),
        meetingDeletionOwnerProofRef(meetingId, row.rows[0].owner_user_id),
        row.rows[0].deleted_at,
      ],
    );
    await client.query(
      `delete from meeting_deletion_tombstones
       where meeting_id = $1
         and owner_user_id = $2
         and ($3::text is null or cleanup_claim_token = $3)`,
      [meetingId, ownerUserId, claimToken ?? null],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type MeetingDeletionRelationalClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: T[] }>;
};

async function purgeMeetingRelationalData(
  client: MeetingDeletionRelationalClient,
  meetingId: string,
  ownerUserId: string,
) {
  await archiveAndDeletePostgresMeetingProcessingLedger(
    client,
    ownerUserId,
    meetingId,
  );
  await client.query(
    "delete from meeting_finalization_jobs where meeting_id = $1 and owner_user_id = $2",
    [meetingId, ownerUserId],
  );
  await client.query(
    "delete from meetings where id = $1 and owner_user_id = $2",
    [meetingId, ownerUserId],
  );
  const residualCatalog = await client.query<{ owner_user_id: string }>(
    "select owner_user_id from meetings where id = $1 limit 1",
    [meetingId],
  );
  if (residualCatalog.rows[0]) {
    throw new Error("Meeting catalog owner conflicts with its deletion owner; manual cleanup is required.");
  }
  const residualTransfer = await client.query(
    "select 1 from meeting_object_transfer_intents where meeting_id = $1 limit 1",
    [meetingId],
  );
  if (residualTransfer.rowCount) {
    throw new Error("Meeting object transfer is still active; deletion cleanup remains pending.");
  }
}

function getLockTimeoutMs() {
  const value = Number(process.env.OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 15_000;
  return Math.max(1_000, Math.min(120_000, Math.round(value)));
}

function sanitizeMessage(value: string) {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url]")
    .replace(/(password|secret|token|key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}
