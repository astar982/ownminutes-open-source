import crypto from "node:crypto";
import { meetingDeletionFenceRef } from "@/lib/server/meeting-deletion-proof";
import { getPostgresDatabaseUrl, getPostgresRuntimePool } from "@/lib/server/postgres-runtime";

const CATALOG_VERSION = 5;
const CATALOG_STATE_KEY = `meeting-catalog-v${CATALOG_VERSION}`;
const CATALOG_BACKFILL_LOCK_KEY = "ownminutes-meeting-catalog-backfill";
const STORAGE_INTEGRITY_KEY = "meeting-storage-integrity";
export const meetingStorageIntegrityAuditVersion = 1;
export const meetingStorageWriterInvariantVersion = 1;
export const meetingStorageIntegrityMaxAgeMs = 10 * 60 * 1_000;
export const meetingStorageIntegrityRefreshAgeMs = 5 * 60 * 1_000;

export type MeetingCatalogProjection = {
  meetingId: string;
  ownerUserId: string;
  title: string;
  objectPrefix: string;
  project?: string;
  tags: string[];
  shareVisibility: "private" | "public";
  shareIncludeTranscript: boolean;
  shareExpiresAt?: string;
  totalBytes: number;
  totalChunks: number;
  durationMs: number;
  updatedAt: string;
};

export function isMeetingCatalogEnabled() {
  return process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(getPostgresDatabaseUrl());
}

export async function isMeetingCatalogReady() {
  if (!isMeetingCatalogEnabled()) return false;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog").query<{ ready: boolean }>(
    `select exists(
       select 1
       from meeting_catalog_state
       where catalog_key = $1 and catalog_version = $2
     ) and not exists(
       select 1
       from meeting_catalog_backfill_blockers
       where resolved_at is null
     ) and not exists(
       select 1
       from meeting_catalog_coverage_fences
       where resolved_at is null
     ) and not exists(
       select 1
       from meeting_object_transfer_intents
       where transfer_kind = 'catalog_manifest'
     ) as ready`,
    [CATALOG_STATE_KEY, CATALOG_VERSION],
  );
  return result.rows[0]?.ready === true;
}

export async function markMeetingCatalogReady(indexedMeetings: number) {
  if (!isMeetingCatalogEnabled()) return false;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog").query<{ catalog_key: string }>(
    `insert into meeting_catalog_state
       (catalog_key, catalog_version, indexed_meetings, completed_at)
     select $1, $2, $3, now()
     where not exists (
       select 1 from meeting_catalog_backfill_blockers where resolved_at is null
     ) and not exists (
       select 1 from meeting_catalog_coverage_fences where resolved_at is null
     ) and not exists (
       select 1 from meeting_object_transfer_intents
       where transfer_kind = 'catalog_manifest'
     )
     on conflict (catalog_key) do update
       set catalog_version = excluded.catalog_version,
           indexed_meetings = excluded.indexed_meetings,
           completed_at = excluded.completed_at
     returning catalog_key`,
    [CATALOG_STATE_KEY, CATALOG_VERSION, Math.max(0, Math.round(indexedMeetings))],
  );
  if (!result.rows[0]) {
    await getPostgresRuntimePool("PostgreSQL meeting catalog").query(
      "delete from meeting_catalog_state where catalog_key = $1",
      [CATALOG_STATE_KEY],
    );
    return false;
  }
  return true;
}

export async function markMeetingCatalogCoverageIncomplete() {
  if (!isMeetingCatalogEnabled()) return;
  await getPostgresRuntimePool("PostgreSQL meeting catalog").query(
    "delete from meeting_catalog_state where catalog_key = $1",
    [CATALOG_STATE_KEY],
  );
}

export async function withMeetingCatalogBackfillLock<T>(operation: () => Promise<T>) {
  if (!isMeetingCatalogEnabled()) return operation();
  const client = await getPostgresRuntimePool("PostgreSQL meeting catalog backfill").connect();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [CATALOG_BACKFILL_LOCK_KEY]);
    locked = true;
    return await operation();
  } finally {
    if (locked) {
      await client
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [CATALOG_BACKFILL_LOCK_KEY])
        .catch(() => undefined);
    }
    client.release();
  }
}

export type MeetingCatalogBackfillBlockerReason =
  | "canonical_unattributed"
  | "legacy_noncanonical_owner_verified"
  | "legacy_noncanonical_unattributed"
  | "unsafe_object_prefix";

