import crypto from "node:crypto";
import {
  MEETING_BACKUP_BARRIER_LOCK_KEY,
  getMeetingWriteLockMode,
  isTraversalSafeLegacyMeetingId,
  meetingDeletionFenceRef,
  meetingDeletionOwnerProofRef,
  minimizeCompletedMeetingDeletionIdentifiers,
  quarantineNonCanonicalMeetingDeletionTombstones,
} from "@/lib/server/meeting-write-lock";
import { getMeetingObjectStore } from "@/lib/server/meeting-object-store";
import {
  getMeetingCatalogBackfillBlockerCount,
  markMeetingCatalogDeleted,
  resolveMeetingCatalogBackfillBlocker,
} from "@/lib/server/meeting-catalog";
import { getPostgresRuntimePool } from "@/lib/server/postgres-runtime";

export const legacyDeletionManualCleanupSlaDays = 30;
export const legacyDeletionManualCleanupInventoryLimit = 100;

export type LegacyDeletionCleanupInventoryItem = {
  attempts: number;
  deletedAt: string;
  detectedAt: string;
  meetingRef: string;
  ownerRef: string;
  state: "pending_manual_cleanup" | "manual_cleanup_approved";
};

export type LegacyDeletionCleanupDiagnostics = {
  generatedAt: string;
  inventory: LegacyDeletionCleanupInventoryItem[];
  inventoryLimit: number;
  oldestDetectedAt: string | null;
  overdueCount: number;
  releaseBlocked: boolean;
  supported: boolean;
  catalogBackfillBlockerCount: number;
  unresolvedCount: number;
  unresolvedOwnedCount: number;
};

export async function getLegacyDeletionCleanupDiagnostics(
  requestedLimit = 25,
): Promise<LegacyDeletionCleanupDiagnostics> {
  const generatedAt = new Date().toISOString();
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    return {
      generatedAt,
      inventory: [],
      inventoryLimit: 0,
      oldestDetectedAt: null,
      overdueCount: 0,
      releaseBlocked: false,
      supported: false,
      catalogBackfillBlockerCount: 0,
      unresolvedCount: 0,
      unresolvedOwnedCount: 0,
    };
  }

  await quarantineNonCanonicalMeetingDeletionTombstones();
  await minimizeCompletedMeetingDeletionIdentifiers(legacyDeletionManualCleanupInventoryLimit);
  const limit = Math.max(1, Math.min(legacyDeletionManualCleanupInventoryLimit, Math.round(requestedLimit)));
  const result = await getPostgresRuntimePool("PostgreSQL legacy deletion cleanup diagnostics").query<{
    cleanup_attempts: number;
    cleanup_disposition: "pending_manual_cleanup" | "manual_cleanup_approved";
    deleted_at: Date | string;
    detected_at: Date | string;
    meeting_id: string;
    owner_user_id: string;
    overdue: boolean;
    unresolved_count: number | string;
    unresolved_owned_count: number | string;
    overdue_count: number | string;
    oldest_detected_at: Date | string | null;
  }>(
    `with unresolved as (
       select meeting_id,
              owner_user_id,
              cleanup_attempts,
              cleanup_disposition,
              deleted_at,
              coalesce(manual_cleanup_detected_at, deleted_at) as detected_at
       from meeting_deletion_tombstones
       where cleanup_pending = true
         and (
           cleanup_disposition in ('pending_manual_cleanup', 'manual_cleanup_approved')
           or not (meeting_id ~ '^[A-Za-z0-9_-]{1,160}$')
         )
     ), totals as (
       select count(*) as unresolved_count,
              count(*) filter (where owner_user_id is not null) as unresolved_owned_count,
              count(*) filter (where detected_at < now() - ($1::integer * interval '1 day')) as overdue_count,
              min(detected_at) as oldest_detected_at
       from unresolved
     )
     select unresolved.*,
            unresolved.detected_at < now() - ($1::integer * interval '1 day') as overdue,
            totals.unresolved_count,
            totals.unresolved_owned_count,
            totals.overdue_count,
            totals.oldest_detected_at
     from totals
     left join lateral (
       select * from unresolved order by detected_at asc, deleted_at asc limit $2
     ) unresolved on true`,
    [legacyDeletionManualCleanupSlaDays, limit],
  );
  const first = result.rows[0];
  const inventory: LegacyDeletionCleanupInventoryItem[] = result.rows
    .filter((row) => typeof row.meeting_id === "string" && typeof row.owner_user_id === "string")
    .map((row) => {
      const state: LegacyDeletionCleanupInventoryItem["state"] =
        row.cleanup_disposition === "manual_cleanup_approved" ? "manual_cleanup_approved" : "pending_manual_cleanup";
      return {
        attempts: Number(row.cleanup_attempts || 0),
        deletedAt: toIso(row.deleted_at),
        detectedAt: toIso(row.detected_at),
        meetingRef: shortRef("meeting", row.meeting_id),
        ownerRef: shortRef("owner", row.owner_user_id),
        state,
      };
    });
  const unresolvedCount = Number(first?.unresolved_count || 0);
  const unresolvedOwnedCount = Number(first?.unresolved_owned_count || 0);
  const catalogBackfillBlockerCount = await getMeetingCatalogBackfillBlockerCount();
  return {
    generatedAt,
    inventory,
    inventoryLimit: limit,
    oldestDetectedAt: first?.oldest_detected_at ? toIso(first.oldest_detected_at) : null,
    overdueCount: Number(first?.overdue_count || 0),
    releaseBlocked: unresolvedOwnedCount > 0 || catalogBackfillBlockerCount > 0,
    supported: true,
    catalogBackfillBlockerCount,
    unresolvedCount,
    unresolvedOwnedCount,
  };
}

