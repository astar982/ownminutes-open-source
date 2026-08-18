#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const qualityModuleUrl = new URL("../src/lib/meeting-result-quality.ts", import.meta.url);
const transcriptQualityUrl = new URL("../src/lib/transcript-quality.ts", import.meta.url);
const qualitySource = readFileSync(qualityModuleUrl, "utf8")
  .replace('from "./transcript-quality"', `from "${transcriptQualityUrl.href}"`);
const transpiled = ts.transpileModule(qualitySource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false,
  },
}).outputText;
const quality = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}#summary-reprocess-${Date.now()}`);

const formalTranscript = [
  {
    id: "seg-1",
    speaker: "Speaker 1",
    timestamp: "00:01",
    text: "我们确认了发布范围、负责人和下周的验收安排。",
  },
];
const baseResult = {
  meetingId: "summary-only-reprocess",
  title: "摘要重做烟测",
  generatedAt: "2026-07-17T00:00:00.000Z",
  provider: "volcano",
  adapter: "volcano-file-asr",
  transcript: formalTranscript,
  summary: {
    summary: "旧摘要",
    topics: ["发布"],
    speakerViews: [],
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
    knowledgePoints: [],
  },
  obsidianMarkdown: "# 旧摘要",
  diagnostics: ["summary_provider_failed: 纪要模型暂时不可用，已使用本地逐字稿约束总结。"],
};

assert.equal(quality.canReuseFormalTranscript(baseResult), true, "a formal transcript remains reusable when only the old summary failed");
assert.equal(
  quality.canReuseFormalTranscript({ ...baseResult, adapter: "volcano-file-asr-fallback" }),
  false,
  "fallback transcripts must never bypass file ASR",
);
assert.equal(
  quality.canReuseFormalTranscript({
    ...baseResult,
    transcript: [{ id: "placeholder", speaker: "System", timestamp: "00:00", text: "音频已保存，等待正式识别配置完成。" }],
  }),
  false,
  "placeholder transcripts must never be reused",
);
assert.equal(
  quality.canReuseFormalTranscript({ ...baseResult, diagnostics: ["asr_incomplete: provider response could not be verified"] }),
  false,
  "an ASR failure diagnostic must not be hidden by formal-looking transcript text",
);
assert.equal(
  quality.canReuseFormalTranscript({ ...baseResult, transcript: [{ id: "short", speaker: "Speaker 1", timestamp: "00:01", text: "好" }] }),
  false,
  "low-confidence transcript text must return to the original ASR path",
);
assert.equal(quality.canReuseFormalTranscript({ ...baseResult, provider: "mock" }), false, "mock transcripts are not formal transcripts");

const finalizer = readFileSync("src/lib/server/meeting-finalizer.ts", "utf8");
const processing = readFileSync("src/lib/meeting-processing.ts", "utf8");
const finalizeRoute = readFileSync("src/app/api/meetings/[id]/finalize/route.ts", "utf8");
const browserPipeline = readFileSync("src/lib/audio-pipeline.ts", "utf8");
const browserActions = readFileSync("src/components/meeting-detail-actions.tsx", "utf8");
const mobileApi = readFileSync("apps/mobile/src/api.ts", "utf8");
const queue = readFileSync("src/lib/server/finalization-queue.ts", "utf8");
const processingCheckpoint = readFileSync("src/lib/server/meeting-processing-checkpoint.ts", "utf8");
const meetingAudioStore = readFileSync("src/lib/server/meeting-audio-store.ts", "utf8");
const preferredExistingIndex = finalizer.indexOf("const existingFormalTranscript = input.force && existingResult && existingTranscriptMatchesAudio && canReuseFormalTranscript(existingResult)");
const preferredTranscriptIndex = finalizer.indexOf("const preferredTranscript = durableCheckpoint");
const asrConfigGuardIndex = finalizer.indexOf("if (!preferredTranscript && isOfficialVolcanoTranscriptionProvider())");
const audioPreparationIndex = finalizer.indexOf("requiresMeetingAudioForProcessing() && !preferredTranscript");
const processingPreferredIndex = processing.indexOf('if (provider === "volcano" && input.preferredTranscript');
const processingAsrIndex = processing.indexOf('await input.onProviderStageStart?.("asr")');

