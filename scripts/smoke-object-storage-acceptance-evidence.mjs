#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/object-storage-evidence-pass.md";
const failPath = ".data/smoke/object-storage-evidence-fail.md";
const partialPath = ".data/smoke/object-storage-evidence-partial.md";
const draftPath = ".data/smoke/object-storage-evidence-draft.md";

const passEvidence = evidenceBlock();
const failEvidence = evidenceBlock({
  overrides: {
    Endpoint: "http://127.0.0.1:9000",
    "Private access": "no",
    Decision: "fail",
  },
});
const partialEvidence = evidenceBlock({
  overrides: {
    "Account delete prefix": "fail",
  },
});

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, passEvidence);
writeFileSync(failPath, failEvidence);
writeFileSync(partialPath, partialEvidence);

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const partial = runChecker(partialPath);
const draft = runDraft(draftPath);
const draftCheck = runChecker(draftPath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  passFixtureAccepted: pass.status === 0 && pass.payload?.evidenceReady === true,
  failFixtureRejected:
    fail.status !== 0 &&
    fail.payload?.evidenceReady === false &&
    fail.payload?.endpointFailure === "not-https" &&
    fail.payload?.privateAccessFailure === "private-access-not-affirmed" &&
    fail.payload?.decisionFail === true,
  partialFixtureRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingPassChecks?.includes("Account delete prefix:") &&
    partial.payload?.failedChecks?.includes("Account delete prefix:"),
  draftGenerated:
    draft.status === 0 &&
    draft.evidence.includes("# Object Storage Acceptance Evidence") &&
    draft.evidence.includes("This file is an automated draft from `npm run storage:preflight`.") &&
    draft.evidence.includes("Provider: r2") &&
    draft.evidence.includes("Production preflight: pass") &&
    draft.evidence.includes("Remote PUT: pending") &&
    draft.evidence.includes("Account delete prefix: pending") &&
    draft.evidence.includes("Cross-instance concurrent chunks: pending") &&
    draft.evidence.includes("Deleted meeting recreation blocked: pending") &&
    draft.evidence.includes("Decision: pending"),
  draftRejectedUntilManualChecks:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.missingPassChecks?.includes("Remote PUT:") &&
    draftCheck.payload?.missingPassChecks?.includes("Account delete prefix:") &&
    draftCheck.payload?.releaseFailures?.includes("objectStorageBlocked-not-cleared"),
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.passFixtureAccepted ||
  !summary.failFixtureRejected ||
  !summary.partialFixtureRejected ||
  !summary.draftGenerated ||
  !summary.draftRejectedUntilManualChecks ||
  !summary.noForbiddenSourcePhrases
) {
  process.exitCode = 1;
}

function evidenceBlock({ overrides = {} } = {}) {
  const values = {
    Date: "2026-07-05",
    Commit: "abc1234",
    Provider: "r2",
    Bucket: "ownminutes-prod-audio",
    Region: "auto",
    Endpoint: "https://storage.example.com",
    "Object prefix": "meetings/user-id/",
    "Lifecycle policy": "90-day audio retention policy recorded in provider console",
    "Delete proof": "private evidence link for meeting and account deletion",
    "Cost budget": "monthly object storage budget reviewed",
    "Local inventory decision": "migrate existing local meetings then archive originals",
    "Private access": "yes",
    "Minimum privilege policy": "bucket-prefix scoped read/write/delete policy recorded",
    "Restore read proof": "manifest/result/audio/markdown restore evidence recorded",
    "Storage diagnostics": "pass",
    "Release readiness objectStorageBlocked": "no",
    "Release readiness nextAction": "Continue ASR and TestFlight evidence.",
    "Production preflight": "pass",
    "Remote PUT": "pass",
    "Remote GET": "pass",
    "Remote LIST": "pass",
    "Remote DELETE": "pass",
    "Manifest write/read": "pass",
    "Audio chunk write/read": "pass",
    "Result JSON write/read": "pass",
    "Obsidian Markdown write/read": "pass",
    "Meeting delete prefix": "pass",
    "Account delete prefix": "pass",
    "Cross-instance concurrent chunks": "pass",
    "Deleted meeting recreation blocked": "pass",
    "Lifecycle policy proof": "pass",
    "Private access proof": "pass",
    "Minimum privilege proof": "pass",
    "Restore/read proof": "pass",
    "Cost budget reviewed": "pass",
    "Local inventory handled": "pass",
    "Secrets leaked": "no",
    Decision: "pass",
    "Known issues": "other release blockers remain",
    ...overrides,
  };

  return [
    "# Object Storage Acceptance Evidence",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    "",
  ].join("\n");
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-object-storage-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_OBJECT_STORAGE_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-object-storage-production-env.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_OBJECT_STORAGE_EVIDENCE_DRAFT_PATH: path,
      DATABASE_URL: "postgresql://storage-smoke.invalid/ownminutes",
      OWNMINUTES_AUTH_REPOSITORY: "postgres",
      OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
      OWNMINUTES_STORAGE_COST_BUDGET: "configured",
      OWNMINUTES_STORAGE_DELETE_PROOF: "configured",
      OWNMINUTES_STORAGE_LIFECYCLE_POLICY: "configured",
      OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION: "configured",
      OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE: "configured",
      OWNMINUTES_STORAGE_PRIVATE_ACCESS: "1",
      OWNMINUTES_STORAGE_PREFIX: "meetings/smoke/",
      OWNMINUTES_STORAGE_RESTORE_READ_PROOF: "configured",
      R2_ACCESS_KEY_ID: "r2-access-key",
      R2_BUCKET: "ownminutes-prod-audio",
      R2_ENDPOINT: "https://storage.example.com",
      R2_REGION: "auto",
      R2_SECRET_ACCESS_KEY: "redacted-test-secret",
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    evidence: readDraft(path),
  };
}

function readDraft(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "-----BEGIN PRIVATE KEY-----", "X-Amz-Signature="]; // gitleaks:allow - detector signatures, not credentials
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/object-storage-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
