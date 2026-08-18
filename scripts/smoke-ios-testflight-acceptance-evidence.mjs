#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/ios-testflight-evidence-pass.md";
const failPath = ".data/smoke/ios-testflight-evidence-fail.md";
const partialPath = ".data/smoke/ios-testflight-evidence-partial.md";
const invalidP0Path = ".data/smoke/ios-testflight-evidence-p0-invalid.md";
const rawBillingSecretPath = ".data/smoke/ios-testflight-evidence-raw-billing-secret.md";
const legacyManualApiPath = ".data/smoke/ios-testflight-evidence-legacy-manual-api.md";
const draftPath = ".data/smoke/ios-testflight-evidence-draft.md";
const developmentPath = ".data/smoke/ios-testflight-evidence-development.md";
const uploadEvidencePath = ".data/smoke/appstore-upload/upload-evidence.json";
const candidateSummaryPath = ".data/smoke/appstore-upload/artifacts/latest-summary.json";

const uploadSmoke = spawnSync("node", ["scripts/smoke-ios-appstore-upload.mjs"], { encoding: "utf8" });

const scenarioRows = [
  ["Simulator smoke", "1-3 minutes", "sim-smoke"],
  ["Real iPhone short meeting", "5 minutes", "real-short"],
  ["Real iPhone normal meeting", "30 minutes", "real-normal"],
  ["Real iPhone long meeting", "90 minutes", "real-long"],
  ["Weak Wi-Fi", "30 minutes", "weak-wifi"],
  ["Offline recovery", "10 minutes", "offline"],
  ["Offline cold start", "5 minutes", "offline-cold-start"],
  ["Force-quit recording recovery", "5 minutes", "force-quit-recovery"],
  ["Background and lock screen", "10 minutes", "background"],
  ["Headset interruption", "5 minutes", "headset"],
  ["Share and Markdown", "1 meeting", "share-markdown"],
  ["Account deletion", "1 account", "delete-account"],
  ["Build 10 to 11 in-place upgrade", "Build 10 to Build 11", "upgrade-10-11"],
  ["Legacy local audio recovery", "5 legacy indexes", "legacy-audio"],
  ["Meeting audio detail navigation", "40 detail cycles", "detail-navigation"],
  ["Meeting deletion consistency", "2 meetings", "delete-consistency"],
  ["Three consecutive meetings", "3 x 5 minutes", "three-consecutive"],
  ["Login session continuity", "upgrade plus 2 relaunches", "session-continuity"],
  ["Official and BYOK route billing", "2 x 1-5 minutes", "route-billing"],
  ["Apple Sandbox billing reconciliation", "1 purchase + restore", "apple-sandbox-billing"],
];

const passEvidence = [
  "# iOS TestFlight Acceptance Evidence",
  "",
  "Date: 2026-07-05",
  "Tester: QA Smoke",
  "Device: iPhone 16 Pro",
  "iOS version: 26.5",
  "Build source: App Store Connect",
  "Build version: 1.0.0 (901)",
  "Distribution: TestFlight",
  "API Base URL: https://app.example.com",
  "Account: qa-smoke@example.invalid",
  "",
  ...scenarioRows.map(([scenario, duration, suffix]) => scenarioBlock({ scenario, duration, suffix })).flat(),
].join("\n");

const failEvidence = [
  "# iOS TestFlight Acceptance Evidence",
  "",
  "Date: 2026-07-05",
  "Tester: QA Smoke",
  "Device: iPhone 16 Pro",
  "iOS version: 26.5",
  "Build source: App Store Connect",
  "Build version: 1.0.0 (901)",
  "Distribution: TestFlight",
  "API Base URL: https://app.example.com",
  "Account: qa-smoke@example.invalid",
  "",
  scenarioBlock({ scenario: "Simulator smoke", duration: "1-3 minutes", suffix: "sim-smoke", decision: "fail" }).join("\n"),
].join("\n");

