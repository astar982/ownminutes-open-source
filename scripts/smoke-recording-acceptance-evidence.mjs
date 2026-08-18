#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const passPath = ".data/smoke/recording-evidence-pass.md";
const failPath = ".data/smoke/recording-evidence-fail.md";
const partialPath = ".data/smoke/recording-evidence-partial.md";

const scenarioRows = [
  ["Short sanity", "5 minutes", "normal", "short"],
  ["Normal meeting", "30 minutes", "normal", "normal"],
  ["Long meeting", "90 minutes", "normal", "long"],
  ["Weak network", "10 minutes", "weak Wi-Fi restored", "weak"],
  ["Offline recovery", "10 minutes", "offline 60 seconds then restored", "offline"],
  ["Device interruption", "5 minutes", "headset disconnected then recovered", "device"],
  ["Background risk", "10 minutes", "tab/app backgrounded briefly", "background"],
];

const metadata = [
  "# Recording Acceptance Evidence",
  "",
  "Date: 2026-07-05",
  "Tester: QA Smoke",
  "Environment: local preview",
  "App URL: http://127.0.0.1:3002/app",
  "Build source: production preview",
  "Browser: Chrome",
  "Device: MacBook test device",
  "Microphone: built-in microphone",
  "Account: qa-smoke@example.invalid",
  "",
];

const passEvidence = [
  ...metadata,
  ...scenarioRows.map(([scenario, duration, network, suffix]) => scenarioBlock({ scenario, duration, network, suffix })).flat(),
].join("\n");

const failEvidence = [
  ...metadata,
  ...scenarioBlock({
    scenario: "Short sanity",
    duration: "5 minutes",
    network: "normal",
    suffix: "short",
    decision: "fail",
  }),
].join("\n");

const partialEvidence = [
  ...metadata,
  ...scenarioRows.map(([scenario, duration, network, suffix]) =>
    scenarioBlock({
      scenario,
      duration,
      network,
      suffix,
      omitFields: scenario === "Weak network" ? ["Pending after stop: 0"] : [],
    }),
  ).flat(),
].join("\n");

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, passEvidence);
writeFileSync(failPath, failEvidence);
writeFileSync(partialPath, partialEvidence);

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const partial = runChecker(partialPath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  passFixtureAccepted: pass.status === 0 && pass.payload?.evidenceReady === true,
  failFixtureRejected: fail.status !== 0 && fail.payload?.evidenceReady === false,
  partialFixtureRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingEvidenceFieldsByScenario?.some((item) => item.scenario === "Weak network" && item.missing.includes("Pending after stop: 0")),
  requiredScenarioCount: pass.payload?.requiredScenarioCount,
  passDecisionCount: pass.payload?.passDecisionCount,
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.passFixtureAccepted || !summary.failFixtureRejected || !summary.partialFixtureRejected || !summary.noForbiddenSourcePhrases) {
  process.exitCode = 1;
}

function scenarioBlock({ scenario, duration, network, suffix, decision = "pass", omitFields = [] }) {
  return [
    `## ${scenario}`,
    "",
    `Scenario: ${scenario}`,
    `Duration: ${duration}`,
    "Started at: 2026-07-05T10:00:00.000Z",
    "Stopped at: 2026-07-05T10:05:00.000Z",
    `Network condition: ${network}`,
    `Meeting ID: recording-smoke-${suffix}`,
    "Timer reached expected duration: pass",
    "Chunks increasing: pass",
    "Bytes: 1048576",
    "Local audio URI/file exists: pass",
    "Pending after stop: 0",
    "Failed chunks: 0",
    "Finalize waited for upload completion: pass",
    "Local audio playback: pass",
    scenario === "Background risk" ? "Foreground/background interruptions: 1" : "Foreground/background interruptions: 0",
    scenario === "Background risk" ? "Last interruption time: 2026-07-05T10:00:00.000Z" : "Last interruption time: none",
    "Crash or tab freeze observed: no",
    "Memory/battery observation: stable during smoke fixture",
    "Finalize result: pass",
    "Transcript boundary: pass",
    "Summary boundary: pass",
    "Share link: pass",
    "Obsidian Markdown: pass",
    "Retry/export state: pass",
    "Recovery after restart/reopen: pass",
    "No secrets leaked: yes",
    "Known issues: none",
    `Decision: ${decision}`,
    "",
  ].filter((line) => !omitFields.includes(line));
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-recording-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_RECORDING_ACCEPTANCE_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "-----BEGIN PRIVATE KEY-----"];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/recording-long-test-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
