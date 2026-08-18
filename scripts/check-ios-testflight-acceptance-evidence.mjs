#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const evidencePath = process.env.OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH || ".data/acceptance/ios-testflight-latest.md";
const evidenceDraftPath = process.env.OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_DRAFT_PATH?.trim() || "";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";
const privateModeReady = existsSync(evidencePath) && (statSync(evidencePath).mode & 0o077) === 0;
const uploadEvidencePath = process.env.OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH || ".data/acceptance/appstore-upload-latest.json";
const candidateSummaryPath = process.env.OWNMINUTES_LOCAL_TESTFLIGHT_SUMMARY_PATH || ".data/testflight-local/latest-summary.json";
const uploadVerification = verifyUploadEvidence();
const uploadReceipt = readJson(uploadEvidencePath);

const requiredMetadata = [
  "Date:",
  "Tester:",
  "Device:",
  "iOS version:",
  "Build source:",
  "Build version:",
  "Distribution:",
  "API Base URL:",
  "Account:",
];

const scenarioRequirements = [
  { name: "Simulator smoke", duration: "1-3 minutes" },
  { name: "Real iPhone short meeting", duration: "5 minutes" },
  { name: "Real iPhone normal meeting", duration: "30 minutes" },
  { name: "Real iPhone long meeting", duration: "90 minutes" },
  {
    name: "Weak Wi-Fi",
    duration: "30 minutes",
    requiredFields: [
      "Weak-network wall time minutes:",
      "Local file growth during outage: pass",
      "Upload resumed after reconnect: pass",
      "Finalized after reconnect: pass",
      "Reconnected audio playback: pass",
      "Reconnected audio export: pass",
    ],
  },
  { name: "Offline recovery", duration: "10 minutes" },
  { name: "Offline cold start", duration: "5 minutes" },
  {
    name: "Force-quit recording recovery",
    duration: "5 minutes",
    requiredFields: [
      "Force quit while recording: pass",
      "Local recovery entry visible after relaunch: pass",
      "Automatic upload before recovery validation: no",
      "Recovered audio playback: pass",
      "Recovered audio export: pass",
      "Recovered meeting finalized: pass",
    ],
  },
  { name: "Background and lock screen", duration: "10 minutes" },
  { name: "Headset interruption", duration: "5 minutes" },
  { name: "Share and Markdown", duration: "1 meeting" },
  { name: "Account deletion", duration: "1 account" },
  {
    name: "Build 10 to 11 in-place upgrade",
    duration: "Build 10 to Build 11",
    requiredFields: [
      "Previous build: 10",
      "Candidate build: 11",
      "In-place update without uninstall: pass",
      "Existing local data preserved: pass",
      "Bottom navigation tab count: 3",
      "Development connection control visible: no",
    ],
  },
  {
    name: "Legacy local audio recovery",
    duration: "5 legacy indexes",
    requiredFields: [
      "Legacy index entries before update:",
      "Legacy index entries reconnected:",
      "Legacy playable entries:",
      "Legacy exportable entries:",
      "Legacy inaccessible index entries after update: 0",
      "Local recovery entry always visible: pass",
      "Legacy unavailable warning cleared: pass",
      "Legacy audio playback: pass",
      "Legacy audio export: pass",
      "Legacy source files preserved: pass",
    ],
  },
  {
    name: "Meeting audio detail navigation",
    duration: "40 detail cycles",
    requiredFields: [
      "Available audio detail cycles:",
      "Unavailable audio detail cycles:",
      "Available audio return: pass",
      "Unavailable audio return: pass",
      "Error boundary shown: no",
      "Playback control errors: 0",
    ],
  },
  {
    name: "Meeting deletion consistency",
    duration: "2 meetings",
    requiredFields: [
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
    ],
  },
  {
    name: "Three consecutive meetings",
    duration: "3 x 5 minutes",
    requiredFields: [
      "Consecutive meeting count:",
      "Unique meeting IDs:",
      "Playable local recordings:",
      "Finalized meetings:",
      "All three history entries visible: pass",
      "Cross-meeting state leakage: no",
    ],
  },
  {
    name: "Login session continuity",
    duration: "upgrade plus 2 relaunches",
    requiredFields: [
      "Logged in before update: pass",
      "Session restored after update: pass",
      "Session restored after force quit: pass",
      "Unexpected login prompt: no",
      "Local recordings retained after session checks: pass",
    ],
  },
  {
    name: "Official and BYOK route billing",
    duration: "2 x 1-5 minutes",
    requiredFields: [
      "Official expected route: official_quota",
      "Official actual route: official_quota",
      "Official route immutable during meeting: pass",
      "Official meeting ID matched ledger: pass",
      "Official processed minutes:",
      "Official minutes before:",
      "Official minutes after:",
      "Official charged minutes:",
      "Official billing event verified: pass",
      "BYOK expected route: byok",
      "BYOK actual route: byok",
      "BYOK route immutable during meeting: pass",
      "BYOK meeting ID matched ledger: pass",
      "BYOK official minutes before:",
      "BYOK official minutes after:",
      "BYOK charged official minutes: 0",
      "BYOK provider request verified: pass",
      "BYOK billing event verified: pass",
      "Simulated billing used: no",
    ],
  },
  {
    name: "Apple Sandbox billing reconciliation",
    duration: "1 purchase + restore",
    requiredFields: [
      "StoreKit environment: Sandbox",
      "Product ID:",
      "Transaction fingerprint:",
      "Raw receipt stored in evidence: no",
      "App Store Server transaction verified: pass",
      "App account binding matched: pass",
      "Server entitlement matched: pass",
      "Official quota matched entitlement: pass",
      "Restore purchases matched entitlement: pass",
      "Simulated billing used: no",
    ],
  },
];

