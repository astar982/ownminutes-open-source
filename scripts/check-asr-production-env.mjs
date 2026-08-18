#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const volcanoAsrPath = path.join(repoRoot, "src", "lib", "volcano-asr.ts");
const audioNormalizationPath = path.join(repoRoot, "src", "lib", "audio-normalization.ts");
const providerHealthPath = path.join(repoRoot, "src", "lib", "provider-health.ts");
const meetingFinalizerPath = path.join(repoRoot, "src", "lib", "server", "meeting-finalizer.ts");
const meetingAudioStorePath = path.join(repoRoot, "src", "lib", "server", "meeting-audio-store.ts");
const meetingObjectStorePath = path.join(repoRoot, "src", "lib", "server", "meeting-object-store.ts");
const asrDiagnosticSmokePath = path.join(repoRoot, "scripts", "smoke-asr-diagnostics.mjs");
const runbookPath = path.join(repoRoot, "docs", "asr-runtime-runbook.md");
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_ASR_PREFLIGHT_STRICT === "1";
const defaultFlashRecognizeUrl = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const defaultStandardResourceId = "volc.seedasr.auc";
const defaultTurboResourceId = "volc.bigasr.auc_turbo";

const requiredEnv = [
  "TRANSCRIPTION_PROVIDER=volcano",
  "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
  "OWNMINUTES_ASR_FILE_STRATEGY=single|standard_then_turbo",
  "VOLCANO_ASR_MODE=standard always requires a non-Turbo VOLCANO_ASR_RESOURCE_ID",
  "VOLCANO_ASR runtime endpoints on https://openspeech.bytedance.com without credentials, fragments, or custom ports",
  "OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1 for standard_then_turbo and single/flash Turbo-only routes",
  "OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES as an integer from 1 through 30 (defaults to 30)",
  "VOLCANO_ASR_TURBO_RECOGNIZE_URL on https://openspeech.bytedance.com",
  "VOLCANO_ASR_TURBO_RESOURCE_ID containing turbo",
  "OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE",
  "OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY",
  "OWNMINUTES_ASR_FALLBACK_POLICY",
  "OWNMINUTES_ASR_PRIVACY_POLICY",
];