const partialEvidence = [
  "# iOS TestFlight Acceptance Evidence",
  "",
  "Date: 2026-07-05",
  "Tester: QA Smoke",
  "Device: iPhone 16 Pro",
  "iOS version: 26.5",
  "Build source: App Store Connect",
  "Build version: 1.0.0 (901)",
  "Distribution: TestFlight",
  "API Base URL: https://app.example.com",
  "Account: qa-smoke@example.invalid",
  "",
  ...scenarioRows.map(([scenario, duration, suffix]) =>
    scenarioBlock({
      scenario,
      duration,
      suffix,
      omitFields: scenario === "Weak Wi-Fi" ? ["Upload failed: 0"] : [],
    }),
  ).flat(),
].join("\n");

mkdirSync(dirname(passPath), { recursive: true });
writePrivate(passPath, passEvidence);
writePrivate(failPath, failEvidence);
writePrivate(partialPath, partialEvidence);
writePrivate(
  invalidP0Path,
  passEvidence
    .replace("Previous build: 10", "Previous build: 9")
    .replace("Weak-network wall time minutes: 30", "Weak-network wall time minutes: 29")
    .replace("Bottom navigation tab count: 3", "Bottom navigation tab count: 4")
    .replace("Legacy index entries before update: 5", "Legacy index entries before update: 4")
    .replace("Legacy playable entries: 5", "Legacy playable entries: 4")
    .replace("Unavailable audio detail cycles: 20", "Unavailable audio detail cycles: 19")
    .replace("Normal delete UI result: pass", "Normal delete UI result: fail")
    .replace("Consecutive meeting count: 3", "Consecutive meeting count: 2")
    .replace("Session restored after force quit: pass", "Session restored after force quit: fail")
    .replace("Official actual route: official_quota", "Official actual route: byok")
    .replace(`Transaction fingerprint: sha256:${"a".repeat(64)}`, "Transaction fingerprint: raw-transaction-123"),
);
writePrivate(
  rawBillingSecretPath,
  passEvidence.replace(
    "Raw receipt stored in evidence: no",
    "Raw receipt stored in evidence: no\nRaw transaction ID: synthetic-value-that-must-be-rejected",
  ),
);
writePrivate(
  legacyManualApiPath,
  passEvidence.replaceAll("Embedded production API origin: pass", "API Base URL persisted: pass"),
);
writePrivate(
  developmentPath,
  passEvidence
    .replace("Build source: App Store Connect", "Build source: Simulator")
    .replace("Distribution: TestFlight", "Distribution: Expo Go")
    .replace("API Base URL: https://app.example.com", "API Base URL: simulator")
    .replaceAll("Install source: TestFlight", "Install source: Expo Go"),
);

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const partial = runChecker(partialPath);
const invalidP0 = runChecker(invalidP0Path);
const rawBillingSecret = runChecker(rawBillingSecretPath);
const legacyManualApi = runChecker(legacyManualApiPath);
const development = runChecker(developmentPath);
const missingUpload = runChecker(passPath, ".data/smoke/appstore-upload/missing.json");
const draft = runDraft(draftPath);
const draftCheck = runChecker(draftPath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  uploadFixtureReady: uploadSmoke.status === 0 && existsSync(uploadEvidencePath),
  passFixtureAccepted:
    pass.status === 0 &&
    pass.payload?.evidenceReady === true &&
    pass.payload?.uploadEvidenceReady === true &&
    pass.payload?.uploadReceiptMatchesBuild === true &&
    pass.payload?.testflightDistributionReady === true,
  failFixtureRejected: fail.status !== 0 && fail.payload?.evidenceReady === false,
  partialScenarioFieldRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingEvidenceFieldsByScenario?.some((item) => item.scenario === "Weak Wi-Fi" && item.missing.includes("Upload failed:")),
  invalidP0ScenarioRejected:
    invalidP0.status !== 0 &&
    invalidP0.payload?.evidenceReady === false &&
    hasMissingScenarioField(invalidP0.payload, "Build 10 to 11 in-place upgrade", "Previous build: 10") &&
    hasInvalidScenarioEvidence(invalidP0.payload, "Weak Wi-Fi", "weak-network wall time must be at least 30 minutes") &&
    hasInvalidScenarioEvidence(
      invalidP0.payload,
      "Build 10 to 11 in-place upgrade",
      "bottom navigation tab count must be exactly 3",
    ) &&
    hasInvalidScenarioEvidence(invalidP0.payload, "Legacy local audio recovery", "legacy index count before update must be exactly 5") &&
    hasInvalidScenarioEvidence(
      invalidP0.payload,
      "Meeting audio detail navigation",
      "unavailable audio detail cycles must be at least 20",
    ) &&
    hasMissingScenarioField(invalidP0.payload, "Meeting deletion consistency", "Normal delete UI result: pass") &&
    hasInvalidScenarioEvidence(invalidP0.payload, "Three consecutive meetings", "consecutive meeting count must be 3") &&
    hasMissingScenarioField(invalidP0.payload, "Login session continuity", "Session restored after force quit: pass") &&
    hasMissingScenarioField(invalidP0.payload, "Official and BYOK route billing", "Official actual route: official_quota") &&
    hasInvalidScenarioEvidence(
      invalidP0.payload,
      "Apple Sandbox billing reconciliation",
      "transaction fingerprint must be redacted SHA-256 evidence",
    ),
  rawBillingSecretRejected:
    rawBillingSecret.status !== 0 &&
    rawBillingSecret.payload?.evidenceReady === false &&
    rawBillingSecret.payload?.leakedPhrases?.includes("Raw transaction ID:"),
  legacyManualApiEvidenceRejected:
    legacyManualApi.status !== 0 &&
    legacyManualApi.payload?.evidenceReady === false &&
    legacyManualApi.payload?.leakedPhrases?.includes("API Base URL persisted: pass") &&
    legacyManualApi.payload?.missingEvidenceFieldsByScenario?.some((item) =>
      item.missing.includes("Embedded production API origin: pass"),
    ),
  expoGoCannotPassRealIphoneAcceptance:
    development.status !== 0 &&
    development.payload?.evidenceReady === false &&
    development.payload?.testflightDistributionReady === false &&
    development.payload?.hasPublicHttpsApiBaseUrl === false,
  missingUploadReceiptRejected:
    missingUpload.status !== 0 &&
    missingUpload.payload?.uploadEvidenceReady === false &&
    missingUpload.payload?.uploadReceiptMatchesBuild === false,
  draftGenerated:
    draft.status === 0 &&
    draft.payload?.draftWritten === true &&
    draft.payload?.draftDecision === "pending" &&
    readDraft(draftPath).includes("This file is an automated draft from `npm run ios:testflight:evidence:draft`.") &&
    readDraft(draftPath).includes("## Real iPhone long meeting") &&
    readDraft(draftPath).includes("Decision: pending") &&
    readDraft(draftPath).includes("Simulator screenshot:"),
  draftRejectedUntilManualChecks:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.missingPassDecisions?.includes("Simulator smoke") &&
    draftCheck.payload?.missingEvidenceFieldsByScenario?.some((item) => item.scenario === "Real iPhone short meeting"),
  passScenarioCount: pass.payload?.passDecisionCount,
  failMissingScenarios: fail.payload?.missingScenarios?.length,
  requiredScenarioCount: pass.payload?.requiredScenarioCount,
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.passFixtureAccepted ||
  !summary.uploadFixtureReady ||
  !summary.failFixtureRejected ||
  !summary.partialScenarioFieldRejected ||
  !summary.invalidP0ScenarioRejected ||
  !summary.rawBillingSecretRejected ||
  !summary.legacyManualApiEvidenceRejected ||
  !summary.expoGoCannotPassRealIphoneAcceptance ||
  !summary.missingUploadReceiptRejected ||
  !summary.draftGenerated ||
  !summary.draftRejectedUntilManualChecks ||
  !summary.noForbiddenSourcePhrases
) {
  process.exitCode = 1;
}