const requiredEvidenceFields = [
  "Meeting ID:",
  "Install source:",
  "App launch: pass",
  "Embedded production API origin: pass",
  "Microphone permission: pass",
  "Storage preflight: pass",
  "Free storage observed:",
  "PCM buffers:",
  "Realtime chunks:",
  "Realtime uploaded:",
  "Foreground/background interruptions:",
  "Crash observed: no",
  "Memory/battery observation:",
  "Upload pending after stop:",
  "Upload failed:",
  "Audio playback: pass",
  "Local audio retry/export: pass",
  "Finalize: pass",
  "Transcript/summary boundary: pass",
  "Share link: pass",
  "Markdown export: pass",
  "Delete cleanup: pass",
];

const interruptedRecoveryEvidenceFields = [
  "Interrupted recording isolated: pass",
  "Recovery validation before upload: pass",
  "Recovered duration:",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "-----BEGIN PRIVATE KEY-----",
  "Bearer ",
  "session=",
  "BEGIN OPENSSH PRIVATE KEY",
  "Raw receipt:",
  "Raw transaction ID:",
  "API Base URL persisted: pass",
];

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const scenarioSections = getScenarioSections(evidence);
const scenarioChecks = scenarioRequirements.map((requirement) => {
  const section = scenarioSections.get(requirement.name) ?? "";
  const simulatorScenario = requirement.name === "Simulator smoke";
  return {
    scenario: requirement.name,
    exists: Boolean(section),
    hasScenarioField: section.includes(`Scenario: ${requirement.name}`),
    hasDuration: section.includes(`Duration: ${requirement.duration}`),
    missingEvidenceFields: [
      ...requiredEvidenceFields,
      ...(requirement.name === "Force-quit recording recovery" ? interruptedRecoveryEvidenceFields : []),
    ].filter((phrase) => !section.includes(phrase)),
    missingScenarioSpecificFields: (requirement.requiredFields ?? []).filter(
      (phrase) => !hasRequiredScenarioField(section, phrase),
    ),
    invalidEvidence: validateScenarioEvidence(requirement.name, section),
    installSourceReady: simulatorScenario
      ? section.includes("Install source: Local Release Simulator")
      : section.includes("Install source: TestFlight"),
    realDeviceReady: simulatorScenario || (!/Device:.*simulator/i.test(section) && /Device:\s*iPhone/i.test(section)),
    hasPassDecision: /Decision:\s*pass/i.test(section),
    hasFailDecision: /Decision:\s*fail/i.test(section),
  };
});
const missingScenarios = scenarioChecks.filter((item) => !item.exists).map((item) => item.scenario);
const missingScenarioFields = scenarioChecks
  .filter((item) => item.exists && !item.hasScenarioField)
  .map((item) => item.scenario);
const missingDurations = scenarioChecks.filter((item) => item.exists && !item.hasDuration).map((item) => item.scenario);
const missingEvidenceFieldsByScenario = scenarioChecks
  .filter((item) => item.exists && (item.missingEvidenceFields.length > 0 || item.missingScenarioSpecificFields.length > 0))
  .map((item) => ({
    scenario: item.scenario,
    missing: [...item.missingEvidenceFields, ...item.missingScenarioSpecificFields],
  }));
