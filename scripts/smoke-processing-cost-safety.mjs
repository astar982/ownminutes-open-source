#!/usr/bin/env node

import fs from "node:fs";

const read = (file) => fs.readFileSync(file, "utf8");
const repository = read("src/lib/server/auth-repository.ts");
const route = read("src/app/api/meetings/[id]/realtime-chunks/route.ts");
const finalizer = read("src/lib/server/meeting-finalizer.ts");
const processing = read("src/lib/meeting-processing.ts");
const checkpoint = read("src/lib/server/meeting-processing-checkpoint.ts");
const migration = read("db/migrations/0015_meeting_processing_reservations.sql");
const settlementIdentityMigration = read("db/migrations/0016_provider_step_settlement_identity.sql");

const checks = {
  quotaReservedBeforeSpend:
    repository.includes("select * from users where id = $1 and deleted_at is null for update") &&
    repository.includes("official_quota_insufficient") &&
    migration.includes("unique (user_id, operation_key)"),
  realtimeQuotaIsServerOwned:
    route.includes("initialMeetingOperationKey(id)") &&
    route.indexOf("reserveMeetingRealtimeQuota") < route.indexOf("startMeetingProviderStep") &&
    route.indexOf("startMeetingProviderStep") < route.indexOf("adapter.acceptChunk") &&
    route.includes('stage: { type: "realtime_asr", sequence }'),
  providerModeSwitchDoesNotResetSequence:
    repository.includes("existing ? highestSequence + 1 : input.sequence"),
  build7QuotaCompatibility:
    route.includes('adapter: "official-quota-exhausted"') &&
    route.includes('providerStatus: "provider_error"') &&
    route.includes("ok: true"),
  finalizationPreparesBeforeCharging:
    finalizer.indexOf("const audioSnapshot = await prepareMeetingAudioSnapshot") <
      finalizer.lastIndexOf("reservation = await reserveFinalizationQuotaOrThrow") &&
    finalizer.lastIndexOf("reservation = await reserveFinalizationQuotaOrThrow") <
      finalizer.indexOf("providerFence = createProviderStepFence({"),
  asrCheckpointPreventsPaidRetries:
    finalizer.includes("readMeetingProcessingCheckpoint") &&
    finalizer.includes("saveMeetingProcessingCheckpoint") &&
    processing.includes("onTranscriptReady") &&
    checkpoint.includes("processing-checkpoints") &&
    checkpoint.includes("could not be verified after storage write") &&
    !finalizer.includes("saveMeetingProcessingCheckpoint({") &&
    !finalizer.includes("saveMeetingProcessingCheckpoint(nextCheckpoint).catch"),
  providerCallsAreAtMostOnce:
    repository.includes("claimMeetingProviderStep") &&
    repository.includes("startMeetingProviderStep") &&
    repository.includes("completeMeetingProviderStep") &&
    finalizer.includes("provider_step_outcome_uncertain") &&
    migration.includes("meeting_processing_provider_steps"),
  providerOutputIsDurableBeforeStepCompletion:
    processing.indexOf("await input.onTranscriptReady") <
      processing.indexOf('await input.onProviderStageComplete?.("asr")') &&
    processing.indexOf("await input.onSummaryReady") <
      processing.indexOf('await input.onProviderStageComplete?.("summary")') &&
    finalizer.includes("reconcileMeetingProviderStep") &&
    finalizer.includes("durableCheckpoint.providerStages") &&
    finalizer.includes("await withMeetingWriteFence(input.meetingId") &&
    checkpoint.includes("ownerUserId") &&
    checkpoint.includes("operationKey") &&
    checkpoint.includes("audioSha256") &&
    !finalizer.includes("officialAsr:") &&
    !finalizer.includes("officialSummary:"),
  deletedOutputSettlesCostWithoutPublishing:
    finalizer.includes('error.code === "meeting_deleted"') &&
    finalizer.includes("completeDiscardedAfterMeetingDeletion") &&
    finalizer.includes("completeMeetingProviderStep(input.userId, activeClaim)") &&
    finalizer.includes("no provider is retried"),
  explicitNonAcceptanceCanRefundAndRetry:
    repository.includes("rejectMeetingProviderStep") &&
    repository.includes("postgresRejectMeetingProviderStep") &&
    processing.includes("beforeProviderRequest") &&
    processing.includes("isDefinitiveVolcanoNonAcceptance") &&
    processing.includes('onProviderStageRejected?.("summary", error)') &&
    finalizer.includes("onProviderStageRejected: providerFence.reject") &&
    settlementIdentityMigration.includes("settlement_period_identity") &&
    settlementIdentityMigration.includes("free_trial_minutes_settled"),
  summaryCheckpointPreventsPaidRetries:
    processing.includes("preferredSummary") &&
    processing.includes("onSummaryReady") &&
    finalizer.includes("durable summary checkpoint") &&
    checkpoint.includes("summary?: MeetingSummary"),
  completedResultIsOperationIdempotent:
    finalizer.includes("existingResult?.processingOperationKey === operationKey") &&
    finalizer.includes("processingOperationKey: operationKey"),
  duplicateUsageIsDatabaseFenced:
    migration.includes("usage_events_processing_reservation_unique_idx") &&
    migration.includes("where processing_reservation_id is not null"),
  realtimeTranscriptAvoidsDuplicateFileAsr:
    finalizer.includes("selectReusableRealtimeTranscript") &&
    processing.includes("preferredTranscript"),
  summarySpendIsBounded:
    processing.includes('type: "disabled"') &&
    processing.includes("OWNMINUTES_SUMMARY_MAX_TOKENS") &&
    processing.includes("max_tokens") &&
    processing.includes("summaryMaxAttempts") &&
    finalizer.includes("summaryMaxAttempts: hasUserSummaryRuntime(runtime) ? undefined : 1"),
  noSecrets: ![repository, route, finalizer, processing, checkpoint, migration, settlementIdentityMigration].some((source) => /sk-proj|AKL[A-Za-z0-9]/.test(source)),
};

console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2));
if (Object.values(checks).some((value) => value !== true)) process.exitCode = 1;
