import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMeetingMarkdown, type MeetingResult } from "@/lib/meeting-processing";
import { assessMeetingResultQuality } from "@/lib/meeting-result-quality";
import { MeetingSharePolicyError, resolveMeetingShareExpiresAt } from "@/lib/meeting-share-policy";
import { getUserById, purgeMeetingProcessingLedger } from "@/lib/server/auth-repository";
import { buildMeetingObjectKey, getMeetingObjectStore, getMeetingObjectStoreInfo, readOptionalMeetingObject } from "@/lib/server/meeting-object-store";
import { getRealtimeSessionOwner } from "@/lib/server/realtime-session-store";
import { readMeetingFinalizationState, type MeetingFinalizationState } from "@/lib/server/meeting-finalization-state";
import {
  claimMeetingDeletionCleanup,
  completeMeetingDeletionCleanup,
  getMeetingDeletionOwner,
  getLegacyMeetingDeletionOwner,
  isCanonicalMeetingId,
  isMeetingWriteAllowed,
  isTraversalSafeLegacyMeetingId,
  listMeetingDeletionIdsForOwner,
  markMeetingDeleted,
  purgeCompletedMeetingCatalogAfterObjectAbsence,
  purgeMeetingCatalogAfterObjectDeletion,
  quarantineMeetingDeletionOwnerConflict,
  quarantineLegacyMeetingDeletionForManualCleanup,
  reopenMeetingDeletionCleanup,
  retryMeetingDeletionCleanup,
  withMeetingWriteFence,
  withMeetingWriteLock,
  withRecordingUploadLock,
  withUserWriteLock,
} from "@/lib/server/meeting-write-lock";
import { MeetingAccessError } from "@/lib/server/meeting-errors";
import {
  createMeetingReviewConfirmation,
  normalizeMeetingReviewConfirmation,
  resolveMeetingHumanReview,
  type MeetingHumanReview,
  type MeetingReviewConfirmation,
} from "@/lib/server/meeting-human-review";
import { normalizeAudioFileForVolcanoAsr, probeAudioFileDurationMs } from "@/lib/audio-normalization";
import { isProviderAccessibleAsrAudioUrl } from "@/lib/asr-audio-url";
import { validateFullRecordingDuration } from "@/lib/server/audio-upload-policy";
import {
  classifyCanonicalMeetingPrefixOwnership,
  isMeetingCatalogEnabled,
  isMeetingCatalogReady,
  getMeetingCatalogShareAnalyticsSummary,
  getMeetingCatalogDeletionCandidate,
  getMeetingCatalogOwnerAccountState,
  getMeetingCatalogOwnerUserId,
  getMeetingStorageIntegrityStatus,
  getUnattributedMeetingCatalogBlockerCount,
  hasMeetingCatalogRowsForOwner,
  hasPendingMeetingCatalogCoverageForOwner,
  markMeetingCatalogCoverageIncomplete,
  recordMeetingCatalogBackfillBlocker,
  reconcileMeetingCatalogBackfillBlockers,
  resolveMeetingCatalogBackfillBlocker,
  listAllMeetingCatalogIds,
  listMeetingCatalogIdsForOwner,
  listMeetingCatalogIdsForOwnerDeletion,
  markMeetingCatalogDeleted,
  markMeetingCatalogReady,
  meetingStorageIntegrityRefreshAgeMs,
  recordMeetingStorageIntegrityAudit,
  recordMeetingCatalogShareView,
  resetMeetingCatalogShareAnalytics,
  searchMeetingCatalogIdsForOwner,
  seedMeetingShareAnalytics,
  updateMeetingCatalogResult,
  upsertMeetingCatalog,
  withMeetingCatalogBackfillLock,
} from "@/lib/server/meeting-catalog";
import {
  beginMeetingObjectTransferIntent,
  completeMeetingObjectTransferIntent,
  hasPendingMeetingObjectTransfersForOwner,
  listExpiredMeetingCatalogTransferIntents,
  listMeetingObjectTransferIdsForOwner,
  listMeetingObjectTransferOwnersForMeeting,
  resolveExpiredMeetingObjectTransfersForDeletion,
} from "@/lib/server/meeting-transfer-intent";
import {
  commitPreparedPublicMeetingShare,
  MeetingSharePublicationPreparationError,
} from "@/lib/server/meeting-share-publication";
import {
  assembleRecordingUpload,
  deleteRecordingUploadStaging,
  finalizeRecordingUpload,
  putRecordingUploadPart,
  readRecordingUploadState,
  recordingUploadStagedBytes,
  RecordingUploadConflictError,
  type RecordingUploadReceipt,
} from "@/lib/server/recording-upload-store";
import {
  normalizeStoredRecordingConsentMetadata,
  type RecordingConsentMetadata,
  type RecordingUploadMetadata,
} from "@/lib/server/recording-upload-protocol";
import {
  getRecordingUploadResourcePolicy,
  isRecordingUploadStale,
  recordingUploadResourceViolation,
} from "@/lib/server/recording-upload-resource-policy";

export { MeetingAccessError } from "@/lib/server/meeting-errors";

type AudioManifest = {
  meetingId: string;
  ownerUserId?: string;
  metadata: {
    participants: string[];
    project?: string;
    tags: string[];
    title?: string;
    updatedAt?: string;
  };
  shareAnalytics: {
    viewCount: number;
    firstViewedAt?: string;
    lastViewedAt?: string;
  };
  share: {
    visibility: "private" | "public";
    includeTranscript: boolean;
    expiresAt?: string;
    updatedAt?: string;
  };
  recordingConsent?: RecordingConsentMetadata;
  reviewConfirmation?: MeetingReviewConfirmation;
  chunks: Array<{
    sequence: number;
    fileName: string;
    bytes: number;
    mimeType: string;
    recordedAt: number;
    durationMs: number;
    receivedAt: string;
    sha256?: string;
  }>;
  recordingUpload?: {
    stagedBytes: number;
    totalBytes: number;
    updatedAt: string;
    uploadId: string;
  };
  audioSeal?: {
    audioRevision: string;
    lastSequence: number;
    totalBytes: number;
    sealedAt: string;
  };
  totalBytes: number;
  updatedAt: string;
};

export type MeetingListItem = {
  meetingId: string;
  title: string;
  generatedAt?: string;
  updatedAt: string;
  durationMs: number;
  totalBytes: number;
  totalChunks: number;
  metadata: AudioManifest["metadata"];
  share: AudioManifest["share"];
  hasResult: boolean;
  transcriptCount: number;
  processing: MeetingFinalizationState | null;
  qualityStatus: "verified" | "unverified";
  humanReview: MeetingHumanReview;
  recordingConsent: RecordingConsentMetadata;
};

export type MeetingDetail = MeetingListItem & {
  result: MeetingResult | null;
  obsidianMarkdown: string | null;
};

export type MeetingShareAnalyticsSummary = {
  publicShares: number;
  viewedShares: number;
  totalShareViews: number;
  lastShareViewedAt?: string;
};

export type MeetingAccessSnapshot = {
  meetingId: string;
  exists: boolean;
  ownerUserId?: string;
  share: AudioManifest["share"];
  hasChunks: boolean;
  humanReview: MeetingHumanReview;
};

export type MeetingShareSnapshot = {
  access: MeetingAccessSnapshot;
  durationMs: number;
  result: MeetingResult | null;
};

const objectStore = getMeetingObjectStore();
let meetingCatalogBackfillPromise: Promise<boolean> | undefined;

async function persistMeetingManifest(manifestKey: string, manifest: AudioManifest) {
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!isMeetingCatalogEnabled()) {
    await objectStore.putText(manifestKey, serializedManifest);
    return;
  }

  const objectPrefix = sanitizeSegment(manifest.meetingId);
  if (!manifest.ownerUserId) {
    await recordMeetingCatalogBackfillBlocker({
      objectPrefix,
      reason: "canonical_unattributed",
    });
    await objectStore.putText(manifestKey, serializedManifest);
    return;
  }

  const intentId = await beginMeetingObjectTransferIntent({
    meetingId: manifest.meetingId,
    ownerUserId: manifest.ownerUserId,
    transferKind: "catalog_manifest",
  });
  await objectStore.putText(manifestKey, serializedManifest);
  await upsertMeetingCatalog(meetingCatalogProjection(manifest));
  await resolveMeetingCatalogBackfillBlocker(objectPrefix);
  await completeMeetingObjectTransferIntent({
    intentId,
    meetingId: manifest.meetingId,
    ownerUserId: manifest.ownerUserId,
  });
}

function meetingCatalogProjection(manifest: AudioManifest) {
  return {
    meetingId: manifest.meetingId,
    ownerUserId: manifest.ownerUserId!,
    title: manifest.metadata.title || manifest.meetingId,
    objectPrefix: sanitizeSegment(manifest.meetingId),
    project: manifest.metadata.project,
    tags: manifest.metadata.tags,
    shareVisibility: manifest.share.visibility,
    shareIncludeTranscript: manifest.share.includeTranscript,
    shareExpiresAt: manifest.share.expiresAt,
    totalBytes: manifest.totalBytes,
    totalChunks: manifest.chunks.length,
    durationMs: manifest.chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0),
    updatedAt: manifest.updatedAt,
  } as const;
}

async function ensureMeetingCatalogBackfilled() {
  if (!isMeetingCatalogEnabled()) return false;
  let activeBackfill: Promise<boolean> | undefined;
  try {
    if (await isMeetingCatalogReady()) return true;
    activeBackfill = meetingCatalogBackfillPromise ??= backfillMeetingCatalog();
    return await activeBackfill;
  } catch (error) {
    console.error("Meeting catalog backfill failed; using bounded object-store discovery for this request.", {
      errorType: error instanceof Error ? error.name : "non_error",
    });
    return false;
  } finally {
    // Keep only an in-flight de-duplication promise. A later durable blocker or
    // catalog-state invalidation must be able to trigger a fresh backfill in
    // this long-lived process.
    if (activeBackfill && meetingCatalogBackfillPromise === activeBackfill) {
      meetingCatalogBackfillPromise = undefined;
    }
  }
}

async function backfillMeetingCatalog(force = false) {
  return withMeetingCatalogBackfillLock(async () => {
    if (force) {
      const recentAudit = await getMeetingStorageIntegrityStatus(meetingStorageIntegrityRefreshAgeMs);
      if (recentAudit.fresh) return isMeetingCatalogReady();
    }
    if (!force && await isMeetingCatalogReady()) return true;
    const discoveredMeetingIds = await objectStore.listTopLevelPrefixes();
    await reconcileMeetingCatalogBackfillBlockers(discoveredMeetingIds);
    await recoverExpiredMeetingCatalogTransfers(discoveredMeetingIds);
    let indexedMeetings = 0;
    await mapWithConcurrency(discoveredMeetingIds, 8, async (meetingId) => {
      if (!isCanonicalMeetingId(meetingId)) {
        await quarantineLegacyCatalogPrefix(meetingId);
        return;
      }

      await withMeetingWriteLock(meetingId, async () => {
        // The check must happen after taking the same cross-instance lock used
        // by deletion. A pre-lock check can race a completed deletion and
        // repopulate owner/title/search fields from a stale manifest.
        if (!(await isMeetingWriteAllowed(meetingId))) return;
        let manifest: AudioManifest | null = null;
        try {
          manifest = await readExistingManifest(buildMeetingObjectKey(meetingId, "manifest"), meetingId);
        } catch {
          await quarantineCanonicalCatalogPrefix(meetingId, await getUniqueDurableMeetingOwner(meetingId));
          return;
        }
        if (!manifest?.ownerUserId || manifest.meetingId !== meetingId) {
          await quarantineCanonicalCatalogPrefix(meetingId, await getUniqueDurableMeetingOwner(meetingId));
          return;
        }
        const ownerState = await getMeetingCatalogOwnerAccountState(manifest.ownerUserId);
        if (ownerState !== "active") {
          // A soft-deleted account remains durable ownership evidence, but its
          // object manifest must never recreate a live catalog row. Keep an
          // owner-linked blocker for the deletion Worker; missing owners remain
          // globally unattributed and fail closed.
          await quarantineCanonicalCatalogPrefix(
            meetingId,
            ownerState === "deleted" ? manifest.ownerUserId : undefined,
          );
          return;
        }
        await upsertMeetingCatalog(meetingCatalogProjection(manifest));
        const result = await readMeetingResult(meetingId);
        if (result) await persistMeetingResultCatalog(meetingId, result);
        await seedMeetingShareAnalytics({
          meetingId,
          viewCount: manifest.shareAnalytics.viewCount,
          firstViewedAt: manifest.shareAnalytics.firstViewedAt,
          lastViewedAt: manifest.shareAnalytics.lastViewedAt,
        });
        await resolveMeetingCatalogBackfillBlocker(meetingId);
        indexedMeetings += 1;
      });
    });
    const unattributedPrefixCount = await getUnattributedMeetingCatalogBlockerCount();
    await recordMeetingStorageIntegrityAudit(unattributedPrefixCount);
    return markMeetingCatalogReady(indexedMeetings);
  });
}

export async function assertAccountDeletionStorageIntegrity() {
  if (!isMeetingCatalogEnabled()) return;
  const integrity = await getMeetingStorageIntegrityStatus();
  if (!integrity.fresh || !integrity.writerInvariantCurrent) {
    throw new MeetingAccessError("账号删除前的录音归属审计尚未完成或已过期，请稍后重试。", 503, {
      code: "account_storage_integrity_stale",
      retryable: true,
      retryAfterSeconds: 30,
    });
  }
  if (integrity.unattributedPrefixCount > 0) {
    throw new MeetingAccessError("录音存储存在无法安全归属的对象，账号删除已暂停。", 503, {
      code: "account_storage_integrity_blocked",
      retryable: false,
    });
  }
}

export async function refreshMeetingStorageIntegrityAudit() {
  if (!isMeetingCatalogEnabled()) return getMeetingStorageIntegrityStatus();
  await backfillMeetingCatalog(true);
  return getMeetingStorageIntegrityStatus();
}

async function recoverExpiredMeetingCatalogTransfers(
  discoveredMeetingIds: readonly string[],
) {
  const exactPrefixes = new Set(discoveredMeetingIds);
  const expiredIntents = await listExpiredMeetingCatalogTransferIntents();
  for (const intent of expiredIntents) {
    await withMeetingWriteLock(intent.meetingId, async () => {
      if (!(await isMeetingWriteAllowed(intent.meetingId))) return;
      if (!exactPrefixes.has(intent.meetingId)) {
        await completeMeetingObjectTransferIntent(intent);
        return;
      }

      let manifest: AudioManifest | null = null;
      try {
        manifest = await readExistingManifest(
          buildMeetingObjectKey(intent.meetingId, "manifest"),
          intent.meetingId,
        );
      } catch {
        // Keep the transfer intent until the prefix is either owner-verified
        // or removed. It is durable ownership evidence for account deletion.
        await quarantineCanonicalCatalogPrefix(intent.meetingId, intent.ownerUserId);
        return;
      }
      if (
        !manifest?.ownerUserId ||
        manifest.meetingId !== intent.meetingId ||
        manifest.ownerUserId !== intent.ownerUserId
      ) {
        await quarantineCanonicalCatalogPrefix(intent.meetingId, intent.ownerUserId);
        return;
      }

      await upsertMeetingCatalog(meetingCatalogProjection(manifest));
      const result = await readMeetingResult(intent.meetingId);
      if (result) await persistMeetingResultCatalog(intent.meetingId, result);
      await seedMeetingShareAnalytics({
        meetingId: intent.meetingId,
        viewCount: manifest.shareAnalytics.viewCount,
        firstViewedAt: manifest.shareAnalytics.firstViewedAt,
        lastViewedAt: manifest.shareAnalytics.lastViewedAt,
      });
      await resolveMeetingCatalogBackfillBlocker(intent.meetingId);
      await completeMeetingObjectTransferIntent(intent);
    });
  }
}