export function classifyCanonicalMeetingPrefixOwnership(input: {
  catalogOwnerUserId?: string;
  deletionOwnerUserId?: string;
  manifest: { meetingId: string; ownerUserId?: string } | null;
  meetingId: string;
  realtimeOwnerUserId?: string;
  transferOwnerUserIds?: readonly string[];
}):
  | { ownerUserId: string; status: "owned" }
  | { reason: "conflicting_owner_evidence" | "unattributed"; status: "quarantined" } {
  if (input.manifest && input.manifest.meetingId !== input.meetingId) {
    return { reason: "conflicting_owner_evidence", status: "quarantined" };
  }
  const owners = new Set(
    [
      input.catalogOwnerUserId,
      input.manifest?.ownerUserId,
      input.deletionOwnerUserId,
      input.realtimeOwnerUserId,
      ...(input.transferOwnerUserIds ?? []),
    ].filter((owner): owner is string => Boolean(owner)),
  );
  if (owners.size === 0) return { reason: "unattributed", status: "quarantined" };
  if (owners.size > 1) return { reason: "conflicting_owner_evidence", status: "quarantined" };
  return { ownerUserId: [...owners][0], status: "owned" };
}

export function meetingCatalogBackfillPrefixRef(objectPrefix: string) {
  return crypto
    .createHash("sha256")
    .update("ownminutes-meeting-catalog-prefix:v1\u0000")
    .update(objectPrefix)
    .digest("hex");
}

export async function recordMeetingCatalogBackfillBlocker(input: {
  objectPrefix: string;
  ownerUserId?: string;
  reason: MeetingCatalogBackfillBlockerReason;
}) {
  if (!isMeetingCatalogEnabled()) return;
  const prefixRef = meetingCatalogBackfillPrefixRef(input.objectPrefix);
  if (input.reason === "canonical_unattributed") {
    await getPostgresRuntimePool("PostgreSQL meeting catalog coverage fence").query(
      `with coverage_fence as (
         insert into meeting_catalog_coverage_fences
           (prefix_ref, owner_user_id, reason, detected_at, last_seen_at, resolved_at)
         values ($1, $2, $3, now(), now(), null)
         on conflict (prefix_ref) do update
           set owner_user_id = excluded.owner_user_id,
               reason = excluded.reason,
               last_seen_at = now(),
               resolved_at = null
         returning prefix_ref
       )
     delete from meeting_catalog_state
     where catalog_key = $4
       and exists(select 1 from coverage_fence)`,
      [prefixRef, input.ownerUserId || null, input.reason, CATALOG_STATE_KEY],
    );
    if (!input.ownerUserId) await invalidateMeetingStorageIntegrityAudit();
    return;
  }
  await getPostgresRuntimePool("PostgreSQL meeting catalog backfill blocker").query(
    `with blocker as (
       insert into meeting_catalog_backfill_blockers
         (prefix_ref, owner_user_id, reason, detected_at, last_seen_at, resolved_at)
       values ($1, $2, $3, now(), now(), null)
       on conflict (prefix_ref) do update
         set owner_user_id = excluded.owner_user_id,
             reason = excluded.reason,
             last_seen_at = now(),
             resolved_at = null
       returning prefix_ref
     )
     delete from meeting_catalog_state
     where catalog_key = $4
       and exists(select 1 from blocker)`,
    [prefixRef, input.ownerUserId || null, input.reason, CATALOG_STATE_KEY],
  );
  if (!input.ownerUserId) await invalidateMeetingStorageIntegrityAudit();
}

export async function reconcileMeetingCatalogBackfillBlockers(objectPrefixes: readonly string[]) {
  if (!isMeetingCatalogEnabled()) return;
  const currentPrefixRefs = [...new Set(objectPrefixes.map(meetingCatalogBackfillPrefixRef))];
  await Promise.all([
    getPostgresRuntimePool("PostgreSQL meeting catalog backfill blocker").query(
      `delete from meeting_catalog_backfill_blockers
       where resolved_at is not null
          or not (prefix_ref = any($1::text[]))`,
      [currentPrefixRefs],
    ),
    getPostgresRuntimePool("PostgreSQL meeting catalog coverage fence").query(
      `delete from meeting_catalog_coverage_fences
       where resolved_at is not null
          or not (prefix_ref = any($1::text[]))`,
      [currentPrefixRefs],
    ),
  ]);
}

