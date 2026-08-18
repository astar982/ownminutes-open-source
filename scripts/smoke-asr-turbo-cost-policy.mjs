#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOfficialTurboFallbackDecision, isOfficialVolcanoTranscriptionProvider } from "../src/lib/asr-cost-policy.ts";
import { transcribeWithVolcanoFileAsr } from "../src/lib/volcano-asr.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const finalizerSource = fs.readFileSync(path.join(repoRoot, "src/lib/server/meeting-finalizer.ts"), "utf8");
const meetingProcessingSource = fs.readFileSync(path.join(repoRoot, "src/lib/meeting-processing.ts"), "utf8");

const turboRoute = {
  OWNMINUTES_ASR_FILE_STRATEGY: "single",
  VOLCANO_ASR_MODE: "flash",
  VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo",
  OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "1",
  OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "30",
};

assert.deepEqual(getOfficialTurboFallbackDecision(30 * 60_000, turboRoute), {
  allowed: true,
  maxAudioMinutes: 30,
  reason: "within_cost_cap",
});
assert.deepEqual(getOfficialTurboFallbackDecision(30 * 60_000 + 1, turboRoute), {
  allowed: false,
  maxAudioMinutes: 30,
  reason: "duration_exceeds_cap",
});
assert.equal(
  getOfficialTurboFallbackDecision(10 * 60_000, {
    ...turboRoute,
    OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "0",
  }).reason,
  "disabled",
);
assert.equal(
  getOfficialTurboFallbackDecision(10 * 60_000, {
    ...turboRoute,
    OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: undefined,
  }).reason,
  "disabled",
);
assert.equal(
  getOfficialTurboFallbackDecision(10 * 60_000, {
    ...turboRoute,
    OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "31",
  }).allowed,
  false,
);
assert.equal(
  getOfficialTurboFallbackDecision(90 * 60_000, {
    ...turboRoute,
    OWNMINUTES_ASR_FILE_STRATEGY: "standard_then_turbo",
    VOLCANO_ASR_MODE: "standard",
    VOLCANO_ASR_RESOURCE_ID: "volc.seedasr.auc",
  }).reason,
  "not_turbo_only_route",
);
assert.equal(
  getOfficialTurboFallbackDecision(90 * 60_000, {
    ...turboRoute,
    VOLCANO_ASR_RESOURCE_ID: "fixture-low-cost-file-resource",
  }).reason,
  "duration_exceeds_cap",
);
await assert.rejects(
  transcribeWithVolcanoFileAsr({
    meetingId: "smoke-standard-turbo-resource-cost-bypass",
    audioUrl: "https://storage.example.test/audio.wav",
    mimeType: "audio/wav",
    fileName: "audio.wav",
    durationMs: 90 * 60_000,
    config: {
      apiKey: "fixture-key",
      mode: "standard",
      resourceId: "volc.bigasr.auc_turbo",
    },
  }),
  /standard mode must not use Turbo resource/,
);
assert.equal(
  getOfficialTurboFallbackDecision(90 * 60_000, {
    ...turboRoute,
    VOLCANO_ASR_MODE: "standard",
    VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo",
  }).reason,
  "duration_exceeds_cap",
);
assert.equal(
  getOfficialTurboFallbackDecision(90 * 60_000, {
    ...turboRoute,
    VOLCANO_ASR_MODE: "standard",
    VOLCANO_ASR_RESOURCE_ID: "fixture-expensive-resource",
    VOLCANO_ASR_TURBO_RESOURCE_ID: "fixture-expensive-resource",
  }).reason,
  "duration_exceeds_cap",
);
assert.equal(isOfficialVolcanoTranscriptionProvider({ TRANSCRIPTION_PROVIDER: "VOLCANO" }), true);
assert.equal(isOfficialVolcanoTranscriptionProvider({ TRANSCRIPTION_PROVIDER: " volcano " }), true);
assert.equal(isOfficialVolcanoTranscriptionProvider({ TRANSCRIPTION_PROVIDER: "mock" }), false);
assert.equal(getOfficialTurboFallbackDecision(0, turboRoute).reason, "invalid_duration");
assert.equal(getOfficialTurboFallbackDecision(Number.NaN, turboRoute).reason, "invalid_duration");
assert.equal(
  getOfficialTurboFallbackDecision(90 * 60_000, {
    ...turboRoute,
    OWNMINUTES_ASR_FILE_STRATEGY: "invalid-strategy",
    VOLCANO_ASR_MODE: "invalid-mode",
  }).reason,
  "duration_exceeds_cap",
);

assert.match(finalizerSource, /prepareMeetingAudioSnapshot\(input\.meetingId\)/);
assert.match(finalizerSource, /const authoritativeDurationMs = audioSnapshot\.durationMs/);
assert.match(finalizerSource, /getOfficialTurboFallbackDecision\(authoritativeDurationMs\)/);
assert.match(finalizerSource, /reserveFinalizationQuotaOrThrow\(\{\s*durationMs: authoritativeDurationMs,/);
assert.match(finalizerSource, /processMeetingAudio\(\{[\s\S]*?durationMs: authoritativeDurationMs,/);
assert.match(finalizerSource, /recordMeetingFinalizeUsage\(input\.user\.id, \{\s*meetingId: input\.meetingId,\s*durationMs: authoritativeDurationMs,/);
assert.match(finalizerSource, /audioSha256: audioSnapshot\.audioSha256/);
assert.match(finalizerSource, /isOfficialVolcanoTranscriptionProvider\(\)/);
assert.match(finalizerSource, /code: "turbo_fallback_cost_cap"/);
assert.match(finalizerSource, /strategy: "single"/);
assert.match(finalizerSource, /turboFallbackEnabled: false/);
assert.match(meetingProcessingSource, /asr_route: mode=\$\{result\.mode\}/);
assert.match(meetingProcessingSource, /turbo_escalated=\$\{result\.fallbackUsed/);

console.log(JSON.stringify({
  ok: true,
  checks: {
    allowsTurboAtConfiguredBoundary: true,
    blocksTurboAboveConfiguredBoundary: true,
    explicitDisableFailsClosed: true,
    missingEnableSwitchFailsClosed: true,
    invalidCapFailsClosed: true,
    flashRouteCannotBypassCapWithResourceName: true,
    standardModeCannotBypassCapWithTurboResource: true,
    runtimeRejectsStandardModeWithTurboResource: true,
    invalidDurationFailsClosed: true,
    invalidStrategyAndModeFailClosed: true,
    providerNameNormalizationCannotBypassCostGate: true,
    standardPrimaryIsNotBlockedByTurboCap: true,
    byokForcesSingleRouteWithoutPlatformFallback: true,
    routeDiagnosticsSupportCostVerification: true,
    serverAuthoritativeDurationProtectsCostAndBilling: true,
    immutableAudioHashProtectsCheckpointReuse: true,
  },
}, null, 2));
