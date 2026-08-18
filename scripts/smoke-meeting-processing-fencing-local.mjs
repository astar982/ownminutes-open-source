#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const authDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-local-fence-"));
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

const store = await import("../src/lib/server/auth-store.ts");
const suffix = `${Date.now()}-${process.pid}`;

const user = store.registerUser({ email: `fence-${suffix}@example.com`, name: "Fence Local", password: `OwnMinutes-${suffix}` });
const reservation = store.reserveMeetingFinalizationQuota(user.id, {
  durationMs: 7 * 60_000,
  meetingId: "local-finalization",
  operationKey: "meeting:local-finalization:initial",
  processingRoute: "official_quota",
});
const afterReserve = store.getUserUsage(user.id);
const claim = store.claimMeetingProviderStep(user.id, {
  reservationId: reservation.id,
  stage: { type: "finalization_asr" },
});
const started = store.startMeetingProviderStep(user.id, { claimToken: claim.claimToken, stepId: claim.step.id });
const repeated = store.startMeetingProviderStep(user.id, { claimToken: claim.claimToken, stepId: claim.step.id });
store.completeMeetingProviderStep(user.id, { claimToken: claim.claimToken, stepId: claim.step.id });
store.recordMeetingFinalizeUsage(user.id, {
  durationMs: 7 * 60_000,
  meetingId: "local-finalization",
  reservationId: reservation.id,
  resultGeneratedAt: "2026-07-17T00:00:00.000Z",
  route: "official_quota",
});
store.recordMeetingFinalizeUsage(user.id, {
  durationMs: 7 * 60_000,
  meetingId: "local-finalization",
  reservationId: reservation.id,
  resultGeneratedAt: "2026-07-17T00:00:00.000Z",
  route: "official_quota",
});
const afterFinalize = store.getUserUsage(user.id);

const releaseUser = store.registerUser({ email: `release-${suffix}@example.com`, name: "Release Local", password: `OwnMinutes-${suffix}` });
const held = store.reserveMeetingFinalizationQuota(releaseUser.id, {
  durationMs: 60 * 60_000,
  meetingId: "local-held",
  operationKey: "meeting:local-held:initial",
  processingRoute: "official_quota",
});
let blocked = false;
try {
  store.reserveMeetingFinalizationQuota(releaseUser.id, {
    durationMs: 60_000,
    meetingId: "local-blocked",
    operationKey: "meeting:local-blocked:initial",
    processingRoute: "official_quota",
  });
} catch (error) {
  blocked = error?.code === "official_quota_insufficient";
}
const heldClaim = store.claimMeetingProviderStep(releaseUser.id, {
  reservationId: held.id,
  stage: { type: "finalization_summary" },
});
store.releaseMeetingProviderStep(releaseUser.id, { claimToken: heldClaim.claimToken, stepId: heldClaim.step.id });
store.releaseMeetingProcessingReservation(releaseUser.id, { reservationId: held.id });
const reclaimed = store.reserveMeetingFinalizationQuota(releaseUser.id, {
  durationMs: 60_000,
  meetingId: "local-blocked",
  operationKey: "meeting:local-blocked:initial",
  processingRoute: "official_quota",
});

const rejectUser = store.registerUser({ email: `reject-${suffix}@example.com`, name: "Reject Local", password: `OwnMinutes-${suffix}` });
const rejectedReservation = store.reserveMeetingFinalizationQuota(rejectUser.id, {
  durationMs: 7 * 60_000,
  meetingId: "local-rejected",
  operationKey: "meeting:local-rejected:initial",
  processingRoute: "official_quota",
});
const rejectedClaim = store.claimMeetingProviderStep(rejectUser.id, {
  reservationId: rejectedReservation.id,
  stage: { type: "finalization_asr" },
});
store.startMeetingProviderStep(rejectUser.id, { claimToken: rejectedClaim.claimToken, stepId: rejectedClaim.step.id });
const afterRejectedStart = store.getUserUsage(rejectUser.id);
const rejected = store.rejectMeetingProviderStep(rejectUser.id, {
  claimToken: rejectedClaim.claimToken,
  stepId: rejectedClaim.step.id,
});
const afterExplicitRejection = store.getUserUsage(rejectUser.id);
const retryClaim = store.claimMeetingProviderStep(rejectUser.id, {
  reservationId: rejectedReservation.id,
  stage: { type: "finalization_asr" },
});
const retryStarted = store.startMeetingProviderStep(rejectUser.id, {
  claimToken: retryClaim.claimToken,
  stepId: retryClaim.step.id,
});