export async function resolveMeetingCatalogBackfillBlocker(objectPrefix: string) {
  if (!isMeetingCatalogEnabled()) return;
  const prefixRef = meetingCatalogBackfillPrefixRef(objectPrefix);
  await Promise.all([
    getPostgresRuntimePool("PostgreSQL meeting catalog backfill blocker").query(
      "delete from meeting_catalog_backfill_blockers where prefix_ref = $1",
      [prefixRef],
    ),
    getPostgresRuntimePool("PostgreSQL meeting catalog coverage fence").query(
      "delete from meeting_catalog_coverage_fences where prefix_ref = $1",
      [prefixRef],
    ),
  ]);
}

export async function getMeetingCatalogBackfillBlockerCount() {
  if (!isMeetingCatalogEnabled()) return 0;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog backfill blocker").query<{ count: string | number }>(
    `select (
       (select count(*) from meeting_catalog_backfill_blockers where resolved_at is null) +
       (select count(*) from meeting_catalog_coverage_fences where resolved_at is null) +
       (select count(*) from meeting_object_transfer_intents where transfer_kind = 'catalog_manifest')
     ) as count`,
  );
  return Number(result.rows[0]?.count || 0);
}

export async function getUnattributedMeetingCatalogBlockerCount() {
  if (!isMeetingCatalogEnabled()) return 0;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog integrity gate").query<{
    count: string | number;
  }>(
    `select (
       (select count(*) from meeting_catalog_backfill_blockers
        where resolved_at is null and owner_user_id is null) +
       (select count(*) from meeting_catalog_coverage_fences
        where resolved_at is null and owner_user_id is null)
     ) as count`,
  );
  return Number(result.rows[0]?.count || 0);
}

export async function recordMeetingStorageIntegrityAudit(unattributedPrefixCount: number) {
  if (!isMeetingCatalogEnabled()) return;
  await getPostgresRuntimePool("PostgreSQL meeting storage integrity audit").query(
    `insert into meeting_storage_integrity_state (
       integrity_key, audit_version, writer_invariant_version,
       unattributed_prefix_count, completed_at
     ) values ($1, $2, $3, $4, now())
     on conflict (integrity_key) do update
       set audit_version = excluded.audit_version,
           writer_invariant_version = excluded.writer_invariant_version,
           unattributed_prefix_count = excluded.unattributed_prefix_count,
           completed_at = excluded.completed_at`,
    [
      STORAGE_INTEGRITY_KEY,
      meetingStorageIntegrityAuditVersion,
      meetingStorageWriterInvariantVersion,
      Math.max(0, Math.round(unattributedPrefixCount)),
    ],
  );
}

export async function getMeetingStorageIntegrityStatus(maxAgeMs = meetingStorageIntegrityMaxAgeMs) {
  if (!isMeetingCatalogEnabled()) {
    return {
      completedAt: null,
      fresh: false,
      ready: false,
      supported: false,
      unattributedPrefixCount: 0,
      writerInvariantCurrent: false,
    } as const;
  }
  const result = await getPostgresRuntimePool("PostgreSQL meeting storage integrity gate").query<{
    audit_version: number | string;
    completed_at: Date | string;
    unattributed_prefix_count: number | string;
    writer_invariant_version: number | string;
  }>(
    `select audit_version, writer_invariant_version,
            unattributed_prefix_count, completed_at
     from meeting_storage_integrity_state
     where integrity_key = $1`,
    [STORAGE_INTEGRITY_KEY],
  );
  const row = result.rows[0];
  const completedAt = row?.completed_at
    ? (row.completed_at instanceof Date ? row.completed_at.toISOString() : new Date(row.completed_at).toISOString())
    : null;
  const fresh = Boolean(completedAt) && Date.now() - Date.parse(completedAt!) <= maxAgeMs;
  const writerInvariantCurrent =
    Number(row?.audit_version || 0) === meetingStorageIntegrityAuditVersion &&
    Number(row?.writer_invariant_version || 0) === meetingStorageWriterInvariantVersion;
  const unattributedPrefixCount = Number(row?.unattributed_prefix_count || 0);
  return {
    completedAt,
    fresh,
    ready: fresh && writerInvariantCurrent && unattributedPrefixCount === 0,
    supported: true,
    unattributedPrefixCount,
    writerInvariantCurrent,
  } as const;
}

