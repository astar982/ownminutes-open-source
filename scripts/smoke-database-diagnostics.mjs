#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";

async function main() {
  const response = await fetch(`${baseUrl}/api/database/diagnostics`, { cache: "no-store" });
  const payload = await readJson(response, "/api/database/diagnostics");
  const diagnostics = payload.diagnostics;
  const text = JSON.stringify(payload);
  const provider = diagnostics?.provider;
  const checks = diagnostics?.checks ?? [];
  const summary = {
    ok: payload.ok === true,
    provider,
    productionReady: diagnostics?.productionReady,
    checkCount: checks.length,
    hasCapabilities: Boolean(diagnostics?.capabilities && typeof diagnostics.capabilities === "object"),
    hasMigrationFiles: diagnostics?.configured?.migrationFiles === true,
    hasMigrationRunner: diagnostics?.configured?.migrationRunner === true,
    hasMigrationRunbook: typeof diagnostics?.configured?.migrationRunbook === "boolean" ? diagnostics.configured.migrationRunbook : false,
    hasRestoreDrillFlag: typeof diagnostics?.configured?.restoreDrill === "boolean",
    hasSslRequiredFlag: typeof diagnostics?.configured?.sslRequired === "boolean",
    hasLocalStoreDecisionFlag: typeof diagnostics?.configured?.localStoreDecision === "boolean",
    hasMeetingWriteFlags:
      typeof diagnostics?.configured?.crossInstanceMeetingWrites === "boolean" &&
      typeof diagnostics?.configured?.durableMeetingDeletionFence === "boolean",
    authRepository: diagnostics?.configured?.authRepository,
    supportsMigrationFiles: diagnostics?.capabilities?.supportsMigrationFiles === true,
    supportsMigrationRunner: diagnostics?.capabilities?.supportsMigrationRunner === true,
    hasRestoreDrillCapability: typeof diagnostics?.capabilities?.supportsRestoreDrillEvidence === "boolean",
    hasEncryptedTransportCapability: typeof diagnostics?.capabilities?.enforcesEncryptedTransport === "boolean",
    supportsPostgresRuntimeWrites: diagnostics?.capabilities?.supportsPostgresRuntimeWrites,
    supportsCrossInstanceMeetingWrites: diagnostics?.capabilities?.supportsCrossInstanceMeetingWrites,
    supportsDurableMeetingDeletionFence: diagnostics?.capabilities?.supportsDurableMeetingDeletionFence,
    migrationFilesCheckPass: checks.some((check) => check.id === "migration-files" && check.status === "pass"),
    migrationRunnerCheckPass: checks.some((check) => check.id === "migration-runner" && check.status === "pass"),
    authRepositoryBoundaryCheckPass: checks.some((check) => check.id === "auth-repository-boundary" && check.status === "pass"),
    hasMissingList: Array.isArray(diagnostics?.missing),
    localMissingAuditLog: provider === "local-file" ? diagnostics?.missing?.includes("OWNMINUTES_DB_AUDIT_LOG") : true,
    localMissingRestoreDrill: provider === "local-file" ? diagnostics?.missing?.includes("OWNMINUTES_DB_RESTORE_DRILL") : true,
    localMissingSsl: provider === "local-file" ? diagnostics?.missing?.includes("OWNMINUTES_DB_SSL_REQUIRED=1") : true,
    localMissingLocalStoreDecision: provider === "local-file" ? diagnostics?.missing?.includes("OWNMINUTES_DB_LOCAL_STORE_DECISION") : true,
    localMissingPostgresRuntimeWrites: provider === "local-file" ? diagnostics?.missing?.includes("OWNMINUTES_AUTH_REPOSITORY=postgres runtime writes") : true,
    localMissingMeetingWriteLock: provider === "local-file" ? diagnostics?.missing?.includes("OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory") : true,
    localMissingDeletionFence: provider === "local-file" ? diagnostics?.missing?.includes("meeting_deletion_tombstones migration/runtime fence") : true,
    restoreDrillCheckExists: checks.some((check) => check.id === "restore-drill"),
    sslCheckExists: checks.some((check) => check.id === "encrypted-transport"),
    localStoreDecisionCheckExists: checks.some((check) => check.id === "local-store-decision"),
    meetingWriteCoordinationCheckExists: checks.some((check) => check.id === "meeting-write-coordination"),
    statusesValid: checks.every((check) => ["pass", "fail", "manual"].includes(check.status)),
    localProviderBlocked: provider === "local-file" ? diagnostics?.productionReady === false : true,
    localStorePathRedacted: diagnostics?.localStorePath === ".data/auth/store.json",
    leaksSecrets:
      text.includes("postgres://") ||
      text.includes("postgresql://") ||
      text.includes("DATABASE_URL=") ||
      text.includes("passwordHash") ||
      text.includes("encryptedSecrets") ||
      text.includes("ownminutes_session") ||
      text.includes("AKL") ||
      text.includes("sk-proj"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    !["local-file", "postgres"].includes(summary.provider) ||
    summary.checkCount < 5 ||
    !summary.hasCapabilities ||
    !summary.hasMigrationFiles ||
    !summary.hasMigrationRunner ||
    !summary.hasMigrationRunbook ||
    !summary.hasRestoreDrillFlag ||
    !summary.hasSslRequiredFlag ||
    !summary.hasLocalStoreDecisionFlag ||
    !summary.hasMeetingWriteFlags ||
    !["local-file", "postgres"].includes(summary.authRepository) ||
    !summary.supportsMigrationFiles ||
    !summary.supportsMigrationRunner ||
    !summary.hasRestoreDrillCapability ||
    !summary.hasEncryptedTransportCapability ||
    summary.supportsPostgresRuntimeWrites !== false ||
    summary.supportsCrossInstanceMeetingWrites !== false ||
    summary.supportsDurableMeetingDeletionFence !== false ||
    !summary.migrationFilesCheckPass ||
    !summary.migrationRunnerCheckPass ||
    !summary.authRepositoryBoundaryCheckPass ||
    !summary.hasMissingList ||
    !summary.localMissingAuditLog ||
    !summary.localMissingRestoreDrill ||
    !summary.localMissingSsl ||
    !summary.localMissingLocalStoreDecision ||
    !summary.localMissingPostgresRuntimeWrites ||
    !summary.localMissingMeetingWriteLock ||
    !summary.localMissingDeletionFence ||
    !summary.restoreDrillCheckExists ||
    !summary.sslCheckExists ||
    !summary.localStoreDecisionCheckExists ||
    !summary.meetingWriteCoordinationCheckExists ||
    !summary.statusesValid ||
    !summary.localProviderBlocked ||
    !summary.localStorePathRedacted ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

async function readJson(response, path) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
