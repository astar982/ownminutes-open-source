#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { waitForHostPostgres } from "./lib/wait-for-postgres.mjs";

const repoRoot = process.cwd();
const suffix = crypto.randomBytes(5).toString("hex");
const container = `ownminutes-provider-fence-${suffix}`;
const password = crypto.randomBytes(24).toString("base64url");
let admin;
let runtimePool;

try {
  run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  run("docker", [
    "run", "--detach", "--name", container,
    "--env", "POSTGRES_DB=ownminutes",
    "--env", "POSTGRES_USER=ownminutes",
    "--env", `POSTGRES_PASSWORD=${password}`,
    "--publish", "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  waitForPostgres();
  const port = run("docker", ["port", container, "5432/tcp"], {}, true).trim().split(":").at(-1);
  const databaseUrl = `postgresql://ownminutes:${encodeURIComponent(password)}@127.0.0.1:${port}/ownminutes`;
  await waitForHostPostgres(databaseUrl);
  run(process.execPath, ["scripts/run-postgres-migrations.mjs"], { DATABASE_URL: databaseUrl }, true);

  process.env.DATABASE_URL = databaseUrl;
  process.env.OWNMINUTES_AUTH_REPOSITORY = "postgres";
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

  const { Client } = await import("pg");
  admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const repository = await import("../src/lib/server/auth-repository.ts");
  runtimePool = (await import("../src/lib/server/postgres-runtime.ts")).getPostgresRuntimePool();

  const raceUser = await repository.registerUser(userInput("race"));
  await setQuota(raceUser.id, 1);
  const race = await Promise.allSettled([
    repository.reserveMeetingFinalizationQuota(raceUser.id, reservationInput("race-a", 1)),
    repository.reserveMeetingFinalizationQuota(raceUser.id, reservationInput("race-b", 1)),
  ]);
  const raceWinner = race.find((item) => item.status === "fulfilled")?.value;
  const raceLoser = race.find((item) => item.status === "rejected")?.reason;
  const afterReserve = await quotaState(raceUser.id);

  const modeRaceUser = await repository.registerUser(userInput("mode-race"));
  await setQuota(modeRaceUser.id, 2);
  const modeRaceMeetingId = `meeting-mode-race-${suffix}`;
  const modeRaceOperationKey = `meeting:${modeRaceMeetingId}:initial`;
  const modeRace = await Promise.allSettled([
    repository.reserveMeetingFinalizationQuota(modeRaceUser.id, {
      durationMs: 60_000,
      meetingId: modeRaceMeetingId,
      operationKey: modeRaceOperationKey,
      processingRoute: "official_quota",
    }),
    repository.reserveMeetingFinalizationQuota(modeRaceUser.id, {
      durationMs: 60_000,
      meetingId: modeRaceMeetingId,
      operationKey: modeRaceOperationKey,
      processingRoute: "byok",
    }),
  ]);
  const modeRaceWinner = modeRace.find((item) => item.status === "fulfilled")?.value;
  const modeRaceLoser = modeRace.find((item) => item.status === "rejected")?.reason;
  const modeRaceRows = await admin.query(
    "select processing_route, official_minutes_reserved from meeting_processing_reservations where user_id=$1 and operation_key=$2",
    [modeRaceUser.id, modeRaceOperationKey],
  );

  const claimed = await repository.claimMeetingProviderStep(raceUser.id, {
    reservationId: raceWinner.id,
    stage: { type: "finalization_asr" },
  });
  const activeClaimIsBusy = await repository.claimMeetingProviderStep(raceUser.id, {
    reservationId: raceWinner.id,
    stage: { type: "finalization_asr" },
  });
  const started = await repository.startMeetingProviderStep(raceUser.id, {
    claimToken: claimed.claimToken,
    stepId: claimed.step.id,
  });
  const repeatedStart = await repository.startMeetingProviderStep(raceUser.id, {
    claimToken: claimed.claimToken,
    stepId: claimed.step.id,
  });
  await admin.query("update meeting_processing_reservations set reservation_expires_at=now()-interval '1 minute' where id=$1", [raceWinner.id]);
  const startedClaim = await repository.claimMeetingProviderStep(raceUser.id, {
    reservationId: raceWinner.id,
    stage: { type: "finalization_asr" },
  });
  const afterStart = await quotaState(raceUser.id);
  const reconciledFromCheckpoint = await repository.reconcileMeetingProviderStep(raceUser.id, {
    reservationId: raceWinner.id,
    stage: { type: "finalization_asr" },
  });
  const completed = await repository.completeMeetingProviderStep(raceUser.id, {
    claimToken: claimed.claimToken,
    stepId: claimed.step.id,
  });
  const completedClaim = await repository.claimMeetingProviderStep(raceUser.id, {
    reservationId: raceWinner.id,
    stage: { type: "finalization_asr" },
  });

  await repository.recordMeetingFinalizeUsage(raceUser.id, {
    durationMs: 60_000,
    meetingId: raceWinner.meetingId,
    reservationId: raceWinner.id,
    reservationOperationKey: raceWinner.operationKey,
    resultGeneratedAt: "2026-07-17T00:00:00.000Z",
    route: "official_quota",
  });
  await repository.recordMeetingFinalizeUsage(raceUser.id, {
    durationMs: 60_000,
    meetingId: raceWinner.meetingId,
    reservationId: raceWinner.id,
    reservationOperationKey: raceWinner.operationKey,
    resultGeneratedAt: "2026-07-17T00:00:00.000Z",
    route: "official_quota",
  });
  const afterFinalize = await quotaState(raceUser.id);
  const usageCount = Number((await admin.query(
    "select count(*)::int as count from usage_events where processing_reservation_id = $1",
    [raceWinner.id],
  )).rows[0].count);

  const releaseUser = await repository.registerUser(userInput("release"));
  await setQuota(releaseUser.id, 1);
  const held = await repository.reserveMeetingFinalizationQuota(releaseUser.id, reservationInput("held", 1));
  const blockedByPending = await rejectsCode(
    () => repository.reserveMeetingFinalizationQuota(releaseUser.id, reservationInput("blocked", 1)),
    "official_quota_insufficient",
  );
  const heldClaim = await repository.claimMeetingProviderStep(releaseUser.id, {
    reservationId: held.id,
    stage: { type: "finalization_summary" },
  });
  await repository.releaseMeetingProviderStep(releaseUser.id, {
    claimToken: heldClaim.claimToken,
    stepId: heldClaim.step.id,
  });
  await repository.releaseMeetingProcessingReservation(releaseUser.id, { reservationId: held.id });
  const reclaimed = await repository.reserveMeetingFinalizationQuota(releaseUser.id, reservationInput("blocked", 1));
  const afterRelease = await quotaState(releaseUser.id);

  const rejectUser = await repository.registerUser(userInput("reject"));
  await setQuota(rejectUser.id, 7);
  const rejectedReservation = await repository.reserveMeetingFinalizationQuota(
    rejectUser.id,
    reservationInput("rejected", 7),
  );
  const rejectedClaim = await repository.claimMeetingProviderStep(rejectUser.id, {
    reservationId: rejectedReservation.id,
    stage: { type: "finalization_asr" },
  });
  await repository.startMeetingProviderStep(rejectUser.id, {
    claimToken: rejectedClaim.claimToken,
    stepId: rejectedClaim.step.id,
  });
  const afterRejectedStart = await quotaState(rejectUser.id);
  const rejected = await repository.rejectMeetingProviderStep(rejectUser.id, {
    claimToken: rejectedClaim.claimToken,
    stepId: rejectedClaim.step.id,
  });
  const afterExplicitRejection = await quotaState(rejectUser.id);
  const retryClaim = await repository.claimMeetingProviderStep(rejectUser.id, {
    reservationId: rejectedReservation.id,
    stage: { type: "finalization_asr" },
  });
  const retryStarted = await repository.startMeetingProviderStep(rejectUser.id, {
    claimToken: retryClaim.claimToken,
    stepId: retryClaim.step.id,
  });

  const upgradeBeforeStartUser = await repository.registerUser(userInput("upgrade-before-start"));
  await setQuota(upgradeBeforeStartUser.id, 7);
  const upgradeBeforeStartReservation = await repository.reserveMeetingFinalizationQuota(
    upgradeBeforeStartUser.id,
    reservationInput("upgrade-before-start", 7),
  );
  await setBillingPeriod(upgradeBeforeStartUser.id, {
    billingOrderId: "period-upgrade-before-start",
    officialMinutesUsed: 0,
    periodStartAt: "2026-08-01T00:00:00.000Z",
  });
  const upgradeBeforeStartClaim = await repository.claimMeetingProviderStep(upgradeBeforeStartUser.id, {
    reservationId: upgradeBeforeStartReservation.id,
    stage: { type: "finalization_summary" },
  });
  const upgradeBeforeStartStarted = await repository.startMeetingProviderStep(upgradeBeforeStartUser.id, {
    claimToken: upgradeBeforeStartClaim.claimToken,
    stepId: upgradeBeforeStartClaim.step.id,
  });
  await repository.rejectMeetingProviderStep(upgradeBeforeStartUser.id, {
    claimToken: upgradeBeforeStartClaim.claimToken,
    stepId: upgradeBeforeStartClaim.step.id,
  });
  const upgradeBeforeStartAfterReject = await quotaState(upgradeBeforeStartUser.id);

  const upgradeAfterStartUser = await repository.registerUser(userInput("upgrade-after-start"));
  await setQuota(upgradeAfterStartUser.id, 7);
  const upgradeAfterStartReservation = await repository.reserveMeetingFinalizationQuota(
    upgradeAfterStartUser.id,
    reservationInput("upgrade-after-start", 7),
  );
  const upgradeAfterStartClaim = await repository.claimMeetingProviderStep(upgradeAfterStartUser.id, {
    reservationId: upgradeAfterStartReservation.id,
    stage: { type: "finalization_asr" },
  });
  const upgradeAfterStartStarted = await repository.startMeetingProviderStep(upgradeAfterStartUser.id, {
    claimToken: upgradeAfterStartClaim.claimToken,
    stepId: upgradeAfterStartClaim.step.id,
  });
  await setBillingPeriod(upgradeAfterStartUser.id, {
    billingOrderId: "period-upgrade-after-start",
    officialMinutesUsed: 0,
    periodStartAt: "2026-08-02T00:00:00.000Z",
  });
  await repository.rejectMeetingProviderStep(upgradeAfterStartUser.id, {
    claimToken: upgradeAfterStartClaim.claimToken,
    stepId: upgradeAfterStartClaim.step.id,
  });
  const upgradeAfterStartAfterReject = await quotaState(upgradeAfterStartUser.id);

  const renewalUser = await repository.registerUser(userInput("renewal"));
  await setBillingPeriod(renewalUser.id, {
    billingOrderId: "period-renewal-1",
    officialMinutesUsed: 0,
    periodStartAt: "2026-08-01T00:00:00.000Z",
  });
  const renewalReservation = await repository.reserveMeetingFinalizationQuota(
    renewalUser.id,
    reservationInput("renewal", 7),
  );
  const renewalClaim = await repository.claimMeetingProviderStep(renewalUser.id, {
    reservationId: renewalReservation.id,
    stage: { type: "finalization_asr" },
  });
  const renewalStarted = await repository.startMeetingProviderStep(renewalUser.id, {
    claimToken: renewalClaim.claimToken,
    stepId: renewalClaim.step.id,
  });
  await setBillingPeriod(renewalUser.id, {
    billingOrderId: "period-renewal-2",
    officialMinutesUsed: 3,
    periodStartAt: "2026-09-01T00:00:00.000Z",
  });
  await repository.rejectMeetingProviderStep(renewalUser.id, {
    claimToken: renewalClaim.claimToken,
    stepId: renewalClaim.step.id,
  });
  const renewalAfterReject = await quotaState(renewalUser.id);

  const realtimeUser = await repository.registerUser(userInput("realtime"));
  await setQuota(realtimeUser.id, 3);
  const realtimeReservation = await repository.reserveMeetingRealtimeQuota(realtimeUser.id, {
    durationMs: 30_000,
    meetingId: "meeting-realtime",
    operationKey: "meeting:meeting-realtime:initial",
    processingRoute: "official_quota",
    sequence: 0,
  });
  const realtime0 = await repository.claimMeetingProviderStep(realtimeUser.id, {
    reservationId: realtimeReservation.id,
    stage: { type: "realtime_asr", sequence: 0 },
  });
  await repository.startMeetingProviderStep(realtimeUser.id, { claimToken: realtime0.claimToken, stepId: realtime0.step.id });
  await repository.completeMeetingProviderStep(realtimeUser.id, { claimToken: realtime0.claimToken, stepId: realtime0.step.id });
  const realtimeReservation2 = await repository.reserveMeetingRealtimeQuota(realtimeUser.id, {
    durationMs: 40_000,
    meetingId: "meeting-realtime",
    operationKey: "meeting:meeting-realtime:initial",
    processingRoute: "official_quota",
    sequence: 1,
  });
  const realtime1 = await repository.claimMeetingProviderStep(realtimeUser.id, {
    reservationId: realtimeReservation2.id,
    stage: { type: "realtime_asr", sequence: 1 },
  });

  const columns = new Set((await admin.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='meeting_processing_reservations'",
  )).rows.map((row) => row.column_name));
  const providerTable = (await admin.query("select to_regclass('public.meeting_processing_provider_steps') as name")).rows[0].name;
  const providerColumns = new Set((await admin.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='meeting_processing_provider_steps'",
  )).rows.map((row) => row.column_name));

  const summary = {
    additiveSchemaReady:
      columns.has("official_minutes_settled") &&
      columns.has("reservation_expires_at") &&
      columns.has("released_at") &&
      providerTable === "meeting_processing_provider_steps" &&
      providerColumns.has("settlement_period_identity") &&
      providerColumns.has("free_trial_minutes_settled"),
    concurrentReservationsDoNotOversell:
      race.filter((item) => item.status === "fulfilled").length === 1 &&
      raceLoser?.code === "official_quota_insufficient",
    concurrentFirstModeBindingIsAtomic:
      modeRace.filter((item) => item.status === "fulfilled").length === 1 &&
      modeRaceLoser?.code === "meeting_processing_mode_conflict" &&
      modeRaceRows.rowCount === 1 &&
      modeRaceRows.rows[0].processing_route === modeRaceWinner?.processingRoute &&
      Number(modeRaceRows.rows[0].official_minutes_reserved) ===
        (modeRaceWinner?.processingRoute === "official_quota" ? 1 : 0),
    reserveDoesNotConsumeQuota: Number(afterReserve.official_minutes_used) === 0,
    activeClaimIsFenced: claimed.outcome === "claimed" && activeClaimIsBusy.outcome === "busy",
    startSettlesAtomically:
      started.outcome === "started" &&
      started.step.officialMinutesSettled === 1 &&
      Number(afterStart.official_minutes_used) === 1,
    startedCrashIsUncertain: repeatedStart.outcome === "uncertain" && startedClaim.outcome === "uncertain",
    durableCheckpointReconcilesStartedStep:
      reconciledFromCheckpoint.outcome === "completed" && completed.outcome === "completed",
    completionIsIdempotent: completedClaim.outcome === "completed",
    finalizeUsesSettlementWithoutDoubleCharge:
      Number(afterFinalize.official_minutes_used) === 1 && usageCount === 1,
    predictablePreStartFailureReleasesCapacity:
      blockedByPending && reclaimed.meetingId === "meeting-blocked" && Number(afterRelease.official_minutes_used) === 0,
    explicitProviderRejectionRefundsStartedQuota:
      Number(afterRejectedStart.official_minutes_used) === 7 &&
      rejected.outcome === "released" &&
      rejected.step.officialMinutesSettled === 0 &&
      Number(afterExplicitRejection.official_minutes_used) === 0,
    explicitProviderRejectionCanBeClaimedAgain:
      retryClaim.outcome === "claimed" &&
      retryStarted.outcome === "started" &&
      retryStarted.step.officialMinutesSettled === 7,
    upgradeBetweenReservationAndStartUsesActualPaidPeriod:
      upgradeBeforeStartStarted.step.freeTrialMinutesSettled === 0 &&
      upgradeBeforeStartStarted.step.settlementPeriodIdentity?.includes("period-upgrade-before-start") === true &&
      Number(upgradeBeforeStartAfterReject.official_minutes_used) === 0 &&
      Number(upgradeBeforeStartAfterReject.free_trial_minutes_used) === 0,
    upgradeAfterFreeTrialStartRefundsLifetimeTrialOnly:
      upgradeAfterStartStarted.step.freeTrialMinutesSettled === 7 &&
      Number(upgradeAfterStartAfterReject.official_minutes_used) === 0 &&
      Number(upgradeAfterStartAfterReject.free_trial_minutes_used) === 0,
    renewalAfterStartDoesNotDecrementNewPeriodUsage:
      renewalStarted.step.freeTrialMinutesSettled === 0 &&
      Number(renewalAfterReject.official_minutes_used) === 3 &&
      Number(renewalAfterReject.free_trial_minutes_used) === 0,
    realtimeSequenceHasUniqueStage:
      realtime0.step.stageKey === "realtime:asr:0" &&
      realtime1.step.stageKey === "realtime:asr:1" &&
      realtime0.step.id !== realtime1.step.id,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
} finally {
  try { await admin?.end(); } catch {}
  try { await runtimePool?.end(); } catch {}
  spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
}

function userInput(label) {
  return { email: `${label}-${suffix}@example.com`, name: `${label} smoke`, password: `OwnMinutes-${suffix}` };
}

function reservationInput(label, minutes) {
  return {
    durationMs: minutes * 60_000,
    meetingId: `meeting-${label}`,
    operationKey: `meeting:meeting-${label}:initial`,
    processingRoute: "official_quota",
  };
}

async function setQuota(userId, total) {
  await admin.query("update users set official_minutes_total=$1, official_minutes_used=0 where id=$2", [total, userId]);
}

async function quotaState(userId) {
  return (await admin.query(
    "select official_minutes_total, official_minutes_used, free_trial_minutes_used from users where id=$1",
    [userId],
  )).rows[0];
}

async function setBillingPeriod(userId, { billingOrderId, officialMinutesUsed, periodStartAt }) {
  await admin.query(
    `update users
     set plan = 'plus', official_minutes_total = 600, official_minutes_used = $1,
         official_minutes_period_source = 'apple_iap', official_minutes_period_start_at = $2,
         official_minutes_billing_order_id = $3
     where id = $4`,
    [officialMinutesUsed, periodStartAt, billingOrderId, userId],
  );
}

async function rejectsCode(action, code) {
  try { await action(); return false; } catch (error) { return error?.code === code; }
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (spawnSync("docker", ["exec", container, "pg_isready", "-U", "ownminutes", "-d", "ownminutes"]).status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("Isolated PostgreSQL did not become ready.");
}

function run(executable, args, extraEnv = {}, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: capture ? "pipe" : "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${result.stdout || ""}\n${result.stderr || ""}`.trim() || `${executable} failed`);
  return result.stdout || "";
}

function redact(value) {
  return value.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]");
}