async function invalidateMeetingStorageIntegrityAudit() {
  await getPostgresRuntimePool("PostgreSQL meeting storage integrity gate").query(
    "delete from meeting_storage_integrity_state where integrity_key = $1",
    [STORAGE_INTEGRITY_KEY],
  );
}

export async function upsertMeetingCatalog(projection: MeetingCatalogProjection) {
  if (!isMeetingCatalogEnabled()) return;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog").query<{ id: string }>(
    `insert into meetings
       (id, owner_user_id, title, object_prefix, project, tags,
        share_visibility, share_include_transcript, share_expires_at, total_bytes,
        total_chunks, duration_ms, transcript_count, has_result, created_at,
        updated_at, deleted_at, metadata_search_text)
     select
       $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, 0, false, $13, $13, null, $14
     where exists (
       select 1 from users where id = $2 and deleted_at is null
     )
       and not exists (
         select 1 from meeting_deletion_tombstones where meeting_id = $1
       )
       and not exists (
         select 1 from meeting_deletion_fences where meeting_ref = $15
       )
     on conflict (id) do update
       set title = excluded.title,
           object_prefix = excluded.object_prefix,
           project = excluded.project,
           tags = excluded.tags,
           share_visibility = excluded.share_visibility,
           share_include_transcript = excluded.share_include_transcript,
           share_expires_at = excluded.share_expires_at,
           total_bytes = excluded.total_bytes,
           total_chunks = excluded.total_chunks,
           duration_ms = excluded.duration_ms,
           metadata_search_text = excluded.metadata_search_text,
           updated_at = excluded.updated_at
       where meetings.owner_user_id = excluded.owner_user_id
         and meetings.deleted_at is null
         and not exists (
           select 1 from meeting_deletion_tombstones where meeting_id = $1
         )
         and not exists (
           select 1 from meeting_deletion_fences where meeting_ref = $15
         )
     returning id`,
    [
      projection.meetingId,
      projection.ownerUserId,
      projection.title,
      projection.objectPrefix,
      projection.project || null,
      JSON.stringify(projection.tags),
      projection.shareVisibility,
      projection.shareIncludeTranscript,
      projection.shareExpiresAt || null,
      projection.totalBytes,
      projection.totalChunks,
      projection.durationMs,
      projection.updatedAt,
      buildMetadataSearchText(projection),
      meetingDeletionFenceRef(projection.meetingId),
    ],
  );
  if (result.rows[0]?.id !== projection.meetingId) {
    throw new Error("Meeting catalog write was rejected by an owner or deletion fence.");
  }
}

export async function seedMeetingShareAnalytics(input: {
  meetingId: string;
  viewCount: number;
  firstViewedAt?: string;
  lastViewedAt?: string;
}) {
  if (!isMeetingCatalogEnabled()) return;
  await getPostgresRuntimePool("PostgreSQL meeting share analytics").query(
    `insert into meeting_share_analytics
       (meeting_id, view_count, first_viewed_at, last_viewed_at, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (meeting_id) do nothing`,
    [
      input.meetingId,
      Math.max(0, Math.round(input.viewCount)),
      input.firstViewedAt || null,
      input.lastViewedAt || null,
    ],
  );
}