async function quarantineCanonicalCatalogPrefix(meetingId: string, ownerUserId?: string) {
  await recordMeetingCatalogBackfillBlocker({
    objectPrefix: meetingId,
    ownerUserId,
    reason: "canonical_unattributed",
  });
}

async function getUniqueDurableMeetingOwner(meetingId: string) {
  if (!isCanonicalMeetingId(meetingId)) {
    if (!isTraversalSafeLegacyMeetingId(meetingId)) return undefined;
    const [catalogOwnerUserId, deletionOwnerUserId] = await Promise.all([
      getMeetingCatalogOwnerUserId(meetingId),
      getLegacyMeetingDeletionOwner(meetingId),
    ]);
    const legacyOwners = new Set(
      [catalogOwnerUserId, deletionOwnerUserId]
        .filter((owner): owner is string => Boolean(owner)),
    );
    return legacyOwners.size === 1 ? [...legacyOwners][0] : undefined;
  }
  const [catalogOwnerUserId, deletionOwnerUserId, realtimeOwnerUserId, transferOwnerUserIds] = await Promise.all([
    getMeetingCatalogOwnerUserId(meetingId),
    getMeetingDeletionOwner(meetingId),
    getRealtimeSessionOwner(meetingId),
    listMeetingObjectTransferOwnersForMeeting(meetingId),
  ]);
  const owners = new Set(
    [catalogOwnerUserId, deletionOwnerUserId, realtimeOwnerUserId, ...transferOwnerUserIds]
      .filter((owner): owner is string => Boolean(owner)),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

async function quarantineLegacyCatalogPrefix(meetingId: string) {
  if (!isTraversalSafeLegacyMeetingId(meetingId)) {
    await recordMeetingCatalogBackfillBlocker({
      objectPrefix: meetingId,
      reason: "unsafe_object_prefix",
    });
    return;
  }

  // Install the global blocker before reading an owner-controlled legacy
  // manifest. A malformed/missing manifest must remain a durable release and
  // account-cleanup blocker rather than disappearing from catalog truth.
  const durableOwnerUserId = await getUniqueDurableMeetingOwner(meetingId);
  await recordMeetingCatalogBackfillBlocker({
    objectPrefix: meetingId,
    ownerUserId: durableOwnerUserId,
    reason: "legacy_noncanonical_unattributed",
  });
  let manifest: AudioManifest | null = null;
  try {
    manifest = await readExistingManifest(buildMeetingObjectKey(meetingId, "manifest"), meetingId);
  } catch {
    return;
  }
  if (!manifest?.ownerUserId || manifest.meetingId !== meetingId) return;

  try {
    await quarantineLegacyMeetingDeletionForManualCleanup(meetingId, manifest.ownerUserId);
  } catch {
    // The global blocker is already durable. Do not certify the catalog if the
    // owner no longer exists or conflicts with an existing quarantine record.
    return;
  }
  await recordMeetingCatalogBackfillBlocker({
    objectPrefix: meetingId,
    ownerUserId: manifest.ownerUserId,
    reason: "legacy_noncanonical_owner_verified",
  });
}

async function discoverMeetingIdsForOwner(
  ownerUserId: string,
  query = "",
) {
  if (await ensureMeetingCatalogBackfilled()) {
    const catalogIds = query
      ? await searchMeetingCatalogIdsForOwner(ownerUserId, query)
      : await listMeetingCatalogIdsForOwner(ownerUserId);
    if (catalogIds) return catalogIds;
  }
  const prefixes = await objectStore.listTopLevelPrefixes();
  return prefixes.filter(isCanonicalMeetingId);
}

async function discoverMeetingIdsForAccountDeletion(ownerUserId: string) {
  // Account deletion is a privacy boundary, not an ordinary indexed read.
  // Verify every object prefix, while keeping a separate set of durable
  // owner-linked IDs so an unrelated unattributed prefix cannot block every
  // account in the bucket.
  const objectPrefixes = await objectStore.listTopLevelPrefixes();
  await ensureMeetingCatalogBackfilled();
  const [catalogIds, transferIds, deletionIds] = await Promise.all([
    listMeetingCatalogIdsForOwnerDeletion(ownerUserId),
    listMeetingObjectTransferIdsForOwner(ownerUserId),
    listMeetingDeletionIdsForOwner(ownerUserId),
  ]);
  const catalogMeetingIds = new Set(catalogIds ?? []);
  const ownerLinkedMeetingIds = new Set([
    ...catalogMeetingIds,
    ...transferIds,
    ...deletionIds,
  ]);
  return {
    catalogMeetingIds,
    discoveredMeetingIds: [...new Set([...objectPrefixes, ...ownerLinkedMeetingIds])],
    objectPrefixes,
    ownerLinkedMeetingIds,
  };
}

async function discoverAllMeetingIds() {
  if (await ensureMeetingCatalogBackfilled()) {
    const catalogIds = await listAllMeetingCatalogIds();
    if (catalogIds) return catalogIds;
  }
  return (await objectStore.listTopLevelPrefixes()).filter(isCanonicalMeetingId);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, Math.max(1, Math.round(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

export async function saveMeetingAudioChunk(input: {
  meetingId: string;
  ownerUserId: string;
  sequence: number;
  buffer: Buffer;
  mimeType: string;
  recordedAt: number;
  durationMs: number;
  recordingConsent?: RecordingConsentMetadata;
}) {
  return withUserWriteLock(input.ownerUserId, async () => {
    if (!(await getUserById(input.ownerUserId))) {
      throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
    }
    return enqueueMeetingWrite(input.meetingId, () => saveMeetingAudioChunkUnsafe(input));
  });
}

async function saveMeetingAudioChunkUnsafe(input: {
  meetingId: string;
  ownerUserId: string;
  sequence: number;
  buffer: Buffer;
  mimeType: string;
  recordedAt: number;
  durationMs: number;
  recordingConsent?: RecordingConsentMetadata;
}) {
  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  return saveMeetingAudioObjectUnsafe({
    bytes: input.buffer.byteLength,
    durationMs: input.durationMs,
    meetingId: input.meetingId,
    mimeType: input.mimeType,
    ownerUserId: input.ownerUserId,
    persist: (key) => objectStore.putBuffer(key, input.buffer),
    recordedAt: input.recordedAt,
    sequence: input.sequence,
    sha256,
    recordingConsent: input.recordingConsent,
  });
}

async function publishPreparedRecordingCommitUnsafe(input: {
  bytes: number;
  durationMs: number;
  meetingId: string;
  mimeType: string;
  ownerUserId: string;
  recordedAt: number;
  sequence: number;
  sha256: string;
  uploadId: string;
  recordingConsent: RecordingConsentMetadata;
}) {
  const meetingKey = sanitizeSegment(input.meetingId);
  const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
  const manifest = await readManifest(manifestKey, input.meetingId);
  if (manifest.ownerUserId && manifest.ownerUserId !== input.ownerUserId) {
    throw new MeetingAccessError("This meeting belongs to another user.", 403);
  }
  assertAndSetRecordingConsent(manifest, input.recordingConsent);
  const fileName = `chunk-${String(input.sequence).padStart(6, "0")}${extensionForMimeType(input.mimeType)}`;
  const existing = manifest.chunks.find((chunk) => chunk.sequence === input.sequence);
  if (existing?.sha256 && existing.sha256 !== input.sha256) {
    throw new MeetingAccessError("同一录音分片序号已保存了不同内容，请保留本地录音并重新同步整场会议。", 409, {
      code: "audio_chunk_content_conflict",
      retryable: false,
    });
  }
  const receivedAt = existing?.receivedAt || new Date().toISOString();
  if (!existing) {
    manifest.chunks.push({
      sequence: input.sequence,
      fileName,
      bytes: input.bytes,
      mimeType: input.mimeType,
      recordedAt: input.recordedAt,
      durationMs: input.durationMs,
      receivedAt,
      sha256: input.sha256,
    });
    manifest.chunks.sort((left, right) => left.sequence - right.sequence);
  } else if (!existing.sha256) {
    existing.sha256 = input.sha256;
  }
  manifest.ownerUserId = input.ownerUserId;
  manifest.totalBytes = manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  manifest.reviewConfirmation = undefined;
  revokeMeetingShare(manifest);
  if (manifest.recordingUpload?.uploadId === input.uploadId) delete manifest.recordingUpload;
  const audioRevision = deriveMeetingAudioRevision(manifest);
  manifest.audioSeal = {
    audioRevision,
    lastSequence: input.sequence,
    totalBytes: manifest.totalBytes,
    sealedAt: new Date().toISOString(),
  };
  manifest.updatedAt = manifest.audioSeal.sealedAt;
  await persistMeetingManifest(manifestKey, manifest);
  return {
    audioSeal: manifest.audioSeal,
    saved: {
      savedBytes: existing?.bytes ?? input.bytes,
      totalChunks: manifest.chunks.length,
      totalBytes: manifest.totalBytes,
      receivedAt,
      idempotent: Boolean(existing),
    },
  };
}

async function saveMeetingAudioObjectUnsafe(input: {
  bytes: number;
  durationMs: number;
  meetingId: string;
  mimeType: string;
  ownerUserId: string;
  persist: (key: string) => Promise<void>;
  recordedAt: number;
  sequence: number;
  sha256: string;
  recordingConsent?: RecordingConsentMetadata;
}) {
  if (!(await isMeetingWriteAllowed(input.meetingId))) {
    throw new MeetingAccessError("This meeting was deleted and cannot accept more audio.", 410);
  }
  const meetingKey = sanitizeSegment(input.meetingId);
  const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
  const fileName = `chunk-${String(input.sequence).padStart(6, "0")}${extensionForMimeType(input.mimeType)}`;
  const manifest = await readManifest(manifestKey, input.meetingId);
  if (manifest.ownerUserId && manifest.ownerUserId !== input.ownerUserId) {
    throw new MeetingAccessError("This meeting belongs to another user.", 403);
  }

  const ownerClaimRequired = !manifest.ownerUserId;
  manifest.ownerUserId = input.ownerUserId;
  assertAndSetRecordingConsent(
    manifest,
    input.recordingConsent ?? { consentMethod: "legacy_unknown" },
  );
  if (ownerClaimRequired) {
    // Claim ownership durably before the first chunk object can exist. A crash
    // between chunk PUT and the former manifest-last commit otherwise leaves a
    // canonical prefix that account deletion cannot safely attribute.
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
  }
  const existingIndex = manifest.chunks.findIndex((chunk) => chunk.sequence === input.sequence);
  if (existingIndex >= 0) {
    const existing = manifest.chunks[existingIndex];
    const existingSha256 = existing.sha256 || crypto.createHash("sha256")
      .update(await objectStore.getBuffer(buildMeetingObjectKey(meetingKey, "chunk", existing.fileName)))
      .digest("hex");
    if (existingSha256 !== input.sha256) {
      throw new MeetingAccessError("同一录音分片序号已保存了不同内容，请保留本地录音并重新同步整场会议。", 409, {
        code: "audio_chunk_content_conflict",
        retryable: false,
      });
    }
    // A same-content retry is also our repair path when the manifest survived
    // but the backing object was lost or a previous storage write was rolled
    // back. Rewriting the identical object keeps the audio revision stable.
    await input.persist(buildMeetingObjectKey(meetingKey, "chunk", existing.fileName));
    await upsertMeetingCatalog(meetingCatalogProjection(manifest));
    await resolveMeetingCatalogBackfillBlocker(meetingKey);
    return {
      savedBytes: existing.bytes,
      totalChunks: manifest.chunks.length,
      totalBytes: manifest.totalBytes,
      receivedAt: existing.receivedAt,
      idempotent: true,
    };
  }

  const receivedAt = new Date().toISOString();
  await input.persist(buildMeetingObjectKey(meetingKey, "chunk", fileName));

  const nextChunk = {
    sequence: input.sequence,
    fileName,
    bytes: input.bytes,
    mimeType: input.mimeType,
    recordedAt: input.recordedAt,
    durationMs: input.durationMs,
    receivedAt,
    sha256: input.sha256,
  };

  manifest.chunks.push(nextChunk);

  manifest.chunks.sort((left, right) => left.sequence - right.sequence);
  manifest.totalBytes = manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  manifest.audioSeal = undefined;
  manifest.reviewConfirmation = undefined;
  revokeMeetingShare(manifest);
  manifest.updatedAt = receivedAt;

  await persistMeetingManifest(manifestKey, manifest);

  return {
    savedBytes: input.bytes,
    totalChunks: manifest.chunks.length,
    totalBytes: manifest.totalBytes,
    receivedAt,
    idempotent: false,
  };
}

async function calculateFileSha256(filePath: string) {
  const hash = crypto.createHash("sha256");
  for await (const part of createReadStream(filePath)) hash.update(part);
  return hash.digest("hex");
}

export async function readMeetingRecordingUploadStatus(input: { meetingId: string; ownerUserId: string; uploadId: string }) {
  const state = await withUserWriteLock(
    input.ownerUserId,
    () => enqueueMeetingWrite(input.meetingId, () => readMeetingRecordingUploadStatusUnsafe(input)),
  );
  if ("staleCleanupUploadId" in state && state.staleCleanupUploadId) {
    await deleteRecordingUploadStaging(input.meetingId, state.staleCleanupUploadId).catch(() => {
      console.error("Stale recording upload cleanup failed after status projection was released.");
    });
  }
  return state;
}

export async function sealMeetingAudio(input: {
  meetingId: string;
  ownerUserId: string;
  expectedLastSequence: number;
  totalBytes: number;
}) {
  return withUserWriteLock(input.ownerUserId, async () => {
    if (!(await getUserById(input.ownerUserId))) {
      throw new MeetingAccessError("This account was deleted and cannot seal audio.", 410);
    }
    return enqueueMeetingWrite(input.meetingId, () => sealMeetingAudioUnsafe(input));
  });
}

async function sealMeetingAudioUnsafe(input: {
  meetingId: string;
  ownerUserId: string;
  expectedLastSequence: number;
  totalBytes: number;
}) {
  if (!Number.isInteger(input.expectedLastSequence) || input.expectedLastSequence <= 0) {
    throw new MeetingAccessError("录音结束序号无效，请完成本地同步后重试。", 400, { code: "invalid_audio_seal" });
  }
  if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes <= 0) {
    throw new MeetingAccessError("录音总字节数无效，请完成本地同步后重试。", 400, { code: "invalid_audio_seal" });
  }
  const meetingKey = sanitizeSegment(input.meetingId);
  const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
  const manifest = await readManifest(manifestKey, input.meetingId);
  if (!manifest.ownerUserId || manifest.ownerUserId !== input.ownerUserId) {
    throw new MeetingAccessError("You do not have access to this meeting.", 403);
  }
  const completeSequence =
    manifest.chunks.length === input.expectedLastSequence &&
    manifest.chunks.every((chunk, index) => chunk.sequence === index + 1);
  if (!completeSequence || manifest.totalBytes !== input.totalBytes) {
    throw new MeetingAccessError("录音仍有分片尚未同步，已保留本地录音，请同步完整后再生成纪要。", 409, {
      code: "meeting_audio_incomplete",
      retryable: true,
    });
  }
  await backfillManifestChunkDigests(manifest, meetingKey);
  const audioRevision = deriveMeetingAudioRevision(manifest);
  if (
    manifest.audioSeal?.audioRevision === audioRevision &&
    manifest.audioSeal.lastSequence === input.expectedLastSequence &&
    manifest.audioSeal.totalBytes === input.totalBytes
  ) {
    return manifest.audioSeal;
  }
  manifest.audioSeal = {
    audioRevision,
    lastSequence: input.expectedLastSequence,
    totalBytes: input.totalBytes,
    sealedAt: new Date().toISOString(),
  };
  manifest.updatedAt = manifest.audioSeal.sealedAt;
  await persistMeetingManifest(manifestKey, manifest);
  return manifest.audioSeal;
}

async function backfillManifestChunkDigests(manifest: AudioManifest, meetingKey: string) {
  const missing = manifest.chunks.filter((chunk) => !chunk.sha256);
  if (missing.length === 0) return;
  const directory = await mkdtemp(join(tmpdir(), "ownminutes-seal-digest-"));
  try {
    for (const [index, chunk] of missing.entries()) {
      const filePath = join(directory, `chunk-${index}.audio`);
      const downloadedBytes = await objectStore.getFile(buildMeetingObjectKey(meetingKey, "chunk", chunk.fileName), filePath);
      if (downloadedBytes !== chunk.bytes) throw new Error("Stored meeting audio length does not match its manifest.");
      chunk.sha256 = await calculateFileSha256(filePath);
      await rm(filePath, { force: true });
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function saveMeetingRecordingUploadPart(input: {
  buffer: Buffer;
  meetingId: string;
  metadata: RecordingUploadMetadata;
  ownerUserId: string;
  partIndex: number;
  sha256: string;
}) {
  const manifestKey = buildMeetingObjectKey(sanitizeSegment(input.meetingId), "manifest");
  const validateShortPhase = () => withUserWriteLock(input.ownerUserId, async () => {
    if (!(await getUserById(input.ownerUserId))) {
      throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
    }
    const observedManifest = await readExistingManifest(manifestKey, input.meetingId);
    const observedUpload =
      observedManifest?.ownerUserId === input.ownerUserId
        ? observedManifest.recordingUpload
        : undefined;
    const needsNewLeaseBudget =
      !observedUpload ||
      observedUpload.uploadId === input.metadata.uploadId &&
        isRecordingUploadStale(observedUpload.updatedAt);
    // Measure and reserve under the same per-user lock. Without the manifest
    // lease written below, concurrent first parts can all observe the same
    // budget and exceed the account limit before any upload publishes.
    const usage = needsNewLeaseBudget
      ? await sweepAndMeasureRecordingUploads(input.ownerUserId)
      : null;
    return withMeetingWriteFence(input.meetingId, async () => {
      const manifest = await readManifest(manifestKey, input.meetingId);
      if (manifest.ownerUserId && manifest.ownerUserId !== input.ownerUserId) {
        throw new MeetingAccessError("This meeting belongs to another user.", 403);
      }
      if (manifest.recordingUpload && manifest.recordingUpload.uploadId !== input.metadata.uploadId) {
        throw new RecordingUploadConflictError(
          "RECORDING_UPLOAD_ALREADY_ACTIVE",
          "该会议已有录音正在同步，请等待完成或稍后重试。",
          409,
        );
      }
      assertRecordingUploadBudget(usage, input);
      const leaseCreated = !manifest.recordingUpload;
      if (leaseCreated) {
        const updatedAt = new Date().toISOString();
        manifest.ownerUserId = input.ownerUserId;
        manifest.recordingUpload = {
          stagedBytes: 0,
          totalBytes: input.metadata.totalBytes,
          updatedAt,
          uploadId: input.metadata.uploadId,
        };
        manifest.updatedAt = updatedAt;
        await persistMeetingManifest(manifestKey, manifest);
      }
      const transferIntentId = await beginMeetingObjectTransferIntent({
        meetingId: input.meetingId,
        ownerUserId: input.ownerUserId,
        transferKind: "recording_staging",
      });
      return { leaseCreated, transferIntentId };
    });
  });

  const { transferIntentId } = await validateShortPhase();
  try {
    const result: Awaited<ReturnType<typeof putRecordingUploadPart>> = await withRecordingUploadLock(
      input.meetingId,
      input.metadata.uploadId,
      () => putRecordingUploadPart(input),
    );
    return await withUserWriteLock(input.ownerUserId, async () => {
      if (!(await getUserById(input.ownerUserId))) {
        throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
      }
      return withMeetingWriteFence(input.meetingId, async () => {
        const manifest = await readManifest(manifestKey, input.meetingId);
        if (manifest.ownerUserId && manifest.ownerUserId !== input.ownerUserId) {
          throw new MeetingAccessError("This meeting belongs to another user.", 403);
        }
        if (manifest.recordingUpload && manifest.recordingUpload.uploadId !== input.metadata.uploadId) {
          throw new RecordingUploadConflictError(
            "RECORDING_UPLOAD_ALREADY_ACTIVE",
            "该会议已有另一段录音正在同步。",
            409,
          );
        }
        await claimMeetingOwner(input.meetingId, input.ownerUserId);
        manifest.ownerUserId = input.ownerUserId;
        if (!result.committed) {
          const updatedAt = new Date().toISOString();
          manifest.recordingUpload = {
            stagedBytes: result.stagedBytes,
            totalBytes: input.metadata.totalBytes,
            updatedAt,
            uploadId: input.metadata.uploadId,
          };
          manifest.updatedAt = updatedAt;
          await persistMeetingManifest(manifestKey, manifest);
        }
        await completeMeetingObjectTransferIntent({
          intentId: transferIntentId,
          meetingId: input.meetingId,
          ownerUserId: input.ownerUserId,
        });
        return result;
      });
    });
  } catch (error) {
    if (isMeetingDeletionTransferError(error)) {
      await scheduleLateMeetingDeletionCleanup(
        input.meetingId,
        input.ownerUserId,
        "Late recording upload part requires deletion cleanup.",
      );
    }
    await completeTransferIntentAfterSettledFailure({
      error,
      intentId: transferIntentId,
      meetingId: input.meetingId,
      ownerUserId: input.ownerUserId,
    });
    throw error;
  }
}

function assertRecordingUploadBudget(
  usage: Awaited<ReturnType<typeof sweepAndMeasureRecordingUploads>> | null,
  input: { meetingId: string; metadata: RecordingUploadMetadata },
) {
  if (!usage) return;
  const usageKey = recordingUploadUsageKey(input.meetingId, input.metadata.uploadId);
  const countedReservedBytes = usage.uploads.get(usageKey) ?? 0;
  const projectedActiveUploads = usage.uploads.size + (usage.uploads.has(usageKey) ? 0 : 1);
  const projectedReservedBytes = usage.reservedBytes - countedReservedBytes + input.metadata.totalBytes;
  const policy = getRecordingUploadResourcePolicy();
  const violation = recordingUploadResourceViolation(
    { activeUploads: projectedActiveUploads, stagedBytes: projectedReservedBytes },
    policy,
  );
  if (violation === "active-upload-limit") {
    throw new RecordingUploadConflictError(
      "RECORDING_UPLOAD_ACTIVE_LIMIT",
      `当前账号已有 ${policy.maxActiveUploadsPerUser} 场录音等待同步，请先完成已有上传。`,
      429,
      60,
    );
  }
  if (violation === "staged-bytes-limit") {
    throw new RecordingUploadConflictError(
      "RECORDING_UPLOAD_STORAGE_LIMIT",
      "当前账号等待同步的录音较多，请先完成已有上传。本地录音仍会保留。",
      429,
      60,
    );
  }
}

export async function commitMeetingRecordingUpload(input: { meetingId: string; ownerUserId: string; uploadId: string }) {
  const shortPreflight = () => withUserWriteLock(input.ownerUserId, async () => {
    if (!(await getUserById(input.ownerUserId))) {
      throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
    }
    return withMeetingWriteFence(input.meetingId, async () => {
      await claimMeetingOwner(input.meetingId, input.ownerUserId);
      const state = await readRecordingUploadState(input.meetingId, input.uploadId);
      const stateOwner = state.receipt?.ownerUserId ?? state.manifest?.ownerUserId;
      if (stateOwner && stateOwner !== input.ownerUserId) {
        throw new MeetingAccessError("This meeting belongs to another user.", 403);
      }
      if (state.receipt) {
        const receipt = await sealCommittedRecordingUploadReceiptUnsafe({
          meetingId: input.meetingId,
          ownerUserId: input.ownerUserId,
          receipt: state.receipt,
        });
        await clearRecordingUploadLease(input.meetingId, input.uploadId);
        return { receipt } as const;
      }
      return { receipt: null } as const;
    });
  });

  const preflight = await shortPreflight();
  if (preflight.receipt) return preflight.receipt;

  const assembled = await withRecordingUploadLock(input.meetingId, input.uploadId, () => assembleRecordingUpload(input));
  if (assembled.alreadyCommitted) {
    return withUserWriteLock(input.ownerUserId, async () => {
      if (!(await getUserById(input.ownerUserId))) throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
      return withMeetingWriteFence(input.meetingId, async () => {
        const receipt = await sealCommittedRecordingUploadReceiptUnsafe({
          meetingId: input.meetingId,
          ownerUserId: input.ownerUserId,
          receipt: assembled.receipt,
        });
        await clearRecordingUploadLease(input.meetingId, input.uploadId);
        return receipt;
      });
    });
  }

  let transferIntentId: string | null = null;
  try {
    const durationMs = await probeAudioFileDurationMs(assembled.filePath);
    validateFullRecordingDuration(durationMs);
    const sha256 = await calculateFileSha256(assembled.filePath);
    const finalFileName = `chunk-${String(1).padStart(6, "0")}${extensionForMimeType(assembled.manifest.mimeType)}`;
    const finalObjectKey = buildMeetingObjectKey(sanitizeSegment(input.meetingId), "chunk", finalFileName);
    transferIntentId = await withUserWriteLock(input.ownerUserId, async () => {
      if (!(await getUserById(input.ownerUserId))) {
        throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
      }
      return withMeetingWriteFence(input.meetingId, () =>
        beginMeetingObjectTransferIntent({
          meetingId: input.meetingId,
          ownerUserId: input.ownerUserId,
          transferKind: "recording_commit",
        }),
      );
    });
    // Large canonical audio PUT remains lock-free, while the durable intent
    // keeps deletion pending until publication has passed its postflight.
    await objectStore.putFile(finalObjectKey, assembled.filePath);

    const published = await withUserWriteLock(input.ownerUserId, async () => {
      if (!(await getUserById(input.ownerUserId))) {
        throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
      }
      return withMeetingWriteFence(input.meetingId, async () => {
        const currentUpload = await readRecordingUploadState(input.meetingId, input.uploadId);
        if (!currentUpload.manifest && !currentUpload.receipt) {
          throw new RecordingUploadConflictError("RECORDING_UPLOAD_NOT_FOUND", "录音上传已失效，请从本地录音重新同步。", 409);
        }
        return publishPreparedRecordingCommitUnsafe({
          bytes: assembled.manifest.totalBytes,
          durationMs,
          meetingId: input.meetingId,
          mimeType: assembled.manifest.mimeType,
          ownerUserId: input.ownerUserId,
          recordedAt: assembled.manifest.recordedAt,
          sequence: 1,
          sha256,
          uploadId: input.uploadId,
          recordingConsent: normalizeStoredRecordingConsentMetadata(assembled.manifest),
        });
      });
    });
    const receipt = await finalizeRecordingUpload({
      cleanupStaging: false,
      meetingId: input.meetingId,
      metadata: assembled.manifest,
      ownerUserId: input.ownerUserId,
      uploadId: input.uploadId,
      receipt: {
        ...published.saved,
        assemblyMaxBufferedBytes: assembled.maxBufferedBytes,
        assemblyMethod: "bounded-temp-file",
        audioRevision: published.audioSeal.audioRevision,
        durationMs,
        sealed: true,
      },
    });
    // Receipt PUT is intentionally lock-free. Recheck after it; if deletion
    // won, the catch reopens durable prefix cleanup so the late object cannot
    // survive a cleanup that completed moments earlier.
    await withUserWriteLock(input.ownerUserId, async () => {
      if (!(await getUserById(input.ownerUserId))) {
        throw new MeetingAccessError("This account was deleted and cannot accept more audio.", 410);
      }
      await withMeetingWriteFence(input.meetingId, async () => {
        const manifest = await readManifest(buildMeetingObjectKey(sanitizeSegment(input.meetingId), "manifest"), input.meetingId);
        const audio = meetingAudioMetadataFromManifest(manifest, input.meetingId);
        if (audio.audioRevision !== published.audioSeal.audioRevision) {
          throw new MeetingAccessError("Meeting audio changed before upload commit publication completed.", 409, {
            code: "audio_revision_changed",
            retryable: true,
          });
        }
        await completeMeetingObjectTransferIntent({
          intentId: transferIntentId,
          meetingId: input.meetingId,
          ownerUserId: input.ownerUserId,
        });
      });
    });
    await deleteRecordingUploadStaging(input.meetingId, input.uploadId).catch(() => {
      console.error("Committed recording upload staging cleanup failed; durable receipt retained.");
    });
    return receipt;
  } catch (error) {
    if (isMeetingDeletionTransferError(error)) {
      await scheduleLateMeetingDeletionCleanup(
        input.meetingId,
        input.ownerUserId,
        "Late recording commit object requires deletion cleanup.",
      );
    }
    await completeTransferIntentAfterSettledFailure({
      error,
      intentId: transferIntentId,
      meetingId: input.meetingId,
      ownerUserId: input.ownerUserId,
    });
    throw error;
  } finally {
    await assembled.cleanup().catch(() => console.error("Temporary recording assembly cleanup failed."));
  }
}

async function readMeetingRecordingUploadStatusUnsafe(input: { meetingId: string; ownerUserId: string; uploadId: string }) {
  const manifestKey = buildMeetingObjectKey(sanitizeSegment(input.meetingId), "manifest");
  const manifest = await readExistingManifest(manifestKey, input.meetingId);
  if (manifest?.ownerUserId && manifest.ownerUserId !== input.ownerUserId) {
    throw new MeetingAccessError("This meeting belongs to another user.", 403);
  }

  const state = await readRecordingUploadState(input.meetingId, input.uploadId);
  const owner = state.receipt?.ownerUserId ?? state.manifest?.ownerUserId;
  if (owner && owner !== input.ownerUserId) throw new MeetingAccessError("This meeting belongs to another user.", 403);
  if (!manifest) return state;

  if (state.receipt) {
    if (manifest.recordingUpload?.uploadId === input.uploadId) {
      delete manifest.recordingUpload;
      manifest.updatedAt = new Date().toISOString();
      await persistMeetingManifest(manifestKey, manifest);
    }
    const receipt = await sealCommittedRecordingUploadReceiptUnsafe({
      meetingId: input.meetingId,
      ownerUserId: input.ownerUserId,
      receipt: state.receipt,
    });
    return {
      ...state,
      receipt,
    };
  }

  if (!state.manifest) {
    if (manifest.recordingUpload?.uploadId === input.uploadId) {
      delete manifest.recordingUpload;
      manifest.updatedAt = new Date().toISOString();
      await persistMeetingManifest(manifestKey, manifest);
    }
    return state;
  }

  if (manifest.recordingUpload && manifest.recordingUpload.uploadId !== input.uploadId) {
    throw new RecordingUploadConflictError(
      "RECORDING_UPLOAD_ALREADY_ACTIVE",
      "该会议已有另一段录音正在同步，请先完成当前上传。",
    );
  }

  const updatedAt = manifest.recordingUpload?.updatedAt ?? state.manifest.updatedAt;
  if (isRecordingUploadStale(updatedAt)) {
    if (manifest.recordingUpload?.uploadId === input.uploadId) delete manifest.recordingUpload;
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
    // GET status may repair the small manifest projection, but it must never
    // hold the writer fence across a physical S3 prefix delete. A later
    // resource sweep removes the now-unreferenced staging prefix lock-free.
    return {
      committed: false,
      exists: false,
      manifest: null,
      receipt: null,
      receivedParts: [],
      staleCleanupUploadId: input.uploadId,
    };
  }

  const stagedBytes = recordingUploadStagedBytes(state.manifest);
  if (
    !manifest.recordingUpload ||
    manifest.recordingUpload.stagedBytes !== stagedBytes ||
    manifest.recordingUpload.totalBytes !== state.manifest.totalBytes
  ) {
    manifest.recordingUpload = {
      stagedBytes,
      totalBytes: state.manifest.totalBytes,
      updatedAt,
      uploadId: input.uploadId,
    };
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
  }
  return state;
}

async function sealCommittedRecordingUploadReceiptUnsafe(input: {
  meetingId: string;
  ownerUserId: string;
  receipt: RecordingUploadReceipt;
}): Promise<RecordingUploadReceipt> {
  const audioSeal = await sealMeetingAudioUnsafe({
    meetingId: input.meetingId,
    ownerUserId: input.ownerUserId,
    expectedLastSequence: input.receipt.totalChunks,
    totalBytes: input.receipt.totalBytes,
  });
  return {
    ...input.receipt,
    audioRevision: audioSeal.audioRevision,
    sealed: true,
  };
}

async function sweepAndMeasureRecordingUploads(ownerUserId: string) {
  const policy = getRecordingUploadResourcePolicy();
  const uploads = new Map<string, number>();
  const meetingIds = await discoverMeetingIdsForOwner(ownerUserId);

  for (const meetingId of meetingIds) {
    const manifest = await readExistingManifest(buildMeetingObjectKey(meetingId, "manifest"), meetingId);
    const activeUpload = manifest?.recordingUpload;
    if (!activeUpload) continue;
    if (!isRecordingUploadStale(activeUpload.updatedAt, policy)) {
      if (manifest?.ownerUserId === ownerUserId) {
        uploads.set(recordingUploadUsageKey(meetingId, activeUpload.uploadId), activeUpload.totalBytes);
      }
      continue;
    }

    const staleUploadId = await enqueueMeetingWrite(meetingId, async () => {
      const current = await readExistingManifest(buildMeetingObjectKey(meetingId, "manifest"), meetingId);
      const currentUpload = current?.recordingUpload;
      if (!current || !currentUpload || !isRecordingUploadStale(currentUpload.updatedAt, policy)) return "";
      delete current.recordingUpload;
      current.updatedAt = new Date().toISOString();
      await persistMeetingManifest(buildMeetingObjectKey(meetingId, "manifest"), current);
      return currentUpload.uploadId;
    });
    if (staleUploadId) {
      // Physical staging deletion is bounded but remains outside the meeting
      // fence so a user-initiated meeting deletion never waits on stale data.
      await deleteRecordingUploadStaging(meetingId, staleUploadId).catch(() => {
        console.error("Stale recording upload cleanup failed; a later sweep will retry.");
      });
    }
  }

  return {
    reservedBytes: [...uploads.values()].reduce((sum, bytes) => sum + bytes, 0),
    uploads,
  };
}

async function clearRecordingUploadLease(meetingId: string, uploadId: string) {
  const manifestKey = buildMeetingObjectKey(sanitizeSegment(meetingId), "manifest");
  const manifest = await readExistingManifest(manifestKey, meetingId);
  if (!manifest || manifest.recordingUpload?.uploadId !== uploadId) return;
  delete manifest.recordingUpload;
  manifest.updatedAt = new Date().toISOString();
  await persistMeetingManifest(manifestKey, manifest);
}

function recordingUploadUsageKey(meetingId: string, uploadId: string) {
  return `${sanitizeSegment(meetingId)}\u0000${uploadId}`;
}

async function claimMeetingOwner(meetingId: string, ownerUserId: string) {
  if (!(await isMeetingWriteAllowed(meetingId))) throw new MeetingAccessError("This meeting was deleted and cannot accept more audio.", 410);
  const meetingKey = sanitizeSegment(meetingId);
  const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
  const manifest = await readManifest(manifestKey, meetingId);
  if (manifest.ownerUserId && manifest.ownerUserId !== ownerUserId) throw new MeetingAccessError("This meeting belongs to another user.", 403);
  if (!manifest.ownerUserId) {
    manifest.ownerUserId = ownerUserId;
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
  }
}

function extensionForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("webm")) return ".webm";
  if (normalized.includes("ogg") || normalized.includes("opus")) return ".ogg";
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) return ".m4a";
  return ".webm";
}

async function enqueueMeetingWrite<T>(meetingId: string, operation: () => Promise<T>) {
  const key = sanitizeSegment(meetingId);
  return withMeetingWriteFence(key, () => operation());
}

async function enqueueMeetingAccess<T>(meetingId: string, operation: () => Promise<T>) {
  const key = sanitizeSegment(meetingId);
  return withMeetingWriteLock(key, operation);
}

export type PreparedMeetingAsrAudio = {
  audioUrl?: string;
  buffer?: Buffer;
  cleanup(): Promise<void>;
  delivery: "private-presigned-url" | "local-buffer-fallback";
  durationMs: number;
  fileName: string;
  mimeType: string;
  transcoded: boolean;
};

type PreparedMeetingAsrPayload = Omit<PreparedMeetingAsrAudio, "cleanup">;

export type PreparedMeetingAudioSnapshot = {
  audioRevision: string;
  audioSha256: string;
  cleanup(): Promise<void>;
  durationMs: number;
  fileName: string;
  mimeType: string;
  prepareForAsr(): Promise<PreparedMeetingAsrPayload>;
};

export async function prepareMeetingAudioSnapshot(meetingId: string): Promise<PreparedMeetingAudioSnapshot> {
  const meetingKey = sanitizeSegment(meetingId);
  const snapshotInput = await withMeetingWriteFence(meetingKey, async () => {
    const manifest = await readManifest(buildMeetingObjectKey(meetingKey, "manifest"), meetingId);
    if (manifest.chunks.length === 0) throw new Error("No audio chunks found for this meeting.");
    const audioMetadata = meetingAudioMetadataFromManifest(manifest, meetingId);
    if (!audioMetadata.sealed) {
      throw new MeetingAccessError("录音尚未完成完整性确认，已保留本地录音，请同步完成后重试。", 409, {
        code: "meeting_audio_not_sealed",
        retryable: true,
      });
    }
    return {
      audioRevision: audioMetadata.audioRevision,
      firstChunk: manifest.chunks[0],
      // A detached immutable view is deliberately carried outside the fence.
      // Chunk downloads, ffprobe/ffmpeg and transient PUT may take minutes and
      // must never prevent logical deletion from winning promptly.
      manifest: structuredClone(manifest),
    };
  });
  const { audioRevision, firstChunk, manifest } = snapshotInput;
  const ownerUserId = manifest.ownerUserId;
  const directory = await mkdtemp(join(tmpdir(), "ownminutes-audio-snapshot-"));
  const assembledPath = join(directory, `recording${extensionForMimeType(firstChunk.mimeType)}`);
  let transientKey = "";
  let transientPrefix = "";
  let transientTransferIntentId: string | null = null;
  let cleanupComplete = false;
  let cleanupInFlight: Promise<void> | null = null;
  let cleanupRequested = false;
  let preparedPayload: PreparedMeetingAsrPayload | null = null;
  let lifecycleTail: Promise<void> = Promise.resolve();

  const enqueueLifecycle = <T>(operation: () => Promise<T>) => {
    const next = lifecycleTail.then(operation, operation);
    lifecycleTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const deleteTransientUnsafe = async () => {
    if (!transientPrefix) return;
    const deletingPrefix = transientPrefix;
    try {
      await objectStore.deletePrefix(deletingPrefix);
      if (transientTransferIntentId) {
        if (!ownerUserId) throw new Error("ASR transfer intent lost its meeting owner.");
        await completeMeetingObjectTransferIntent({
          intentId: transientTransferIntentId,
          meetingId: meetingKey,
          ownerUserId,
        });
      }
      transientTransferIntentId = null;
      if (transientPrefix === deletingPrefix) {
        transientPrefix = "";
        transientKey = "";
      }
    } catch (error) {
      if (!(await isMeetingWriteAllowed(meetingKey))) {
        await scheduleLateMeetingDeletionCleanup(
          meetingKey,
          ownerUserId,
          "Late ASR transient cleanup failed after meeting deletion.",
        );
      }
      throw error;
    }
  };

  const cleanup = () => {
    cleanupRequested = true;
    if (cleanupComplete) return Promise.resolve();
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = enqueueLifecycle(async () => {
      let deletionError: unknown;
      try {
        await deleteTransientUnsafe();
      } catch (error) {
        deletionError = error;
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
      if (deletionError) throw deletionError;
      cleanupComplete = true;
    }).finally(() => {
      cleanupInFlight = null;
    });
    return cleanupInFlight;
  };

  const assertRevisionCurrent = () => withMeetingWriteFence(meetingKey, async () => {
    const current = await readManifest(buildMeetingObjectKey(meetingKey, "manifest"), meetingId);
    const currentAudio = meetingAudioMetadataFromManifest(current, meetingId);
    if (currentAudio.audioRevision !== audioRevision) {
      throw new MeetingAccessError("Meeting audio changed while its processing snapshot was prepared.", 409, {
        code: "audio_revision_changed",
        retryable: true,
      });
    }
  });

  const beginAsrTransientTransfer = () => withMeetingWriteFence(meetingKey, async () => {
    const current = await readManifest(buildMeetingObjectKey(meetingKey, "manifest"), meetingId);
    const currentAudio = meetingAudioMetadataFromManifest(current, meetingId);
    if (currentAudio.audioRevision !== audioRevision) {
      throw new MeetingAccessError("Meeting audio changed while its processing snapshot was prepared.", 409, {
        code: "audio_revision_changed",
        retryable: true,
      });
    }
    if (!ownerUserId) {
      throw new MeetingAccessError("Meeting owner is required for private ASR transfer.", 409, {
        code: "meeting_owner_required",
        retryable: false,
      });
    }
    return beginMeetingObjectTransferIntent({
      meetingId: meetingKey,
      ownerUserId,
      transferKind: "asr_transient",
    });
  });

  try {
    const assembled = await assembleMeetingAudioFile({ assembledPath, directory, manifest, meetingKey });
    const durationMs = await probeAudioFileDurationMs(assembledPath);
    validateFullRecordingDuration(durationMs);
    await assertRevisionCurrent();

    const prepareForAsr = () => enqueueLifecycle(async () => {
      if (cleanupRequested) throw new Error("Meeting audio snapshot has already been cleaned up.");
      if (preparedPayload) return preparedPayload;
      try {
        const normalized = await normalizeAudioFileForVolcanoAsr({
          fileName: firstChunk.fileName,
          filePath: assembledPath,
          mimeType: firstChunk.mimeType,
        });
        if (cleanupRequested) throw new Error("Meeting audio snapshot has already been cleaned up.");
        const shared = {
          durationMs,
          fileName: normalized.fileName,
          mimeType: normalized.mimeType,
          transcoded: normalized.transcoded,
        };

        if (getMeetingObjectStoreInfo().supportsPresignedGet) {
          const extension = extensionForMimeType(normalized.mimeType);
          transientPrefix = buildMeetingObjectKey(meetingKey, "asrInput", crypto.randomUUID());
          transientKey = `${transientPrefix}/recording${extension}`;
          transientTransferIntentId = await beginAsrTransientTransfer();
          await objectStore.putFile(transientKey, normalized.filePath);
          if (cleanupRequested) {
            await deleteTransientUnsafe();
            throw new Error("Meeting audio snapshot has already been cleaned up.");
          }
          await assertRevisionCurrent();
          const audioUrl = await objectStore.createPresignedGetUrl(transientKey, getAsrAudioUrlTtlSeconds());
          if (!audioUrl) throw new Error("Remote meeting object storage could not create a private ASR input URL.");
          if (isProviderAccessibleAsrAudioUrl(audioUrl)) {
            preparedPayload = { ...shared, audioUrl, delivery: "private-presigned-url" as const };
            return preparedPayload;
          }
          await deleteTransientUnsafe();
        }

        const buffer = await readFile(normalized.filePath);
        await assertRevisionCurrent();
        preparedPayload = {
          ...shared,
          buffer,
          delivery: "local-buffer-fallback" as const,
        };
        if (cleanupRequested) throw new Error("Meeting audio snapshot has already been cleaned up.");
        return preparedPayload;
      } catch (error) {
        if (isMeetingDeletionTransferError(error)) {
          await scheduleLateMeetingDeletionCleanup(
            meetingKey,
            ownerUserId,
            "Late ASR transient object requires deletion cleanup.",
          );
        }
        await deleteTransientUnsafe().catch(() => undefined);
        throw error;
      }
    });

    return {
      audioRevision,
      audioSha256: assembled.sha256,
      cleanup,
      durationMs,
      fileName: firstChunk.fileName,
      mimeType: firstChunk.mimeType,
      prepareForAsr,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

export async function prepareMeetingAudioForAsr(meetingId: string): Promise<PreparedMeetingAsrAudio> {
  const snapshot = await prepareMeetingAudioSnapshot(meetingId);
  try {
    return { ...(await snapshot.prepareForAsr()), cleanup: snapshot.cleanup };
  } catch (error) {
    await snapshot.cleanup().catch(() => undefined);
    throw error;
  }
}

async function assembleMeetingAudioFile(input: {
  assembledPath: string;
  directory: string;
  manifest: AudioManifest;
  meetingKey: string;
}) {
  let assembledBytes = 0;
  const sha256 = crypto.createHash("sha256");
  const output = await open(input.assembledPath, "wx", 0o600);
  try {
    for (const [index, chunk] of input.manifest.chunks.entries()) {
      const partPath = join(input.directory, `part-${String(index).padStart(6, "0")}.audio`);
      const chunkSha256 = crypto.createHash("sha256");
      const downloadedBytes = await objectStore.getFile(
        buildMeetingObjectKey(input.meetingKey, "chunk", chunk.fileName),
        partPath,
      );
      if (downloadedBytes !== chunk.bytes) throw new Error("Stored meeting audio length does not match its manifest.");
      for await (const part of createReadStream(partPath)) {
        const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
        await writeAllAsrFile(output, buffer);
        chunkSha256.update(buffer);
        sha256.update(buffer);
        assembledBytes += buffer.byteLength;
      }
      if (chunk.sha256 && chunkSha256.digest("hex") !== chunk.sha256) {
        throw new Error("Stored meeting audio digest does not match its manifest.");
      }
      await rm(partPath, { force: true });
    }
    await output.sync();
    await output.close();
    if (assembledBytes !== input.manifest.totalBytes) throw new Error("Stored meeting audio assembly length is inconsistent.");
    return { bytes: assembledBytes, sha256: sha256.digest("hex") };
  } catch (error) {
    await output.close().catch(() => undefined);
    throw error;
  }
}

async function writeAllAsrFile(file: Awaited<ReturnType<typeof open>>, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Could not assemble meeting audio for ASR.");
    offset += bytesWritten;
  }
}

function getAsrAudioUrlTtlSeconds() {
  const parsed = Number(process.env.OWNMINUTES_ASR_AUDIO_URL_TTL_SECONDS || 1_800);
  return Number.isFinite(parsed) ? Math.min(3_600, Math.max(300, Math.round(parsed))) : 1_800;
}

export async function readMeetingAudioMetadata(meetingId: string) {
  const meetingKey = sanitizeSegment(meetingId);
  return enqueueMeetingAccess(meetingKey, async () => {
    const manifest = await readManifest(buildMeetingObjectKey(meetingKey, "manifest"), meetingId);
    return meetingAudioMetadataFromManifest(manifest, meetingId);
  });
}

function deriveMeetingAudioRevision(manifest: AudioManifest) {
  const audioState = {
    chunks: [...manifest.chunks]
      .sort((left, right) => left.sequence - right.sequence)
      .map((chunk) => ({
        sequence: chunk.sequence,
        bytes: chunk.bytes,
        sha256: chunk.sha256 || `legacy:${chunk.fileName}:${chunk.bytes}:${chunk.mimeType}:${chunk.recordedAt}:${chunk.durationMs}`,
      })),
    totalBytes: manifest.totalBytes,
  };
  return crypto.createHash("sha256").update(JSON.stringify(audioState)).digest("hex");
}

function meetingAudioMetadataFromManifest(manifest: AudioManifest, meetingId: string) {
  if (manifest.chunks.length === 0) throw new Error("No audio chunks found for this meeting.");
  const firstChunk = manifest.chunks[0];
  const lastChunkReceivedAt = manifest.chunks
    .map((chunk) => chunk.receivedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? new Date(0).toISOString();
  const audioRevision = deriveMeetingAudioRevision(manifest);
  const sealed =
    manifest.audioSeal?.audioRevision === audioRevision &&
    manifest.audioSeal.lastSequence === manifest.chunks.at(-1)?.sequence &&
    manifest.audioSeal.totalBytes === manifest.totalBytes;
  return {
    meetingId,
    audioRevision,
    audioUpdatedAt: lastChunkReceivedAt,
    lastChunkReceivedAt,
    chunks: manifest.chunks.length,
    totalBytes: manifest.totalBytes,
    durationMs: manifest.chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0),
    fileName: firstChunk.fileName,
    mimeType: firstChunk.mimeType,
    sealed,
    sealedAt: sealed ? manifest.audioSeal?.sealedAt : undefined,
    updatedAt: manifest.updatedAt,
  };
}

export function isMeetingResultFreshForAudio(
  result: MeetingResult | null,
  audio: ReturnType<typeof meetingAudioMetadataFromManifest>,
) {
  if (!result) return false;
  if (result.audioRevision) return result.audioRevision === audio.audioRevision;
  return audio.audioUpdatedAt <= result.generatedAt;
}

export async function readMeetingResultFreshness(meetingId: string) {
  const meetingKey = sanitizeSegment(meetingId);
  return enqueueMeetingAccess(meetingKey, async () => {
    const manifest = await readManifest(buildMeetingObjectKey(meetingKey, "manifest"), meetingId);
    const audio = meetingAudioMetadataFromManifest(manifest, meetingId);
    const result = await readMeetingResult(meetingId);
    const current = isMeetingResultFreshForAudio(result, audio);
    return {
      audio,
      current,
      currentResult: current ? result : null,
      result,
    };
  });
}

export async function readMeetingAccess(meetingId: string) {
  const meetingKey = sanitizeSegment(meetingId);
  return enqueueMeetingAccess(meetingKey, () => readMeetingAccessUnsafe(meetingKey, meetingId));
}

export async function readMeetingShareSnapshot(meetingId: string): Promise<MeetingShareSnapshot> {
  const meetingKey = sanitizeSegment(meetingId);
  return enqueueMeetingAccess(meetingKey, () => readMeetingShareSnapshotUnsafe(meetingKey, meetingId));
}

async function readMeetingAccessUnsafe(meetingKey: string, meetingId: string): Promise<MeetingAccessSnapshot> {
  return (await readMeetingShareSnapshotUnsafe(meetingKey, meetingId)).access;
}

async function readMeetingShareSnapshotUnsafe(meetingKey: string, meetingId: string): Promise<MeetingShareSnapshot> {
  if (!(await isMeetingWriteAllowed(meetingKey))) {
    return {
      access: {
        meetingId,
        exists: false,
        ownerUserId: undefined,
        share: emptyManifest(meetingId).share,
        hasChunks: false,
        humanReview: resolveMeetingHumanReview(undefined, null),
      },
      durationMs: 0,
      result: null,
    };
  }
  const existingManifest = await readExistingManifest(buildMeetingObjectKey(meetingKey, "manifest"), meetingId);
  const manifest = existingManifest ?? emptyManifest(meetingId);

  const storedResult = existingManifest ? await readMeetingResult(meetingId) : null;
  const result = existingManifest && existingManifest.chunks.length > 0
    ? currentMeetingResultForManifest(storedResult, existingManifest, meetingId)
    : null;
  return {
    access: {
      meetingId,
      exists: Boolean(existingManifest),
      ownerUserId: manifest.ownerUserId,
      share: manifest.share,
      hasChunks: manifest.chunks.length > 0,
      humanReview: resolveMeetingHumanReview(manifest.reviewConfirmation, result),
    },
    durationMs: manifest.chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0),
    result,
  };
}

export function isMeetingShareActive(share: AudioManifest["share"], now = new Date()) {
  if (share.visibility !== "public") return false;
  if (!share.expiresAt) return false;

  const expiresAt = new Date(share.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;

  return expiresAt.getTime() > now.getTime();
}

export async function listUserMeetings(
  userId: string,
  options: { query?: string } = {},
): Promise<MeetingListItem[]> {
  const query = options.query?.replace(/\s+/g, " ").trim().slice(0, 200) || "";
  const meetingIds = await discoverMeetingIdsForOwner(userId, query);
  const meetings = await mapWithConcurrency(
    meetingIds,
    8,
    (meetingId) => enqueueMeetingAccess(meetingId, async () => {
      if (!(await isMeetingWriteAllowed(meetingId))) return null;
      const manifest = await readManifest(buildMeetingObjectKey(meetingId, "manifest"), meetingId);
      if (manifest.ownerUserId !== userId || manifest.chunks.length === 0) return null;

      const [storedResult, processing] = await Promise.all([readMeetingResult(meetingId), readMeetingFinalizationState(meetingId)]);
      const result = currentMeetingResultForManifest(storedResult, manifest, meetingId);
      if (query && !meetingMatchesQuery(manifest, result, query)) return null;
      const humanReview = resolveMeetingHumanReview(manifest.reviewConfirmation, result);
      return {
        meetingId,
        title: manifest.metadata.title || result?.title || meetingId,
        generatedAt: result?.generatedAt,
        updatedAt: manifest.updatedAt,
        durationMs: manifest.chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0),
        totalBytes: manifest.totalBytes,
        totalChunks: manifest.chunks.length,
        metadata: manifest.metadata,
        share: manifest.share,
        hasResult: Boolean(result),
        transcriptCount: result?.transcript.length ?? 0,
        processing: processing?.ownerUserId === userId ? processing : null,
        qualityStatus: assessMeetingResultQuality(result).status,
        humanReview,
        recordingConsent: normalizeStoredRecordingConsentMetadata(manifest.recordingConsent),
      } satisfies MeetingListItem;
    }),
  );

  const visibleMeetings: MeetingListItem[] = [];
  for (const meeting of meetings) {
    if (meeting) visibleMeetings.push(meeting);
  }

  return visibleMeetings.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function assertMeetingOwner(meetingId: string, userId: string) {
  const meetingKey = sanitizeSegment(meetingId);
  return enqueueMeetingAccess(meetingKey, () => assertMeetingOwnerUnsafe(meetingKey, meetingId, userId));
}

async function assertMeetingOwnerUnsafe(meetingKey: string, meetingId: string, userId: string) {
  const access = await readMeetingAccessUnsafe(meetingKey, meetingId);

  if (!access.exists || !access.hasChunks) {
    throw new MeetingAccessError("Meeting audio was not found.", 404);
  }

  if (!access.ownerUserId || access.ownerUserId !== userId) {
    throw new MeetingAccessError("You do not have access to this meeting.", 403);
  }

  return access;
}

async function assertMeetingDeletionOwnerUnsafe(meetingKey: string, meetingId: string, userId: string) {
  const access = await readMeetingAccessUnsafe(meetingKey, meetingId);

  // A resumable recording upload claims an owner manifest before its first
  // canonical audio chunk is published. That owned prefix is still a real
  // user resource and must be deletable while staging I/O is in flight.
  if (!access.exists) {
    throw new MeetingAccessError("Meeting audio was not found.", 404);
  }
  if (!access.ownerUserId || access.ownerUserId !== userId) {
    throw new MeetingAccessError("You do not have access to this meeting.", 403);
  }

  return access;
}

export async function readUserMeetingDetail(meetingId: string, userId: string): Promise<MeetingDetail> {
  const meetingKey = sanitizeSegment(meetingId);
  return enqueueMeetingAccess(meetingKey, () => readUserMeetingDetailUnsafe(meetingKey, meetingId, userId));
}

async function readUserMeetingDetailUnsafe(meetingKey: string, meetingId: string, userId: string): Promise<MeetingDetail> {
  await assertMeetingOwnerUnsafe(meetingKey, meetingId, userId);
  const manifest = await readManifest(buildMeetingObjectKey(meetingKey, "manifest"), meetingId);
  const [storedResult, storedObsidianMarkdown, processing] = await Promise.all([
    readMeetingResult(meetingId),
    readMeetingMarkdown(meetingId),
    readMeetingFinalizationState(meetingId),
  ]);
  const result = currentMeetingResultForManifest(storedResult, manifest, meetingId);
  const obsidianMarkdown = result ? storedObsidianMarkdown : null;

  const humanReview = resolveMeetingHumanReview(manifest.reviewConfirmation, result);
  return {
    meetingId,
    title: manifest.metadata.title || result?.title || meetingId,
    generatedAt: result?.generatedAt,
    updatedAt: manifest.updatedAt,
    durationMs: manifest.chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0),
    totalBytes: manifest.totalBytes,
    totalChunks: manifest.chunks.length,
    metadata: manifest.metadata,
    share: manifest.share,
    hasResult: Boolean(result),
    transcriptCount: result?.transcript.length ?? 0,
    result,
    obsidianMarkdown,
    processing: processing?.ownerUserId === userId ? processing : null,
    qualityStatus: qualityStatusForResult(result),
    humanReview,
    recordingConsent: normalizeStoredRecordingConsentMetadata(manifest.recordingConsent),
  };
}

function qualityStatusForResult(result: MeetingResult | null) {
  return assessMeetingResultQuality(result).status;
}

export async function readMeetingMarkdown(meetingId: string) {
  try {
    return await objectStore.getText(buildMeetingObjectKey(meetingId, "obsidianMarkdown"));
  } catch {
    return null;
  }
}

function currentMeetingResultForManifest(result: MeetingResult | null, manifest: AudioManifest, meetingId: string) {
  if (!result || manifest.chunks.length === 0) return null;
  const audio = meetingAudioMetadataFromManifest(manifest, meetingId);
  return isMeetingResultFreshForAudio(result, audio) ? result : null;
}

export async function recordMeetingShareView(meetingId: string) {
  if (await ensureMeetingCatalogBackfilled()) {
    const snapshot = await readMeetingShareSnapshot(meetingId);
    if (
      snapshot.access.hasChunks &&
      isMeetingShareActive(snapshot.access.share) &&
      snapshot.access.humanReview.status === "confirmed"
    ) {
      const shareAnalytics = await recordMeetingCatalogShareView(meetingId);
      return {
        meetingId,
        recorded: Boolean(shareAnalytics),
        shareAnalytics: shareAnalytics ?? { viewCount: 0 },
      };
    }
    return {
      meetingId,
      recorded: false,
      shareAnalytics: { viewCount: 0 },
    };
  }

  return enqueueMeetingWrite(meetingId, async () => {
    const meetingKey = sanitizeSegment(meetingId);
    const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
    const manifest = await readManifest(manifestKey, meetingId);

    const result = currentMeetingResultForManifest(await readMeetingResult(meetingId), manifest, meetingId);
    const humanReview = resolveMeetingHumanReview(manifest.reviewConfirmation, result);
    if (!manifest.chunks.length || !isMeetingShareActive(manifest.share) || humanReview.status !== "confirmed") {
      return {
        meetingId,
        recorded: false,
        shareAnalytics: manifest.shareAnalytics,
      };
    }

    const viewedAt = new Date().toISOString();
    manifest.shareAnalytics = {
      viewCount: manifest.shareAnalytics.viewCount + 1,
      firstViewedAt: manifest.shareAnalytics.firstViewedAt || viewedAt,
      lastViewedAt: viewedAt,
    };

    await persistMeetingManifest(manifestKey, manifest);

    return {
      meetingId,
      recorded: true,
      shareAnalytics: manifest.shareAnalytics,
    };
  });
}

export async function getMeetingShareAnalyticsSummary(): Promise<MeetingShareAnalyticsSummary> {
  if (await ensureMeetingCatalogBackfilled()) {
    const summary = await getMeetingCatalogShareAnalyticsSummary();
    if (summary) return summary;
  }

  const meetingIds = await discoverAllMeetingIds();
  let publicShares = 0;
  let viewedShares = 0;
  let totalShareViews = 0;
  let lastShareViewedAt: string | undefined;

  for (const meetingId of meetingIds) {
    const analytics = await enqueueMeetingAccess(meetingId, async () => {
      if (!(await isMeetingWriteAllowed(meetingId))) return null;
      const manifest = await readExistingManifest(buildMeetingObjectKey(meetingId, "manifest"), meetingId);
      if (!manifest?.ownerUserId || !manifest.chunks.length) return null;
      const result = currentMeetingResultForManifest(await readMeetingResult(meetingId), manifest, meetingId);
      return {
        lastViewedAt: manifest.shareAnalytics.lastViewedAt,
        public: isMeetingShareActive(manifest.share) &&
          resolveMeetingHumanReview(manifest.reviewConfirmation, result).status === "confirmed",
        views: manifest.shareAnalytics.viewCount,
      };
    });
    if (!analytics) continue;

    const views = analytics.views;
    totalShareViews += views;
    if (views > 0) viewedShares += 1;
    if (analytics.public) publicShares += 1;
    if (analytics.lastViewedAt && (!lastShareViewedAt || analytics.lastViewedAt > lastShareViewedAt)) {
      lastShareViewedAt = analytics.lastViewedAt;
    }
  }

  return {
    publicShares,
    viewedShares,
    totalShareViews,
    lastShareViewedAt,
  };
}

export async function deleteUserMeeting(meetingId: string, userId: string) {
  const meetingKey = sanitizeSegment(meetingId);
  return enqueueMeetingAccess(meetingKey, async () => {
    const deletionOwner = await getMeetingDeletionOwner(meetingKey);
    if (deletionOwner && deletionOwner !== userId) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }
    const transferOwners = await listMeetingObjectTransferOwnersForMeeting(meetingKey);
    if (transferOwners.some((ownerUserId) => ownerUserId !== userId)) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }
    if (!deletionOwner) {
      try {
        await assertMeetingDeletionOwnerUnsafe(meetingKey, meetingId, userId);
      } catch (error) {
        if (!(error instanceof MeetingAccessError) || error.status !== 404) throw error;
        const realtimeOwnerUserId = await getRealtimeSessionOwner(meetingKey);
        const transferProvesOwner = transferOwners.length > 0 &&
          transferOwners.every((ownerUserId) => ownerUserId === userId);
        if ((!realtimeOwnerUserId || realtimeOwnerUserId !== userId) && !transferProvesOwner) {
          throw new MeetingAccessError("Meeting audio was not found.", 404);
        }
      }
      await markMeetingDeleted(meetingKey, userId);
    }
    await markMeetingCatalogDeleted(meetingKey, userId);
    await purgeMeetingProcessingLedger(userId, meetingKey);
    await resolveExpiredMeetingObjectTransfersForDeletion(meetingKey, userId);

    try {
      // Logical deletion is already durable. Keep the HTTP response bounded so
      // a slow object store cannot make the client report a false failure; the
      // durable cleanup worker owns any work that outlives this short attempt.
      await withDeadline(
        (signal) => deleteMeetingObjectPrefixWithRetries(meetingKey, signal),
        1_500,
        "Meeting object cleanup exceeded the inline deadline.",
      );
      await purgeMeetingCatalogAfterObjectDeletion(meetingKey, userId);
      await completeMeetingDeletionCleanup(meetingKey, userId);
      return { meetingId, cleanupPending: false };
    } catch (error) {
      await retryMeetingDeletionCleanup(
        meetingKey,
        1_000,
        error instanceof Error ? error.message : "Meeting object cleanup failed.",
      ).catch(() => undefined);
      console.error("Meeting object cleanup is pending after logical deletion.", {
        meetingIdHash: shortMeetingIdHash(meetingKey),
        thrownValueType: error instanceof Error ? "error" : "non_error",
      });
      return { meetingId, cleanupPending: true };
    }
  });
}

async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
    timer.unref?.();
    return await operation(controller.signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function scheduleLateMeetingDeletionCleanup(
  meetingId: string,
  ownerUserId: string | undefined,
  errorMessage: string,
) {
  if (!isMeetingCatalogEnabled()) {
    await deleteMeetingObjectPrefixWithRetries(meetingId);
    return;
  }
  // A deletion may still have a raw tombstone, or its successful cleanup may
  // already have been privacy-minimized to a one-way fence. Cover both states:
  // retry the former, then reopen the latter so a lock-free late PUT cannot
  // survive a cleanup that completed while the transfer was in flight.
  const retry = await retryMeetingDeletionCleanup(meetingId, 1_000, errorMessage);
  if (retry.scheduled) return;
  if (ownerUserId) {
    const reopened = await reopenMeetingDeletionCleanup(meetingId, ownerUserId, errorMessage);
    if (reopened.reopened) return;
  }
  throw new Error("Late meeting object cleanup could not be persisted.");
}

function isMeetingDeletionTransferError(error: unknown) {
  return error instanceof MeetingAccessError && (
    error.status === 401 ||
    error.status === 410 ||
    error.code === "meeting_transfer_intent_lost"
  );
}

async function completeTransferIntentAfterSettledFailure(input: {
  error: unknown;
  intentId: string | null;
  meetingId: string;
  ownerUserId: string;
}) {
  if (!input.intentId || (
    input.error instanceof MeetingAccessError &&
    input.error.code === "meeting_transfer_intent_lost"
  )) return;
  try {
    await completeMeetingObjectTransferIntent(input);
  } catch (completionError) {
    if (
      completionError instanceof MeetingAccessError &&
      completionError.code === "meeting_transfer_intent_lost"
    ) return;
    // A failed CAS leaves the durable intent in place, which is the safe state:
    // account deletion remains pending until a later cleanup can prove the PUT
    // has passed its bounded transfer lifetime.
    console.error("Meeting object transfer intent release is pending after a settled failure.", {
      errorType: completionError instanceof Error ? completionError.name : "non_error",
    });
  }
}

export async function runMeetingDeletionCleanupOnce(workerId: string, ownerUserId?: string) {
  const claim = await claimMeetingDeletionCleanup(workerId, ownerUserId);
  if (!claim) return { claimed: false as const };
  return withMeetingWriteLock(claim.meetingId, async () => {
    try {
      await markMeetingCatalogDeleted(claim.meetingId, claim.ownerUserId);
      await purgeMeetingProcessingLedger(claim.ownerUserId, claim.meetingId);
      await resolveExpiredMeetingObjectTransfersForDeletion(
        claim.meetingId,
        claim.ownerUserId,
      );
      await deleteMeetingObjectPrefixWithRetries(claim.meetingId);
      await purgeMeetingCatalogAfterObjectDeletion(
        claim.meetingId,
        claim.ownerUserId,
        claim.claimToken,
      );
      await completeMeetingDeletionCleanup(
        claim.meetingId,
        claim.ownerUserId,
        claim.claimToken,
      );
      return { claimed: true as const, cleaned: true as const, claim };
    } catch (error) {
      await retryMeetingDeletionCleanup(
        claim.meetingId,
        meetingDeletionCleanupRetryDelayMs(claim.attempt),
        error instanceof Error ? error.message : "Meeting object cleanup failed.",
        claim.claimToken,
      );
      return { claimed: true as const, cleaned: false as const, claim };
    }
  });
}

async function deleteMeetingObjectPrefixWithRetries(meetingKey: string, signal?: AbortSignal) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Meeting object cleanup was cancelled.");
    try {
      await objectStore.deletePrefix(buildMeetingObjectKey(meetingKey, "prefix"), { signal });
      await resolveMeetingCatalogBackfillBlocker(meetingKey);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, attempt * 100);
          timer.unref?.();
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error("Meeting object cleanup was cancelled."));
          }, { once: true });
        });
      }
    }
  }
  throw lastError;
}

