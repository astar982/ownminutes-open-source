export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getSecretAuditInfo } = await import("@/lib/server/secret-audit");
  const secretAuditInfo = getSecretAuditInfo();
  if (!secretAuditInfo.legacyMigrationReady) {
    console.error("Legacy secret audit migration failed closed.", {
      code: secretAuditInfo.legacyMigrationStatus,
    });
  }
  const finalizationWorkerEnabled =
    process.env.OWNMINUTES_FINALIZATION_MODE === "postgres-queue" &&
    process.env.OWNMINUTES_FINALIZATION_WORKER === "1";
  const deletionCleanupWorkerEnabled =
    process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" &&
    process.env.OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER === "1";
  const secretAuditOutboxWorkerEnabled =
    process.env.OWNMINUTES_SECRET_AUDIT_OUTBOX_WORKER !== "0" &&
    (
      process.env.OWNMINUTES_SECRET_AUDIT_OUTBOX_WORKER === "1" ||
      process.env.OWNMINUTES_AUTH_REPOSITORY !== "postgres" ||
      finalizationWorkerEnabled
    );
  if (
    !finalizationWorkerEnabled &&
    !deletionCleanupWorkerEnabled &&
    !secretAuditOutboxWorkerEnabled
  ) return;

  const { startFinalizationWorker, startMeetingDeletionCleanupWorker } =
    await import("@/lib/server/finalization-queue");
  if (finalizationWorkerEnabled) startFinalizationWorker();
  if (deletionCleanupWorkerEnabled) startMeetingDeletionCleanupWorker();
  if (secretAuditOutboxWorkerEnabled) {
    const { startSecretAuditOutboxWorker } =
      await import("@/lib/server/auth-repository");
    startSecretAuditOutboxWorker();
  }
}
