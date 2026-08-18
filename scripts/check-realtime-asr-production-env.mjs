#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const adapterPath = path.join(repoRoot, "src", "lib", "transcription-adapter.ts");
const protocolPath = path.join(repoRoot, "src", "lib", "server", "volcano-realtime-asr.ts");
const mobileRealtimeSmokePath = path.join(repoRoot, "scripts", "smoke-mobile-realtime-chunks.mjs");
const runbookPath = path.join(repoRoot, "docs", "asr-runtime-runbook.md");
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_REALTIME_ASR_PREFLIGHT_STRICT === "1";

const requiredEnv = [
  "TRANSCRIPTION_PROVIDER=volcano",
  "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
  "VOLCANO_ASR_WS_URL wss:// endpoint",
  "VOLCANO_REALTIME_ASR_RESOURCE_ID or default volc.seedasr.sauc.duration",
  "OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED=1",
  "OWNMINUTES_REALTIME_ASR_RUNTIME=stateful_node",
  "OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY",
  "OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY",
  "OWNMINUTES_REALTIME_ASR_WEAK_NETWORK_EVIDENCE",
  "OWNMINUTES_REALTIME_ASR_FAILURE_ISOLATION_EVIDENCE",
  "OWNMINUTES_REALTIME_ASR_REAL_MEETING_EVIDENCE",
];