const invalidScenarioEvidenceByScenario = scenarioChecks
  .filter((item) => item.exists && item.invalidEvidence.length > 0)
  .map((item) => ({ scenario: item.scenario, invalid: item.invalidEvidence }));
const missingPassDecisions = scenarioChecks.filter((item) => item.exists && !item.hasPassDecision).map((item) => item.scenario);
const scenarioFailDecisions = scenarioChecks.filter((item) => item.hasFailDecision).map((item) => item.scenario);
const invalidInstallSources = scenarioChecks.filter((item) => item.exists && !item.installSourceReady).map((item) => item.scenario);
const invalidRealDevices = scenarioChecks.filter((item) => item.exists && !item.realDeviceReady).map((item) => item.scenario);
const requiredScenarioCount = scenarioRequirements.length;
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));
const passDecisionCount = countMatches(evidence, /Decision:\s*pass/gi);
const failDecisionCount = countMatches(evidence, /Decision:\s*fail/gi);
const apiBaseUrl = readLineValue(evidence, "API Base URL:");
const buildVersion = readLineValue(evidence, "Build version:");
const distribution = readLineValue(evidence, "Distribution:");
const buildSource = readLineValue(evidence, "Build source:");
const hasPublicHttpsApiBaseUrl = isPublicHttps(apiBaseUrl);
const testflightDistributionReady = distribution === "TestFlight" && buildSource === "App Store Connect";
const uploadReceiptMatchesBuild = matchesUploadReceipt(uploadReceipt, buildVersion, apiBaseUrl);

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  privateModeReady,
  requiredScenarioCount,
  passDecisionCount,
  failDecisionCount,
  hasPublicHttpsApiBaseUrl,
  testflightDistributionReady,
  uploadEvidenceReady: uploadVerification.ok,
  uploadReceiptMatchesBuild,
  uploadEvidenceErrors: uploadVerification.errors,
  missingMetadata,
  missingScenarios,
  missingScenarioFields,
  missingDurations,
  missingEvidenceFieldsByScenario,
  invalidScenarioEvidenceByScenario,
  missingPassDecisions,
  scenarioFailDecisions,
  invalidInstallSources,
  invalidRealDevices,
  leakedPhrases,
  evidenceReady:
    Boolean(evidence) &&
    privateModeReady &&
    missingMetadata.length === 0 &&
    missingScenarios.length === 0 &&
    missingScenarioFields.length === 0 &&
    missingDurations.length === 0 &&
    missingEvidenceFieldsByScenario.length === 0 &&
    invalidScenarioEvidenceByScenario.length === 0 &&
    missingPassDecisions.length === 0 &&
    scenarioFailDecisions.length === 0 &&
    invalidInstallSources.length === 0 &&
    invalidRealDevices.length === 0 &&
    leakedPhrases.length === 0 &&
    passDecisionCount >= requiredScenarioCount &&
    failDecisionCount === 0 &&
    hasPublicHttpsApiBaseUrl &&
    testflightDistributionReady &&
    uploadVerification.ok &&
    uploadReceiptMatchesBuild,
  checkerBoundary:
    "This checker validates private-file permissions, structure, arithmetic, redaction, build/upload matching, and declared decisions. It cannot prove that a tester performed a real device, provider, deletion, or Apple transaction; QA must not fabricate those observations.",
};