export async function resolveLegacyMeetingDeletionCleanup(input: {
  approvedBy: string;
  meetingId: string;
  ownerUserId: string;
}) {
  if (getMeetingWriteLockMode() !== "postgres-advisory") {
    throw new Error("Legacy deletion cleanup resolution requires PostgreSQL advisory-lock mode.");
  }
  const meetingId = validateLegacyObjectPrefix(input.meetingId);
  const ownerUserId = validateOwnerUserId(input.ownerUserId);
  const approvedByRef = shortRef("operator", input.approvedBy);
  const pool = getPostgresRuntimePool("PostgreSQL legacy deletion cleanup resolution");
  const client = await pool.connect();
  const objectStore = getMeetingObjectStore();
  let backupBarrierLocked = false;
  let locked = false;
  try {
    await client.query(
      "select pg_advisory_lock_shared(hashtextextended($1, 0))",
      [MEETING_BACKUP_BARRIER_LOCK_KEY],
    );
    backupBarrierLocked = true;
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [`ownminutes-meeting-write:${meetingId}`]);
    locked = true;
    const tombstone = await client.query<{
      cleanup_disposition: string;
      deleted_at: Date | string;
      manual_cleanup_proof: string | null;
      owner_user_id: string;
    }>(
      `select owner_user_id, cleanup_disposition, manual_cleanup_proof, deleted_at
       from meeting_deletion_tombstones
       where meeting_id = $1 and cleanup_pending = true
       for update`,
      [meetingId],
    );
    const row = tombstone.rows[0];
    if (!row || row.owner_user_id !== ownerUserId) {
      throw new Error("Legacy cleanup record was not found for the supplied owner.");
    }
    if (!["pending_manual_cleanup", "manual_cleanup_approved"].includes(row.cleanup_disposition)) {
      throw new Error("Legacy cleanup record is not in a manual-cleanup state.");
    }

    const prefixes = await objectStore.listTopLevelPrefixes();
    const prefixExists = prefixes.includes(meetingId);
    let proof = row.manual_cleanup_proof;
    if (prefixExists) {
      const manifestText = await objectStore.getText(`${meetingId}/manifest.json`);
      const manifest = parseOwnerManifest(manifestText);
      if (manifest.meetingId !== meetingId || manifest.ownerUserId !== ownerUserId) {
        throw new Error("Exact manifest ownership proof did not match the quarantined cleanup record.");
      }
      const relationalMeeting = await client.query<{ object_prefix: string; owner_user_id: string }>(
        "select owner_user_id, object_prefix from meetings where id = $1 limit 1",
        [meetingId],
      );
      if (
        relationalMeeting.rows[0] &&
        (relationalMeeting.rows[0].owner_user_id !== ownerUserId || relationalMeeting.rows[0].object_prefix !== meetingId)
      ) {
        throw new Error("Relational meeting ownership conflicts with the exact manifest proof.");
      }
      proof = legacyManifestProof(meetingId, ownerUserId, manifestText);
      if (row.manual_cleanup_proof && row.manual_cleanup_proof !== proof) {
        throw new Error("The legacy manifest changed after manual approval; cleanup remains quarantined.");
      }
      await client.query(
        `update meeting_deletion_tombstones
         set cleanup_disposition = 'manual_cleanup_approved',
             manual_cleanup_approved_at = coalesce(manual_cleanup_approved_at, now()),
             manual_cleanup_approved_by_ref = $3,
             manual_cleanup_proof = $4,
             cleanup_last_error = 'legacy_exact_manifest_owner_verified'
         where meeting_id = $1 and owner_user_id = $2 and cleanup_pending = true`,
        [meetingId, ownerUserId, approvedByRef, proof],
      );
      await markMeetingCatalogDeleted(meetingId, ownerUserId);
      await objectStore.deletePrefix(`${meetingId}/`);
    } else if (row.cleanup_disposition !== "manual_cleanup_approved" || !proof) {
      throw new Error("No exact object prefix exists and no prior owner-verified approval can prove a completed retry.");
    } else {
      await markMeetingCatalogDeleted(meetingId, ownerUserId);
    }

    const remainingPrefixes = await objectStore.listTopLevelPrefixes();
    if (remainingPrefixes.includes(meetingId)) {
      throw new Error("The exact legacy object prefix still exists after cleanup.");
    }

    await resolveMeetingCatalogBackfillBlocker(meetingId);

    await client.query("begin");
    await purgeLegacyMeetingRelationalData(client, meetingId, ownerUserId);
    await client.query(
      `insert into meeting_deletion_fences (
         meeting_ref, owner_proof_ref, deleted_at, cleaned_at, cleanup_resolution,
         approved_at, approved_by_ref, proof_ref
       ) values ($1, $2, $3, now(), 'legacy_exact_manifest_owner_verified', now(), $4, $5)
       on conflict (meeting_ref) do update
         set deleted_at = least(meeting_deletion_fences.deleted_at, excluded.deleted_at),
             cleaned_at = least(meeting_deletion_fences.cleaned_at, excluded.cleaned_at),
             cleanup_resolution = excluded.cleanup_resolution,
             approved_at = coalesce(meeting_deletion_fences.approved_at, excluded.approved_at),
             approved_by_ref = coalesce(meeting_deletion_fences.approved_by_ref, excluded.approved_by_ref),
             proof_ref = coalesce(meeting_deletion_fences.proof_ref, excluded.proof_ref)`,
      [
        meetingDeletionFenceRef(meetingId),
        meetingDeletionOwnerProofRef(meetingId, ownerUserId),
        row.deleted_at,
        approvedByRef,
        proof,
      ],
    );
    const removed = await client.query(
      `delete from meeting_deletion_tombstones
       where meeting_id = $1
         and owner_user_id = $2
         and cleanup_pending = true
         and cleanup_disposition = 'manual_cleanup_approved'
         and manual_cleanup_proof = $3`,
      [meetingId, ownerUserId, proof],
    );
    if (removed.rowCount !== 1) throw new Error("Legacy cleanup approval changed before completion.");
    await client.query("commit");
    return {
      cleaned: true as const,
      meetingRef: shortRef("meeting", meetingId),
      ownerRef: shortRef("owner", ownerUserId),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    if (locked) {
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [`ownminutes-meeting-write:${meetingId}`])
        .catch(() => undefined);
    }
    if (backupBarrierLocked) {
      await client
        .query("select pg_advisory_unlock_shared(hashtextextended($1, 0))", [MEETING_BACKUP_BARRIER_LOCK_KEY])
        .catch(() => undefined);
    }
    client.release();
  }
}

type LegacyDeletionRelationalClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: T[] }>;
};

async function purgeLegacyMeetingRelationalData(
  client: LegacyDeletionRelationalClient,
  meetingId: string,
  ownerUserId: string,
) {
  const providerCost = await client.query<{
    free_trial_minutes_settled: number | string;
    official_minutes_settled: number | string;
    provider_steps: number | string;
  }>(
    `select count(*) as provider_steps,
            coalesce(sum(step.official_minutes_settled), 0) as official_minutes_settled,
            coalesce(sum(step.free_trial_minutes_settled), 0) as free_trial_minutes_settled
     from meeting_processing_provider_steps step
     join meeting_processing_reservations reservation on reservation.id = step.reservation_id
     where reservation.user_id = $1 and reservation.meeting_id = $2`,
    [ownerUserId, meetingId],
  );
  if (Number(providerCost.rows[0]?.provider_steps || 0) > 0) {
    await client.query(
      `insert into account_deletion_provider_cost_aggregates (
         id, provider_steps, official_minutes_settled, free_trial_minutes_settled, recorded_at
       ) values ($1, $2, $3, $4, now())`,
      [
        `meeting-delete-cost-${crypto.randomUUID()}`,
        Number(providerCost.rows[0]?.provider_steps || 0),
        Number(providerCost.rows[0]?.official_minutes_settled || 0),
        Number(providerCost.rows[0]?.free_trial_minutes_settled || 0),
      ],
    );
  }
  const usagePrefix = `Finalized meeting:${meetingId} `;
  await client.query(
    `update usage_events
     set note = 'Deleted meeting usage retained without meeting identity.',
         processing_reservation_id = null
     where user_id = $1
       and type = 'meeting_finalize'
       and (
         left(note, char_length($3::text)) = $3
         or exists (
           select 1
           from meeting_processing_reservations reservation
           where reservation.id = usage_events.processing_reservation_id
             and reservation.user_id = $1
             and reservation.meeting_id = $2
         )
       )`,
    [ownerUserId, meetingId, usagePrefix],
  );
  await client.query(
    "delete from meeting_finalization_jobs where meeting_id = $1 and owner_user_id = $2",
    [meetingId, ownerUserId],
  );
  await client.query(
    "delete from meeting_processing_reservations where meeting_id = $1 and user_id = $2",
    [meetingId, ownerUserId],
  );
  await client.query(
    "delete from meetings where id = $1 and owner_user_id = $2",
    [meetingId, ownerUserId],
  );
}

