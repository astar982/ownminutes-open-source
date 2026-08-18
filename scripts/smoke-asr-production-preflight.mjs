#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const completeEnv = {
  TRANSCRIPTION_PROVIDER: "volcano",
  VOLCANO_ASR_API_KEY: "redacted-asr-api-key",
  OWNMINUTES_ASR_FILE_STRATEGY: "single",
  VOLCANO_ASR_MODE: "flash",
  VOLCANO_ASR_RECOGNIZE_URL: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  VOLCANO_ASR_SUBMIT_URL: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
  VOLCANO_ASR_QUERY_URL: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
  VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo",
  OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "1",
  OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "30",
  VOLCANO_ASR_TURBO_RECOGNIZE_URL: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  VOLCANO_ASR_TURBO_RESOURCE_ID: "volc.bigasr.auc_turbo",
  OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE: "5-30s Mandarin sample and 1-3 minute meeting evidence recorded with transcriptPreview",
  OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY: "near-field, alternating speakers, far-field, mild noise, accent sample",
  OWNMINUTES_ASR_FALLBACK_POLICY: "fallback transcript cannot be accepted as production ASR evidence",
  OWNMINUTES_ASR_PRIVACY_POLICY: "no customer private audio in smoke; no raw secrets in output",
};

const standardThenTurboEnv = {
  ...completeEnv,
  OWNMINUTES_ASR_FILE_STRATEGY: "standard_then_turbo",
  VOLCANO_ASR_MODE: "standard",
  VOLCANO_ASR_RESOURCE_ID: "volc.seedasr.auc",
};

const legacyFlashEnv = {
  ...completeEnv,
  OWNMINUTES_ASR_FILE_STRATEGY: "single",
  VOLCANO_ASR_MODE: "flash",
  VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo",
  OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "1",
  OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "30",
  VOLCANO_ASR_TURBO_RECOGNIZE_URL: "",
  VOLCANO_ASR_TURBO_RESOURCE_ID: "",
};

