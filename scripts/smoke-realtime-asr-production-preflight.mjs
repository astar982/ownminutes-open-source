#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evidenceDirectory = mkdtempSync(join(tmpdir(), "ownminutes-realtime-preflight-"));
const weakNetworkEvidence = writeEvidence("weak-network.md");
const failureIsolationEvidence = writeEvidence("failure-isolation.md");
const realMeetingEvidence = writeEvidence("real-meeting.md");

const completeEnv = {
  TRANSCRIPTION_PROVIDER: "volcano",
  VOLCANO_ASR_API_KEY: "redacted-realtime-api-key",
  VOLCANO_ASR_WS_URL: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  VOLCANO_REALTIME_ASR_RESOURCE_ID: "volc.seedasr.sauc.duration",
  OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED: "1",
  OWNMINUTES_REALTIME_ASR_RUNTIME: "stateful_node",
  OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY: "ping/pong heartbeat every 15 seconds; close stale sessions after 45 seconds",
  OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY: "bounded reconnect with session resume disabled until provider contract confirms resume support",
  OWNMINUTES_REALTIME_ASR_WEAK_NETWORK_EVIDENCE: weakNetworkEvidence,
  OWNMINUTES_REALTIME_ASR_FAILURE_ISOLATION_EVIDENCE: failureIsolationEvidence,
  OWNMINUTES_REALTIME_ASR_REAL_MEETING_EVIDENCE: realMeetingEvidence,
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
    name: "http-websocket-url",
    expectOk: false,
    env: {
      ...completeEnv,
      VOLCANO_ASR_WS_URL: "http://openspeech.local/realtime",
    },
  },
  {
    name: "untrusted-wss-host",
    expectOk: false,
    env: {
      ...completeEnv,
      VOLCANO_ASR_WS_URL: "wss://127.0.0.1/internal-probe",
    },
  },
  {
    name: "configured-but-no-protocol-flag",
    expectOk: false,
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_API_KEY: "redacted-realtime-api-key",
      VOLCANO_ASR_WS_URL: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
      VOLCANO_REALTIME_ASR_RESOURCE_ID: "volc.seedasr.sauc.duration",
    },
  },
  {
    name: "complete-env",
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
      VOLCANO_ASR_TOKEN: "redacted-realtime-token",
    },
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
    scopeMentionsRealtimeOnly: String(payload?.scope || "").includes("realtime WebSocket ASR") && String(payload?.scope || "").includes("file ASR"),
    missing: payload?.missing ?? [],
    hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 13,
    hasRequiredEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.length >= 9,
    hasRuntimeCredentialGate: payload?.checks?.some((check) => check.id === "runtime-credential"),
    hasAccountKeyGate: payload?.checks?.some((check) => check.id === "account-ak-sk-not-runtime"),
    hasWebSocketGate: payload?.checks?.some((check) => check.id === "websocket-url"),
    hasProtocolSourceGate: payload?.checks?.some((check) => check.id === "protocol-source"),
    hasHeartbeatGate: payload?.checks?.some((check) => check.id === "heartbeat-policy"),
    hasReconnectGate: payload?.checks?.some((check) => check.id === "reconnect-policy"),
    hasWeakNetworkGate: payload?.checks?.some((check) => check.id === "weak-network-evidence"),
    hasFailureIsolationGate: payload?.checks?.some((check) => check.id === "failure-isolation-evidence"),
    hasMobileRealtimeSmokeGate: payload?.checks?.some((check) => check.id === "mobile-realtime-smoke"),
    noSecretLeaks:
      !output.combined.includes("redacted-realtime-api-key") &&
      !output.combined.includes("redacted-realtime-token") &&
      !output.combined.includes("redacted-account-sk") &&
      !output.combined.includes("AKL") &&
      !output.combined.includes("sk-proj") &&
      !output.combined.includes("Secret Access Key") &&
      !output.combined.includes("WVRCaE"),
  };
});

const completeCase = results.find((result) => result.name === "complete-env");
const appTokenCase = results.find((result) => result.name === "complete-app-token");
const summary = {
  allExpected: results.every((result) => result.ok === result.expected),
  strictFailsWhenMissing: results.find((result) => result.name === "missing-env")?.status === 1,
  strictFailsWithAccountKeysOnly: results.find((result) => result.name === "account-ak-sk-only")?.status === 1,
  strictFailsWithHttpWebSocketUrl: results.find((result) => result.name === "http-websocket-url")?.status === 1,
  strictFailsWithUntrustedWebSocketHost: results.find((result) => result.name === "untrusted-wss-host")?.status === 1,
  strictFailsWithoutProtocolFlag: results.find((result) => result.name === "configured-but-no-protocol-flag")?.status === 1,
  completeEnvPassesImplementedSource: completeCase?.status === 0 && completeCase?.missing.length === 0,
  completeAppTokenPassesImplementedSource: appTokenCase?.status === 0 && appTokenCase?.missing.length === 0,
  allHaveChecks: results.every((result) => result.hasChecks),
  allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
  allHaveProductionGates: results.every(
    (result) =>
      result.hasRuntimeCredentialGate &&
      result.hasAccountKeyGate &&
      result.hasWebSocketGate &&
      result.hasProtocolSourceGate &&
      result.hasHeartbeatGate &&
      result.hasReconnectGate &&
      result.hasWeakNetworkGate &&
      result.hasFailureIsolationGate &&
      result.hasMobileRealtimeSmokeGate,
  ),
  allScopesMentionRealtimeOnly: results.every((result) => result.scopeMentionsRealtimeOnly),
  noSecretLeaks: results.every((result) => result.noSecretLeaks),
  results,
};

console.log(JSON.stringify(summary, null, 2));
rmSync(evidenceDirectory, { recursive: true, force: true });

if (
  !summary.allExpected ||
  !summary.strictFailsWhenMissing ||
  !summary.strictFailsWithAccountKeysOnly ||
  !summary.strictFailsWithHttpWebSocketUrl ||
  !summary.strictFailsWithUntrustedWebSocketHost ||
  !summary.strictFailsWithoutProtocolFlag ||
  !summary.completeEnvPassesImplementedSource ||
  !summary.completeAppTokenPassesImplementedSource ||
  !summary.allHaveChecks ||
  !summary.allHaveRequiredEnv ||
  !summary.allHaveProductionGates ||
  !summary.allScopesMentionRealtimeOnly ||
  !summary.noSecretLeaks
) {
  process.exitCode = 1;
}

function writeEvidence(fileName) {
  const filePath = join(evidenceDirectory, fileName);
  writeFileSync(filePath, "# Smoke evidence\n\nDecision: pass\n");
  return filePath;
}

function runCase(env) {
  const result = spawnSync(process.execPath, ["scripts/check-realtime-asr-production-env.mjs", "--strict"], {
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
    throw new Error(`Invalid realtime ASR preflight JSON: ${error.message}\n${stdout}`);
  }
}