function validateLegacyObjectPrefix(value: string) {
  const normalized = String(value || "");
  if (!isTraversalSafeLegacyMeetingId(normalized)) {
    throw new Error("Legacy cleanup requires one exact, non-canonical, traversal-safe object prefix.");
  }
  return normalized;
}

function validateOwnerUserId(value: string) {
  const normalized = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,192}$/.test(normalized)) throw new Error("Invalid legacy cleanup owner id.");
  return normalized;
}

function parseOwnerManifest(value: string) {
  const parsed = JSON.parse(value) as { meetingId?: unknown; ownerUserId?: unknown };
  return {
    meetingId: typeof parsed.meetingId === "string" ? parsed.meetingId : "",
    ownerUserId: typeof parsed.ownerUserId === "string" ? parsed.ownerUserId : "",
  };
}

function legacyManifestProof(meetingId: string, ownerUserId: string, manifestText: string) {
  return crypto
    .createHash("sha256")
    .update("ownminutes-legacy-manifest-proof:v1\u0000")
    .update(meetingId)
    .update("\u0000")
    .update(ownerUserId)
    .update("\u0000")
    .update(manifestText)
    .digest("hex");
}

function shortRef(scope: string, value: string) {
  return `${scope}_${crypto.createHash("sha256").update(`ownminutes-${scope}-ref:v1:${value}`).digest("hex").slice(0, 20)}`;
}

function toIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}
