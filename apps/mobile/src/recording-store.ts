import * as FileSystem from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";
import {
  AtomicIndexPaths,
  AtomicTextStore,
  createSerialExecutor,
  readAtomicArrayIndex,
  writeAtomicArrayIndex,
} from "./atomic-recording-index";
import { withRecordingStoreTimeout } from "./recording-store-timeout";
import type { RecordingConsentMethod, UserProcessingMode } from "./types";

const legacyPendingRecordingKey = "ownminutes_pending_recording";
const localDeletionJournalKey = "ownminutes_local_deletion_journal_v1";
const realtimeSessionJournalKey = "ownminutes_realtime_session_journal_v1";
const realtimeSessionJournalQuarantineKey = "ownminutes_realtime_session_journal_quarantined_v1";
const recordingDirectoryName = "ownminutes-recordings";
const indexFileName = "index.json";
const runRecordingStoreMutation = createSerialExecutor();
const minimumRecoverableRecordingBytes = 4 * 1024;
export const recordingStoreFileProbeTimeoutMs = 2_500;
export const recordingStoreProbeConcurrency = 5;
const orphanMatchMaximumDistanceMs = 6 * 60 * 60 * 1000;
const localDeletionTombstoneRetentionMs = 7 * 24 * 60 * 60 * 1000;
const orphanRecordingNamePattern = /^recording-[^/]+\.(caf|wav|mp3|ogg|opus|webm|aac|m4a)$/i;
const managedRecordingNamePattern = /^[a-zA-Z0-9_-]{1,192}\.(caf|wav|mp3|ogg|opus|webm|aac|m4a)$/i;

type LocalDeletionJournalEntry = {
  completedAt?: string;
  createdAt: string;
  kind: "account" | "meeting";
  meetingId?: string;
  userId?: string;
};

type LocalDeletionJournal = {
  entries: LocalDeletionJournalEntry[];
  version: 1;
};

export type PendingRealtimeSession = {
  consentConfirmedAt?: string;
  consentMethod?: RecordingConsentMethod;
  consentPolicyVersion?: string;
  createdAt: string;
  meetingId: string;
  processingMode: UserProcessingMode;
  realtimeClosePendingAt: string;
  title?: string;
  updatedAt: string;
  uri?: string;
  userId?: string;
};

type RealtimeSessionJournal = {
  entries: PendingRealtimeSession[];
  version: 1;
};

export type PendingRecording = {
  activeRecording?: boolean;
  audioUploadedAt?: string;
  consentConfirmedAt?: string;
  consentMethod?: RecordingConsentMethod;
  consentPolicyVersion?: string;
  createdAt: string;
  durationMs?: number;
  finalizedAt?: string;
  lastUploadError?: string;
  localDeletionCompletedAt?: string;
  localDeletionPendingAt?: string;
  localRecoveryOnly?: boolean;
  meetingId: string;
  mimeType?: string;
  nextRetryAt?: string;
  /**
   * Frozen when the recording starts. Undefined means a pre-Build 11 record
   * whose processing route is genuinely unknown and must be chosen by the
   * user before any cloud processing is attempted.
   */
  processingMode?: UserProcessingMode;
  /**
   * Set before realtime audio can be sent and cleared only after the server
   * confirms that the realtime session is absent or completed. This makes
   * provider-session cleanup durable across offline stops and process crashes.
   */
  realtimeClosePendingAt?: string;
  recoverySourceUris?: string[];
  recordingUploadId?: string;
  recordingUploadedParts?: number;
  recordingTotalParts?: number;
  recordingRecordedAt?: number;
  title?: string;
  uploadAttempts?: number;
  userId?: string;
  updatedAt: string;
  uri: string;
};

type RecordingFileProbe = {
  available: boolean;
  exists: boolean;
  modificationTimeMs?: number;
  size: number;
  uri: string;
};

type RootOrphanRecording = RecordingFileProbe & {
  available: true;
  exists: true;
};

function recordingDirectory() {
  if (!FileSystem.documentDirectory) {
    throw new Error("设备文档目录不可用，无法安全保存录音。");
  }
  return `${FileSystem.documentDirectory}${recordingDirectoryName}/`;
}

function recordingIndexPath() {
  return `${recordingDirectory()}${indexFileName}`;
}

function recordingIndexPaths(): AtomicIndexPaths {
  const primary = recordingIndexPath();
  return {
    backup: `${primary}.backup`,
    backupTemporary: `${primary}.backup.tmp`,
    primary,
    temporary: `${primary}.tmp`,
  };
}

async function ensureRecordingDirectory() {
  await FileSystem.makeDirectoryAsync(recordingDirectory(), { intermediates: true });
}

const atomicTextStore: AtomicTextStore = {
  async copy(from, to) {
    await FileSystem.copyAsync({ from, to });
  },
  async exists(path) {
    return (await FileSystem.getInfoAsync(path)).exists;
  },
  async move(from, to) {
    await FileSystem.moveAsync({ from, to });
  },
  async read(path) {
    return FileSystem.readAsStringAsync(path);
  },
  async remove(path) {
    await FileSystem.deleteAsync(path, { idempotent: true });
  },
  async write(path, contents) {
    await FileSystem.writeAsStringAsync(path, contents);
  },
};

async function readIndexFile() {
  await ensureRecordingDirectory();
  return readAtomicArrayIndex(atomicTextStore, recordingIndexPaths(), isPendingRecording);
}

async function writeIndexFile(recordings: PendingRecording[]) {
  await ensureRecordingDirectory();
  await writeAtomicArrayIndex(atomicTextStore, recordingIndexPaths(), recordings, isPendingRecording);
}

async function readLocalDeletionJournal(): Promise<LocalDeletionJournal> {
  const stored = await SecureStore.getItemAsync(localDeletionJournalKey);
  if (!stored) return { entries: [], version: 1 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error("本机删除保护记录损坏，已停止展示和同步本地录音。");
  }
  if (!isLocalDeletionJournal(parsed)) {
    throw new Error("本机删除保护记录无效，已停止展示和同步本地录音。");
  }
  return pruneLocalDeletionJournal(parsed);
}

async function writeLocalDeletionJournal(journal: LocalDeletionJournal) {
  await SecureStore.setItemAsync(localDeletionJournalKey, JSON.stringify(pruneLocalDeletionJournal(journal)));
}

async function readRealtimeSessionJournal(): Promise<RealtimeSessionJournal> {
  const stored = await SecureStore.getItemAsync(realtimeSessionJournalKey);
  if (!stored) return { entries: [], version: 1 };
  return parseRealtimeSessionJournal(stored);
}

function parseRealtimeSessionJournal(stored: string): RealtimeSessionJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error("实时录音恢复记录损坏，已停止启动实时转写以保护本机原音。");
  }
  if (!isRealtimeSessionJournal(parsed)) {
    throw new Error("实时录音恢复记录无效，已停止启动实时转写以保护本机原音。");
  }
  return parsed;
}

async function readRealtimeSessionJournalForRecovery(): Promise<{
  journal: RealtimeSessionJournal;
  unrecoverable: boolean;
}> {
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(realtimeSessionJournalKey);
  } catch {
    return {
      journal: { entries: [], version: 1 },
      unrecoverable: true,
    };
  }

  if (!stored) {
    const quarantined = await SecureStore.getItemAsync(realtimeSessionJournalQuarantineKey)
      .then(Boolean, () => true);
    return {
      journal: { entries: [], version: 1 },
      unrecoverable: quarantined,
    };
  }

  try {
    const journal = parseRealtimeSessionJournal(stored);
    await SecureStore.deleteItemAsync(realtimeSessionJournalQuarantineKey).catch(() => undefined);
    return { journal, unrecoverable: false };
  } catch {
    await quarantineRealtimeSessionJournal(stored.length);
    return {
      journal: { entries: [], version: 1 },
      unrecoverable: true,
    };
  }
}

async function quarantineRealtimeSessionJournal(storedLength: number) {
  // SecureStore may reject large values on some platforms. Keep only a small
  // encrypted marker, then remove the active key so a corrupt auxiliary
  // journal cannot repeatedly block the durable recording index.
  const quarantined = await SecureStore.setItemAsync(
    realtimeSessionJournalQuarantineKey,
    JSON.stringify({
      quarantinedAt: new Date().toISOString(),
      reason: "invalid_realtime_session_journal",
      storedLength,
      version: 1,
    }),
  ).then(
    () => true,
    () => false,
  );
  if (quarantined) {
    await SecureStore.deleteItemAsync(realtimeSessionJournalKey).catch(() => undefined);
  }
}