function scenarioBlock({ scenario, duration, suffix, decision = "pass", omitFields = [] }) {
  const simulatorScenario = scenario === "Simulator smoke";
  const interruptedRecoveryScenario = scenario === "Force-quit recording recovery";
  return [
    `## ${scenario}`,
    "",
    "Date: 2026-07-05",
    "Tester: QA Smoke",
    `Device: ${simulatorScenario ? "iPhone 17 Pro Simulator" : "iPhone 16 Pro"}`,
    `iOS version: ${simulatorScenario ? "26.5 simulator" : "26.5"}`,
    `Build source: ${simulatorScenario ? "Local Xcode Release" : "App Store Connect"}`,
    "Build version: 1.0.0 (901)",
    `Distribution: ${simulatorScenario ? "Simulator" : "TestFlight"}`,
    "API Base URL: https://app.example.com",
    `Scenario: ${scenario}`,
    `Duration: ${duration}`,
    "Network: normal",
    "Account: qa-smoke@example.invalid",
    `Meeting ID: meeting-smoke-${suffix}`,
    `Install source: ${simulatorScenario ? "Local Release Simulator" : "TestFlight"}`,
    "App launch: pass",
    "Embedded production API origin: pass",
    "Microphone permission: pass",
    "Storage preflight: pass",
    "Free storage observed: 12.4 GB",
    "PCM buffers: pass",
    "Realtime chunks: pass",
    "Realtime uploaded: pass",
    "Foreground/background interruptions: 0",
    "Last interruption time: none",
    "Crash observed: no",
    "Memory/battery observation: stable during smoke fixture",
    "Upload pending after stop: 0",
    "Upload failed: 0",
    "Audio playback: pass",
    "Local audio retry/export: pass",
    "Finalize: pass",
    "Transcript/summary boundary: pass",
    "Share link: pass",
    "Markdown export: pass",
    "Delete cleanup: pass",
    ...(interruptedRecoveryScenario
      ? [
          "Interrupted recording isolated: pass",
          "Recovery validation before upload: pass",
          "Recovered duration: 40.362 seconds",
        ]
      : []),
    ...scenarioSpecificEvidence(scenario),
    "Known issues: none",
    `Decision: ${decision}`,
    "",
  ].filter((line) => !omitFields.includes(line));
}