function meetingDeletionCleanupRetryDelayMs(attempt: number) {
  return Math.min(60 * 60 * 1000, 15_000 * 2 ** Math.max(0, Math.min(8, attempt - 1)));
}

export async function deleteAllUserMeetings(userId: string, options: { signal?: AbortSignal } = {}) {
  throwIfAborted(options.signal);
  // Include durable tombstones as well as visible object prefixes. A prior
  // account-deletion attempt may have removed the manifest before a later S3
  // object failed; the tombstone remains the authoritative owner for retry.
  const discovery = await discoverMeetingIdsForAccountDeletion(userId);
  const discoveredMeetingIds = discovery.discoveredMeetingIds;
  const meetingIds = discoveredMeetingIds.filter(isCanonicalMeetingId);
  const unsafeObjectPrefixes = discovery.objectPrefixes.filter((meetingId) => !isCanonicalMeetingId(meetingId));
  const unsafeObjectPrefixCount = unsafeObjectPrefixes.length;
  const ownerLinkedUnsafePrefixCount = [...discovery.ownerLinkedMeetingIds]
    .filter((meetingId) => !isCanonicalMeetingId(meetingId)).length;
  if (unsafeObjectPrefixCount > 0) {
    // A fresh integrity snapshot may predate an out-of-band legacy prefix.
    // Persist its hashed blocker during authoritative account discovery so the
    // current job cannot erase its own receipt and report a false `deleted`.
    // The quarantine helper never passes a traversal-unsafe prefix to an
    // object-store path; traversal-safe legacy manifests may still provide one
    // durable owner and avoid blocking unrelated tenants.
    await mapWithConcurrency(unsafeObjectPrefixes, 8, async (meetingId) => {
      throwIfAborted(options.signal);
      await quarantineLegacyCatalogPrefix(meetingId);
    });
    console.error(`[meeting-deletion-cleanup] quarantined ${unsafeObjectPrefixCount} non-canonical object prefix(es); manual storage audit required.`);
  }
  const deletedMeetingIds: string[] = [];
  let cleanupPending = ownerLinkedUnsafePrefixCount > 0 || (!isMeetingCatalogEnabled() && unsafeObjectPrefixCount > 0);
  let localUnattributedPrefixObserved = false;

  for (const meetingId of meetingIds) {
    throwIfAborted(options.signal);
    const deleted = await withMeetingWriteLock(meetingId, async () => {
      throwIfAborted(options.signal);
      const [catalogOwnerUserId, deletionOwnerUserId, realtimeOwnerUserId, transferOwnerUserIds] = await Promise.all([
        getMeetingCatalogOwnerUserId(meetingId),
        getMeetingDeletionOwner(meetingId),
        getRealtimeSessionOwner(meetingId),
        listMeetingObjectTransferOwnersForMeeting(meetingId),
      ]);
      const durableOwnerEvidence = new Set(
        [catalogOwnerUserId, deletionOwnerUserId, realtimeOwnerUserId, ...transferOwnerUserIds]
          .filter((owner): owner is string => Boolean(owner)),
      );
      const ownerEvidenceIncludesUser = durableOwnerEvidence.has(userId);
      let manifest: AudioManifest | null;
      try {
        manifest = await readExistingManifest(buildMeetingObjectKey(meetingId, "manifest"), meetingId);
      } catch {
        const uniqueOwner = durableOwnerEvidence.size === 1 ? [...durableOwnerEvidence][0] : undefined;
        await quarantineCanonicalCatalogPrefix(meetingId, uniqueOwner);
        if (
          deletionOwnerUserId &&
          [...durableOwnerEvidence].some((owner) => owner !== deletionOwnerUserId)
        ) {
          await quarantineMeetingDeletionOwnerConflict(meetingId, deletionOwnerUserId);
          throw new Error("Meeting owner evidence conflicts with its deletion owner; manual cleanup is required.");
        }
        if (!uniqueOwner) {
          localUnattributedPrefixObserved = true;
          if (ownerEvidenceIncludesUser) cleanupPending = true;
          return false;
        }
        // A canonical prefix with one durable relational owner can be removed
        // even when its manifest is corrupt. Zero or conflicting owners remain
        // quarantined; a unique different owner is skipped.
        if (uniqueOwner !== userId) return false;
        manifest = null;
      }
      const allOwnerEvidence = new Set(durableOwnerEvidence);
      if (manifest?.ownerUserId) allOwnerEvidence.add(manifest.ownerUserId);
      let ownership = classifyCanonicalMeetingPrefixOwnership({
        catalogOwnerUserId,
        deletionOwnerUserId,
        manifest,
        meetingId,
        realtimeOwnerUserId,
        transferOwnerUserIds,
      });
      if (
        ownership.status === "quarantined" &&
        !manifest &&
        durableOwnerEvidence.size === 0
      ) {
        const catalogCandidate = await getMeetingCatalogDeletionCandidate(meetingId, userId);
        const catalogProvesCanonicalOwner =
          Boolean(catalogCandidate) &&
          (
            catalogCandidate?.objectPrefix === meetingId ||
            Boolean(catalogCandidate?.deletedAt)
          );
        const exactPrefixExists = (await objectStore.listTopLevelPrefixes()).includes(meetingId);
        if (catalogProvesCanonicalOwner && !exactPrefixExists) {
          const completed = await purgeCompletedMeetingCatalogAfterObjectAbsence(
            meetingId,
            userId,
          );
          if (completed.completedFence) {
            await purgeMeetingProcessingLedger(userId, meetingId);
            return true;
          }
          ownership = { ownerUserId: userId, status: "owned" };
        }
      }
      if (ownership.status === "quarantined") {
        const uniqueOwner = allOwnerEvidence.size === 1 ? [...allOwnerEvidence][0] : undefined;
        await quarantineCanonicalCatalogPrefix(meetingId, uniqueOwner);
        if (
          deletionOwnerUserId &&
          [...allOwnerEvidence].some((owner) => owner !== deletionOwnerUserId)
        ) {
          await quarantineMeetingDeletionOwnerConflict(meetingId, deletionOwnerUserId);
          throw new Error("Meeting owner evidence conflicts with its deletion owner; manual cleanup is required.");
        }
        if (!uniqueOwner) localUnattributedPrefixObserved = true;
        if (ownerEvidenceIncludesUser || manifest?.ownerUserId === userId) cleanupPending = true;
        return false;
      }
      if (ownership.ownerUserId !== userId) return false;

      if (!deletionOwnerUserId) {
        const reopened = await reopenMeetingDeletionCleanup(
          meetingId,
          userId,
          "Account deletion discovered a late object transfer after completed cleanup.",
        );
        if (!reopened.reopened) await markMeetingDeleted(meetingId, userId);
      }
      await markMeetingCatalogDeleted(meetingId, userId);
      await purgeMeetingProcessingLedger(userId, meetingId);
      await resolveExpiredMeetingObjectTransfersForDeletion(meetingId, userId);
      try {
        await deleteMeetingObjectPrefixWithRetries(meetingId, options.signal);
        await purgeMeetingCatalogAfterObjectDeletion(meetingId, userId);
        await completeMeetingDeletionCleanup(meetingId, userId);
      } catch (error) {
        cleanupPending = true;
        await retryMeetingDeletionCleanup(
          meetingId,
          1_000,
          error instanceof Error ? error.message : "Account meeting cleanup failed.",
        ).catch(() => undefined);
        return false;
      }
      return true;
    });
    if (deleted) deletedMeetingIds.push(meetingId);
  }
  if (await hasMeetingCatalogRowsForOwner(userId)) cleanupPending = true;
  if (await hasPendingMeetingCatalogCoverageForOwner(userId)) cleanupPending = true;
  if (await hasPendingMeetingObjectTransfersForOwner(userId)) cleanupPending = true;
  if (await getUnattributedMeetingCatalogBlockerCount()) cleanupPending = true;
  if (!isMeetingCatalogEnabled() && localUnattributedPrefixObserved) cleanupPending = true;

  return {
    cleanupPending,
    deletedMeetings: deletedMeetingIds.length,
    deletedMeetingIds,
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Account deletion cleanup lease was lost.");
}

export async function updateMeetingShare(input: {
  meetingId: string;
  ownerUserId: string;
  visibility: "private" | "public";
  includeTranscript: boolean;
  expiresAt?: string;
}) {
  if (
    input.visibility === "public" &&
    isMeetingCatalogEnabled() &&
    !(await ensureMeetingCatalogBackfilled())
  ) {
    throw new MeetingAccessError("分享发布所需数据暂未就绪，链接仍保持私密。请稍后重试。", 503, {
      code: "share_publication_not_committed",
      retryable: true,
      retryAfterSeconds: 5,
    });
  }
  return enqueueMeetingWrite(input.meetingId, async () => {
    const meetingKey = sanitizeSegment(input.meetingId);
    const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
    const manifest = await readManifest(manifestKey, input.meetingId);

    if (!manifest.chunks.length) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }

    if (!manifest.ownerUserId || manifest.ownerUserId !== input.ownerUserId) {
      throw new MeetingAccessError("You do not have access to this meeting.", 403);
    }

    if (input.visibility === "public") {
      const result = currentMeetingResultForManifest(await readMeetingResult(input.meetingId), manifest, input.meetingId);
      if (!result) {
        throw new MeetingAccessError("请先生成会议纪要，再发布分享链接。", 409, { code: "meeting_result_required" });
      }
      if (resolveMeetingHumanReview(manifest.reviewConfirmation, result).status !== "confirmed") {
        throw new MeetingAccessError("请先逐项核对逐字稿、纪要和待办，并确认当前版本后再发布。", 409, {
          code: "human_review_required",
        });
      }
    }

    let expiresAt: string | undefined;
    if (input.visibility === "public") {
      try {
        expiresAt = resolveMeetingShareExpiresAt(input.expiresAt);
      } catch (error) {
        if (error instanceof MeetingSharePolicyError) {
          throw new MeetingAccessError(error.message, 400, { code: error.code });
        }
        throw error;
      }
    }

    manifest.share = {
      visibility: input.visibility,
      includeTranscript: input.includeTranscript,
      expiresAt,
      updatedAt: new Date().toISOString(),
    };
    manifest.shareAnalytics =
      input.visibility === "public"
        ? {
            viewCount: 0,
          }
        : {
            viewCount: 0,
            firstViewedAt: undefined,
            lastViewedAt: undefined,
          };
    manifest.updatedAt = new Date().toISOString();
    if (input.visibility === "public") {
      try {
        await commitPreparedPublicMeetingShare({
          prepareCatalog: async () => {
            if (isMeetingCatalogEnabled() && !(await isMeetingCatalogReady())) {
              throw new Error("Meeting catalog coverage is not ready for public sharing.");
            }
            await upsertMeetingCatalog(meetingCatalogProjection(manifest));
            await resolveMeetingCatalogBackfillBlocker(input.meetingId);
          },
          prepareAnalytics: async () => {
            await resetMeetingCatalogShareAnalytics(input.meetingId);
          },
          commitPublicManifest: async () => {
            await objectStore.putText(manifestKey, `${JSON.stringify(manifest, null, 2)}\n`);
          },
        });
      } catch (error) {
        if (error instanceof MeetingSharePublicationPreparationError) {
          throw new MeetingAccessError(error.message, error.status, {
            code: error.code,
            retryable: error.retryable,
            retryAfterSeconds: 5,
          });
        }
        throw error;
      }
    } else {
      await commitPrivateMeetingShareManifest(manifestKey, manifest);
    }

    return {
      meetingId: input.meetingId,
      share: manifest.share,
    };
  });
}