export async function recordMeetingCatalogShareView(meetingId: string) {
  if (!isMeetingCatalogEnabled()) return null;
  const result = await getPostgresRuntimePool("PostgreSQL meeting share analytics").query<{
    first_viewed_at: Date | string | null;
    last_viewed_at: Date | string | null;
    view_count: number | string;
  }>(
    `insert into meeting_share_analytics
       (meeting_id, view_count, first_viewed_at, last_viewed_at, updated_at)
     values ($1, 1, now(), now(), now())
     on conflict (meeting_id) do update
       set view_count = meeting_share_analytics.view_count + 1,
           first_viewed_at = coalesce(meeting_share_analytics.first_viewed_at, now()),
           last_viewed_at = now(),
           updated_at = now()
     returning view_count, first_viewed_at, last_viewed_at`,
    [meetingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    viewCount: Number(row.view_count),
    firstViewedAt: toIsoString(row.first_viewed_at),
    lastViewedAt: toIsoString(row.last_viewed_at),
  };
}

export async function resetMeetingCatalogShareAnalytics(meetingId: string) {
  if (!isMeetingCatalogEnabled()) return;
  await getPostgresRuntimePool("PostgreSQL meeting share analytics").query(
    `insert into meeting_share_analytics
       (meeting_id, view_count, first_viewed_at, last_viewed_at, updated_at)
     values ($1, 0, null, null, now())
     on conflict (meeting_id) do update
       set view_count = 0,
           first_viewed_at = null,
           last_viewed_at = null,
           updated_at = now()`,
    [meetingId],
  );
}

export async function getMeetingCatalogShareAnalyticsSummary() {
  if (!isMeetingCatalogEnabled()) return null;
  const result = await getPostgresRuntimePool("PostgreSQL meeting share analytics").query<{
    last_share_viewed_at: Date | string | null;
    public_shares: number | string;
    total_share_views: number | string;
    viewed_shares: number | string;
  }>(
    `select
       count(*) filter (
         where meetings.share_visibility = 'public'
           and meetings.share_expires_at > now()
       ) as public_shares,
       count(*) filter (where coalesce(analytics.view_count, 0) > 0) as viewed_shares,
       coalesce(sum(analytics.view_count), 0) as total_share_views,
       max(analytics.last_viewed_at) as last_share_viewed_at
     from meetings
     left join meeting_share_analytics analytics on analytics.meeting_id = meetings.id
     where meetings.deleted_at is null`,
  );
  const row = result.rows[0];
  return {
    publicShares: Number(row?.public_shares || 0),
    viewedShares: Number(row?.viewed_shares || 0),
    totalShareViews: Number(row?.total_share_views || 0),
    lastShareViewedAt: toIsoString(row?.last_share_viewed_at),
  };
}

export async function updateMeetingCatalogResult(input: {
  meetingId: string;
  generatedAt: string;
  resultSearchText: string;
  transcriptCount: number;
}) {
  if (!isMeetingCatalogEnabled()) return;
  await getPostgresRuntimePool("PostgreSQL meeting catalog").query(
    `update meetings
     set has_result = true,
         generated_at = $2,
         transcript_count = $3,
         result_search_text = $4,
         updated_at = greatest(updated_at, $2::timestamptz)
     where id = $1 and deleted_at is null`,
    [
      input.meetingId,
      input.generatedAt,
      Math.max(0, Math.round(input.transcriptCount)),
      input.resultSearchText.slice(0, 1_000_000),
    ],
  );
}

export async function markMeetingCatalogDeleted(meetingId: string, ownerUserId: string) {
  if (!isMeetingCatalogEnabled()) return;
  const client = await getPostgresRuntimePool("PostgreSQL meeting catalog deletion").connect();
  let ownerConflict = false;
  try {
    await client.query("begin");
    const catalogOwner = await client.query<{ owner_user_id: string }>(
      "select owner_user_id from meetings where id = $1 for update",
      [meetingId],
    );
    ownerConflict = Boolean(
      catalogOwner.rows[0] && catalogOwner.rows[0].owner_user_id !== ownerUserId,
    );
    if (ownerConflict) {
      await client.query(
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
        [meetingId, ownerUserId],
      );
    } else {
      // Logical deletion immediately removes share telemetry and queued work;
      // object-store availability must not control retention of those identities.
      await client.query(
        "delete from meeting_share_analytics where meeting_id = $1",
        [meetingId],
      );
      await client.query(
        "delete from meeting_finalization_jobs where meeting_id = $1 and owner_user_id = $2",
        [meetingId, ownerUserId],
      );
      await client.query(
        `update meetings
         set title = '',
             object_prefix = $3,
             project = null,
             tags = '[]'::jsonb,
             share_visibility = 'private',
             share_include_transcript = false,
             share_expires_at = null,
             total_bytes = 0,
             total_chunks = 0,
             duration_ms = 0,
             transcript_count = 0,
             has_result = false,
             generated_at = null,
             metadata_search_text = '',
             result_search_text = '',
             deleted_at = coalesce(deleted_at, now()),
             updated_at = now()
         where id = $1 and owner_user_id = $2`,
        [meetingId, ownerUserId, `deleted-${meetingDeletionFenceRef(meetingId)}`],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (ownerConflict) {
    throw new Error("Meeting catalog owner conflicts with its deletion owner; manual cleanup is required.");
  }
}

export async function listMeetingCatalogIdsForOwner(ownerUserId: string) {
  if (!isMeetingCatalogEnabled()) return null;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog").query<{ id: string }>(
    `select id
     from meetings
     where owner_user_id = $1 and deleted_at is null
     order by updated_at desc`,
    [ownerUserId],
  );
  return result.rows.map((row) => row.id);
}

export async function listMeetingCatalogIdsForOwnerDeletion(ownerUserId: string) {
  if (!isMeetingCatalogEnabled()) return null;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog deletion").query<{ id: string }>(
    `select id
     from meetings
     where owner_user_id = $1
     order by updated_at desc`,
    [ownerUserId],
  );
  return result.rows.map((row) => row.id);
}

export async function getMeetingCatalogDeletionCandidate(meetingId: string, ownerUserId: string) {
  if (!isMeetingCatalogEnabled()) return null;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog deletion").query<{
    deleted_at: Date | string | null;
    object_prefix: string;
  }>(
    `select object_prefix, deleted_at
     from meetings
     where id = $1 and owner_user_id = $2
     limit 1`,
    [meetingId, ownerUserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    deletedAt: toIsoString(row.deleted_at),
    objectPrefix: row.object_prefix,
  };
}

export async function getMeetingCatalogOwnerUserId(meetingId: string) {
  if (!isMeetingCatalogEnabled()) return undefined;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog deletion").query<{
    owner_user_id: string;
  }>(
    `select owner_user_id
     from meetings
     where id = $1
       and (object_prefix = $1 or deleted_at is not null)
     limit 1`,
    [meetingId],
  );
  return result.rows[0]?.owner_user_id;
}

export async function getMeetingCatalogOwnerAccountState(ownerUserId: string) {
  if (!isMeetingCatalogEnabled()) return "unknown" as const;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog owner state").query<{
    deleted_at: Date | string | null;
  }>(
    "select deleted_at from users where id = $1 limit 1",
    [ownerUserId],
  );
  if (!result.rows[0]) return "missing" as const;
  return result.rows[0].deleted_at ? "deleted" as const : "active" as const;
}