async function writeRealtimeSessionJournal(journal: RealtimeSessionJournal) {
  if (journal.entries.length === 0) {
    await SecureStore.deleteItemAsync(realtimeSessionJournalKey);
    return;
  }
  await SecureStore.setItemAsync(realtimeSessionJournalKey, JSON.stringify(journal));
  await SecureStore.deleteItemAsync(realtimeSessionJournalQuarantineKey).catch(() => undefined);
}

function pruneRealtimeSessionJournalForLocalDeletions(
  journal: RealtimeSessionJournal,
  deletionJournal: LocalDeletionJournal,
  recordings: PendingRecording[],
) {
  const entries = journal.entries.filter((entry) => {
    if (localDeletionIntentForRecording(entry, deletionJournal)) return false;
    return !recordings.some(
      (recording) =>
        Boolean(recording.localDeletionPendingAt) &&
        recording.meetingId === entry.meetingId &&
        (!recording.userId || recording.userId === entry.userId),
    );
  });
  return entries.length === journal.entries.length
    ? journal
    : { entries, version: 1 as const };
}

async function pruneStoredRealtimeSessionsForLocalDeletions(
  deletionJournal: LocalDeletionJournal,
  recordings: PendingRecording[],
) {
  const journal = await readRealtimeSessionJournal();
  const next = pruneRealtimeSessionJournalForLocalDeletions(journal, deletionJournal, recordings);
  if (next !== journal) await writeRealtimeSessionJournal(next);
}

export async function preparePendingRealtimeSession(
  input: Omit<PendingRealtimeSession, "realtimeClosePendingAt" | "updatedAt"> & {
    realtimeClosePendingAt?: string;
    updatedAt?: string;
  },
) {
  return runRecordingStoreMutation(async () => {
    const journal = await readRealtimeSessionJournal();
    const existing = journal.entries.find((entry) => entry.meetingId === input.meetingId);
    const now = new Date().toISOString();
    const entry: PendingRealtimeSession = {
      ...existing,
      ...input,
      consentConfirmedAt: input.consentConfirmedAt ?? existing?.consentConfirmedAt,
      consentMethod: normalizeConsentMethod(input.consentMethod ?? existing?.consentMethod),
      consentPolicyVersion: normalizeConsentPolicyVersion(
        input.consentPolicyVersion ?? existing?.consentPolicyVersion,
      ),
      createdAt: existing?.createdAt ?? input.createdAt,
      processingMode: input.processingMode,
      realtimeClosePendingAt:
        existing?.realtimeClosePendingAt ??
        input.realtimeClosePendingAt ??
        input.createdAt,
      title: normalizePendingTitle(input.title ?? existing?.title),
      updatedAt: input.updatedAt ?? now,
      uri: input.uri ?? existing?.uri,
      userId: input.userId ?? existing?.userId,
    };
    const next = {
      entries: [entry, ...journal.entries.filter((item) => item.meetingId !== entry.meetingId)],
      version: 1 as const,
    };
    await writeRealtimeSessionJournal(next);
    return entry;
  });
}

export async function attachPendingRealtimeSessionUri(meetingId: string, uri: string) {
  return runRecordingStoreMutation(async () => {
    const journal = await readRealtimeSessionJournal();
    const existing = journal.entries.find((entry) => entry.meetingId === meetingId);
    if (!existing) return null;
    const entry = {
      ...existing,
      updatedAt: new Date().toISOString(),
      uri,
    };
    await writeRealtimeSessionJournal({
      entries: [entry, ...journal.entries.filter((item) => item.meetingId !== meetingId)],
      version: 1,
    });
    return entry;
  });
}

export async function completePendingRealtimeSession(meetingId: string) {
  return runRecordingStoreMutation(async () => {
    const journal = await readRealtimeSessionJournal();
    const entries = journal.entries.filter((entry) => entry.meetingId !== meetingId);
    await writeRealtimeSessionJournal({ entries, version: 1 });
    return entries;
  });
}

function pruneLocalDeletionJournal(journal: LocalDeletionJournal): LocalDeletionJournal {
  const now = Date.now();
  return {
    version: 1,
    entries: journal.entries.filter((entry) => {
      if (!entry.completedAt) return true;
      const completedAt = Date.parse(entry.completedAt);
      return !Number.isFinite(completedAt) || now - completedAt < localDeletionTombstoneRetentionMs;
    }),
  };
}

function isLocalDeletionJournal(value: unknown): value is LocalDeletionJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Partial<LocalDeletionJournal>;
  return journal.version === 1 && Array.isArray(journal.entries) && journal.entries.every(isLocalDeletionJournalEntry);
}

function isLocalDeletionJournalEntry(value: unknown): value is LocalDeletionJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<LocalDeletionJournalEntry>;
  if ((entry.kind !== "meeting" && entry.kind !== "account") || !isJournalTimestamp(entry.createdAt)) return false;
  if (entry.completedAt !== undefined && !isJournalTimestamp(entry.completedAt)) return false;
  if (entry.kind === "meeting") return isJournalIdentifier(entry.meetingId);
  return isJournalIdentifier(entry.userId);
}

function isRealtimeSessionJournal(value: unknown): value is RealtimeSessionJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Partial<RealtimeSessionJournal>;
  return journal.version === 1 &&
    Array.isArray(journal.entries) &&
    journal.entries.every(isPendingRealtimeSession);
}

function isPendingRealtimeSession(value: unknown): value is PendingRealtimeSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<PendingRealtimeSession>;
  return isJournalIdentifier(entry.meetingId) &&
    isJournalTimestamp(entry.createdAt) &&
    isJournalTimestamp(entry.updatedAt) &&
    isJournalTimestamp(entry.realtimeClosePendingAt) &&
    normalizeProcessingMode(entry.processingMode) !== undefined &&
    (entry.consentConfirmedAt === undefined || isJournalTimestamp(entry.consentConfirmedAt)) &&
    (entry.consentMethod === undefined || normalizeConsentMethod(entry.consentMethod) === entry.consentMethod) &&
    (entry.consentPolicyVersion === undefined || normalizeConsentPolicyVersion(entry.consentPolicyVersion) === entry.consentPolicyVersion) &&
    (entry.title === undefined || typeof entry.title === "string") &&
    (entry.uri === undefined || (typeof entry.uri === "string" && entry.uri.length > 0)) &&
    (entry.userId === undefined || isJournalIdentifier(entry.userId));
}

function isJournalTimestamp(value: unknown) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isJournalIdentifier(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 192;
}

function upsertMeetingDeletionIntent(
  journal: LocalDeletionJournal,
  meetingId: string,
  userId?: string,
): LocalDeletionJournal {
  const createdAt = new Date().toISOString();
  const existing = journal.entries.find((entry) => entry.kind === "meeting" && entry.meetingId === meetingId);
  const entry: LocalDeletionJournalEntry = {
    ...existing,
    completedAt: undefined,
    createdAt: existing?.createdAt ?? createdAt,
    kind: "meeting",
    meetingId,
    userId: userId || existing?.userId,
  };
  return {
    version: 1,
    entries: [entry, ...journal.entries.filter((item) => item !== existing)],
  };
}

function upsertAccountDeletionIntent(journal: LocalDeletionJournal, userId: string): LocalDeletionJournal {
  const createdAt = new Date().toISOString();
  const existing = journal.entries.find((entry) => entry.kind === "account" && entry.userId === userId);
  const entry: LocalDeletionJournalEntry = {
    ...existing,
    completedAt: undefined,
    createdAt: existing?.createdAt ?? createdAt,
    kind: "account",
    userId,
  };
  return {
    version: 1,
    entries: [entry, ...journal.entries.filter((item) => item !== existing)],
  };
}

function applyLocalDeletionJournal(
  recordings: PendingRecording[],
  journal: LocalDeletionJournal,
): PendingRecording[] {
  return recordings.map((recording) => {
    const intent = localDeletionIntentForRecording(recording, journal);
    if (!intent) return recording;
    return {
      ...recording,
      activeRecording: false,
      localDeletionPendingAt: recording.localDeletionPendingAt ?? intent.createdAt,
      nextRetryAt: undefined,
    };
  });
}

