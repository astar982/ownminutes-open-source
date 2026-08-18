#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const evidencePath = process.env.OWNMINUTES_OBJECT_STORAGE_EVIDENCE_PATH || ".data/acceptance/object-storage-latest.md";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";

const requiredMetadata = [
  "Date:",
  "Commit:",
  "Provider:",
  "Bucket:",
  "Region:",
  "Endpoint:",
  "Object prefix:",
  "Lifecycle policy:",
  "Delete proof:",
  "Cost budget:",
  "Local inventory decision:",
  "Private access:",
  "Minimum privilege policy:",
  "Restore read proof:",
  "Storage diagnostics:",
  "Release readiness objectStorageBlocked:",
  "Release readiness nextAction:",
];

const requiredPassChecks = [
  "Production preflight:",
  "Storage diagnostics:",
  "Remote PUT:",
  "Remote GET:",
  "Remote LIST:",
  "Remote DELETE:",
  "Manifest write/read:",
  "Audio chunk write/read:",
  "Result JSON write/read:",
  "Obsidian Markdown write/read:",
  "Meeting delete prefix:",
  "Account delete prefix:",
  "Cross-instance concurrent chunks:",
  "Deleted meeting recreation blocked:",
  "Lifecycle policy proof:",
  "Private access proof:",
  "Minimum privilege proof:",
  "Restore/read proof:",
  "Cost budget reviewed:",
  "Local inventory handled:",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "S3_SECRET_ACCESS_KEY=",
  "R2_SECRET_ACCESS_KEY=",
  "TOS_SECRET_ACCESS_KEY=",
  "VOLCANO_TOS_SECRET_ACCESS_KEY=",
  "AWS_SECRET_ACCESS_KEY=",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "Bearer ",
  "session=",
  "X-Amz-Credential=",
  "X-Amz-Signature=",
];

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const missingPassChecks = requiredPassChecks.filter((phrase) => !lineHasValue(phrase, "pass"));
const failedChecks = requiredPassChecks.filter((phrase) => lineHasValue(phrase, "fail"));
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));

const provider = readLineValue("Provider:");
const endpoint = readLineValue("Endpoint:");
const privateAccess = readLineValue("Private access:");
const releaseObjectStorageBlocked = readLineValue("Release readiness objectStorageBlocked:");
const releaseNextAction = readLineValue("Release readiness nextAction:");

const providerFailure = ["s3", "r2", "volcano-tos"].includes(provider.toLowerCase()) ? "" : "provider-not-supported";
const endpointCheck = validateEndpoint(endpoint);
const privateAccessFailure = ["1", "yes", "true", "pass"].includes(privateAccess.toLowerCase()) ? "" : "private-access-not-affirmed";
const releaseFailures = [
  ["no", "false"].includes(releaseObjectStorageBlocked.toLowerCase()) ? "" : "objectStorageBlocked-not-cleared",
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
  providerFailure,
  endpointFailure: endpointCheck.ok ? "" : endpointCheck.reason,
  privateAccessFailure,
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
    !providerFailure &&
    endpointCheck.ok &&
    !privateAccessFailure &&
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

function validateEndpoint(value) {
  if (!value) return { ok: false, reason: "missing" };

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return { ok: false, reason: "not-https" };
    if (usesLocalHost(parsed.hostname)) return { ok: false, reason: "local-or-lan-host" };
    return { ok: true, reason: "public-https" };
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
}

function usesLocalHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}
