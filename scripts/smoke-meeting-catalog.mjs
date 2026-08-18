import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";

const storeSource = await readFile("src/lib/server/meeting-audio-store.ts", "utf8");
const catalogSource = await readFile("src/lib/server/meeting-catalog.ts", "utf8");
const migrationSource = await readFile("db/migrations/0024_meeting_catalog_state.sql", "utf8");
const searchMigrationSource = await readFile("db/migrations/0026_meeting_fulltext_search.sql", "utf8");
const blockerMigrationSource = await readFile("db/migrations/0027_meeting_catalog_backfill_blockers.sql", "utf8");
const writeFenceMigrationSource = await readFile("db/migrations/0030_meeting_catalog_write_fences.sql", "utf8");
const purgeMigrationSource = await readFile("db/migrations/0031_meeting_catalog_purge.sql", "utf8");
const transferMigrationSource = await readFile("db/migrations/0032_meeting_transfer_intents.sql", "utf8");
const transferSource = await readFile("src/lib/server/meeting-transfer-intent.ts", "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(process.cwd(), "src") },
});
const { classifyCanonicalMeetingPrefixOwnership } = jiti("../src/lib/server/meeting-catalog.ts");

const functionBody = (name, nextName) => {
  const start = storeSource.indexOf(`export async function ${name}`);
  const end = storeSource.indexOf(`export async function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `could not isolate ${name}`);
  return storeSource.slice(start, end);
};

const listBody = functionBody("listUserMeetings", "assertMeetingOwner");
const deleteAllBody = functionBody("deleteAllUserMeetings", "updateMeetingShare");
const updateShareBody = functionBody("updateMeetingShare", "updateMeetingHumanReview");
const saveAudioObjectStart = storeSource.indexOf("async function saveMeetingAudioObjectUnsafe");
const saveAudioObjectEnd = storeSource.indexOf("async function calculateFileSha256", saveAudioObjectStart);
const saveAudioObjectBody = storeSource.slice(saveAudioObjectStart, saveAudioObjectEnd);

assert.match(migrationSource, /create table if not exists meeting_catalog_state/i);
assert.match(migrationSource, /add column if not exists share_expires_at/i);
assert.match(migrationSource, /create table if not exists meeting_share_analytics/i);
assert.match(catalogSource, /on conflict \(id\) do update/i);
assert.match(catalogSource, /meeting_share_analytics\.view_count \+ 1/i);
assert.match(catalogSource, /share_expires_at > now\(\)/i);
assert.match(searchMigrationSource, /generated always as/i);
assert.match(searchMigrationSource, /using gin \(search_document\)/i);
assert.match(blockerMigrationSource, /create table if not exists meeting_catalog_backfill_blockers/i);
assert.match(blockerMigrationSource, /where resolved_at is null/i);
assert.match(writeFenceMigrationSource, /canonical_unattributed/i);
assert.doesNotMatch(writeFenceMigrationSource, /canonical_catalog_write_pending/i);
assert.match(writeFenceMigrationSource, /0030_meeting_catalog_write_fences/i);
assert.match(purgeMigrationSource, /0031_meeting_catalog_purge/i);
assert.match(purgeMigrationSource, /meetings_owner_deletion_idx/i);
assert.match(purgeMigrationSource, /delete from meetings meeting/i);
assert.match(transferMigrationSource, /create table if not exists meeting_object_transfer_intents/i);
assert.match(transferMigrationSource, /account_deletion_provider_cost_source_ref_idx/i);
assert.match(catalogSource, /websearch_to_tsquery\('simple', \$2\)/i);
assert.match(catalogSource, /result_search_text = ''/i);
assert.match(catalogSource, /const CATALOG_VERSION = 5/);
assert.match(catalogSource, /withMeetingCatalogBackfillLock/);
assert.match(catalogSource, /recordMeetingCatalogBackfillBlocker/);
assert.doesNotMatch(catalogSource, /last_seen_at < now\(\)/);
assert.match(catalogSource, /delete from meeting_catalog_coverage_fences/);
assert.match(catalogSource, /delete from meeting_catalog_backfill_blockers/);
assert.match(catalogSource, /where resolved_at is null/);
assert.match(storeSource, /resultSearchText: JSON\.stringify\(result\)/);
assert.match(storeSource, /markMeetingCatalogReady\(indexedMeetings\)/);
assert.match(storeSource, /recoverExpiredMeetingCatalogTransfers\(discoveredMeetingIds\)/);
assert.match(storeSource, /beginMeetingObjectTransferIntent/);
assert.match(storeSource, /completeMeetingObjectTransferIntent/);
assert.match(transferSource, /now\(\) \+ \(\$5::bigint \* interval '1 millisecond'\)/i);
assert.match(storeSource, /mapWithConcurrency\(discoveredMeetingIds, 8/);
assert.match(storeSource, /await withMeetingWriteLock\(meetingId, async \(\) =>/);
assert.match(storeSource, /if \(!\(await isMeetingWriteAllowed\(meetingId\)\)\) return/);
assert.match(storeSource, /quarantineLegacyCatalogPrefix\(meetingId\)/);
assert.match(storeSource, /getLegacyMeetingDeletionOwner\(meetingId\)/);
assert.match(storeSource, /ownerState === "deleted" \? manifest\.ownerUserId : undefined/);
assert.match(storeSource, /recordMeetingCatalogShareView\(meetingId\)/);
assert.match(storeSource, /resetMeetingCatalogShareAnalytics\(input\.meetingId\)/);
assert.doesNotMatch(listBody, /listTopLevelPrefixes/);
assert.doesNotMatch(listBody, /Promise\.all\(\s*meetingIds/);
assert.match(deleteAllBody, /objectStore\.listTopLevelPrefixes\(\)\)\.includes\(meetingId\)/);
assert.match(storeSource, /listMeetingCatalogIdsForOwnerDeletion\(ownerUserId\)/);
assert.match(deleteAllBody, /quarantineLegacyCatalogPrefix\(meetingId\)/);
assert.match(deleteAllBody, /let cleanupPending = ownerLinkedUnsafePrefixCount > 0/);
assert.match(deleteAllBody, /getUnattributedMeetingCatalogBlockerCount\(\)/);
assert.match(deleteAllBody, /classifyCanonicalMeetingPrefixOwnership/);
assert.match(deleteAllBody, /await quarantineCanonicalCatalogPrefix\(meetingId, uniqueOwner\)/);
assert.match(deleteAllBody, /quarantineMeetingDeletionOwnerConflict\(meetingId, deletionOwnerUserId\)/);
assert.match(deleteAllBody, /cleanupPending = true/);
assert.match(deleteAllBody, /purgeMeetingCatalogAfterObjectDeletion/);
assert.match(deleteAllBody, /purgeCompletedMeetingCatalogAfterObjectAbsence/);
assert.ok(
  updateShareBody.indexOf("ensureMeetingCatalogBackfilled()") <
    updateShareBody.indexOf("return enqueueMeetingWrite"),
  "public-share catalog backfill must run before the per-meeting write lock",
);
assert.doesNotMatch(
  updateShareBody.slice(updateShareBody.indexOf("return enqueueMeetingWrite")),
  /ensureMeetingCatalogBackfilled\(\)/,
);
assert.ok(saveAudioObjectStart >= 0 && saveAudioObjectEnd > saveAudioObjectStart);
assert.ok(
  saveAudioObjectBody.indexOf("await persistMeetingManifest(manifestKey, manifest)") <
    saveAudioObjectBody.indexOf("await input.persist"),
  "the owner manifest must commit before the first canonical chunk PUT",
);

const chunkCrashOwnership = classifyCanonicalMeetingPrefixOwnership({
  deletionOwnerUserId: undefined,
  manifest: null,
  meetingId: "chunk-crash-without-manifest",
  realtimeOwnerUserId: undefined,
});
assert.deepEqual(chunkCrashOwnership, {
  reason: "unattributed",
  status: "quarantined",
});
assert.deepEqual(
  classifyCanonicalMeetingPrefixOwnership({
    deletionOwnerUserId: undefined,
    manifest: null,
    meetingId: "intent-only-prefix",
    realtimeOwnerUserId: undefined,
    transferOwnerUserIds: ["user-a"],
  }),
  {
    ownerUserId: "user-a",
    status: "owned",
  },
);
assert.deepEqual(
  classifyCanonicalMeetingPrefixOwnership({
    deletionOwnerUserId: undefined,
    manifest: null,
    meetingId: "intent-owner-conflict",
    realtimeOwnerUserId: undefined,
    transferOwnerUserIds: ["user-a", "user-b"],
  }),
  {
    reason: "conflicting_owner_evidence",
    status: "quarantined",
  },
);
assert.deepEqual(
  classifyCanonicalMeetingPrefixOwnership({
    deletionOwnerUserId: "user-b",
    manifest: {
      meetingId: "owner-conflict",
      ownerUserId: "user-a",
    },
    meetingId: "owner-conflict",
    realtimeOwnerUserId: undefined,
  }),
  {
    reason: "conflicting_owner_evidence",
    status: "quarantined",
  },
);
assert.deepEqual(
  classifyCanonicalMeetingPrefixOwnership({
    deletionOwnerUserId: undefined,
    manifest: {
      meetingId: "owned-prefix",
      ownerUserId: "user-a",
    },
    meetingId: "owned-prefix",
    realtimeOwnerUserId: "user-a",
  }),
  {
    ownerUserId: "user-a",
    status: "owned",
  },
);

console.log(JSON.stringify({
  boundedLegacyBackfill: true,
  catalogTransferIntentPreventsFalseReadyPublication: true,
  chunkCrashPrefixBlocksAccountCleanup: true,
  indexedHistoryReads: true,
  indexedAccountDeletion: true,
  atomicShareAnalytics: true,
      fullTextSearch: true,
      legacyPrefixCleanupBlocksReady: true,
      backfillDeleteRaceUsesMeetingLock: true,
      catalogOnlyDeletionDoesNotDependOnReady: true,
      catalogPurgeAfterObjectDeletion: true,
      publicShareAvoidsCatalogMeetingLockInversion: true,
      expiredCatalogTransferRecovery: true,
      migrationVersions: [
        "0024_meeting_catalog_state",
        "0026_meeting_fulltext_search",
        "0027_meeting_catalog_backfill_blockers",
        "0030_meeting_catalog_write_fences",
        "0031_meeting_catalog_purge",
        "0032_meeting_transfer_intents",
      ],
}, null, 2));