function localDeletionIntentForRecording(
  recording: Pick<PendingRecording, "meetingId" | "userId">,
  journal: LocalDeletionJournal,
) {
  return journal.entries.find((entry) => {
    if (entry.kind === "meeting") {
      return entry.meetingId === recording.meetingId &&
        (!entry.userId || entry.userId === recording.userId);
    }
    return Boolean(recording.userId) && entry.userId === recording.userId;
  });
}

function completeResolvedLocalDeletionIntents(
  journal: LocalDeletionJournal,
  recordings: PendingRecording[],
): LocalDeletionJournal {
  const completedAt = new Date().toISOString();
  return {
    version: 1,
    entries: journal.entries.map((entry) => {
      const matches = recordings.filter((recording) => journalEntryMatchesRecording(entry, recording));
      const unresolved = matches.some((recording) => !recording.localDeletionCompletedAt);
      return unresolved || entry.completedAt ? entry : { ...entry, completedAt };
    }),
  };
}

function journalEntryMatchesRecording(entry: LocalDeletionJournalEntry, recording: PendingRecording) {
  if (entry.kind === "meeting") {
    return entry.meetingId === recording.meetingId &&
      (!entry.userId || entry.userId === recording.userId);
  }
  return Boolean(recording.userId) && entry.userId === recording.userId;
}

export type RecordingRecoveryNotice = {
  indexRecovered: boolean;
  localCleanupCount: number;
  orphanMatchedCount: number;
  relocatedCount: number;
};

export type RecordingRecoveryIssue = {
  count: number;
  kind:
    | "deletion_journal_completion_pending"
    | "indexed_file_inaccessible"
    | "index_unrecoverable"
    | "isolated_recording"
    | "local_cleanup_pending"
    | "orphan_directory_inaccessible"
    | "orphan_file_inaccessible"
    | "realtime_journal_unrecoverable"
    | "undersized_recording";
};

export async function loadPendingRecordings(): Promise<{
  issues?: RecordingRecoveryIssue[];
  recordings: PendingRecording[];
  notice?: RecordingRecoveryNotice;
}> {
  return runRecordingStoreMutation(async () => {
    let deletionJournal = await readLocalDeletionJournal();
    const realtimeJournalRead = await readRealtimeSessionJournalForRecovery();
    let realtimeJournal = realtimeJournalRead.journal;
    const index = await readIndexFile();
    const legacy = await readLegacyRecording();
    const durableIndexRecords = legacy ? upsertInMemory(index.records, legacy) : index.records;
    const prunedRealtimeJournal = pruneRealtimeSessionJournalForLocalDeletions(
      realtimeJournal,
      deletionJournal,
      durableIndexRecords,
    );
    if (prunedRealtimeJournal !== realtimeJournal) {
      realtimeJournal = prunedRealtimeJournal;
      await writeRealtimeSessionJournal(realtimeJournal).catch(() => undefined);
    }
    const merged = applyLocalDeletionJournal(
      mergePendingRealtimeSessions(
        durableIndexRecords
          .map(normalizePendingRecordingConsent)
          .map(quarantineOwnerlessRecording),
        realtimeJournal,
      ),
      deletionJournal,
    );
    const issues: RecordingRecoveryIssue[] = realtimeJournalRead.unrecoverable
      ? [{ count: 1, kind: "realtime_journal_unrecoverable" }]
      : [];
    const deletionCleanup = index.source === "unrecoverable"
      ? { cleanedCount: 0, pendingCount: 0, recordings: merged }
      : await retryLocalDeletionPendingRecordings(merged);
    if (deletionCleanup.pendingCount > 0) {
      issues.push({ count: deletionCleanup.pendingCount, kind: "local_cleanup_pending" });
    }
    const deletionTombstones = deletionCleanup.recordings.filter((recording) => recording.localDeletionPendingAt);
    const normalized = visiblePendingRecordings(deletionCleanup.recordings).map((recording) => ({
      ...recording,
      mimeType: recording.mimeType ?? audioMimeTypeForUri(recording.uri),
    }));
    const relocation = await relocateManagedRecordingUris(normalized);
    const relocated = relocation.recordings;
    if (relocation.relocatedCount > 0) {
      // Commit path repairs before any later orphan/probe work. A slow or
      // interrupted scan on the same launch must not discard already-proven
      // TestFlight container migrations.
      await writeIndexFile([...relocated, ...deletionTombstones].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ));
    }
    const probes = await probeIndexedRecordings(relocated);
    // Deleted-recording tombstones remain authoritative for a bounded window.
    // Their URIs must stay known so the orphan scan cannot resurrect a file
    // while deletion is retrying or a late upload callback is still in flight.
    const knownUris = collectKnownRecordingUris(
      [...relocated, ...deletionTombstones].filter((recording) => !isRealtimeJournalPlaceholder(recording.uri)),
    );
    const orphanScan = await scanRootOrphanRecordings(knownUris);
    issues.push(...orphanScan.issues);
    const reconciliation = await reconcileRootOrphans(relocated, probes, orphanScan.recordings);
    if (index.source === "unrecoverable") {
      // A deletion journal is intentionally not completed while the main index
      // is unreadable. It remains an independent cold-start fence, including
      // for isolated root files discovered only after the index read failed.
      const recordings = visiblePendingRecordings(
        applyLocalDeletionJournal(reconciliation.recordings, deletionJournal),
      ).filter(
        (recording) => !isRealtimeJournalPlaceholder(recording.uri),
      ).sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      realtimeJournal = attachRecoveredRealtimeSessionUris(realtimeJournal, recordings);
      await writeRealtimeSessionJournal(realtimeJournal).catch(() => undefined);
      issues.unshift({ count: reconciliation.isolatedCount, kind: "index_unrecoverable" });
      return {
        issues: createRecoveryIssues(issues),
        recordings,
        notice: createRecoveryNotice({
          indexRecovered: false,
          localCleanupCount: deletionCleanup.cleanedCount,
          orphanMatchedCount: 0,
          relocatedCount: relocation.relocatedCount,
        }),
      };
    }

    // Re-apply the independent journal after orphan discovery. In particular,
    // an account deletion intent also owns legacy files with no userId; those
    // files must be fenced before an isolated recovery record can surface.
    const reconciledDeletionCleanup = await retryLocalDeletionPendingRecordings(
      applyLocalDeletionJournal(reconciliation.recordings, deletionJournal),
    );
    if (reconciledDeletionCleanup.pendingCount > 0) {
      issues.push({ count: reconciledDeletionCleanup.pendingCount, kind: "local_cleanup_pending" });
    }
    const recordings = visiblePendingRecordings(reconciledDeletionCleanup.recordings)
      .filter((recording) => !isRealtimeJournalPlaceholder(recording.uri))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const allDeletionRecords = [
      ...deletionTombstones,
      ...reconciledDeletionCleanup.recordings.filter((recording) => recording.localDeletionPendingAt),
    ];
    const finalProbes = await probeIndexedRecordings(recordings);
    const inaccessibleCount = [...finalProbes.values()].filter((probe) => !probe.exists).length;
    const undersizedCount = [...finalProbes.values()].filter(
      (probe) => probe.exists && probe.size < minimumRecoverableRecordingBytes,
    ).length;

    const visibleIsolatedCount = recordings.filter((recording) => recording.localRecoveryOnly).length;
    if (visibleIsolatedCount > 0) {
      issues.push({ count: visibleIsolatedCount, kind: "isolated_recording" });
    }
    if (inaccessibleCount > 0) {
      issues.push({ count: inaccessibleCount, kind: "indexed_file_inaccessible" });
    }
    if (undersizedCount > 0) {
      issues.push({ count: undersizedCount, kind: "undersized_recording" });
    }

    await writeIndexFile([...recordings, ...allDeletionRecords].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    ));
    realtimeJournal = attachRecoveredRealtimeSessionUris(realtimeJournal, recordings);
    await writeRealtimeSessionJournal(realtimeJournal).catch(() => undefined);
    deletionJournal = completeResolvedLocalDeletionIntents(deletionJournal, allDeletionRecords);
    await writeLocalDeletionJournal(deletionJournal).catch(() => {
      issues.push({ count: 1, kind: "deletion_journal_completion_pending" });
    });
    await SecureStore.deleteItemAsync(legacyPendingRecordingKey);
    return {
      issues: createRecoveryIssues(issues),
      recordings,
      notice: createRecoveryNotice({
        indexRecovered: index.source === "backup" || index.source === "temporary",
        localCleanupCount: deletionCleanup.cleanedCount + reconciledDeletionCleanup.cleanedCount,
        orphanMatchedCount: reconciliation.matchedCount,
        relocatedCount: relocation.relocatedCount,
      }),
    };
  });
}