const upgradeBeforeStartUser = store.registerUser({
  email: `upgrade-before-start-${suffix}@example.com`,
  name: "Upgrade Before Start Local",
  password: `OwnMinutes-${suffix}`,
});
const upgradeBeforeStartReservation = store.reserveMeetingFinalizationQuota(upgradeBeforeStartUser.id, {
  durationMs: 7 * 60_000,
  meetingId: "local-upgrade-before-start",
  operationKey: "meeting:local-upgrade-before-start:initial",
  processingRoute: "official_quota",
});
mutateLocalUser(upgradeBeforeStartUser.id, (record) => {
  record.plan = "plus";
  record.officialMinutesTotal = 600;
  record.officialMinutesUsed = 0;
  record.officialMinutesPeriodSource = "apple_iap";
  record.officialMinutesPeriodStartAt = "2026-08-01T00:00:00.000Z";
  record.officialMinutesBillingOrderId = "period-upgrade-before-start";
});
const upgradeBeforeStartClaim = store.claimMeetingProviderStep(upgradeBeforeStartUser.id, {
  reservationId: upgradeBeforeStartReservation.id,
  stage: { type: "finalization_summary" },
});
const upgradeBeforeStartStarted = store.startMeetingProviderStep(upgradeBeforeStartUser.id, {
  claimToken: upgradeBeforeStartClaim.claimToken,
  stepId: upgradeBeforeStartClaim.step.id,
});
store.rejectMeetingProviderStep(upgradeBeforeStartUser.id, {
  claimToken: upgradeBeforeStartClaim.claimToken,
  stepId: upgradeBeforeStartClaim.step.id,
});
const upgradeBeforeStartAfterReject = readLocalUser(upgradeBeforeStartUser.id);

const upgradeAfterStartUser = store.registerUser({
  email: `upgrade-after-start-${suffix}@example.com`,
  name: "Upgrade After Start Local",
  password: `OwnMinutes-${suffix}`,
});
const upgradeAfterStartReservation = store.reserveMeetingFinalizationQuota(upgradeAfterStartUser.id, {
  durationMs: 7 * 60_000,
  meetingId: "local-upgrade-after-start",
  operationKey: "meeting:local-upgrade-after-start:initial",
  processingRoute: "official_quota",
});
const upgradeAfterStartClaim = store.claimMeetingProviderStep(upgradeAfterStartUser.id, {
  reservationId: upgradeAfterStartReservation.id,
  stage: { type: "finalization_asr" },
});
const upgradeAfterStartStarted = store.startMeetingProviderStep(upgradeAfterStartUser.id, {
  claimToken: upgradeAfterStartClaim.claimToken,
  stepId: upgradeAfterStartClaim.step.id,
});
mutateLocalUser(upgradeAfterStartUser.id, (record) => {
  record.plan = "plus";
  record.officialMinutesTotal = 600;
  record.officialMinutesUsed = 0;
  record.officialMinutesPeriodSource = "apple_iap";
  record.officialMinutesPeriodStartAt = "2026-08-02T00:00:00.000Z";
  record.officialMinutesBillingOrderId = "period-upgrade-after-start";
});
store.rejectMeetingProviderStep(upgradeAfterStartUser.id, {
  claimToken: upgradeAfterStartClaim.claimToken,
  stepId: upgradeAfterStartClaim.step.id,
});
const upgradeAfterStartAfterReject = readLocalUser(upgradeAfterStartUser.id);