if (evidenceDraftPath) {
  writeEvidenceDraft(evidenceDraftPath);
  console.log(
    JSON.stringify(
      {
        ...summary,
        evidenceDraftPath,
        draftWritten: true,
        draftDecision: "pending",
        draftNote: "Draft files are intentionally incomplete and must fail ios:testflight:evidence until a real App Store upload receipt and every TestFlight/iPhone scenario are verified. Never paste or fabricate an Apple receipt or raw transaction ID.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(JSON.stringify(summary, null, 2));

if (!summary.evidenceReady) {
  process.exitCode = 1;
}

function countMatches(text, pattern) {
  return Array.from(text.matchAll(pattern)).length;
}

function getScenarioSections(text) {
  const sections = new Map();
  const headingPattern = /^##\s+(.+)$/gm;
  const headings = Array.from(text.matchAll(headingPattern));

  headings.forEach((match, index) => {
    const name = match[1].trim();
    const start = match.index ?? 0;
    const next = headings[index + 1]?.index ?? text.length;
    sections.set(name, text.slice(start, next));
  });

  return sections;
}

function writeEvidenceDraft(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildEvidenceDraft(), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function buildEvidenceDraft() {
  const screenshot = readSimulatorScreenshotSummary();
  return [
    "# iOS TestFlight Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run ios:testflight:evidence:draft`.",
    "Replace every `pending` value with real simulator, iPhone, or TestFlight evidence before running `npm run ios:testflight:evidence` as a release gate.",
    "The checker validates completeness and consistency only. It cannot prove that real-device, provider, deletion, or Apple observations occurred; do not fabricate them, and never paste a raw Apple receipt or transaction ID.",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "Tester: pending",
    "Device: pending",
    "iOS version: pending",
    "Build source: App Store Connect",
    "Build version: pending",
    "Distribution: TestFlight",
    "API Base URL: pending",
    "Account: pending",
    `App Store upload evidence: ${uploadEvidencePath}`,
    `Candidate summary: ${candidateSummaryPath}`,
    "",
    ...scenarioRequirements.map((requirement) => draftScenarioBlock(requirement, screenshot)).flat(),
  ].join("\n");
}

function draftScenarioBlock(requirement, screenshot) {
  const simulatorScenario = requirement.name === "Simulator smoke";
  const interruptedRecoveryScenario = requirement.name === "Force-quit recording recovery";
  return [
    `## ${requirement.name}`,
    "",
    "Date: pending",
    "Tester: pending",
    "Device: pending",
    "iOS version: pending",
    "Build source: pending",
    "Build version: pending",
    "Distribution: pending",
    "API Base URL: pending",
    `Scenario: ${requirement.name}`,
    `Duration: ${requirement.duration}`,
    "Network: pending",
    "Account: pending",
    "Meeting ID: pending",
    `Install source: ${simulatorScenario ? "Local Release Simulator" : "TestFlight"}`,
    `App launch: ${simulatorScenario && screenshot.exists ? "pending - simulator screenshot captured" : "pending"}`,
    "Embedded production API origin: pending",
    "Microphone permission: pending",
    "Storage preflight: pending",
    "Free storage observed: pending",
    "PCM buffers: pending",
    "Realtime chunks: pending",
    "Realtime uploaded: pending",
    "Foreground/background interruptions: pending",
    "Last interruption time: pending",
    "Crash observed: pending",
    "Memory/battery observation: pending",
    "Upload pending after stop: pending",
    "Upload failed: pending",
    "Audio playback: pending",
    "Local audio retry/export: pending",
    "Finalize: pending",
    "Transcript/summary boundary: pending",
    "Share link: pending",
    "Markdown export: pending",
    "Delete cleanup: pending",
    ...(interruptedRecoveryScenario
      ? [
          "Interrupted recording isolated: pending",
          "Recovery validation before upload: pending",
          "Recovered duration: pending",
        ]
      : []),
    ...draftScenarioSpecificFields(requirement.name),
    simulatorScenario ? `Simulator screenshot: ${screenshot.summary}` : "Scenario evidence: pending",
    "Known issues: pending",
    "Decision: pending",
    "",
  ];
}

function draftScenarioSpecificFields(scenario) {
  switch (scenario) {
    case "Weak Wi-Fi":
      return [
        "Weak-network wall time minutes: pending",
        "Local file growth during outage: pending",
        "Upload resumed after reconnect: pending",
        "Finalized after reconnect: pending",
        "Reconnected audio playback: pending",
        "Reconnected audio export: pending",
      ];
    case "Force-quit recording recovery":
      return [
        "Force quit while recording: pending",
        "Local recovery entry visible after relaunch: pending",
        "Automatic upload before recovery validation: pending",
        "Recovered audio playback: pending",
        "Recovered audio export: pending",
        "Recovered meeting finalized: pending",
      ];
    case "Build 10 to 11 in-place upgrade":
      return [
        "Previous build: pending",
        "Candidate build: pending",
        "In-place update without uninstall: pending",
        "Existing local data preserved: pending",
        "Bottom navigation tab count: pending",
        "Development connection control visible: pending",
      ];
    case "Legacy local audio recovery":
      return [
        "Legacy index entries before update: pending",
        "Legacy index entries reconnected: pending",
        "Legacy playable entries: pending",
        "Legacy exportable entries: pending",
        "Legacy inaccessible index entries after update: pending",
        "Local recovery entry always visible: pending",
        "Legacy unavailable warning cleared: pending",
        "Legacy audio playback: pending",
        "Legacy audio export: pending",
        "Legacy source files preserved: pending",
      ];
    case "Meeting audio detail navigation":
      return [
        "Available audio detail cycles: pending",
        "Unavailable audio detail cycles: pending",
        "Available audio return: pending",
        "Unavailable audio return: pending",
        "Error boundary shown: pending",
        "Playback control errors: pending",
      ];
    case "Meeting deletion consistency":
      return [
        "Normal delete UI result: pending",
        "Normal delete final state: pending",
        "Weak-network delete UI result: pending",
        "Weak-network delete final state: pending",
        "Lost delete response induced: pending",
        "Pending confirmation shown before truth: pending",
        "Server truth reconciled: pending",
        "Local audio removed before truth: pending",
        "Delete false-failure message observed: pending",
        "Delete retry idempotent: pending",
        "Deleted meeting visible after relaunch: pending",
      ];
    case "Three consecutive meetings":
      return [
        "Consecutive meeting count: pending",
        "Unique meeting IDs: pending",
        "Playable local recordings: pending",
        "Finalized meetings: pending",
        "All three history entries visible: pending",
        "Cross-meeting state leakage: pending",
      ];
    case "Login session continuity":
      return [
        "Logged in before update: pending",
        "Session restored after update: pending",
        "Session restored after force quit: pending",
        "Unexpected login prompt: pending",
        "Local recordings retained after session checks: pending",
      ];
    case "Official and BYOK route billing":
      return [
        "Official expected route: pending",
        "Official actual route: pending",
        "Official route immutable during meeting: pending",
        "Official meeting ID matched ledger: pending",
        "Official processed minutes: pending",
        "Official minutes before: pending",
        "Official minutes after: pending",
        "Official charged minutes: pending",
        "Official billing event verified: pending",
        "BYOK expected route: pending",
        "BYOK actual route: pending",
        "BYOK route immutable during meeting: pending",
        "BYOK meeting ID matched ledger: pending",
        "BYOK official minutes before: pending",
        "BYOK official minutes after: pending",
        "BYOK charged official minutes: pending",
        "BYOK provider request verified: pending",
        "BYOK billing event verified: pending",
        "Simulated billing used: pending",
      ];
    case "Apple Sandbox billing reconciliation":
      return [
        "StoreKit environment: pending",
        "Product ID: pending",
        "Transaction fingerprint: pending",
        "Raw receipt stored in evidence: pending",
        "App Store Server transaction verified: pending",
        "App account binding matched: pending",
        "Server entitlement matched: pending",
        "Official quota matched entitlement: pending",
        "Restore purchases matched entitlement: pending",
        "Simulated billing used: pending",
      ];
    default:
      return [];
  }
}

function validateScenarioEvidence(scenario, section) {
  if (!section) return [];
  const invalid = [];

  if (scenario === "Weak Wi-Fi") {
    if (readNumberValue(section, "Weak-network wall time minutes:") < 30) {
      invalid.push("weak-network wall time must be at least 30 minutes");
    }
  }

  if (scenario === "Build 10 to 11 in-place upgrade") {
    if (readNumberValue(section, "Bottom navigation tab count:") !== 3) {
      invalid.push("bottom navigation tab count must be exactly 3");
    }
  }

  if (scenario === "Legacy local audio recovery") {
    const before = readNumberValue(section, "Legacy index entries before update:");
    const reconnected = readNumberValue(section, "Legacy index entries reconnected:");
    const playable = readNumberValue(section, "Legacy playable entries:");
    const exportable = readNumberValue(section, "Legacy exportable entries:");
    const inaccessible = readNumberValue(section, "Legacy inaccessible index entries after update:");
    if (before !== 5) invalid.push("legacy index count before update must be exactly 5");
    if (reconnected !== before) invalid.push("all legacy index entries must be reconnected");
    if (playable !== before) invalid.push("all legacy index entries must be playable");
    if (exportable !== before) invalid.push("all legacy index entries must be exportable");
    if (inaccessible !== 0) invalid.push("legacy inaccessible index count must be 0");
  }

  if (scenario === "Meeting audio detail navigation") {
    if (readNumberValue(section, "Available audio detail cycles:") < 20) invalid.push("available audio detail cycles must be at least 20");
    if (readNumberValue(section, "Unavailable audio detail cycles:") < 20) invalid.push("unavailable audio detail cycles must be at least 20");
    if (readNumberValue(section, "Playback control errors:") !== 0) invalid.push("playback control errors must be 0");
  }

  if (scenario === "Three consecutive meetings") {
    if (readNumberValue(section, "Consecutive meeting count:") !== 3) invalid.push("consecutive meeting count must be 3");
    if (readNumberValue(section, "Unique meeting IDs:") !== 3) invalid.push("unique meeting ID count must be 3");
    if (readNumberValue(section, "Playable local recordings:") !== 3) invalid.push("playable local recording count must be 3");
    if (readNumberValue(section, "Finalized meetings:") !== 3) invalid.push("finalized meeting count must be 3");
  }

  if (scenario === "Official and BYOK route billing") {
    const officialProcessed = readNumberValue(section, "Official processed minutes:");
    const officialBefore = readNumberValue(section, "Official minutes before:");
    const officialAfter = readNumberValue(section, "Official minutes after:");
    const officialCharged = readNumberValue(section, "Official charged minutes:");
    const byokBefore = readNumberValue(section, "BYOK official minutes before:");
    const byokAfter = readNumberValue(section, "BYOK official minutes after:");
    const byokCharged = readNumberValue(section, "BYOK charged official minutes:");
    if (!(officialProcessed > 0)) invalid.push("official processed minutes must be greater than 0");
    if (officialCharged !== officialProcessed) invalid.push("official charged minutes must equal processed minutes");
    if (!numbersEqual(officialBefore - officialAfter, officialCharged)) invalid.push("official balance delta must equal charged minutes");
    if (byokCharged !== 0) invalid.push("BYOK charged official minutes must be 0");
    if (!numbersEqual(byokBefore, byokAfter)) invalid.push("BYOK official balance must remain unchanged");
  }

  if (scenario === "Apple Sandbox billing reconciliation") {
    const productId = readLineValue(section, "Product ID:");
    const transactionFingerprint = readLineValue(section, "Transaction fingerprint:");
    if (!["ownminutes.plus.monthly", "ownminutes.pro.monthly"].includes(productId)) {
      invalid.push("Apple Sandbox product ID must be an OwnMinutes Plus or Pro product");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(transactionFingerprint)) {
      invalid.push("transaction fingerprint must be redacted SHA-256 evidence");
    }
  }

  return invalid;
}

function readNumberValue(text, label) {
  const value = Number(readLineValue(text, label));
  return Number.isFinite(value) ? value : Number.NaN;
}

function hasRequiredScenarioField(section, phrase) {
  const lines = section.split(/\r?\n/).map((line) => line.trim());
  return phrase.endsWith(":")
    ? lines.some((line) => line.startsWith(phrase))
    : lines.includes(phrase);
}

function numbersEqual(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.000001;
}

function verifyUploadEvidence() {
  const run = spawnSync("node", ["scripts/check-ios-appstore-upload-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH: uploadEvidencePath,
      OWNMINUTES_LOCAL_TESTFLIGHT_SUMMARY_PATH: candidateSummaryPath,
    },
  });
  const payload = parseJson(run.stdout);
  return {
    ok: run.status === 0 && payload?.ok === true,
    errors: payload?.errors || ["App Store upload evidence is missing or invalid."],
  };
}

function matchesUploadReceipt(receipt, versionLabel, publicApiBaseUrl) {
  if (!receipt || receipt.operation !== "upload" || receipt.status !== "pass") return false;
  const candidate = receipt.candidate;
  if (!candidate || versionLabel !== `${candidate.version} (${candidate.buildNumber})`) return false;
  try {
    return new URL(publicApiBaseUrl).hostname === candidate.apiHost;
  } catch {
    return false;
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function parseJson(text = "") {
  try { return JSON.parse(text); } catch { return null; }
}

function readLineValue(text, label) {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(label));
  return line ? line.slice(label.length).trim() : "";
}

function isPublicHttps(value) {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host) && !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}

function readSimulatorScreenshotSummary() {
  const path = ".data/screenshots/ownminutes-ios-simulator-latest.png";
  if (!existsSync(path)) {
    return {
      exists: false,
      summary: "pending - run npm run smoke:ios-simulator-ui",
    };
  }

  const stats = statSync(path);
  return {
    exists: true,
    summary: `${path}, ${stats.size} bytes`,
  };
}