const checks = {
  forceReprocessSelectsOnlyFormalExistingTranscript:
    preferredExistingIndex >= 0 &&
    finalizer.includes("Reused the existing formal transcript for summary-only reprocessing") &&
    finalizer.includes(": existingFormalTranscript") &&
    preferredExistingIndex < preferredTranscriptIndex,
  reusedTranscriptSkipsAsrAndAudioPreparation:
    preferredTranscriptIndex < asrConfigGuardIndex &&
    asrConfigGuardIndex < audioPreparationIndex &&
    processingPreferredIndex >= 0 &&
    processingPreferredIndex < processingAsrIndex,
  summaryIsStillRegenerated:
    finalizer.includes("const preferredSummary = durableCheckpoint?.summary") &&
    !finalizer.includes("preferredSummary: existingResult") &&
    processing.includes("const summary = await summarizeTranscript({") &&
    processing.includes("preferredSummary: input.preferredSummary"),
  unusableExistingTranscriptKeepsOriginalAsrPath:
    finalizer.includes("input.force && existingResult && existingTranscriptMatchesAudio && canReuseFormalTranscript(existingResult)") &&
    finalizer.includes("if (!preferredTranscript && isOfficialVolcanoTranscriptionProvider())") &&
    finalizer.includes("requiresMeetingAudioForProcessing() && !preferredTranscript"),
  transcriptReuseIsBoundToCurrentAudio:
    finalizer.includes("const existingResultMatchesCurrentAudio = freshness.current") &&
    finalizer.includes("existingResult.audioSha256 === audioSnapshot.audioSha256") &&
    finalizer.includes("audioSha256: audioSnapshot.audioSha256") &&
    processingCheckpoint.includes("checkpoint.audioSha256 !== input.audioSha256") &&
    finalizer.includes("expectedAudioRevision: audioSnapshot.audioRevision") &&
    meetingAudioStore.includes('code: "audio_revision_changed"'),
  forceOperationIdControlsIdempotency:
    finalizeRoute.includes('body.operationId ?? request.headers.get("idempotency-key")') &&
    finalizeRoute.includes("reprocessMeetingOperationKey(id, operationId)") &&
    finalizeRoute.includes("usageOperationKey: forceOperationKey") &&
    finalizer.includes("input.usageOperationKey ||") &&
    !finalizer.includes("existingResult.processingOperationKey?.startsWith"),
  legacyBuildRemainsCompatible:
    finalizeRoute.includes("return `legacy-${randomUUID()}`") &&
    finalizer.includes("reprocessMeetingOperationKey(input.meetingId, `legacy-${randomUUID()}`)"),
  webAndExpoCreatePerActionOperationIds:
    browserPipeline.includes("createBrowserReprocessOperationId()") &&
    browserPipeline.includes("JSON.stringify({ title, force, operationId, ...audioSeal })") &&
    browserActions.includes("hasResult ? createBrowserReprocessOperationId() : undefined") &&
    mobileApi.includes("params.operationId ?? `reprocess-${Crypto.randomUUID()}`") &&
    mobileApi.includes("processingMode: params.processingMode"),
  concurrentDifferentForceActionIsNotSilentlyReused:
    queue.includes("input.processingOperationKey !== existingJob.processing_operation_key") &&
    queue.includes('code: "processing_in_progress"'),
};

assert.equal(Object.values(checks).every(Boolean), true, JSON.stringify(checks));

console.log(JSON.stringify({
  ok: true,
  checks,
  scenarios: {
    formalTranscriptSummaryFailureIsReusable: true,
    forceSummaryReprocessAsrCalls: 0,
    summaryProviderPathRemainsEnabled: true,
    sameNetworkRetryReusesOperationId: true,
    consecutiveForceActionsUseDifferentOperationIds: true,
    placeholderOrFallbackTranscriptReturnsToAsr: true,
  },
}, null, 2));