async function commitPrivateMeetingShareManifest(manifestKey: string, manifest: AudioManifest) {
  // Revocation is privacy-authoritative as soon as the object manifest is
  // private. A stale auxiliary projection must not keep anonymous access open,
  // nor turn a completed revoke into a failed API response.
  await objectStore.putText(manifestKey, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!manifest.ownerUserId) return;
  try {
    await upsertMeetingCatalog(meetingCatalogProjection(manifest));
    await resetMeetingCatalogShareAnalytics(manifest.meetingId);
    await resolveMeetingCatalogBackfillBlocker(manifest.meetingId);
  } catch (error) {
    await markMeetingCatalogCoverageIncomplete().catch(() => undefined);
    console.error("Meeting share revoke projection refresh failed after the private manifest committed.", {
      errorType: error instanceof Error ? error.name : "non_error",
      event: "meeting_share_revoke_projection_failed",
      meetingRef: shortMeetingIdHash(manifest.meetingId),
    });
  }
}

export async function updateMeetingHumanReview(input: {
  confirmed: boolean;
  meetingId: string;
  ownerUserId: string;
}) {
  return enqueueMeetingWrite(input.meetingId, async () => {
    const meetingKey = sanitizeSegment(input.meetingId);
    const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
    const manifest = await readManifest(manifestKey, input.meetingId);

    if (!manifest.chunks.length) throw new MeetingAccessError("Meeting audio was not found.", 404);
    if (!manifest.ownerUserId || manifest.ownerUserId !== input.ownerUserId) {
      throw new MeetingAccessError("You do not have access to this meeting.", 403);
    }

    const result = currentMeetingResultForManifest(await readMeetingResult(input.meetingId), manifest, input.meetingId);
    if (!result) throw new MeetingAccessError("请先生成会议纪要，再确认人工复核。", 409, { code: "meeting_result_required" });

    manifest.reviewConfirmation = input.confirmed ? createMeetingReviewConfirmation(result) : undefined;
    if (!input.confirmed) revokeMeetingShare(manifest);
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);

    return {
      meetingId: input.meetingId,
      humanReview: resolveMeetingHumanReview(manifest.reviewConfirmation, result),
      share: manifest.share,
    };
  });
}