const cases = [
  {
    name: "missing-env",
    expectOk: false,
    env: {},
  },
  {
    name: "account-ak-sk-only",
    expectOk: false,
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ACCESS_KEY_ID: "account-ak",
      VOLCANO_SECRET_ACCESS_KEY: "redacted-account-sk",
    },
  },
  {
    name: "api-key-no-evidence-policy",
    expectOk: false,
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_API_KEY: "redacted-asr-api-key",
    },
  },
  {
    name: "invalid-strategy",
    expectOk: false,
    env: {
      ...completeEnv,
      OWNMINUTES_ASR_FILE_STRATEGY: "cheap_then_anything",
    },
  },
  {
    name: "standard-strategy-with-flash-primary",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      VOLCANO_ASR_MODE: "flash",
    },
  },
  {
    name: "standard-strategy-with-turbo-primary",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo",
    },
  },
  {
    name: "standard-strategy-with-disabled-fallback",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "0",
    },
  },
  {
    name: "standard-strategy-with-http-fallback",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      VOLCANO_ASR_TURBO_RECOGNIZE_URL: "http://openspeech.local/recognize",
    },
  },
  {
    name: "standard-strategy-with-arbitrary-https-submit-host",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      VOLCANO_ASR_SUBMIT_URL: "https://example.com/api/v3/auc/bigmodel/submit",
    },
  },
  {
    name: "standard-strategy-with-arbitrary-https-query-host",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      VOLCANO_ASR_QUERY_URL: "https://example.com/api/v3/auc/bigmodel/query",
    },
  },
  {
    name: "standard-strategy-with-arbitrary-https-fallback-host",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      VOLCANO_ASR_TURBO_RECOGNIZE_URL: "https://example.com/api/v3/auc/bigmodel/recognize/flash",
    },
  },
  {
    name: "standard-strategy-with-non-turbo-fallback",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      VOLCANO_ASR_TURBO_RESOURCE_ID: "volc.seedasr.auc",
    },
  },
  {
    name: "standard-strategy-with-unbounded-fallback",
    expectOk: false,
    env: {
      ...standardThenTurboEnv,
      OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "31",
    },
  },
  {
    name: "single-flash-with-unbounded-cap",
    expectOk: false,
    env: {
      ...completeEnv,
      OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "31",
    },
  },
  {
    name: "single-flash-with-disabled-cost-guard",
    expectOk: false,
    env: {
      ...legacyFlashEnv,
      OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "0",
    },
  },
  {
    name: "single-standard-with-turbo-resource",
    expectOk: false,
    env: {
      ...completeEnv,
      VOLCANO_ASR_MODE: "standard",
      VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo",
    },
  },
  {
    name: "single-flash-with-arbitrary-https-host",
    expectOk: false,
    env: {
      ...legacyFlashEnv,
      VOLCANO_ASR_RECOGNIZE_URL: "https://example.com/api/v3/auc/bigmodel/recognize/flash",
    },
  },
  {
    name: "single-flash-with-credentialed-endpoint",
    expectOk: false,
    env: {
      ...legacyFlashEnv,
      VOLCANO_ASR_RECOGNIZE_URL: "https://fixture-user:fixture-password@openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    },
  },
  {
    name: "single-flash-with-fragmented-endpoint",
    expectOk: false,
    env: {
      ...legacyFlashEnv,
      VOLCANO_ASR_RECOGNIZE_URL: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash#fixture",
    },
  },
  {
    name: "single-flash-with-custom-port",
    expectOk: false,
    env: {
      ...legacyFlashEnv,
      VOLCANO_ASR_RECOGNIZE_URL: "https://openspeech.bytedance.com:444/api/v3/auc/bigmodel/recognize/flash",
    },
  },
  {
    name: "complete-api-key",
    expectOk: true,
    env: completeEnv,
  },
  {
    name: "complete-app-token",
    expectOk: true,
    env: {
      ...completeEnv,
      VOLCANO_ASR_API_KEY: "",
      VOLCANO_ASR_APP_ID: "asr-app-id",
      VOLCANO_ASR_TOKEN: "redacted-asr-token",
    },
  },
  {
    name: "complete-standard-then-turbo",
    expectOk: true,
    env: standardThenTurboEnv,
  },
  {
    name: "complete-default-cap",
    expectOk: true,
    env: {
      ...standardThenTurboEnv,
      OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "",
    },
  },
  {
    name: "legacy-single-flash",
    expectOk: true,
    env: legacyFlashEnv,
  },
];

const results = cases.map((testCase) => {
  const output = runCase(testCase.env);
  const payload = parseJson(output.stdout);
  return {
    name: testCase.name,
    expected: testCase.expectOk,
    status: output.status,
    ok: payload?.ok,
    productionCandidate: payload?.productionCandidate,
    provider: payload?.provider,
    scopeMentionsFileOnly: String(payload?.scope || "").includes("file ASR") && String(payload?.scope || "").includes("realtime"),
    missing: payload?.missing ?? [],
    strategy: payload?.configured?.strategy,
    hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 20,
    hasRequiredEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.length >= 12,
    hasRuntimeCredentialGate: payload?.checks?.some((check) => check.id === "runtime-credential"),
    hasAccountKeyGate: payload?.checks?.some((check) => check.id === "account-ak-sk-not-runtime"),
    hasRealAudioGate: payload?.checks?.some((check) => check.id === "real-audio-evidence"),
    hasQualityGate: payload?.checks?.some((check) => check.id === "quality-sampling-policy"),
    hasRealtimeBoundaryGate: payload?.checks?.some((check) => check.id === "realtime-boundary"),
    hasPrivateAudioUrlGate: payload?.checks?.some((check) => check.id === "private-audio-url-delivery"),
    hasFileStrategyGate: payload?.checks?.some((check) => check.id === "file-strategy"),
    hasPrimaryModeGate: payload?.checks?.some((check) => check.id === "primary-mode-contract"),
    hasPrimaryEndpointGate: payload?.checks?.some((check) => check.id === "primary-endpoint-https"),
    hasPrimaryResourceGate: payload?.checks?.some((check) => check.id === "primary-resource-contract"),
    hasTurboFallbackEnabledGate: payload?.checks?.some((check) => check.id === "turbo-fallback-enabled"),
    hasTurboFallbackUrlGate: payload?.checks?.some((check) => check.id === "turbo-fallback-url-https"),
    hasTurboFallbackResourceGate: payload?.checks?.some((check) => check.id === "turbo-fallback-resource"),
    hasTurboFallbackCapGate: payload?.checks?.some((check) => check.id === "turbo-fallback-duration-cap"),
    noSecretLeaks:
      !output.combined.includes("redacted-asr-api-key") &&
      !output.combined.includes("redacted-asr-token") &&
      !output.combined.includes("redacted-account-sk") &&
      !output.combined.includes("AKL") &&
      !output.combined.includes("sk-proj") &&
      !output.combined.includes("Secret Access Key") &&
      !output.combined.includes("WVRCaE"),
  };
});