function createRecoveryIssues(issues: RecordingRecoveryIssue[]) {
  const counts = new Map<RecordingRecoveryIssue["kind"], number>();
  for (const issue of issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + issue.count);
  const unique = [...counts].map(([kind, count]) => ({ count, kind }));
  return unique.length > 0 ? unique : undefined;
}

function createRecoveryNotice(notice: RecordingRecoveryNotice) {
  return notice.indexRecovered || notice.localCleanupCount > 0 || notice.orphanMatchedCount > 0 || notice.relocatedCount > 0
    ? notice
    : undefined;
}

async function relocateManagedRecordingUris(recordings: PendingRecording[]) {
  const documentDirectory = FileSystem.documentDirectory;
  if (!documentDirectory) {
    return {
      recordings,
      relocatedCount: 0,
    };
  }

  const destinations = recordings.map((recording) => currentManagedRecordingUri(recording.uri, documentDirectory));
  const destinationCandidateCounts = new Map<string, number>();
  const currentOwners = new Map<string, string[]>();
  recordings.forEach((recording, index) => {
    const destination = destinations[index];
    if (destination && destination !== recording.uri) {
      destinationCandidateCounts.set(destination, (destinationCandidateCounts.get(destination) ?? 0) + 1);
    }
    const owners = currentOwners.get(recording.uri) ?? [];
    owners.push(recording.meetingId);
    currentOwners.set(recording.uri, owners);
  });

  const results = await mapWithBoundedConcurrency(recordings, recordingStoreProbeConcurrency, async (recording, index) => {
    const destination = destinations[index];
    if (!destination || destination === recording.uri) {
      return { recording, relocated: false };
    }
    if ((destinationCandidateCounts.get(destination) ?? 0) !== 1) {
      return { recording, relocated: false };
    }
    const destinationOwners = (currentOwners.get(destination) ?? []).filter(
      (meetingId) => meetingId !== recording.meetingId,
    );
    if (destinationOwners.length > 0 || !destinationMatchesRecordingIdentity(recording, destination)) {
      return { recording, relocated: false };
    }

    // Only repair a path when the old URI is positively known to be missing.
    // A probe error may be transient, so guessing in that case could associate
    // the index with a different file.
    let sourceMissing = false;
    try {
      const sourceInfo = await probeRecordingFile(recording.uri);
      sourceMissing = !sourceInfo.exists;
    } catch {
      return { recording, relocated: false };
    }
    if (!sourceMissing) {
      return { recording, relocated: false };
    }

    try {
      const destinationInfo = await probeRecordingFile(destination);
      if (
        !destinationInfo.exists ||
        destinationInfo.isDirectory ||
        destinationInfo.size < minimumRecoverableRecordingBytes ||
        !destinationTimestampMatchesRecording(recording, destination, destinationInfo.modificationTime)
      ) {
        return { recording, relocated: false };
      }
    } catch {
      return { recording, relocated: false };
    }

    return {
      recording: {
        ...recording,
        mimeType: audioMimeTypeForUri(destination),
        recoverySourceUris: mergeRecoverySourceUris(recording.recoverySourceUris, recording.uri),
        uri: destination,
      },
      relocated: true,
    };
  });

  return {
    recordings: results.map((result) => result.recording),
    relocatedCount: results.filter((result) => result.relocated).length,
  };
}

function destinationMatchesRecordingIdentity(recording: PendingRecording, destination: string) {
  if (destination.includes(`/${recordingDirectoryName}/`)) {
    const fileName = destination.slice(destination.lastIndexOf("/") + 1);
    const stem = fileName.replace(/\.(caf|wav|mp3|ogg|opus|webm|aac|m4a)$/i, "");
    const meetingStem = sanitizeManagedRecordingName(recording.meetingId);
    return stem === meetingStem || stem.startsWith(`${meetingStem}-recovered-`);
  }
  return destination.includes("/ExpoAudio/");
}

function destinationTimestampMatchesRecording(
  recording: PendingRecording,
  destination: string,
  modificationTimeSeconds: number | undefined,
) {
  if (!destination.includes("/ExpoAudio/")) return true;
  const createdAt = Date.parse(recording.createdAt);
  const modificationTimeMs = Number(modificationTimeSeconds) * 1000;
  return Number.isFinite(createdAt) &&
    Number.isFinite(modificationTimeMs) &&
    Math.abs(modificationTimeMs - createdAt) <= orphanMatchMaximumDistanceMs;
}

function currentManagedRecordingUri(uri: string, documentDirectory: string) {
  const managedDirectoryMarker = `/${recordingDirectoryName}/`;
  const managedIndex = uri.lastIndexOf(managedDirectoryMarker);
  if (managedIndex >= 0) {
    const name = uri.slice(managedIndex + managedDirectoryMarker.length);
    return managedRecordingNamePattern.test(name)
      ? `${documentDirectory}${recordingDirectoryName}/${name}`
      : undefined;
  }

  const expoAudioDirectoryMarker = "/ExpoAudio/";
  const expoAudioIndex = uri.lastIndexOf(expoAudioDirectoryMarker);
  if (expoAudioIndex >= 0) {
    const name = uri.slice(expoAudioIndex + expoAudioDirectoryMarker.length);
    return orphanRecordingNamePattern.test(name)
      ? `${documentDirectory}ExpoAudio/${name}`
      : undefined;
  }

  return undefined;
}

export async function upsertPendingRecording(
  recording: Omit<PendingRecording, "updatedAt"> & { updatedAt?: string },
): Promise<PendingRecording[]> {
  return runRecordingStoreMutation(async () => {
    const deletionJournal = await readLocalDeletionJournal();
    const index = await readIndexFile();
    if (index.source === "unrecoverable") throw new Error("本地录音索引损坏，已停止写入以保护原音频。");
    const existing = index.records.find((item) => item.meetingId === recording.meetingId);
    if (existing && !existing.userId && recording.userId) {
      // Ownerless pre-upgrade audio has no trustworthy server owner proof.
      // A normal session callback must never turn it into the signed-in user's
      // meeting. This build intentionally provides no cloud-claim action.
      return visiblePendingRecordings(applyLocalDeletionJournal(index.records, deletionJournal));
    }
    if (
      existing?.localDeletionPendingAt ||
      (existing && localDeletionIntentForRecording(existing, deletionJournal)) ||
      localDeletionIntentForRecording(recording, deletionJournal)
    ) {
      // A remote delete already won. Ignore any late upload/finalize callback
      // that still holds a pre-delete snapshot of this recording.
      return visiblePendingRecordings(applyLocalDeletionJournal(index.records, deletionJournal));
    }
    const next = quarantineOwnerlessRecording(normalizePendingRecordingConsent({
      ...existing,
      ...recording,
      createdAt: existing?.createdAt ?? recording.createdAt,
      title: normalizePendingTitle(recording.title ?? existing?.title),
      userId: recording.userId ?? existing?.userId,
      updatedAt: recording.updatedAt ?? new Date().toISOString(),
    }));
    if (next.localRecoveryOnly) {
      next.activeRecording = true;
    }
    const recordings = upsertInMemory(index.records, next).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await writeIndexFile(recordings);
    return visiblePendingRecordings(applyLocalDeletionJournal(recordings, deletionJournal));
  });
}

export async function removePendingRecording(meetingId: string): Promise<PendingRecording[]> {
  return runRecordingStoreMutation(async () => {
    const deletionJournal = await readLocalDeletionJournal();
    const index = await readIndexFile();
    if (index.source === "unrecoverable") throw new Error("本地录音索引损坏，已停止删除以保护原音频。");
    const next = index.records.filter(
      (recording) => recording.meetingId !== meetingId || Boolean(recording.localDeletionPendingAt),
    );
    await writeIndexFile(next);
    return visiblePendingRecordings(applyLocalDeletionJournal(next, deletionJournal));
  });
}