function scenarioSpecificEvidence(scenario) {
  switch (scenario) {
    case "Weak Wi-Fi":
      return [
        "Weak-network wall time minutes: 30",
        "Local file growth during outage: pass",
        "Upload resumed after reconnect: pass",
        "Finalized after reconnect: pass",
        "Reconnected audio playback: pass",
        "Reconnected audio export: pass",
      ];
    case "Force-quit recording recovery":
      return [
        "Force quit while recording: pass",
        "Local recovery entry visible after relaunch: pass",
        "Automatic upload before recovery validation: no",
        "Recovered audio playback: pass",
        "Recovered audio export: pass",
        "Recovered meeting finalized: pass",
      ];
    case "Build 10 to 11 in-place upgrade":
      return [
        "Previous build: 10",
        "Candidate build: 11",
        "In-place update without uninstall: pass",
        "Existing local data preserved: pass",
        "Bottom navigation tab count: 3",
        "Development connection control visible: no",
      ];
    case "Legacy local audio recovery":
      return [
        "Legacy index entries before update: 5",
        "Legacy index entries reconnected: 5",
        "Legacy playable entries: 5",
        "Legacy exportable entries: 5",
        "Legacy inaccessible index entries after update: 0",
        "Local recovery entry always visible: pass",
        "Legacy unavailable warning cleared: pass",
        "Legacy audio playback: pass",
        "Legacy audio export: pass",
        "Legacy source files preserved: pass",
      ];
    case "Meeting audio detail navigation":
      return [
        "Available audio detail cycles: 20",
        "Unavailable audio detail cycles: 20",
        "Available audio return: pass",
        "Unavailable audio return: pass",
        "Error boundary shown: no",
        "Playback control errors: 0",
      ];
    case "Meeting deletion consistency":
      return [
        "Normal delete UI result: pass",
        "Normal delete final state: absent",
        "Weak-network delete UI result: pass",
        "Weak-network delete final state: absent",
        "Lost delete response induced: pass",
        "Pending confirmation shown before truth: pass",
        "Server truth reconciled: pass",
        "Local audio removed before truth: no",
        "Delete false-failure message observed: no",
        "Delete retry idempotent: pass",
        "Deleted meeting visible after relaunch: no",
      ];
    case "Three consecutive meetings":
      return [
        "Consecutive meeting count: 3",
        "Unique meeting IDs: 3",
        "Playable local recordings: 3",
        "Finalized meetings: 3",
        "All three history entries visible: pass",
        "Cross-meeting state leakage: no",
      ];
    case "Login session continuity":
      return [
        "Logged in before update: pass",
        "Session restored after update: pass",
        "Session restored after force quit: pass",
        "Unexpected login prompt: no",
        "Local recordings retained after session checks: pass",
      ];
    case "Official and BYOK route billing":
      return [
        "Official expected route: official_quota",
        "Official actual route: official_quota",
        "Official route immutable during meeting: pass",
        "Official meeting ID matched ledger: pass",
        "Official processed minutes: 3",
        "Official minutes before: 60",
        "Official minutes after: 57",
        "Official charged minutes: 3",
        "Official billing event verified: pass",
        "BYOK expected route: byok",
        "BYOK actual route: byok",
        "BYOK route immutable during meeting: pass",
        "BYOK meeting ID matched ledger: pass",
        "BYOK official minutes before: 57",
        "BYOK official minutes after: 57",
        "BYOK charged official minutes: 0",
        "BYOK provider request verified: pass",
        "BYOK billing event verified: pass",
        "Simulated billing used: no",
      ];
    case "Apple Sandbox billing reconciliation":
      return [
        "StoreKit environment: Sandbox",
        "Product ID: ownminutes.plus.monthly",
        `Transaction fingerprint: sha256:${"a".repeat(64)}`,
        "Raw receipt stored in evidence: no",
        "App Store Server transaction verified: pass",
        "App account binding matched: pass",
        "Server entitlement matched: pass",
        "Official quota matched entitlement: pass",
        "Restore purchases matched entitlement: pass",
        "Simulated billing used: no",
      ];
    default:
      return [];
  }
}

function hasMissingScenarioField(payload, scenario, field) {
  return payload?.missingEvidenceFieldsByScenario?.some(
    (item) => item.scenario === scenario && item.missing.includes(field),
  );
}

function hasInvalidScenarioEvidence(payload, scenario, message) {
  return payload?.invalidScenarioEvidenceByScenario?.some(
    (item) => item.scenario === scenario && item.invalid.includes(message),
  );
}

function runChecker(path, uploadPath = uploadEvidencePath) {
  const result = spawnSync("node", ["scripts/check-ios-testflight-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH: path,
      OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH: uploadPath,
      OWNMINUTES_LOCAL_TESTFLIGHT_SUMMARY_PATH: candidateSummaryPath,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-ios-testflight-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_DRAFT_PATH: path,
      OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH: uploadEvidencePath,
      OWNMINUTES_LOCAL_TESTFLIGHT_SUMMARY_PATH: candidateSummaryPath,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function readDraft(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
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
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/ios-testflight-acceptance-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
