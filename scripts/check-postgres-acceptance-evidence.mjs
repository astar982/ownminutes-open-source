#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const evidencePath = process.env.OWNMINUTES_POSTGRES_EVIDENCE_PATH || ".data/acceptance/postgres-latest.md";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";

const requiredMetadata = [
  "Date:",
  "Commit:",
  "Database provider:",
  "Runtime repository:",
  "Finalization mode:",
  "Worker instances:",
  "Meeting write lock:",
  "Migration command:",
  "Migration version:",
  "Backup policy:",
  "Restore drill:",
  "Minimum privilege role:",
  "Audit log policy:",
  "SSL/TLS required:",
  "Local JSON store decision:",
  "Database diagnostics:",
  "Release readiness databaseBlocked:",
  "Release readiness finalizationQueueBlocked:",
  "Release readiness nextAction:",
];

const requiredPassChecks = [
  "Production preflight:",
  "Schema smoke:",
  "Migration dry run:",
  "Migration applied:",
  "Auth export reviewed:",
  "Runtime writes:",
  "Register/login:",
  "Password reset token:",
  "Provider credentials save/delete:",
  "Meeting metadata write/read:",
  "Usage event write/read:",
  "Admin metrics:",
  "Account deletion cleanup:",
  "Queue migration applied:",
  "Queue duplicate enqueue:",
  "Queue atomic claim:",
  "Queue expired lease reclaim:",
  "Queue retry recovery:",
  "Queue deletion cancellation:",
  "Queue account cleanup:",
  "Meeting deletion fence migration:",
  "Cross-instance chunk write:",
  "Deleted meeting recreation blocked:",
  "Backup snapshot:",
  "Restore drill proof:",
  "Minimum privilege proof:",
  "Audit log proof:",
  "SSL/TLS proof:",
  "Local JSON store handled:",
];

const forbiddenPhrases = [
  "postgres://",
  "postgresql://",
  "DATABASE_URL=",
  "POSTGRES_URL=",
  "password=",
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "Bearer ",
  "session=",
];

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const missingPassChecks = requiredPassChecks.filter((phrase) => !lineHasValue(phrase, "pass"));
const failedChecks = requiredPassChecks.filter((phrase) => lineHasValue(phrase, "fail"));
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));

const runtimeRepository = readLineValue("Runtime repository:");
const finalizationMode = readLineValue("Finalization mode:");
const workerInstances = Number(readLineValue("Worker instances:"));
const meetingWriteLock = readLineValue("Meeting write lock:");
const sslRequired = readLineValue("SSL/TLS required:");
const releaseDatabaseBlocked = readLineValue("Release readiness databaseBlocked:");
const releaseFinalizationQueueBlocked = readLineValue("Release readiness finalizationQueueBlocked:");
const releaseNextAction = readLineValue("Release readiness nextAction:");

const runtimeFailure = runtimeRepository.toLowerCase() === "postgres" ? "" : "runtime-not-postgres";
const finalizationModeFailure = finalizationMode === "postgres-queue" ? "" : "finalization-mode-not-postgres-queue";
const workerInstancesFailure = Number.isFinite(workerInstances) && workerInstances >= 2 ? "" : "worker-instances-below-two";
const meetingWriteLockFailure = meetingWriteLock === "postgres-advisory" ? "" : "meeting-write-lock-not-postgres-advisory";
const sslFailure = ["1", "yes", "true", "pass"].includes(sslRequired.toLowerCase()) ? "" : "ssl-tls-not-affirmed";
const releaseFailures = [
  ["no", "false"].includes(releaseDatabaseBlocked.toLowerCase()) ? "" : "databaseBlocked-not-cleared",
  ["no", "false"].includes(releaseFinalizationQueueBlocked.toLowerCase()) ? "" : "finalizationQueueBlocked-not-cleared",
  releaseNextAction.length > 0 ? "" : "nextAction-missing",
].filter(Boolean);

const decisionPass = lineHasValue("Decision:", "pass");
const decisionFail = lineHasValue("Decision:", "fail");
const secretsLeakedNo = lineHasValue("Secrets leaked:", "no");
const secretsLeakedYes = lineHasValue("Secrets leaked:", "yes");

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  missingMetadata,
  missingPassChecks,
  failedChecks,
  runtimeFailure,
  finalizationModeFailure,
  workerInstancesFailure,
  meetingWriteLockFailure,
  sslFailure,
  releaseFailures,
  decisionPass,
  decisionFail,
  secretsLeakedNo,
  secretsLeakedYes,
  leakedPhrases,
  evidenceReady:
    Boolean(evidence) &&
    missingMetadata.length === 0 &&
    missingPassChecks.length === 0 &&
    failedChecks.length === 0 &&
    !runtimeFailure &&
    !finalizationModeFailure &&
    !workerInstancesFailure &&
    !meetingWriteLockFailure &&
    !sslFailure &&
    releaseFailures.length === 0 &&
    decisionPass &&
    !decisionFail &&
    secretsLeakedNo &&
    !secretsLeakedYes &&
    leakedPhrases.length === 0,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.evidenceReady) {
  process.exitCode = 1;
}

function readLineValue(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = evidence.match(new RegExp(`^${escaped}\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function lineHasValue(label, value) {
  return readLineValue(label).toLowerCase() === value.toLowerCase();
}