export async function deleteLocalRecordingFromDevice(input: {
  expectedUserId: string | null;
  meetingId: string;
  uri: string;
}): Promise<{
  cleaned: boolean;
  pending: boolean;
  recordings: PendingRecording[];
}> {
  return runRecordingStoreMutation(async () => {
    const deletionJournal = await readLocalDeletionJournal();
    const index = await readIndexFile();
    if (index.source === "unrecoverable") throw new Error("本地录音索引损坏，已停止删除以保护原音频。");

    const existing = index.records.find((recording) => recording.meetingId === input.meetingId);
    if (!existing) {
      return {
        cleaned: true,
        pending: false,
        recordings: visiblePendingRecordings(applyLocalDeletionJournal(index.records, deletionJournal)),
      };
    }

    const ownerMatches = input.expectedUserId === null
      ? !existing.userId && existing.localRecoveryOnly === true
      : existing.userId === input.expectedUserId && existing.localRecoveryOnly !== true;
    if (!ownerMatches || existing.uri !== input.uri) {
      // The detail view may hold a stale snapshot after an account switch or
      // a container-path repair. Never turn that stale UI state into authority
      // to remove a different account's audio or a newly reconnected file.
      throw new Error("本机录音已发生变化，请返回列表刷新后重试。");
    }

    const marked: PendingRecording = {
      ...existing,
      activeRecording: false,
      lastUploadError: "用户已选择从本机永久删除，原音等待安全清理。",
      localDeletionPendingAt: existing.localDeletionPendingAt ?? new Date().toISOString(),
      nextRetryAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    const markedRecordings = upsertInMemory(index.records, marked).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );

    // Commit the no-sync/no-display fence before touching the file. If the
    // physical delete is interrupted, cold-start recovery retries it instead
    // of resurfacing or uploading a recording the user already deleted.
    await writeIndexFile(markedRecordings);
    await pruneStoredRealtimeSessionsForLocalDeletions(deletionJournal, markedRecordings)
      .catch(() => undefined);
    try {
      await deleteLocalRecordingCandidates(marked, markedRecordings);
    } catch {
      return { cleaned: false, pending: true, recordings: visiblePendingRecordings(markedRecordings) };
    }

    const completedRecords = upsertInMemory(markedRecordings, {
      ...marked,
      lastUploadError: undefined,
      localDeletionCompletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    try {
      await writeIndexFile(completedRecords);
      return {
        cleaned: true,
        pending: false,
        recordings: visiblePendingRecordings(applyLocalDeletionJournal(completedRecords, deletionJournal)),
      };
    } catch {
      // The pending marker is already durable and the file removal is
      // idempotent. A later launch will safely complete the tombstone write.
      return { cleaned: false, pending: true, recordings: visiblePendingRecordings(markedRecordings) };
    }
  });
}

export async function deletePendingRecordingAfterRemoteDelete(meetingId: string, userId?: string): Promise<{
  cleaned: boolean;
  pending: boolean;
  recordings: PendingRecording[];
}> {
  return runRecordingStoreMutation(async () => {
    let deletionJournal = upsertMeetingDeletionIntent(
      await readLocalDeletionJournal(),
      meetingId,
      userId,
    );
    // The independent journal is the cold-start fence. Commit it before the
    // main recording index so a failed index write cannot resurrect a meeting.
    await writeLocalDeletionJournal(deletionJournal);
    await pruneStoredRealtimeSessionsForLocalDeletions(deletionJournal, [])
      .catch(() => undefined);
    const index = await readIndexFile();
    if (index.source === "unrecoverable") throw new Error("本地录音索引损坏，已停止删除以保护原音频。");
    const existing = index.records.find((recording) => recording.meetingId === meetingId);
    if (!existing) {
      deletionJournal = completeResolvedLocalDeletionIntents(deletionJournal, index.records);
      await writeLocalDeletionJournal(deletionJournal).catch(() => undefined);
      return {
        cleaned: true,
        pending: false,
        recordings: visiblePendingRecordings(applyLocalDeletionJournal(index.records, deletionJournal)),
      };
    }
    if (userId && existing.userId !== userId) {
      // A server-side delete proves ownership only for the authenticated user.
      // It cannot authorize deleting ownerless legacy audio (or another local
      // account's audio) merely because the meeting IDs happen to collide.
      return {
        cleaned: false,
        pending: false,
        recordings: visiblePendingRecordings(
          applyLocalDeletionJournal(index.records.map(quarantineOwnerlessRecording), deletionJournal),
        ),
      };
    }

    const marked: PendingRecording = {
      ...existing,
      activeRecording: false,
      lastUploadError: "服务端会议已删除，本机原音等待安全清理。",
      localDeletionPendingAt: existing.localDeletionPendingAt ?? new Date().toISOString(),
      nextRetryAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    const markedRecordings = upsertInMemory(index.records, marked).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );

    // Persist the no-sync fence before touching the file. If the later file or
    // index operation fails, the next launch can retry without re-uploading a
    // recording whose server meeting has already been deleted.
    await writeIndexFile(markedRecordings);
    try {
      await deleteLocalRecordingCandidates(marked, markedRecordings);
    } catch {
      return { cleaned: false, pending: true, recordings: visiblePendingRecordings(markedRecordings) };
    }

    const completedTombstone: PendingRecording = {
      ...marked,
      lastUploadError: undefined,
      localDeletionCompletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const completedRecords = upsertInMemory(markedRecordings, completedTombstone).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    try {
      await writeIndexFile(completedRecords);
      deletionJournal = completeResolvedLocalDeletionIntents(deletionJournal, completedRecords);
      const journalCompleted = await writeLocalDeletionJournal(deletionJournal).then(
        () => true,
        () => false,
      );
      return {
        cleaned: journalCompleted,
        pending: !journalCompleted,
        recordings: visiblePendingRecordings(applyLocalDeletionJournal(completedRecords, deletionJournal)),
      };
    } catch {
      // The durable marker was committed before file deletion. Keep the
      // in-memory marker too; an idempotent startup retry will remove it.
      return { cleaned: false, pending: true, recordings: visiblePendingRecordings(markedRecordings) };
    }
  });
}

async function retryLocalDeletionPendingRecordings(recordings: PendingRecording[]) {
  const retained: PendingRecording[] = [];
  let cleanedCount = 0;
  let pendingCount = 0;
  const now = Date.now();
  for (const recording of recordings) {
    if (!recording.localDeletionPendingAt) {
      retained.push(recording);
      continue;
    }
    const completedAt = Date.parse(recording.localDeletionCompletedAt ?? "");
    if (Number.isFinite(completedAt)) {
      if (now - completedAt < localDeletionTombstoneRetentionMs) retained.push(recording);
      continue;
    }
    try {
      await deleteLocalRecordingCandidates(recording, recordings);
      retained.push({
        ...recording,
        lastUploadError: undefined,
        localDeletionCompletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      cleanedCount += 1;
    } catch {
      retained.push(recording);
      pendingCount += 1;
    }
  }
  return { cleanedCount, pendingCount, recordings: retained };
}

async function deleteLocalRecordingCandidates(
  recording: PendingRecording,
  allRecordings: PendingRecording[],
) {
  const candidates = recordingCandidateUris(recording);
  const occupiedByOtherMeetings = new Set<string>();
  for (const other of allRecordings) {
    if (other.meetingId === recording.meetingId || other.localDeletionPendingAt) continue;
    for (const uri of recordingCandidateUris(other)) occupiedByOtherMeetings.add(uri);
  }
  for (const uri of candidates) {
    // A damaged legacy index can point two meetings at the same file. Keep the
    // shared file for the surviving meeting instead of treating cleanup of the
    // deleted meeting as authority to unlink someone else's local original.
    if (occupiedByOtherMeetings.has(uri)) continue;
    await deleteRecordingFile(uri);
  }
}

function recordingCandidateUris(recording: PendingRecording) {
  const candidates = new Set([recording.uri, ...(recording.recoverySourceUris ?? [])]);
  if (FileSystem.documentDirectory) {
    for (const uri of [...candidates]) {
      if (!isControlledRecordingUri(uri)) continue;
      const currentUri = currentManagedRecordingUri(uri, FileSystem.documentDirectory);
      if (currentUri) candidates.add(currentUri);
    }
  }
  return new Set([...candidates].filter(isControlledRecordingUri));
}

function isControlledRecordingUri(uri: string) {
  if (!uri.startsWith("file:///") || /%(2f|5c)/i.test(uri)) return false;
  const path = uri.split(/[?#]/, 1)[0];
  const currentDocuments = FileSystem.documentDirectory?.split(/[?#]/, 1)[0];
  let relativePath: string | undefined;
  if (currentDocuments && path.toLowerCase().startsWith(currentDocuments.toLowerCase())) {
    relativePath = path.slice(currentDocuments.length);
  } else {
    // TestFlight updates replace the app-container UUID. Only recognize the
    // canonical historical iOS container layout, not an arbitrary URI that
    // happens to contain a directory named Documents.
    relativePath = path.match(/\/Containers\/Data\/Application\/[^/]+\/Documents\/(.+)$/i)?.[1];
  }
  if (!relativePath) return false;
  const normalizedRelativePath = relativePath.toLowerCase();

  if (normalizedRelativePath.startsWith(`${recordingDirectoryName}/`)) {
    return managedRecordingNamePattern.test(relativePath.slice(recordingDirectoryName.length + 1));
  }
  if (normalizedRelativePath.startsWith("expoaudio/")) {
    return orphanRecordingNamePattern.test(relativePath.slice("ExpoAudio/".length));
  }
  // Older recorder versions wrote directly under Documents. Keep only the
  // strict native recording filename, never an arbitrary indexed file path.
  return orphanRecordingNamePattern.test(relativePath);
}

export async function moveRecordingIntoManagedDirectory(meetingId: string, sourceUri: string): Promise<string> {
  await ensureRecordingDirectory();
  const safeMeetingId = sanitizeManagedRecordingName(meetingId);
  const extension = recordingExtension(sourceUri);
  const destination = `${recordingDirectory()}${safeMeetingId}${extension}`;
  if (sourceUri === destination) return destination;

  const sourceInfo = await probeRecordingFile(sourceUri);
  const destinationInfo = await probeRecordingFile(destination);
  if (!sourceInfo.exists || sourceInfo.isDirectory) {
    if (destinationInfo.exists && !destinationInfo.isDirectory) return destination;
    throw new Error("待保存的录音文件不存在，且托管目录中没有可恢复副本。");
  }

  if (!destinationInfo.exists) {
    await FileSystem.moveAsync({ from: sourceUri, to: destination });
    return destination;
  }

  if (!destinationInfo.isDirectory && destinationInfo.size >= sourceInfo.size) {
    return destination;
  }

  const recoveryStem = `${safeMeetingId}-recovered-${stableRecordingHash(`${sourceUri}:${sourceInfo.size}`)}`;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const recoveryDestination = `${recordingDirectory()}${recoveryStem}${suffix === 0 ? "" : `-${suffix}`}${extension}`;
    const recoveryInfo = await probeRecordingFile(recoveryDestination);
    if (!recoveryInfo.exists) {
      await FileSystem.moveAsync({ from: sourceUri, to: recoveryDestination });
      return recoveryDestination;
    }
    if (!recoveryInfo.isDirectory && recoveryInfo.size >= sourceInfo.size) {
      return recoveryDestination;
    }
  }

  throw new Error("托管目录存在过多同名恢复录音；原文件未删除，请联系支持处理。");
}

function probeRecordingFile(uri: string) {
  return withRecordingStoreTimeout(
    FileSystem.getInfoAsync(uri),
    recordingStoreFileProbeTimeoutMs,
  );
}

async function probeIndexedRecordings(recordings: PendingRecording[]) {
  const probes = new Map<string, RecordingFileProbe>();
  const results = await mapWithBoundedConcurrency(recordings, recordingStoreProbeConcurrency, async (recording) => {
    try {
      const fileInfo = await probeRecordingFile(recording.uri);
      if (fileInfo.exists) {
        return {
          available: true,
          exists: !fileInfo.isDirectory,
          modificationTimeMs: fileInfo.modificationTime * 1000,
          size: fileInfo.isDirectory ? 0 : fileInfo.size,
          uri: recording.uri,
        } satisfies RecordingFileProbe;
      }
      return {
        available: true,
        exists: false,
        size: 0,
        uri: recording.uri,
      } satisfies RecordingFileProbe;
    } catch {
      return {
        available: false,
        exists: false,
        size: 0,
        uri: recording.uri,
      } satisfies RecordingFileProbe;
    }
  });
  recordings.forEach((recording, index) => {
    probes.set(recording.meetingId, results[index]);
  });
  return probes;
}

async function mapWithBoundedConcurrency<T, Result>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<Result>,
) {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

type OrphanProbeResult = {
  inaccessible: boolean;
  recording?: RootOrphanRecording;
};

async function probeRootOrphanCandidates(candidates: string[]) {
  return mapWithBoundedConcurrency(candidates, recordingStoreProbeConcurrency, async (uri): Promise<OrphanProbeResult> => {
    try {
      const info = await probeRecordingFile(uri);
      if (!info.exists || info.isDirectory || info.size <= 0) return { inaccessible: false };
      return {
        inaccessible: false,
        recording: {
          available: true,
          exists: true,
          modificationTimeMs: info.modificationTime * 1000,
          size: info.size,
          uri,
        },
      };
    } catch {
      return { inaccessible: true };
    }
  });
}

function appendOrphanProbeResults(results: OrphanProbeResult[], recordings: RootOrphanRecording[]) {
  let inaccessibleCount = 0;
  for (const result of results) {
    if (result.recording) recordings.push(result.recording);
    if (result.inaccessible) inaccessibleCount += 1;
  }
  return inaccessibleCount;
}

function collectKnownRecordingUris(recordings: PendingRecording[]) {
  const known = new Set<string>();
  for (const recording of recordings) {
    known.add(recording.uri);
    for (const sourceUri of recording.recoverySourceUris ?? []) {
      if (sourceUri) known.add(sourceUri);
    }
  }
  return known;
}

async function scanRootOrphanRecordings(knownUris: Set<string>): Promise<{
  issues: RecordingRecoveryIssue[];
  recordings: RootOrphanRecording[];
}> {
  const documentDirectory = FileSystem.documentDirectory;
  if (!documentDirectory) {
    return {
      issues: [{ count: 1, kind: "orphan_directory_inaccessible" }],
      recordings: [],
    };
  }

  const recordings: RootOrphanRecording[] = [];
  let inaccessibleCount = 0;
  let inaccessibleDirectoryCount = 0;
  // Expo Audio writes under Documents/ExpoAudio, while recordings already
  // adopted by OwnMinutes live under Documents/ownminutes-recordings. A fully
  // corrupt index must scan all three controlled locations or managed audio is
  // invisible precisely when recovery is needed most.
  const recordingDirectories = [
    { directory: documentDirectory, pattern: orphanRecordingNamePattern, required: true },
    { directory: `${documentDirectory}ExpoAudio/`, pattern: orphanRecordingNamePattern, required: false },
    { directory: recordingDirectory(), pattern: managedRecordingNamePattern, required: false },
  ];
  for (const { directory, pattern, required } of recordingDirectories) {
    let entries: string[];
    try {
      entries = await FileSystem.readDirectoryAsync(directory);
    } catch {
      if (required) inaccessibleDirectoryCount += 1;
      continue;
    }
    const candidates = entries
      .filter((name) => pattern.test(name))
      .map((name) => `${directory}${name}`)
      .filter((uri) => !knownUris.has(uri));
    inaccessibleCount += appendOrphanProbeResults(
      await probeRootOrphanCandidates(candidates),
      recordings,
    );
  }

  recordings.sort((left, right) => {
    const timeDifference = (right.modificationTimeMs ?? 0) - (left.modificationTimeMs ?? 0);
    return timeDifference || right.size - left.size || left.uri.localeCompare(right.uri);
  });
  return {
    issues: [
      ...(inaccessibleDirectoryCount > 0
        ? [{ count: inaccessibleDirectoryCount, kind: "orphan_directory_inaccessible" as const }]
        : []),
      ...(inaccessibleCount > 0
        ? [{ count: inaccessibleCount, kind: "orphan_file_inaccessible" as const }]
        : []),
    ],
    recordings,
  };
}

async function reconcileRootOrphans(
  recordings: PendingRecording[],
  probes: Map<string, RecordingFileProbe>,
  rootOrphans: RootOrphanRecording[],
) {
  const next = [...recordings];
  const remaining = [...rootOrphans];
  let isolatedCount = 0;
  let matchedCount = 0;
  const candidates = next
    .map((recording, index) => ({
      index,
      priority: recoveryCandidatePriority(recording, probes.get(recording.meetingId)),
      recording,
    }))
    .filter((candidate) => candidate.priority !== null)
    .sort((left, right) =>
      (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER) ||
      left.recording.createdAt.localeCompare(right.recording.createdAt),
    );

  for (const candidate of candidates) {
    // Never guess when several broken indexes could claim the same orphan.
    // Ambiguous files remain local-only until the user explicitly associates
    // them with a meeting in a future recovery flow.
    if (candidates.length !== 1) break;
    const currentProbe = probes.get(candidate.recording.meetingId);
    const createdAt = Date.parse(candidate.recording.createdAt);
    const eligible = remaining
      .map((orphan, index) => ({
        distance:
          Number.isFinite(createdAt) && orphan.modificationTimeMs !== undefined
            ? Math.abs(orphan.modificationTimeMs - createdAt)
            : Number.POSITIVE_INFINITY,
        index,
        orphan,
      }))
      .filter(({ distance, orphan }) => {
        if (currentProbe?.exists && orphan.size <= currentProbe.size) return false;
        return !Number.isFinite(distance) || distance <= orphanMatchMaximumDistanceMs;
      })
      .sort((left, right) =>
        left.distance - right.distance || right.orphan.size - left.orphan.size || left.orphan.uri.localeCompare(right.orphan.uri),
      );
    const selected = eligible.length === 1 ? eligible[0] : undefined;
    if (!selected) continue;

    const [orphan] = remaining.splice(selected.index, 1);
    next[candidate.index] = recoveredRecording(candidate.recording, orphan.uri, orphan.uri);
    matchedCount += 1;
  }

  for (const orphan of remaining) {
    const meetingId = isolatedRecoveryMeetingId(orphan);
    if (next.some((recording) => recording.meetingId === meetingId)) continue;
    next.push(createIsolatedRecoveryRecording(orphan, orphan.uri));
    isolatedCount += 1;
  }

  return {
    isolatedCount,
    matchedCount,
    recordings: next,
  };
}

function recoveryCandidatePriority(recording: PendingRecording, probe: RecordingFileProbe | undefined) {
  if (recording.localRecoveryOnly) return null;
  if (recording.activeRecording && (!probe?.exists || probe.size < minimumRecoverableRecordingBytes)) return 0;
  // Never attach an orphan to a completed/non-active record, or replace a
  // valid non-trivial active file. Either choice could upload the wrong
  // conversation to an existing meeting. Unclaimed files stay quarantined.
  return null;
}

function recoveredRecording(recording: PendingRecording, sourceUri: string, durableUri: string): PendingRecording {
  return {
    ...recording,
    audioUploadedAt: undefined,
    finalizedAt: undefined,
    lastUploadError: "已从本机孤立音频恢复，等待重新上传。",
    mimeType: audioMimeTypeForUri(durableUri),
    nextRetryAt: undefined,
    recordingRecordedAt: undefined,
    recordingTotalParts: undefined,
    recordingUploadId: undefined,
    recordingUploadedParts: undefined,
    recoverySourceUris: mergeRecoverySourceUris(recording.recoverySourceUris, sourceUri),
    updatedAt: new Date().toISOString(),
    uploadAttempts: undefined,
    uri: durableUri,
  };
}

function createIsolatedRecoveryRecording(orphan: RootOrphanRecording, durableUri: string): PendingRecording {
  const timestamp = orphan.modificationTimeMs ?? Date.now();
  const createdAt = new Date(timestamp).toISOString();
  return {
    activeRecording: true,
    consentMethod: "legacy_unknown",
    createdAt,
    lastUploadError: "隔离恢复记录尚未关联服务器会议，不会自动上传；请先确认本地音频。",
    localRecoveryOnly: true,
    meetingId: isolatedRecoveryMeetingId(orphan),
    mimeType: audioMimeTypeForUri(durableUri),
    recoverySourceUris: [orphan.uri],
    title: `本地恢复录音 ${createdAt.slice(0, 16).replace("T", " ")}`,
    updatedAt: createdAt,
    uri: durableUri,
  };
}

function quarantineOwnerlessRecording(recording: PendingRecording): PendingRecording {
  if (recording.userId) return recording;
  return {
    ...recording,
    activeRecording: true,
    lastUploadError: "此设备旧版录音缺少可验证的账号归属，仅允许浏览、播放和导出，不会自动上传。",
    localRecoveryOnly: true,
    nextRetryAt: undefined,
  };
}

function isolatedRecoveryMeetingId(orphan: RootOrphanRecording) {
  return `local-recovery-${stableRecordingHash(
    `${orphan.uri}:${orphan.size}:${orphan.modificationTimeMs ?? 0}`,
  )}`;
}

function mergeRecoverySourceUris(existing: string[] | undefined, sourceUri: string) {
  return [...new Set([...(existing ?? []), sourceUri].filter(Boolean))].slice(-20);
}

function sanitizeManagedRecordingName(value: string) {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
  return normalized || `recording-${stableRecordingHash(value)}`;
}

function stableRecordingHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function audioMimeTypeForUri(uri: string) {
  const extension = recordingExtension(uri);
  if (extension === ".caf") return "audio/x-caf";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".ogg" || extension === ".opus") return "audio/ogg";
  if (extension === ".webm") return "audio/webm";
  if (extension === ".aac") return "audio/aac";
  return "audio/mp4";
}

export async function deleteRecordingFile(uri: string | null | undefined) {
  if (!uri) return;
  if (!isControlledRecordingUri(uri)) {
    throw new Error("已拒绝删除非 OwnMinutes 受控录音路径。");
  }
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

export async function deleteLocalRecordingsForUser(userId: string) {
  return runRecordingStoreMutation(async () => {
    let deletionJournal = upsertAccountDeletionIntent(await readLocalDeletionJournal(), userId);
    // Account deletion may invalidate the session immediately. Persist the
    // account-scoped fence first; ownerless legacy recovery is device data and
    // must remain outside every account's deletion scope.
    await writeLocalDeletionJournal(deletionJournal);
    await pruneStoredRealtimeSessionsForLocalDeletions(deletionJournal, [])
      .catch(() => undefined);
    const index = await readIndexFile();
    if (index.source === "unrecoverable") throw new Error("本地录音索引损坏，已停止删除以保护原音频。");
    const legacy = await readLegacyRecording();
    const allRecords = (legacy ? upsertInMemory(index.records, legacy) : index.records).map(quarantineOwnerlessRecording);
    const owned = allRecords.filter((recording) => recording.userId === userId);
    const remaining = allRecords.filter((recording) => recording.userId !== userId);
    const markedOwned = owned.map((recording): PendingRecording => ({
      ...recording,
      activeRecording: false,
      lastUploadError: "账号已删除，本机原音等待安全清理。",
      localDeletionPendingAt: recording.localDeletionPendingAt ?? new Date().toISOString(),
      nextRetryAt: undefined,
      updatedAt: new Date().toISOString(),
    }));
    const fencedRecords = [...remaining, ...markedOwned];
    await writeIndexFile(fencedRecords);

    const tombstones: PendingRecording[] = [];
    let pendingCount = 0;
    for (const recording of markedOwned) {
      try {
        await deleteLocalRecordingCandidates(recording, fencedRecords);
        tombstones.push({
          ...recording,
          lastUploadError: undefined,
          localDeletionCompletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch {
        tombstones.push(recording);
        pendingCount += 1;
      }
    }
    await writeIndexFile([...remaining, ...tombstones]);
    deletionJournal = completeResolvedLocalDeletionIntents(
      deletionJournal,
      [...remaining, ...tombstones],
    );
    const journalCompleted = await writeLocalDeletionJournal(deletionJournal).then(
      () => true,
      () => false,
    );
    await SecureStore.deleteItemAsync(legacyPendingRecordingKey);
    return {
      pendingCount: pendingCount + (journalCompleted ? 0 : 1),
      recordings: visiblePendingRecordings(applyLocalDeletionJournal(remaining, deletionJournal)),
    };
  });
}

async function readLegacyRecording(): Promise<PendingRecording | null> {
  const stored = await SecureStore.getItemAsync(legacyPendingRecordingKey);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as Partial<PendingRecording>;
    if (!parsed.meetingId || !parsed.uri) return null;
    const createdAt = parsed.createdAt ?? new Date().toISOString();
    return {
      activeRecording: parsed.activeRecording,
      audioUploadedAt: parsed.audioUploadedAt,
      consentConfirmedAt: normalizeConsentConfirmedAt(parsed.consentConfirmedAt),
      consentMethod: normalizeConsentMethod(parsed.consentMethod),
      consentPolicyVersion: normalizeConsentPolicyVersion(parsed.consentPolicyVersion),
      createdAt,
      durationMs: normalizeDurationMs(parsed.durationMs),
      finalizedAt: parsed.finalizedAt,
      lastUploadError: parsed.lastUploadError,
      meetingId: parsed.meetingId,
      mimeType: parsed.mimeType ?? audioMimeTypeForUri(parsed.uri),
      nextRetryAt: parsed.nextRetryAt,
      processingMode: normalizeProcessingMode(parsed.processingMode),
      recordingUploadId: normalizeUploadId(parsed.recordingUploadId),
      recordingUploadedParts: normalizePartCount(parsed.recordingUploadedParts),
      recordingTotalParts: normalizePartCount(parsed.recordingTotalParts),
      recordingRecordedAt: normalizeTimestamp(parsed.recordingRecordedAt),
      title: normalizePendingTitle(parsed.title),
      uploadAttempts: parsed.uploadAttempts,
      userId: parsed.userId,
      updatedAt: parsed.updatedAt ?? createdAt,
      uri: parsed.uri,
    };
  } catch {
    return null;
  }
}

function normalizePendingTitle(value: unknown) {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/g, " ").trim().slice(0, 80);
  return title || undefined;
}

function normalizeDurationMs(value: unknown) {
  const durationMs = Number(value);
  return Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : undefined;
}

function normalizePartCount(value: unknown) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 256 ? count : undefined;
}

function normalizeUploadId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,80}$/.test(value) ? value : undefined;
}

function normalizeTimestamp(value: unknown) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : undefined;
}

function normalizeProcessingMode(value: unknown): UserProcessingMode | undefined {
  return value === "official_quota" || value === "byok" ? value : undefined;
}

function recordingExtension(uri: string) {
  const pathname = uri.split(/[?#]/, 1)[0].toLowerCase();
  const match = pathname.match(/\.(caf|wav|mp3|ogg|opus|webm|aac|m4a)$/);
  return match ? `.${match[1]}` : ".m4a";
}

function upsertInMemory(recordings: PendingRecording[], recording: PendingRecording) {
  const existing = recordings.find((item) => item.meetingId === recording.meetingId);
  if (existing?.localDeletionPendingAt && !recording.localDeletionPendingAt) {
    return [existing, ...recordings.filter((item) => item.meetingId !== recording.meetingId)];
  }
  return [recording, ...recordings.filter((item) => item.meetingId !== recording.meetingId)];
}

function mergePendingRealtimeSessions(
  recordings: PendingRecording[],
  journal: RealtimeSessionJournal,
) {
  const journalByMeetingId = new Map(journal.entries.map((entry) => [entry.meetingId, entry]));
  const merged = recordings.map((recording) => {
    const entry = journalByMeetingId.get(recording.meetingId);
    if (!entry) return recording;
    journalByMeetingId.delete(recording.meetingId);
    const journalConsentMethod = normalizeConsentMethod(entry.consentMethod);
    const useJournalConsent =
      recording.consentMethod !== "in_app_confirmation" &&
      journalConsentMethod === "in_app_confirmation";
    return {
      ...recording,
      activeRecording: recording.finalizedAt ? recording.activeRecording : true,
      consentConfirmedAt: useJournalConsent
        ? normalizeConsentConfirmedAt(entry.consentConfirmedAt)
        : recording.consentConfirmedAt,
      consentMethod: useJournalConsent ? journalConsentMethod : recording.consentMethod,
      consentPolicyVersion: useJournalConsent
        ? normalizeConsentPolicyVersion(entry.consentPolicyVersion)
        : recording.consentPolicyVersion,
      processingMode: recording.processingMode ?? entry.processingMode,
      realtimeClosePendingAt:
        recording.realtimeClosePendingAt ??
        entry.realtimeClosePendingAt,
      title: recording.title ?? entry.title,
      userId: recording.userId ?? entry.userId,
    };
  });
  return [
    ...merged,
    ...[...journalByMeetingId.values()].map((entry): PendingRecording => ({
      activeRecording: true,
      consentConfirmedAt: normalizeConsentConfirmedAt(entry.consentConfirmedAt),
      consentMethod: normalizeConsentMethod(entry.consentMethod),
      consentPolicyVersion: normalizeConsentPolicyVersion(entry.consentPolicyVersion),
      createdAt: entry.createdAt,
      meetingId: entry.meetingId,
      processingMode: entry.processingMode,
      realtimeClosePendingAt: entry.realtimeClosePendingAt,
      title: entry.title,
      updatedAt: entry.updatedAt,
      uri: entry.uri ?? realtimeJournalPlaceholderUri(entry.meetingId),
      userId: entry.userId,
    })),
  ];
}

function realtimeJournalPlaceholderUri(meetingId: string) {
  return `ownminutes-realtime-journal://${encodeURIComponent(meetingId)}`;
}

function isRealtimeJournalPlaceholder(uri: string) {
  return uri.startsWith("ownminutes-realtime-journal://");
}

function attachRecoveredRealtimeSessionUris(
  journal: RealtimeSessionJournal,
  recordings: PendingRecording[],
): RealtimeSessionJournal {
  const recordingByMeetingId = new Map(recordings.map((recording) => [recording.meetingId, recording]));
  let changed = false;
  const entries = journal.entries.map((entry) => {
    const recording = recordingByMeetingId.get(entry.meetingId);
    if (!recording || isRealtimeJournalPlaceholder(recording.uri) || recording.uri === entry.uri) return entry;
    changed = true;
    return {
      ...entry,
      updatedAt: new Date().toISOString(),
      uri: recording.uri,
    };
  });
  return changed ? { entries, version: 1 } : journal;
}

function visiblePendingRecordings(recordings: PendingRecording[]) {
  return recordings.filter((recording) => !recording.localDeletionPendingAt);
}

function isPendingRecording(value: unknown): value is PendingRecording {
  if (!value || typeof value !== "object") return false;
  const recording = value as Partial<PendingRecording>;
  if (recording.processingMode !== undefined && !normalizeProcessingMode(recording.processingMode)) return false;
  if (recording.consentConfirmedAt !== undefined && !normalizeConsentConfirmedAt(recording.consentConfirmedAt)) return false;
  if (recording.consentMethod !== undefined && normalizeConsentMethod(recording.consentMethod) !== recording.consentMethod) return false;
  if (recording.consentPolicyVersion !== undefined && normalizeConsentPolicyVersion(recording.consentPolicyVersion) !== recording.consentPolicyVersion) return false;
  return Boolean(
    recording.meetingId &&
      recording.uri &&
      recording.createdAt &&
      recording.updatedAt,
  );
}

function normalizePendingRecordingConsent(recording: PendingRecording): PendingRecording {
  const consentMethod = normalizeConsentMethod(recording.consentMethod);
  if (consentMethod === "legacy_unknown") {
    return {
      ...recording,
      consentConfirmedAt: undefined,
      consentMethod,
      consentPolicyVersion: undefined,
    };
  }
  return {
    ...recording,
    consentConfirmedAt: normalizeConsentConfirmedAt(recording.consentConfirmedAt),
    consentMethod,
    consentPolicyVersion: normalizeConsentPolicyVersion(recording.consentPolicyVersion),
  };
}

function normalizeConsentMethod(value: unknown): RecordingConsentMethod {
  return value === "in_app_confirmation" ? value : "legacy_unknown";
}

function normalizeConsentConfirmedAt(value: unknown) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function normalizeConsentPolicyVersion(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : undefined;
}