function main() {
  const volcanoAsrSource = readFile(volcanoAsrPath);
  const audioNormalizationSource = readFile(audioNormalizationPath);
  const providerHealthSource = readFile(providerHealthPath);
  const meetingFinalizerSource = readFile(meetingFinalizerPath);
  const meetingAudioStoreSource = readFile(meetingAudioStorePath);
  const meetingObjectStoreSource = readFile(meetingObjectStorePath);
  const asrDiagnosticSmokeSource = readFile(asrDiagnosticSmokePath);
  const configuredStrategy = process.env.OWNMINUTES_ASR_FILE_STRATEGY?.trim();
  const strategy = configuredStrategy || "single";
  const configuredMode = process.env.VOLCANO_ASR_MODE?.trim();
  const mode = configuredMode || "flash";
  const recognizeUrl = process.env.VOLCANO_ASR_RECOGNIZE_URL || defaultFlashRecognizeUrl;
  const submitUrl = process.env.VOLCANO_ASR_SUBMIT_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
  const queryUrl = process.env.VOLCANO_ASR_QUERY_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
  const primaryResourceId = process.env.VOLCANO_ASR_RESOURCE_ID || (mode === "standard" ? defaultStandardResourceId : defaultTurboResourceId);
  const fallbackEnabled = process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED?.trim();
  const fallbackMaxAudioMinutes = process.env.OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES?.trim() || "30";
  const fallbackRecognizeUrl = process.env.VOLCANO_ASR_TURBO_RECOGNIZE_URL || "";
  const fallbackResourceId = process.env.VOLCANO_ASR_TURBO_RESOURCE_ID || "";
  const strategyValid = strategy === "single" || strategy === "standard_then_turbo";
  const modeValid = mode === "flash" || mode === "standard";
  const fallbackBooleanValid = !fallbackEnabled || fallbackEnabled === "0" || fallbackEnabled === "1";
  const fallbackCapValid = isBoundedFallbackMinutes(fallbackMaxAudioMinutes);
  const standardThenTurbo = strategy === "standard_then_turbo";
  const primaryResourceIsTurbo = isTurboResource(primaryResourceId);
  const turboCostGuardRequired = standardThenTurbo || (strategy === "single" && (mode === "flash" || primaryResourceIsTurbo));
  const hasApiKey = Boolean(process.env.VOLCANO_ASR_API_KEY);
  const hasAppTokenPair = Boolean(process.env.VOLCANO_ASR_APP_ID && process.env.VOLCANO_ASR_TOKEN);
  const hasAccountOnlyKeys = Boolean(process.env.VOLCANO_ACCESS_KEY_ID || process.env.VOLCANO_SECRET_ACCESS_KEY);
  const hasRuntimeCredential = hasApiKey || hasAppTokenPair;

  const checks = [
    check(
      "provider-volcano",
      process.env.TRANSCRIPTION_PROVIDER === "volcano",
      "TRANSCRIPTION_PROVIDER=volcano is configured.",
      "Missing TRANSCRIPTION_PROVIDER=volcano.",
    ),
    check(
      "runtime-credential",
      hasRuntimeCredential,
      "Volcano ASR runtime credential is configured.",
      "Missing VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN.",
    ),
    check(
      "account-ak-sk-not-runtime",
      !hasAccountOnlyKeys || hasRuntimeCredential,
      "No account AK/SK-only ASR configuration detected.",
      "VOLCANO_ACCESS_KEY_ID/VOLCANO_SECRET_ACCESS_KEY alone cannot be treated as ASR runtime credentials.",
    ),
    check(
      "file-strategy",
      strategyValid,
      `File ASR strategy is ${strategy}.`,
      "OWNMINUTES_ASR_FILE_STRATEGY must be single or standard_then_turbo.",
    ),
    check("primary-mode-value", modeValid, `Primary ASR mode is ${mode}.`, "VOLCANO_ASR_MODE must be standard or flash."),
    check(
      "primary-mode-contract",
      !standardThenTurbo || mode === "standard",
      standardThenTurbo ? "The low-cost primary route uses standard mode." : "Legacy single-route mode remains supported.",
      "standard_then_turbo requires VOLCANO_ASR_MODE=standard.",
    ),
    check(
      "primary-endpoint-https",
      mode === "standard"
        ? isOfficialVolcanoRuntimeEndpoint(submitUrl) && isOfficialVolcanoRuntimeEndpoint(queryUrl)
        : isOfficialVolcanoRuntimeEndpoint(recognizeUrl),
      mode === "standard"
        ? "Standard submit/query endpoints use the official Volcano runtime host."
        : "Flash recognition endpoint uses the official Volcano runtime host.",
      mode === "standard"
        ? "VOLCANO_ASR_SUBMIT_URL and VOLCANO_ASR_QUERY_URL must use https://openspeech.bytedance.com without credentials, fragments, or custom ports."
        : "VOLCANO_ASR_RECOGNIZE_URL must use https://openspeech.bytedance.com without credentials, fragments, or custom ports.",
    ),
    check(
      "primary-resource-contract",
      Boolean(primaryResourceId) && (mode !== "standard" || !primaryResourceIsTurbo),
      mode === "standard" ? "The standard primary resource is explicitly non-Turbo." : "The flash primary resource is configured or defaulted.",
      "VOLCANO_ASR_MODE=standard requires a non-Turbo VOLCANO_ASR_RESOURCE_ID.",
    ),
    check(
      "turbo-fallback-boolean",
      fallbackBooleanValid,
      "Turbo fallback switch uses the 0|1 contract.",
      "OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED must be 0 or 1 when set.",
    ),
    check(
      "turbo-fallback-enabled",
      !turboCostGuardRequired || fallbackEnabled === "1",
      turboCostGuardRequired
        ? "Turbo usage is explicitly enabled behind the bounded cost guard."
        : "The non-Turbo single route does not require the Turbo cost switch.",
      "standard_then_turbo and single/flash Turbo-only routes require OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1.",
    ),
    check(
      "turbo-fallback-url-https",
      !standardThenTurbo || isOfficialVolcanoRuntimeEndpoint(fallbackRecognizeUrl),
      standardThenTurbo
        ? "Turbo fallback recognition URL uses the official Volcano runtime host."
        : "The single route does not require a separate fallback URL.",
      "standard_then_turbo requires VOLCANO_ASR_TURBO_RECOGNIZE_URL on https://openspeech.bytedance.com without credentials, fragments, or custom ports.",
    ),
    check(
      "turbo-fallback-resource",
      !standardThenTurbo || isTurboResource(fallbackResourceId),
      standardThenTurbo ? "Turbo fallback uses a Turbo resource." : "Legacy single route does not require a separate fallback resource.",
      "standard_then_turbo requires a Turbo VOLCANO_ASR_TURBO_RESOURCE_ID.",
    ),
    check(
      "turbo-fallback-duration-cap",
      fallbackCapValid,
      "Turbo fallback cap is a bounded 1-30 minute value (default 30).",
      "OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES must be an integer from 1 through 30 when set.",
    ),
    check(
      "real-audio-evidence",
      Boolean(process.env.OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE),
      "Real audio evidence policy is declared.",
      "Missing OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE.",
    ),
    check(
      "quality-sampling-policy",
      Boolean(process.env.OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY),
      "ASR quality sampling policy is declared.",
      "Missing OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY.",
    ),
    check(
      "fallback-policy",
      Boolean(process.env.OWNMINUTES_ASR_FALLBACK_POLICY),
      "ASR fallback policy is declared.",
      "Missing OWNMINUTES_ASR_FALLBACK_POLICY.",
    ),
    check(
      "privacy-policy",
      Boolean(process.env.OWNMINUTES_ASR_PRIVACY_POLICY),
      "ASR privacy policy is declared.",
      "Missing OWNMINUTES_ASR_PRIVACY_POLICY.",
    ),
    check(
      "adapter-runtime",
      volcanoAsrSource.includes("recognizeAudio") &&
        volcanoAsrSource.includes("normalizeAudioForVolcanoAsr") &&
        volcanoAsrSource.includes("audioUrl") &&
        volcanoAsrSource.includes("requires exactly one audio URL or audio buffer") &&
        volcanoAsrSource.includes("ssd_version") &&
        volcanoAsrSource.includes("normalizeVolcanoTranscript"),
      "Volcano file ASR adapter supports flash recognition, audio normalization, speaker clustering, and transcript normalization.",
      "Volcano file ASR adapter is missing flash recognition, audio normalization, speaker clustering, or transcript normalization.",
    ),
    check(
      "adapter-cost-aware-routing",
      volcanoAsrSource.includes("standard_then_turbo") &&
        volcanoAsrSource.includes("fallbackUsed") &&
        volcanoAsrSource.includes("turboFallbackMaxAudioMinutes"),
      "Volcano file ASR adapter implements standard-primary routing with bounded Turbo fallback telemetry.",
      "Volcano file ASR adapter is missing the standard-primary and bounded Turbo fallback contract.",
    ),
    check(
      "speech-audio-standardization",
      audioNormalizationSource.includes("loudnorm=I=-20:TP=-2:LRA=11") &&
        audioNormalizationSource.includes('"libopus"') &&
        audioNormalizationSource.includes('"48k"') &&
        audioNormalizationSource.includes('mimeType: "audio/ogg"'),
      "Meeting audio is standardized from 16 kHz mono speech input to -20 LUFS, 48 kbps OGG Opus before file ASR.",
      "Missing the benchmarked speech loudness and OGG Opus standardization path.",
    ),
    check(
      "private-audio-url-delivery",
      meetingFinalizerSource.includes("prepareMeetingAudioSnapshot") &&
        meetingFinalizerSource.includes("audioSnapshot.prepareForAsr()") &&
        !meetingFinalizerSource.includes("readMeetingAudioBundle") &&
        meetingAudioStoreSource.includes("createPresignedGetUrl") &&
        meetingAudioStoreSource.includes('buildMeetingObjectKey(meetingKey, "asrInput"') &&
        meetingObjectStoreSource.includes("presignAwsV4Get") &&
        meetingObjectStoreSource.includes("UNSIGNED-PAYLOAD"),
      "Production ASR input is file-normalized, delivered by short-lived private object URL, and cleaned after processing.",
      "Missing file-based private ASR URL delivery or cleanup implementation.",
    ),
    check(
      "realtime-boundary",
      providerHealthSource.includes("realtimeProtocolReady = true") &&
        providerHealthSource.includes("realtimeConfigured") &&
        asrDiagnosticSmokeSource.includes("ws-url-with-protocol-flag-enables-realtime-capability"),
      "Realtime protocol implementation remains separately gated by runtime credentials and acceptance evidence.",
      "Realtime ASR capability boundary is missing or may be conflated with file ASR readiness.",
    ),
    check("runbook", fs.existsSync(runbookPath), "ASR runtime runbook exists.", "Missing docs/asr-runtime-runbook.md."),
  ];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const summary = {
    ok: missing.length === 0,
    strict,
    provider: process.env.TRANSCRIPTION_PROVIDER || "mock",
    productionCandidate: missing.length === 0,
    scope:
      strategy === "standard_then_turbo"
        ? "post-meeting file ASR with a standard primary route and bounded Turbo fallback; realtime WebSocket quality is not certified by this preflight"
        : "post-meeting legacy single-route file ASR; realtime WebSocket quality is not certified by this preflight",
    requiredEnv,
    configured: {
      providerVolcano: process.env.TRANSCRIPTION_PROVIDER === "volcano",
      asrApiKey: hasApiKey,
      appTokenPair: hasAppTokenPair,
      accountKeysPresent: hasAccountOnlyKeys,
      strategy,
      mode,
      recognizeUrl: Boolean(process.env.VOLCANO_ASR_RECOGNIZE_URL),
      resourceId: Boolean(primaryResourceId),
      turboFallbackEnabled: fallbackEnabled === "1",
      turboFallbackMaxAudioMinutes: fallbackCapValid ? Number(fallbackMaxAudioMinutes) : null,
      turboRecognizeUrl: Boolean(fallbackRecognizeUrl),
      turboResourceId: Boolean(fallbackResourceId),
      realAudioEvidence: Boolean(process.env.OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE),
      qualitySamplingPolicy: Boolean(process.env.OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY),
      fallbackPolicy: Boolean(process.env.OWNMINUTES_ASR_FALLBACK_POLICY),
      privacyPolicy: Boolean(process.env.OWNMINUTES_ASR_PRIVACY_POLICY),
    },
    missing,
    checks,
    nextAction:
      missing.length === 0
        ? "Run a real 5-30 second Mandarin ASR transcribe test, then record a 1-3 minute meeting and compare transcript quality against docs/asr-acceptance-evidence-template.md."
        : "Set the missing ASR production environment and rerun npm run asr:preflight.",
    leaksSecrets: leaksSecrets(JSON.stringify({ checks, missing, requiredEnv })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (summary.leaksSecrets || (strict && !summary.ok)) {
    process.exitCode = 1;
  }
}

function check(id, passed, passDetail, failDetail) {
  return {
    id,
    status: passed ? "pass" : "fail",
    detail: passed ? passDetail : failDetail,
  };
}

function readFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function isOfficialVolcanoRuntimeEndpoint(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "openspeech.bytedance.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isTurboResource(value) {
  return typeof value === "string" && value.trim().toLowerCase().includes("turbo");
}

function isBoundedFallbackMinutes(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 30;
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE") ||
    text.includes("asr-live-key") ||
    text.includes("runtime-token") ||
    text.includes("VOLCANO_ASR_API_KEY=")
  );
}

main();