export async function updateMeetingMetadata(input: {
  meetingId: string;
  ownerUserId: string;
  participants?: string[];
  project?: string;
  tags?: string[];
  title?: string;
}) {
  return enqueueMeetingWrite(input.meetingId, async () => {
    const meetingKey = sanitizeSegment(input.meetingId);
    const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
    const manifest = await readManifest(manifestKey, input.meetingId);

    if (!manifest.chunks.length) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }

    if (!manifest.ownerUserId || manifest.ownerUserId !== input.ownerUserId) {
      throw new MeetingAccessError("You do not have access to this meeting.", 403);
    }

    const title = input.title === undefined ? manifest.metadata.title : normalizeMeetingTitle(input.title);
    manifest.metadata = {
      participants: input.participants === undefined ? manifest.metadata.participants : normalizeParticipants(input.participants),
      project: input.project === undefined ? manifest.metadata.project : normalizeProject(input.project),
      tags: input.tags === undefined ? manifest.metadata.tags : normalizeTags(input.tags),
      title,
      updatedAt: new Date().toISOString(),
    };
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);

    const result = currentMeetingResultForManifest(await readMeetingResult(input.meetingId), manifest, input.meetingId);
    let updatedResult: MeetingResult | null = null;
    if (result && title && title !== result.title) {
      updatedResult = {
        ...result,
        title,
        obsidianMarkdown: buildMeetingMarkdown({
          title,
          meetingId: input.meetingId,
          shareUrl: `/share/${input.meetingId}`,
          transcript: result.transcript,
          summary: result.summary,
          contentLocale: result.contentLocale,
        }),
      };
      await saveMeetingResultUnsafe(input.meetingId, updatedResult);
      revokeMeetingShare(manifest);
      manifest.updatedAt = new Date().toISOString();
      await persistMeetingManifest(manifestKey, manifest);
      await persistMeetingResultCatalog(input.meetingId, updatedResult);
    }

    return {
      meetingId: input.meetingId,
      metadata: manifest.metadata,
      result: updatedResult,
      obsidianMarkdown: updatedResult?.obsidianMarkdown,
      humanReview: resolveMeetingHumanReview(manifest.reviewConfirmation, updatedResult ?? result),
      share: manifest.share,
    };
  });
}