export async function hasMeetingCatalogRowsForOwner(ownerUserId: string) {
  if (!isMeetingCatalogEnabled()) return false;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog deletion").query<{ pending: boolean }>(
    "select exists(select 1 from meetings where owner_user_id = $1) as pending",
    [ownerUserId],
  );
  return result.rows[0]?.pending === true;
}

export async function hasPendingMeetingCatalogCoverageForOwner(ownerUserId: string) {
  if (!isMeetingCatalogEnabled()) return false;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog deletion").query<{ pending: boolean }>(
    `select (
       exists(
         select 1 from meeting_catalog_backfill_blockers
         where owner_user_id = $1 and resolved_at is null
       )
       or exists(
         select 1 from meeting_catalog_coverage_fences
         where owner_user_id = $1 and resolved_at is null
       )
     ) as pending`,
    [ownerUserId],
  );
  return result.rows[0]?.pending === true;
}

export async function searchMeetingCatalogIdsForOwner(ownerUserId: string, rawQuery: string) {
  if (!isMeetingCatalogEnabled()) return null;
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!query) return listMeetingCatalogIdsForOwner(ownerUserId);
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog search").query<{ id: string }>(
    `select id
     from meetings
     where owner_user_id = $1
       and deleted_at is null
       and (
         search_document @@ websearch_to_tsquery('simple', $2)
         or position(lower($2) in lower(metadata_search_text)) > 0
         or position(lower($2) in lower(result_search_text)) > 0
       )
     order by updated_at desc
     limit 500`,
    [ownerUserId, query],
  );
  return result.rows.map((row) => row.id);
}

export async function listAllMeetingCatalogIds() {
  if (!isMeetingCatalogEnabled()) return null;
  const result = await getPostgresRuntimePool("PostgreSQL meeting catalog").query<{ id: string }>(
    `select id
     from meetings
     where deleted_at is null
     order by updated_at desc`,
  );
  return result.rows.map((row) => row.id);
}

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildMetadataSearchText(projection: MeetingCatalogProjection) {
  return [
    projection.meetingId,
    projection.title,
    projection.project,
    ...projection.tags,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 16_000);
}