function main() {
  const adapterSource = readFile(adapterPath);
  const protocolSource = readFile(protocolPath);
  const mobileRealtimeSmokeSource = readFile(mobileRealtimeSmokePath);
  const hasApiKey = Boolean(process.env.VOLCANO_ASR_API_KEY);
  const hasAppTokenPair = Boolean(process.env.VOLCANO_ASR_APP_ID && process.env.VOLCANO_ASR_TOKEN);
  const hasAccountOnlyKeys = Boolean(process.env.VOLCANO_ACCESS_KEY_ID || process.env.VOLCANO_SECRET_ACCESS_KEY);
  const hasRuntimeCredential = hasApiKey || hasAppTokenPair;
  const wsUrl = process.env.VOLCANO_ASR_WS_URL || process.env.VOLCANO_ASR_ENDPOINT || "";
  const protocolImplementedFlag = process.env.OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED === "1";
  const sourceStillPendingProtocol =
    adapterSource.includes("Volcano runtime config is present, but protocol implementation is pending") ||
    !adapterSource.includes("transcribeWithVolcanoRealtime");
  const hasLiveRealtimeFunction =
    adapterSource.includes("transcribeWithVolcanoRealtime") &&
    protocolSource.includes("createVolcanoRealtimeSession") &&
    protocolSource.includes("buildVolcanoProtocolFrame") &&
    protocolSource.includes("finishVolcanoRealtimeSession") &&
    protocolSource.includes("socket.ping()") &&
    protocolSource.includes('"reconnecting"') &&
    protocolSource.includes("sessions.delete(key)");
  const statefulRuntime = process.env.OWNMINUTES_REALTIME_ASR_RUNTIME === "stateful_node";
  const realtimeResourceId = process.env.VOLCANO_REALTIME_ASR_RESOURCE_ID || "volc.seedasr.sauc.duration";
  const weakNetworkEvidence = hasPassingEvidence(process.env.OWNMINUTES_REALTIME_ASR_WEAK_NETWORK_EVIDENCE);
  const failureIsolationEvidence = hasPassingEvidence(process.env.OWNMINUTES_REALTIME_ASR_FAILURE_ISOLATION_EVIDENCE);
  const realMeetingEvidence = hasPassingEvidence(process.env.OWNMINUTES_REALTIME_ASR_REAL_MEETING_EVIDENCE);

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
      "No account AK/SK-only realtime ASR configuration detected.",
      "VOLCANO_ACCESS_KEY_ID/VOLCANO_SECRET_ACCESS_KEY alone cannot be treated as realtime ASR runtime credentials.",
    ),
    check(
      "websocket-url",
      isSecureWebSocketUrl(wsUrl),
      "Realtime ASR WebSocket URL uses an approved wss:// provider host.",
      "VOLCANO_ASR_WS_URL must use the approved official wss:// provider host.",
    ),
    check(
      "resource-id",
      Boolean(realtimeResourceId),
      "Realtime ASR resource id is explicitly configured.",
      "Missing VOLCANO_REALTIME_ASR_RESOURCE_ID for realtime ASR.",
    ),
    check(
      "stateful-runtime",
      statefulRuntime,
      "Realtime ASR is declared for a stateful Node runtime.",
      "Set OWNMINUTES_REALTIME_ASR_RUNTIME=stateful_node; in-memory WebSocket sessions are not serverless-safe.",
    ),
    check(
      "protocol-flag",
      protocolImplementedFlag,
      "Realtime ASR protocol implementation flag is set.",
      "Missing OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED=1.",
    ),
    check(
      "protocol-source",
      protocolImplementedFlag && hasLiveRealtimeFunction && !sourceStillPendingProtocol,
      "Realtime ASR source appears to contain a live protocol implementation.",
      "Realtime ASR adapter still appears to be pending protocol implementation.",
    ),
    check(
      "heartbeat-policy",
      Boolean(process.env.OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY),
      "Realtime ASR heartbeat policy is declared.",
      "Missing OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY.",
    ),
    check(
      "reconnect-policy",
      Boolean(process.env.OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY),
      "Realtime ASR reconnect policy is declared.",
      "Missing OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY.",
    ),
    check(
      "weak-network-evidence",
      weakNetworkEvidence,
      "Realtime ASR weak network evidence is declared.",
      "Missing OWNMINUTES_REALTIME_ASR_WEAK_NETWORK_EVIDENCE.",
    ),
    check(
      "failure-isolation-evidence",
      failureIsolationEvidence,
      "Realtime ASR failure isolation evidence is declared.",
      "Missing OWNMINUTES_REALTIME_ASR_FAILURE_ISOLATION_EVIDENCE.",
    ),
    check(
      "real-meeting-evidence",
      realMeetingEvidence,
      "Realtime ASR real meeting evidence is declared.",
      "Missing OWNMINUTES_REALTIME_ASR_REAL_MEETING_EVIDENCE.",
    ),
    check(
      "mobile-realtime-smoke",
      mobileRealtimeSmokeSource.includes("configuredRealtimeProviderStatus") &&
        mobileRealtimeSmokeSource.includes("configuredRealtimeKeepsAudioSaved") &&
        mobileRealtimeSmokeSource.includes("noFormalMeetingManifestCreated") &&
        mobileRealtimeSmokeSource.includes("invalidRealtimeTracked") &&
        mobileRealtimeSmokeSource.includes("rejectedRealtimeStatusReadable") &&
        mobileRealtimeSmokeSource.includes("rejected_format"),
      "Mobile realtime smoke verifies chunk upload, rejected format tracking, saved-audio isolation, and no formal manifest pollution.",
      "Mobile realtime smoke is missing rejected format tracking, saved-audio isolation, or manifest boundary checks.",
    ),
    check("runbook", fs.existsSync(runbookPath), "ASR runtime runbook exists.", "Missing docs/asr-runtime-runbook.md."),
  ];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const summary = {
    ok: missing.length === 0,
    strict,
    provider: process.env.TRANSCRIPTION_PROVIDER || "mock",
    productionCandidate: missing.length === 0,
    scope: "realtime WebSocket ASR only; post-meeting file ASR is certified by asr:preflight",
    requiredEnv,
    configured: {
      providerVolcano: process.env.TRANSCRIPTION_PROVIDER === "volcano",
      asrApiKey: hasApiKey,
      appTokenPair: hasAppTokenPair,
      accountKeysPresent: hasAccountOnlyKeys,
      websocketUrl: Boolean(wsUrl),
      resourceId: Boolean(realtimeResourceId),
      protocolImplementedFlag,
      statefulRuntime,
      sourceHasLiveRealtimeFunction: hasLiveRealtimeFunction,
      sourceStillPendingProtocol,
      heartbeatPolicy: Boolean(process.env.OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY),
      reconnectPolicy: Boolean(process.env.OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY),
      weakNetworkEvidence,
      failureIsolationEvidence,
      realMeetingEvidence,
    },
    missing,
    checks,
    nextAction:
      missing.length === 0
        ? "Run live realtime ASR with a 1-3 minute Mandarin meeting, then compare draft latency, reconnect behavior, and post-meeting file ASR fallback."
        : sourceStillPendingProtocol
          ? "Complete the realtime WebSocket ASR implementation, then rerun npm run realtime:preflight."
          : "Add a Volcano speech runtime credential and collect weak-network plus 1-3 minute real-meeting evidence, then rerun npm run realtime:preflight.",
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

function hasPassingEvidence(value) {
  if (!value) return false;
  const filePath = path.isAbsolute(value) ? value : path.join(repoRoot, value);
  if (!fs.existsSync(filePath)) return false;
  return /Decision:\s*pass/i.test(fs.readFileSync(filePath, "utf8"));
}

function isSecureWebSocketUrl(value) {
  try {
    const url = new URL(value);
    const allowedHosts = new Set([
      "openspeech.bytedance.com",
      ...(process.env.OWNMINUTES_VOLCANO_REALTIME_ALLOWED_HOSTS || "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ]);
    return (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      allowedHosts.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE") ||
    text.includes("realtime-live-key") ||
    text.includes("realtime-live-token") ||
    text.includes("VOLCANO_ASR_API_KEY=")
  );
}

main();