export async function updateMeetingSpeakers(input: {
  meetingId: string;
  ownerUserId: string;
  speakerNames: Record<string, string>;
}) {
  return enqueueMeetingWrite(input.meetingId, async () => {
    const meetingKey = sanitizeSegment(input.meetingId);
    const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
    const manifest = await readManifest(manifestKey, input.meetingId);

    if (!manifest.chunks.length) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }

    if (!manifest.ownerUserId || manifest.ownerUserId !== input.ownerUserId) {
      throw new MeetingAccessError("You do not have access to this meeting.", 403);
    }

    const result = currentMeetingResultForManifest(await readMeetingResult(input.meetingId), manifest, input.meetingId);
    if (!result) {
      throw new MeetingAccessError("Meeting result was not found.", 404);
    }

    const knownSpeakers = new Set([
      ...result.transcript.map((segment) => segment.speaker),
      ...result.summary.speakerViews.map((item) => item.speaker),
      ...result.summary.actionItems.map((item) => item.owner),
    ].filter((speaker) => speaker && speaker !== "System"));
    const speakerNames = normalizeSpeakerNames(input.speakerNames, knownSpeakers);

    const updatedResult = applySpeakerNames(result, speakerNames);
    updatedResult.obsidianMarkdown = buildMeetingMarkdown({
      title: updatedResult.title,
      meetingId: input.meetingId,
      shareUrl: `/share/${input.meetingId}`,
      transcript: updatedResult.transcript,
      summary: updatedResult.summary,
      contentLocale: updatedResult.contentLocale,
    });

    await saveMeetingResultUnsafe(input.meetingId, updatedResult);

    revokeMeetingShare(manifest);
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
    await persistMeetingResultCatalog(input.meetingId, updatedResult);

    return {
      meetingId: input.meetingId,
      speakerNames,
      result: updatedResult,
      obsidianMarkdown: updatedResult.obsidianMarkdown,
      humanReview: resolveMeetingHumanReview(manifest.reviewConfirmation, updatedResult),
      share: manifest.share,
    };
  });
}