const renewalUser = store.registerUser({
  email: `renewal-${suffix}@example.com`,
  name: "Renewal Local",
  password: `OwnMinutes-${suffix}`,
});
mutateLocalUser(renewalUser.id, (record) => {
  record.plan = "plus";
  record.officialMinutesTotal = 600;
  record.officialMinutesUsed = 0;
  record.officialMinutesPeriodSource = "apple_iap";
  record.officialMinutesPeriodStartAt = "2026-08-01T00:00:00.000Z";
  record.officialMinutesBillingOrderId = "period-renewal-1";
});
const renewalReservation = store.reserveMeetingFinalizationQuota(renewalUser.id, {
  durationMs: 7 * 60_000,
  meetingId: "local-renewal",
  operationKey: "meeting:local-renewal:initial",
  processingRoute: "official_quota",
});
const renewalClaim = store.claimMeetingProviderStep(renewalUser.id, {
  reservationId: renewalReservation.id,
  stage: { type: "finalization_asr" },
});
const renewalStarted = store.startMeetingProviderStep(renewalUser.id, {
  claimToken: renewalClaim.claimToken,
  stepId: renewalClaim.step.id,
});
mutateLocalUser(renewalUser.id, (record) => {
  record.officialMinutesUsed = 3;
  record.officialMinutesPeriodStartAt = "2026-09-01T00:00:00.000Z";
  record.officialMinutesBillingOrderId = "period-renewal-2";
});
store.rejectMeetingProviderStep(renewalUser.id, {
  claimToken: renewalClaim.claimToken,
  stepId: renewalClaim.step.id,
});
const renewalAfterReject = readLocalUser(renewalUser.id);

const summary = {
  reserveDoesNotConsumeQuota: afterReserve.officialMinutesUsed === 0,
  startSettlesQuota: started.outcome === "started" && started.step.officialMinutesSettled === 7,
  startedRetryIsUncertain: repeated.outcome === "uncertain",
  finalizeDoesNotDoubleCharge:
    afterFinalize.officialMinutesUsed === 7 &&
    afterFinalize.events.filter((event) => event.type === "meeting_finalize").length === 1,
  releasedPreStartCapacityCanBeReused:
    blocked && reclaimed.meetingId === "local-blocked" && store.getUserUsage(releaseUser.id).officialMinutesUsed === 0,
  explicitProviderRejectionRefundsStartedQuota:
    afterRejectedStart.officialMinutesUsed === 7 &&
    rejected.outcome === "released" &&
    rejected.step.officialMinutesSettled === 0 &&
    afterExplicitRejection.officialMinutesUsed === 0,
  explicitProviderRejectionCanBeClaimedAgain:
    retryClaim.outcome === "claimed" &&
    retryStarted.outcome === "started" &&
    retryStarted.step.officialMinutesSettled === 7,
  upgradeBetweenReservationAndStartUsesActualPaidPeriod:
    upgradeBeforeStartStarted.step.freeTrialMinutesSettled === 0 &&
    upgradeBeforeStartStarted.step.settlementPeriodIdentity?.includes("period-upgrade-before-start") === true &&
    upgradeBeforeStartAfterReject.officialMinutesUsed === 0 &&
    upgradeBeforeStartAfterReject.freeTrialMinutesUsed === 0,
  upgradeAfterFreeTrialStartRefundsLifetimeTrialOnly:
    upgradeAfterStartStarted.step.freeTrialMinutesSettled === 7 &&
    upgradeAfterStartAfterReject.officialMinutesUsed === 0 &&
    upgradeAfterStartAfterReject.freeTrialMinutesUsed === 0,
  renewalAfterStartDoesNotDecrementNewPeriodUsage:
    renewalStarted.step.freeTrialMinutesSettled === 0 &&
    renewalAfterReject.officialMinutesUsed === 3 &&
    renewalAfterReject.freeTrialMinutesUsed === 0,
};

console.log(JSON.stringify(summary, null, 2));
if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

function readLocalStore() {
  return JSON.parse(fs.readFileSync(path.join(authDataDir, "store.json"), "utf8"));
}

function readLocalUser(userId) {
  return readLocalStore().users.find((user) => user.id === userId);
}

function mutateLocalUser(userId, mutate) {
  const data = readLocalStore();
  const user = data.users.find((candidate) => candidate.id === userId);
  if (!user) throw new Error(`Missing local fixture user ${userId}`);
  mutate(user);
  fs.writeFileSync(path.join(authDataDir, "store.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