const summary = {
  allExpected: results.every((result) => result.ok === result.expected),
  strictFailsWhenMissing: results.find((result) => result.name === "missing-env")?.status === 1,
  strictFailsWithAccountKeysOnly: results.find((result) => result.name === "account-ak-sk-only")?.status === 1,
  strictFailsWithoutEvidencePolicy: results.find((result) => result.name === "api-key-no-evidence-policy")?.status === 1,
  strictFailsWithInvalidStrategy: results.find((result) => result.name === "invalid-strategy")?.status === 1,
  strictFailsWithFlashPrimary: results.find((result) => result.name === "standard-strategy-with-flash-primary")?.status === 1,
  strictFailsWithTurboPrimary: results.find((result) => result.name === "standard-strategy-with-turbo-primary")?.status === 1,
  strictFailsWithDisabledFallback: results.find((result) => result.name === "standard-strategy-with-disabled-fallback")?.status === 1,
  strictFailsWithHttpFallback: results.find((result) => result.name === "standard-strategy-with-http-fallback")?.status === 1,
  strictFailsWithArbitraryHttpsSubmitHost:
    results.find((result) => result.name === "standard-strategy-with-arbitrary-https-submit-host")?.status === 1,
  strictFailsWithArbitraryHttpsQueryHost:
    results.find((result) => result.name === "standard-strategy-with-arbitrary-https-query-host")?.status === 1,
  strictFailsWithArbitraryHttpsFallbackHost:
    results.find((result) => result.name === "standard-strategy-with-arbitrary-https-fallback-host")?.status === 1,
  strictFailsWithNonTurboFallback: results.find((result) => result.name === "standard-strategy-with-non-turbo-fallback")?.status === 1,
  strictFailsWithUnboundedFallback: results.find((result) => result.name === "standard-strategy-with-unbounded-fallback")?.status === 1,
  strictFailsWithUnboundedSingleCap: results.find((result) => result.name === "single-flash-with-unbounded-cap")?.status === 1,
  strictFailsWithDisabledSingleFlashCostGuard:
    results.find((result) => result.name === "single-flash-with-disabled-cost-guard")?.status === 1,
  strictFailsWithSingleStandardTurboResource:
    results.find((result) => result.name === "single-standard-with-turbo-resource")?.status === 1,
  strictFailsWithArbitraryHttpsSingleFlashHost:
    results.find((result) => result.name === "single-flash-with-arbitrary-https-host")?.status === 1,
  strictFailsWithCredentialedSingleFlashEndpoint:
    results.find((result) => result.name === "single-flash-with-credentialed-endpoint")?.status === 1,
  strictFailsWithFragmentedSingleFlashEndpoint:
    results.find((result) => result.name === "single-flash-with-fragmented-endpoint")?.status === 1,
  strictFailsWithCustomPortSingleFlashEndpoint:
    results.find((result) => result.name === "single-flash-with-custom-port")?.status === 1,
  strictPassesWithCompleteApiKey: results.find((result) => result.name === "complete-api-key")?.status === 0,
  strictPassesWithCompleteAppToken: results.find((result) => result.name === "complete-app-token")?.status === 0,
  strictPassesWithCompleteStandardThenTurbo: results.find((result) => result.name === "complete-standard-then-turbo")?.status === 0,
  strictPassesWithDefaultCap: results.find((result) => result.name === "complete-default-cap")?.status === 0,
  strictPassesWithLegacySingleFlash: results.find((result) => result.name === "legacy-single-flash")?.status === 0,
  allHaveChecks: results.every((result) => result.hasChecks),
  allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
  allHaveProductionGates: results.every(
    (result) =>
      result.hasRuntimeCredentialGate &&
      result.hasAccountKeyGate &&
      result.hasRealAudioGate &&
      result.hasQualityGate &&
      result.hasPrivateAudioUrlGate &&
      result.hasRealtimeBoundaryGate &&
      result.hasFileStrategyGate &&
      result.hasPrimaryModeGate &&
      result.hasPrimaryEndpointGate &&
      result.hasPrimaryResourceGate &&
      result.hasTurboFallbackEnabledGate &&
      result.hasTurboFallbackUrlGate &&
      result.hasTurboFallbackResourceGate &&
      result.hasTurboFallbackCapGate,
  ),
  allScopesMentionFileOnly: results.every((result) => result.scopeMentionsFileOnly),
  noSecretLeaks: results.every((result) => result.noSecretLeaks),
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.allExpected ||
  !summary.strictFailsWhenMissing ||
  !summary.strictFailsWithAccountKeysOnly ||
  !summary.strictFailsWithoutEvidencePolicy ||
  !summary.strictFailsWithInvalidStrategy ||
  !summary.strictFailsWithFlashPrimary ||
  !summary.strictFailsWithTurboPrimary ||
  !summary.strictFailsWithDisabledFallback ||
  !summary.strictFailsWithHttpFallback ||
  !summary.strictFailsWithArbitraryHttpsSubmitHost ||
  !summary.strictFailsWithArbitraryHttpsQueryHost ||
  !summary.strictFailsWithArbitraryHttpsFallbackHost ||
  !summary.strictFailsWithNonTurboFallback ||
  !summary.strictFailsWithUnboundedFallback ||
  !summary.strictFailsWithUnboundedSingleCap ||
  !summary.strictFailsWithDisabledSingleFlashCostGuard ||
  !summary.strictFailsWithSingleStandardTurboResource ||
  !summary.strictFailsWithArbitraryHttpsSingleFlashHost ||
  !summary.strictFailsWithCredentialedSingleFlashEndpoint ||
  !summary.strictFailsWithFragmentedSingleFlashEndpoint ||
  !summary.strictFailsWithCustomPortSingleFlashEndpoint ||
  !summary.strictPassesWithCompleteApiKey ||
  !summary.strictPassesWithCompleteAppToken ||
  !summary.strictPassesWithCompleteStandardThenTurbo ||
  !summary.strictPassesWithDefaultCap ||
  !summary.strictPassesWithLegacySingleFlash ||
  !summary.allHaveChecks ||
  !summary.allHaveRequiredEnv ||
  !summary.allHaveProductionGates ||
  !summary.allScopesMentionFileOnly ||
  !summary.noSecretLeaks
) {
  process.exitCode = 1;
}

function runCase(env) {
  const result = spawnSync(process.execPath, ["scripts/check-asr-production-env.mjs", "--strict"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      ...env,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid ASR preflight JSON: ${error.message}\n${stdout}`);
  }
}