export async function updateMeetingTranscriptSpeakers(input: {
  meetingId: string;
  ownerUserId: string;
  speakerAssignments: Record<string, string>;
}) {
  return enqueueMeetingWrite(input.meetingId, async () => {
    const meetingKey = sanitizeSegment(input.meetingId);
    const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
    const manifest = await readManifest(manifestKey, input.meetingId);

    if (!manifest.chunks.length) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }

    if (!manifest.ownerUserId || manifest.ownerUserId !== input.ownerUserId) {
      throw new MeetingAccessError("You do not have access to this meeting.", 403);
    }

    const result = currentMeetingResultForManifest(await readMeetingResult(input.meetingId), manifest, input.meetingId);
    if (!result) {
      throw new MeetingAccessError("Meeting result was not found.", 404);
    }

    const speakerAssignments = normalizeTranscriptSpeakerAssignments(input.speakerAssignments, result.transcript);
    const updatedTranscript = result.transcript.map((segment) => ({
      ...segment,
      speaker: speakerAssignments[segment.id] || segment.speaker,
    }));
    const correctionCount = Object.keys(speakerAssignments).length;
    const correctionDiagnostic = `manual_speaker_assignment: ${correctionCount} transcript segment(s) corrected; review summary attribution and action owners.`;
    const updatedResult: MeetingResult = {
      ...result,
      transcript: updatedTranscript,
      diagnostics: correctionCount > 0
        ? [...result.diagnostics.filter((item) => !item.startsWith("manual_speaker_assignment:")), correctionDiagnostic]
        : result.diagnostics,
      obsidianMarkdown: buildMeetingMarkdown({
        title: result.title,
        meetingId: input.meetingId,
        shareUrl: `/share/${input.meetingId}`,
        transcript: updatedTranscript,
        summary: result.summary,
        contentLocale: result.contentLocale,
      }),
    };

    await saveMeetingResultUnsafe(input.meetingId, updatedResult);

    revokeMeetingShare(manifest);
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
    await persistMeetingResultCatalog(input.meetingId, updatedResult);

    return {
      meetingId: input.meetingId,
      speakerAssignments,
      result: updatedResult,
      obsidianMarkdown: updatedResult.obsidianMarkdown,
      humanReview: resolveMeetingHumanReview(manifest.reviewConfirmation, updatedResult),
      share: manifest.share,
    };
  });
}

export async function updateMeetingSummary(input: {
  meetingId: string;
  ownerUserId: string;
  summaryPatch: Partial<MeetingResult["summary"]>;
}) {
  return enqueueMeetingWrite(input.meetingId, async () => {
    const meetingKey = sanitizeSegment(input.meetingId);
    const manifestKey = buildMeetingObjectKey(meetingKey, "manifest");
    const manifest = await readManifest(manifestKey, input.meetingId);

    if (!manifest.chunks.length) {
      throw new MeetingAccessError("Meeting audio was not found.", 404);
    }

    if (!manifest.ownerUserId || manifest.ownerUserId !== input.ownerUserId) {
      throw new MeetingAccessError("You do not have access to this meeting.", 403);
    }

    const result = currentMeetingResultForManifest(await readMeetingResult(input.meetingId), manifest, input.meetingId);
    if (!result) {
      throw new MeetingAccessError("Meeting result was not found.", 404);
    }

    const updatedSummary = normalizeMeetingSummaryPatch(result.summary, input.summaryPatch);
    const updatedResult: MeetingResult = {
      ...result,
      summary: updatedSummary,
      obsidianMarkdown: buildMeetingMarkdown({
        title: result.title,
        meetingId: input.meetingId,
        shareUrl: `/share/${input.meetingId}`,
        transcript: result.transcript,
        summary: updatedSummary,
        contentLocale: result.contentLocale,
      }),
    };

    await saveMeetingResultUnsafe(input.meetingId, updatedResult);

    revokeMeetingShare(manifest);
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
    await persistMeetingResultCatalog(input.meetingId, updatedResult);

    return {
      meetingId: input.meetingId,
      result: updatedResult,
      obsidianMarkdown: updatedResult.obsidianMarkdown,
      humanReview: resolveMeetingHumanReview(manifest.reviewConfirmation, updatedResult),
      share: manifest.share,
    };
  });
}

export async function saveMeetingResult(
  meetingId: string,
  result: MeetingResult,
  options: { expectedAudioRevision?: string } = {},
) {
  return enqueueMeetingWrite(meetingId, async () => {
    if (!(await isMeetingWriteAllowed(meetingId))) {
      throw new MeetingAccessError("This meeting was deleted and cannot accept a result.", 410);
    }
    const manifestKey = buildMeetingObjectKey(sanitizeSegment(meetingId), "manifest");
    const manifest = await readManifest(manifestKey, meetingId);
    const audio = meetingAudioMetadataFromManifest(manifest, meetingId);
    if (options.expectedAudioRevision && audio.audioRevision !== options.expectedAudioRevision) {
      throw new MeetingAccessError("录音在处理期间收到新的音频分片，请基于完整录音重新生成纪要。", 409, {
        code: "audio_revision_changed",
        retryable: true,
      });
    }
    if (options.expectedAudioRevision && !audio.sealed) {
      throw new MeetingAccessError("录音尚未完成完整性确认，已保留本地录音，请同步完成后重试。", 409, {
        code: "meeting_audio_not_sealed",
        retryable: true,
      });
    }
    await saveMeetingResultUnsafe(meetingId, result);
    revokeMeetingShare(manifest);
    manifest.updatedAt = new Date().toISOString();
    await persistMeetingManifest(manifestKey, manifest);
    await persistMeetingResultCatalog(meetingId, result);
  });
}

