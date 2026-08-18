#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const authDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-mode-freeze-"));
process.env.OWNMINUTES_AUTH_DATA_DIR = authDataDir;
process.env.OWNMINUTES_AUTH_REPOSITORY = "local-file";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const sourcePath = path.join(repoRoot, "src", specifier.slice(2));
    for (const candidate of [`${sourcePath}.ts`, `${sourcePath}.tsx`, path.join(sourcePath, "index.ts")]) {
      if (fs.existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});

try {
  const store = await import("../src/lib/server/auth-store.ts");
  const {
    parseRequestedMeetingProcessingMode,
    resolveMeetingProcessingMode,
  } = await import("../src/lib/server/meeting-processing-mode.ts");
  const suffix = `${Date.now()}-${process.pid}`;

  const officialUser = store.registerUser({
    email: `official-freeze-${suffix}@example.com`,
    name: "Official Freeze",
    password: `OwnMinutes-${suffix}`,
  });
  const officialMeetingId = `official-freeze-${suffix}`;
  const officialOperationKey = `meeting:${officialMeetingId}:initial`;
  const officialStart = store.reserveMeetingRealtimeQuota(officialUser.id, {
    durationMs: 30_000,
    meetingId: officialMeetingId,
    operationKey: officialOperationKey,
    processingRoute: "official_quota",
    sequence: 1,
  });
  mutateUser(officialUser.id, (user) => {
    user.processingMode = "byok";
  });
  const officialFinishMode = resolveMeetingProcessingMode({
    accountMode: "byok",
    frozenRoute: officialStart.processingRoute,
    requestedMode: "official_quota",
  });
  const officialForceMode = resolveMeetingProcessingMode({
    accountMode: "byok",
    frozenRoute: officialStart.processingRoute,
    requestedMode: "official_quota",
  });
  const officialFinalize = store.reserveMeetingFinalizationQuota(officialUser.id, {
    durationMs: 60_000,
    meetingId: officialMeetingId,
    operationKey: officialOperationKey,
    processingRoute: officialFinishMode,
  });
  const officialClaim = store.claimMeetingProviderStep(officialUser.id, {
    reservationId: officialFinalize.id,
    stage: { type: "finalization_asr" },
  });
  assert.equal(officialClaim.outcome, "claimed");
  store.startMeetingProviderStep(officialUser.id, {
    claimToken: officialClaim.claimToken,
    stepId: officialClaim.step.id,
  });
  store.completeMeetingProviderStep(officialUser.id, {
    claimToken: officialClaim.claimToken,
    stepId: officialClaim.step.id,
  });
  const officialGeneratedAt = "2026-07-19T00:00:00.000Z";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    store.recordMeetingFinalizeUsage(officialUser.id, {
      durationMs: 60_000,
      meetingId: officialMeetingId,
      reservationId: officialFinalize.id,
      reservationOperationKey: officialOperationKey,
      resultGeneratedAt: officialGeneratedAt,
      route: officialFinishMode,
    });
  }
  const officialConflict = captureCode(() => store.reserveMeetingFinalizationQuota(officialUser.id, {
    durationMs: 60_000,
    meetingId: officialMeetingId,
    operationKey: officialOperationKey,
    processingRoute: "byok",
  }));
  const officialUsage = store.getUserUsage(officialUser.id);

  const byokUser = store.registerUser({
    email: `byok-freeze-${suffix}@example.com`,
    name: "BYOK Freeze",
    password: `OwnMinutes-${suffix}`,
  });
  mutateUser(byokUser.id, (user) => {
    user.processingMode = "byok";
  });
  const byokMeetingId = `byok-freeze-${suffix}`;
  const byokOperationKey = `meeting:${byokMeetingId}:initial`;
  const byokStart = store.reserveMeetingRealtimeQuota(byokUser.id, {
    durationMs: 30_000,
    meetingId: byokMeetingId,
    operationKey: byokOperationKey,
    processingRoute: "byok",
    sequence: 1,
  });
  mutateUser(byokUser.id, (user) => {
    user.processingMode = "official_quota";
  });
  const byokFinishMode = resolveMeetingProcessingMode({
    accountMode: "official_quota",
    frozenRoute: byokStart.processingRoute,
    requestedMode: "byok",
  });
  const byokForceMode = resolveMeetingProcessingMode({
    accountMode: "official_quota",
    frozenRoute: byokStart.processingRoute,
    requestedMode: "byok",
  });
  const byokFinalize = store.reserveMeetingFinalizationQuota(byokUser.id, {
    durationMs: 60_000,
    meetingId: byokMeetingId,
    operationKey: byokOperationKey,
    processingRoute: byokFinishMode,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    store.recordMeetingFinalizeUsage(byokUser.id, {
      durationMs: 60_000,
      meetingId: byokMeetingId,
      reservationId: byokFinalize.id,
      reservationOperationKey: byokOperationKey,
      resultGeneratedAt: "2026-07-19T00:01:00.000Z",
      route: byokFinishMode,
    });
  }
  const byokConflict = captureCode(() => store.reserveMeetingRealtimeQuota(byokUser.id, {
    durationMs: 30_000,
    meetingId: byokMeetingId,
    operationKey: byokOperationKey,
    processingRoute: "official_quota",
    sequence: 2,
  }));
  const byokUsage = store.getUserUsage(byokUser.id);

  // Offline recordings have no server reservation until upload/finalize. The
  // mode captured on the device must win over a later account-level change.
  const offlineOfficialUser = store.registerUser({
    email: `offline-official-${suffix}@example.com`,
    name: "Offline Official Freeze",
    password: `OwnMinutes-${suffix}`,
  });
  mutateUser(offlineOfficialUser.id, (user) => {
    user.processingMode = "byok";
  });
  const offlineOfficialMeetingId = `offline-official-${suffix}`;
  const offlineOfficialOperationKey = `meeting:${offlineOfficialMeetingId}:initial`;
  const offlineOfficialMode = resolveMeetingProcessingMode({
    accountMode: "byok",
    requestedMode: "official_quota",
  });
  const offlineOfficialReservation = store.reserveMeetingFinalizationQuota(offlineOfficialUser.id, {
    durationMs: 60_000,
    meetingId: offlineOfficialMeetingId,
    operationKey: offlineOfficialOperationKey,
    processingRoute: offlineOfficialMode,
  });
  const offlineOfficialClaim = store.claimMeetingProviderStep(offlineOfficialUser.id, {
    reservationId: offlineOfficialReservation.id,
    stage: { type: "finalization_asr" },
  });
  store.startMeetingProviderStep(offlineOfficialUser.id, {
    claimToken: offlineOfficialClaim.claimToken,
    stepId: offlineOfficialClaim.step.id,
  });
  store.completeMeetingProviderStep(offlineOfficialUser.id, {
    claimToken: offlineOfficialClaim.claimToken,
    stepId: offlineOfficialClaim.step.id,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    store.recordMeetingFinalizeUsage(offlineOfficialUser.id, {
      durationMs: 60_000,
      meetingId: offlineOfficialMeetingId,
      reservationId: offlineOfficialReservation.id,
      reservationOperationKey: offlineOfficialOperationKey,
      resultGeneratedAt: "2026-07-19T00:02:00.000Z",
      route: offlineOfficialMode,
    });
  }
  const offlineOfficialConflict = captureCode(() => store.reserveMeetingFinalizationQuota(offlineOfficialUser.id, {
    durationMs: 60_000,
    meetingId: offlineOfficialMeetingId,
    operationKey: offlineOfficialOperationKey,
    processingRoute: "byok",
  }));
  const offlineOfficialUsage = store.getUserUsage(offlineOfficialUser.id);

  const offlineByokUser = store.registerUser({
    email: `offline-byok-${suffix}@example.com`,
    name: "Offline BYOK Freeze",
    password: `OwnMinutes-${suffix}`,
  });
  mutateUser(offlineByokUser.id, (user) => {
    user.processingMode = "official_quota";
  });
  const offlineByokMeetingId = `offline-byok-${suffix}`;
  const offlineByokOperationKey = `meeting:${offlineByokMeetingId}:initial`;
  const offlineByokMode = resolveMeetingProcessingMode({
    accountMode: "official_quota",
    requestedMode: "byok",
  });
  const offlineByokReservation = store.reserveMeetingFinalizationQuota(offlineByokUser.id, {
    durationMs: 60_000,
    meetingId: offlineByokMeetingId,
    operationKey: offlineByokOperationKey,
    processingRoute: offlineByokMode,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    store.recordMeetingFinalizeUsage(offlineByokUser.id, {
      durationMs: 60_000,
      meetingId: offlineByokMeetingId,
      reservationId: offlineByokReservation.id,
      reservationOperationKey: offlineByokOperationKey,
      resultGeneratedAt: "2026-07-19T00:03:00.000Z",
      route: offlineByokMode,
    });
  }
  const offlineByokConflict = captureCode(() => store.reserveMeetingFinalizationQuota(offlineByokUser.id, {
    durationMs: 60_000,
    meetingId: offlineByokMeetingId,
    operationKey: offlineByokOperationKey,
    processingRoute: "official_quota",
  }));
  const offlineByokUsage = store.getUserUsage(offlineByokUser.id);

  const summary = {
    legacyMissingModeFreezesCurrentAccountMode:
      parseRequestedMeetingProcessingMode(undefined) === undefined &&
      resolveMeetingProcessingMode({ accountMode: "byok" }) === "byok",
    forceNeverFallsBackToCurrentAccountMode:
      captureCode(() => resolveMeetingProcessingMode({
        accountMode: "byok",
        requestedMode: "official_quota",
        requireFrozenRoute: true,
      })) === "meeting_processing_mode_missing",
    invalidModeRejectedBeforeBinding:
      captureCode(() => parseRequestedMeetingProcessingMode("hybrid")) === "invalid_meeting_processing_mode",
    officialStartRemainsOfficialAfterAccountSwitch:
      officialStart.processingRoute === "official_quota" &&
      officialFinalize.processingRoute === "official_quota",
    byokStartRemainsByokAfterAccountSwitch:
      byokStart.processingRoute === "byok" &&
      byokFinalize.processingRoute === "byok",
    forceOfficialRemainsOfficialAfterAccountSwitch: officialForceMode === "official_quota",
    forceByokRemainsByokAfterAccountSwitch: byokForceMode === "byok",
    conflictingRetriesRejected:
      officialConflict === "meeting_processing_mode_conflict" &&
      byokConflict === "meeting_processing_mode_conflict",
    officialRetryDoesNotDoubleBill:
      officialUsage.officialMinutesUsed === 1 &&
      officialUsage.events.filter((event) => event.type === "meeting_finalize").length === 1,
    byokRetryNeverConsumesOfficialQuota:
      byokUsage.officialMinutesUsed === 0 &&
      byokUsage.events.filter((event) => event.type === "meeting_finalize").length === 1 &&
      byokUsage.events.find((event) => event.type === "meeting_finalize")?.officialMinutesCharged === 0,
    noReservationLeak:
      officialFinalize.status === "reserved" &&
      byokFinalize.status === "reserved" &&
      readStore().meetingProcessingReservations.every((reservation) =>
        reservation.status === "finalized" && reservation.releasedAt === undefined,
      ),
    offlineOfficialCaptureOverridesLaterByokAccountMode:
      offlineOfficialMode === "official_quota" &&
      offlineOfficialReservation.processingRoute === "official_quota" &&
      offlineOfficialConflict === "meeting_processing_mode_conflict" &&
      offlineOfficialUsage.officialMinutesUsed === 1 &&
      offlineOfficialUsage.events.filter((event) => event.type === "meeting_finalize").length === 1,
    offlineByokCaptureOverridesLaterOfficialAccountMode:
      offlineByokMode === "byok" &&
      offlineByokReservation.processingRoute === "byok" &&
      offlineByokConflict === "meeting_processing_mode_conflict" &&
      offlineByokUsage.officialMinutesUsed === 0 &&
      offlineByokUsage.events.filter((event) => event.type === "meeting_finalize").length === 1,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

  function readStore() {
    return JSON.parse(fs.readFileSync(path.join(authDataDir, "store.json"), "utf8"));
  }

  function mutateUser(userId, mutate) {
    const data = readStore();
    const user = data.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error(`Missing local fixture user ${userId}`);
    mutate(user);
    fs.writeFileSync(path.join(authDataDir, "store.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
} finally {
  fs.rmSync(authDataDir, { force: true, recursive: true });
}

function captureCode(operation) {
  try {
    operation();
    return null;
  } catch (error) {
    return error?.code ?? null;
  }
}