async function saveMeetingResultUnsafe(meetingId: string, result: MeetingResult) {
  const meetingKey = sanitizeSegment(meetingId);
  await objectStore.putText(buildMeetingObjectKey(meetingKey, "result"), `${JSON.stringify(result, null, 2)}\n`);
  await objectStore.putText(buildMeetingObjectKey(meetingKey, "obsidianMarkdown"), `${result.obsidianMarkdown.trim()}\n`);
}

async function persistMeetingResultCatalog(meetingId: string, result: MeetingResult) {
  await updateMeetingCatalogResult({
    meetingId,
    generatedAt: result.generatedAt,
    resultSearchText: JSON.stringify(result).slice(0, 1_000_000),
    transcriptCount: result.transcript.length,
  });
}

function meetingMatchesQuery(
  manifest: AudioManifest,
  result: MeetingResult | null,
  query: string,
) {
  const needle = query.toLocaleLowerCase();
  const searchable = [
    manifest.meetingId,
    manifest.metadata.title,
    manifest.metadata.project,
    ...manifest.metadata.tags,
    result ? JSON.stringify(result) : "",
  ]
    .filter(Boolean)
    .join("\n")
    .toLocaleLowerCase();
  return searchable.includes(needle);
}

export async function readMeetingResult(meetingId: string) {
  return readOptionalMeetingObject(async () => {
    return JSON.parse(await objectStore.getText(buildMeetingObjectKey(meetingId, "result"))) as MeetingResult;
  });
}

async function readManifest(manifestKey: string, meetingId: string): Promise<AudioManifest> {
  return (await readExistingManifest(manifestKey, meetingId)) ?? emptyManifest(meetingId);
}

async function readExistingManifest(manifestKey: string, meetingId: string): Promise<AudioManifest | null> {
  return readOptionalMeetingObject(async () => {
    const contents = await objectStore.getText(manifestKey);
    return normalizeManifest(JSON.parse(contents) as Partial<AudioManifest>, meetingId);
  });
}

function emptyManifest(meetingId: string): AudioManifest {
  return {
    meetingId,
    share: {
      visibility: "private",
      includeTranscript: false,
      expiresAt: undefined,
    },
    shareAnalytics: {
      viewCount: 0,
    },
    metadata: {
      participants: [],
      tags: [],
    },
    chunks: [],
    totalBytes: 0,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeManifest(input: Partial<AudioManifest>, meetingId: string): AudioManifest {
  return {
    meetingId: input.meetingId || meetingId,
    ownerUserId: input.ownerUserId,
    metadata: {
      participants: normalizeParticipants(input.metadata?.participants),
      project: normalizeProject(input.metadata?.project),
      tags: normalizeTags(input.metadata?.tags),
      title: normalizeMeetingTitle(input.metadata?.title),
      updatedAt: input.metadata?.updatedAt,
    },
    share: {
      visibility: input.share?.visibility === "public" ? "public" : "private",
      includeTranscript: Boolean(input.share?.includeTranscript),
      expiresAt: normalizeShareExpiresAt(input.share?.expiresAt),
      updatedAt: input.share?.updatedAt,
    },
    shareAnalytics: normalizeShareAnalytics(input.shareAnalytics),
    reviewConfirmation: normalizeMeetingReviewConfirmation(input.reviewConfirmation),
    chunks: Array.isArray(input.chunks)
      ? input.chunks.map((chunk) => ({
          ...chunk,
          sha256: normalizeAudioSha256(chunk.sha256),
        }))
      : [],
    audioSeal: normalizeAudioSeal(input.audioSeal),
    recordingUpload: normalizeRecordingUploadLease(input.recordingUpload),
    recordingConsent: input.recordingConsent
      ? normalizeStoredRecordingConsentMetadata(input.recordingConsent)
      : undefined,
    totalBytes: Number(input.totalBytes || 0),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function normalizeAudioSha256(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

function normalizeAudioSeal(input: AudioManifest["audioSeal"]) {
  if (!input) return undefined;
  const audioRevision = normalizeAudioSha256(input.audioRevision);
  const lastSequence = Number(input.lastSequence);
  const totalBytes = Number(input.totalBytes);
  const sealedAt = String(input.sealedAt || "");
  if (
    !audioRevision ||
    !Number.isInteger(lastSequence) ||
    lastSequence <= 0 ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isFinite(Date.parse(sealedAt))
  ) {
    return undefined;
  }
  return { audioRevision, lastSequence, totalBytes, sealedAt };
}

function revokeMeetingShare(manifest: AudioManifest) {
  if (manifest.share.visibility !== "public") return;
  manifest.share = {
    visibility: "private",
    includeTranscript: false,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeRecordingUploadLease(input: AudioManifest["recordingUpload"]) {
  if (!input || !/^[a-zA-Z0-9_-]{16,80}$/.test(String(input.uploadId || ""))) return undefined;
  const stagedBytes = Number(input.stagedBytes);
  const totalBytes = Number(input.totalBytes);
  const updatedAt = String(input.updatedAt || "");
  if (
    !Number.isSafeInteger(stagedBytes) ||
    stagedBytes < 0 ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    stagedBytes > totalBytes ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    return undefined;
  }
  return { stagedBytes, totalBytes, updatedAt, uploadId: input.uploadId };
}

function assertAndSetRecordingConsent(
  manifest: AudioManifest,
  input: RecordingConsentMetadata,
) {
  const incoming = normalizeStoredRecordingConsentMetadata(input);
  const existing = manifest.recordingConsent
    ? normalizeStoredRecordingConsentMetadata(manifest.recordingConsent)
    : undefined;

  if (!existing) {
    if (manifest.chunks.length > 0 && incoming.consentMethod !== "legacy_unknown") {
      throw new MeetingAccessError(
        "已有录音缺少同一份知情确认记录，不能把新的确认信息追溯写入旧音频。",
        409,
        { code: "recording_consent_conflict", retryable: false },
      );
    }
    manifest.recordingConsent = incoming;
    return;
  }

  if (
    existing.consentMethod !== incoming.consentMethod ||
    existing.consentConfirmedAt !== incoming.consentConfirmedAt ||
    existing.consentPolicyVersion !== incoming.consentPolicyVersion
  ) {
    throw new MeetingAccessError(
      "本地录音与已保存的知情确认记录不一致，请保留录音并重新开始同步。",
      409,
      { code: "recording_consent_conflict", retryable: false },
    );
  }
}

function normalizeSpeakerNames(input: Record<string, string>, knownSpeakers: Set<string>) {
  const output: Record<string, string> = {};

  for (const [rawSpeaker, rawName] of Object.entries(input)) {
    const speaker = normalizeSpeakerLabelInput(rawSpeaker);
    const name = normalizeSpeakerLabelInput(rawName);

    if (!speaker || !name || speaker === "System" || !knownSpeakers.has(speaker)) continue;
    if (speaker === name) continue;

    output[speaker] = name;
  }

  return output;
}

function normalizeSpeakerLabelInput(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 48);
}

function normalizeTranscriptSpeakerAssignments(input: Record<string, string>, transcript: MeetingResult["transcript"]) {
  const entries = Object.entries(input);
  if (entries.length > 500) {
    throw new MeetingAccessError("单次最多可校正 500 条发言段。", 400);
  }

  const segments = new Map(transcript.map((segment) => [segment.id, segment]));
  const output: Record<string, string> = {};

  for (const [rawSegmentId, rawSpeaker] of entries) {
    const segmentId = rawSegmentId.trim();
    const segment = segments.get(segmentId);
    const speaker = normalizeSpeakerLabelInput(rawSpeaker);

    if (!segment || segment.speaker === "System") {
      throw new MeetingAccessError("逐字稿已变化，请刷新后重新校正。", 409);
    }
    if (!speaker || speaker === "System") {
      throw new MeetingAccessError("每条校正都需要有效的发言人姓名。", 400);
    }
    if (speaker !== segment.speaker) output[segmentId] = speaker;
  }

  return output;
}

function applySpeakerNames(result: MeetingResult, speakerNames: Record<string, string>): MeetingResult {
  if (Object.keys(speakerNames).length === 0) return result;

  return {
    ...result,
    transcript: result.transcript.map((segment) => ({
      ...segment,
      speaker: speakerNames[segment.speaker] || segment.speaker,
      text: replaceSpeakerLabels(segment.text, speakerNames),
    })),
    summary: {
      ...result.summary,
      summary: replaceSpeakerLabels(result.summary.summary, speakerNames),
      topics: result.summary.topics.map((item) => replaceSpeakerLabels(item, speakerNames)),
      speakerViews: result.summary.speakerViews.map((item) => ({
        speaker: speakerNames[item.speaker] || item.speaker,
        view: replaceSpeakerLabels(item.view, speakerNames),
      })),
      decisions: result.summary.decisions.map((item) => ({
        ...item,
        title: replaceSpeakerLabels(item.title, speakerNames),
        detail: replaceSpeakerLabels(item.detail, speakerNames),
      })),
      actionItems: result.summary.actionItems.map((item) => ({
        ...item,
        owner: speakerNames[item.owner] || item.owner,
        task: replaceSpeakerLabels(item.task, speakerNames),
        due: replaceSpeakerLabels(item.due, speakerNames),
      })),
      risks: result.summary.risks.map((item) => replaceSpeakerLabels(item, speakerNames)),
      openQuestions: result.summary.openQuestions.map((item) => replaceSpeakerLabels(item, speakerNames)),
      knowledgePoints: result.summary.knowledgePoints.map((item) => replaceSpeakerLabels(item, speakerNames)),
    },
  };
}

function replaceSpeakerLabels(text: string, speakerNames: Record<string, string>) {
  return Object.entries(speakerNames)
    .sort((left, right) => right[0].length - left[0].length)
    .reduce((current, [speaker, name]) => current.split(speaker).join(name), text);
}

function normalizeMeetingSummaryPatch(current: MeetingResult["summary"], patch: Partial<MeetingResult["summary"]>) {
  return {
    ...current,
    ...(typeof patch.summary === "string" ? { summary: normalizeSummaryText(patch.summary, current.summary) } : {}),
    ...(Array.isArray(patch.topics) ? { topics: normalizeStringList(patch.topics, current.topics) } : {}),
    ...(Array.isArray(patch.speakerViews) ? { speakerViews: normalizeSpeakerViews(patch.speakerViews, current.speakerViews) } : {}),
    ...(Array.isArray(patch.decisions) ? { decisions: normalizeDecisions(patch.decisions, current.decisions) } : {}),
    ...(Array.isArray(patch.actionItems) ? { actionItems: normalizeActionItems(patch.actionItems, current.actionItems) } : {}),
    ...(Array.isArray(patch.risks) ? { risks: normalizeStringList(patch.risks, current.risks) } : {}),
    ...(Array.isArray(patch.openQuestions) ? { openQuestions: normalizeStringList(patch.openQuestions, current.openQuestions) } : {}),
    ...(Array.isArray(patch.knowledgePoints) ? { knowledgePoints: normalizeStringList(patch.knowledgePoints, current.knowledgePoints) } : {}),
  } satisfies MeetingResult["summary"];
}

function normalizeSummaryText(value: string, fallback: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 2400) || fallback;
}

function normalizeStringList(values: unknown[], fallback: string[]) {
  const output = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 12);

  return output.length ? output : fallback;
}

function normalizeSpeakerViews(values: unknown[], fallback: MeetingResult["summary"]["speakerViews"]) {
  const output = values
    .filter((value): value is { speaker?: unknown; view?: unknown } => Boolean(value) && typeof value === "object")
    .map((value, index) => ({
      speaker: typeof value.speaker === "string" ? normalizeSummaryText(value.speaker, `Speaker ${index + 1}`).slice(0, 80) : `Speaker ${index + 1}`,
      view: typeof value.view === "string" ? normalizeSummaryText(value.view, "不确定").slice(0, 360) : "不确定",
    }))
    .filter((item) => item.speaker && item.view)
    .slice(0, 12);

  return output.length ? output : fallback;
}

function normalizeDecisions(values: unknown[], fallback: MeetingResult["summary"]["decisions"]) {
  const output = values
    .filter((value): value is { id?: unknown; title?: unknown; detail?: unknown; status?: unknown } => Boolean(value) && typeof value === "object")
    .map((value, index) => ({
      id: typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 80) : `decision-${index + 1}`,
      title: typeof value.title === "string" ? normalizeSummaryText(value.title, "不确定").slice(0, 160) : "不确定",
      detail: typeof value.detail === "string" ? normalizeSummaryText(value.detail, "不确定").slice(0, 480) : "不确定",
      status: value.status === "confirmed" ? ("confirmed" as const) : ("candidate" as const),
    }))
    .filter((item) => item.title && item.detail)
    .slice(0, 20);

  return output.length ? output : fallback;
}

function normalizeActionItems(values: unknown[], fallback: MeetingResult["summary"]["actionItems"]) {
  const output = values
    .filter((value): value is { id?: unknown; task?: unknown; owner?: unknown; due?: unknown; status?: unknown } => Boolean(value) && typeof value === "object")
    .map((value, index) => ({
      id: typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 80) : `action-${index + 1}`,
      task: typeof value.task === "string" ? normalizeSummaryText(value.task, "不确定").slice(0, 220) : "不确定",
      owner: typeof value.owner === "string" ? normalizeSummaryText(value.owner, "不确定").slice(0, 80) : "不确定",
      due: typeof value.due === "string" ? normalizeSummaryText(value.due, "不确定").slice(0, 80) : "不确定",
      status: value.status === "confirmed" ? ("confirmed" as const) : ("candidate" as const),
    }))
    .filter((item) => item.task)
    .slice(0, 30);

  return output.length ? output : fallback;
}

function normalizeShareAnalytics(value: unknown): AudioManifest["shareAnalytics"] {
  if (!value || typeof value !== "object") {
    return {
      viewCount: 0,
    };
  }

  const input = value as Partial<AudioManifest["shareAnalytics"]>;
  return {
    viewCount: Math.max(0, Math.floor(Number(input.viewCount || 0))),
    firstViewedAt: normalizeIsoDate(input.firstViewedAt),
    lastViewedAt: normalizeIsoDate(input.lastViewedAt),
  };
}

function normalizeIsoDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function normalizeShareExpiresAt(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;

  return date.toISOString();
}

function normalizeProject(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 60);
  return trimmed || undefined;
}

function normalizeMeetingTitle(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, 80);
  return trimmed || undefined;
}

function normalizeParticipants(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const participants: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    const participant = item.replace(/\s+/g, " ").trim().slice(0, 48);
    const key = participant.toLowerCase();
    if (!participant || seen.has(key)) continue;
    seen.add(key);
    participants.push(participant);
    if (participants.length >= 30) break;
  }

  return participants;
}

function normalizeTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim().replace(/^#/, "").slice(0, 24);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }

  return tags;
}

function sanitizeSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) {
    throw new MeetingAccessError("Invalid meeting id.", 400, {
      code: "invalid_meeting_id",
      retryable: false,
    });
  }
  return value;
}

function shortMeetingIdHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}
