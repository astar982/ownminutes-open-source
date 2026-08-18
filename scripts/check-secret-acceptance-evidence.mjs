#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const evidencePath = process.env.OWNMINUTES_SECRET_EVIDENCE_PATH || ".data/acceptance/secret-management-latest.md";
const evidenceDraftPath = process.env.OWNMINUTES_SECRET_EVIDENCE_DRAFT_PATH?.trim() || "";
const vaultLiveEvidencePath = process.env.OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH || ".data/acceptance/vault-transit-live-latest.json";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";
const vaultLiveEvidence = readJson(vaultLiveEvidencePath);

const requiredMetadata = [
  "Date:",
  "Commit:",
  "Secret provider:",
  "Runtime adapter:",
  "KMS key or store reference:",
  "Vault policy:",
  "Vault live evidence:",
  "Encryption context:",
  "Rotation policy:",
  "Audit log sink:",
  "Tenant scoped keys:",
  "Deletion proof:",
  "Admin access policy:",
  "Local secret decision:",
  "Decrypt failure audit:",
  "Backup recovery policy:",
  "Secret diagnostics:",
  "Release readiness secretManagementBlocked:",
  "Release readiness nextAction:",
];

const requiredPassChecks = [
  "Production preflight:",
  "Vault runtime smoke:",
  "Vault repository smoke:",
  "Vault live verifier:",
  "Redirect rejection:",
  "Oversized response rejection:",
  "Token file permission check:",
  "Secret diagnostics:",
  "Secret audit smoke:",
  "Provider secret save:",
  "Provider secret preview only:",
  "Provider secret rotate:",
  "Provider secret delete:",
  "Account deletion cleanup:",
  "Tenant isolation proof:",
  "Admin plaintext denial:",
  "Decrypt failure audit proof:",
  "Backup/recovery proof:",
  "Local secret migration handled:",
  "Runtime provider decrypt:",
  "Export excludes plaintext:",
  "Browser response hides plaintext:",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "ARK_API_KEY=",
  "VOLCANO_ASR_API_KEY=",
  "OPENAI_API_KEY=",
  "OWNMINUTES_APP_SECRET=",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "Bearer ",
  "session=",
  "v2.",
  "v3.vault.",
];

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const missingPassChecks = requiredPassChecks.filter((phrase) => !lineHasValue(phrase, "pass"));
const failedChecks = requiredPassChecks.filter((phrase) => lineHasValue(phrase, "fail"));
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));

const provider = readLineValue("Secret provider:");
const runtimeAdapter = readLineValue("Runtime adapter:");
const evidenceCommit = readLineValue("Commit:");
const tenantScoped = readLineValue("Tenant scoped keys:");
const releaseSecretBlocked = readLineValue("Release readiness secretManagementBlocked:");
const releaseNextAction = readLineValue("Release readiness nextAction:");

const providerFailure = provider.toLowerCase() === "managed-secret-store" ? "" : "provider-not-vault-managed-store";
const runtimeAdapterFailure = runtimeAdapter.toLowerCase() === "vault-transit" ? "" : "runtime-adapter-not-vault-transit";
const tenantScopedFailure = ["1", "yes", "true", "pass"].includes(tenantScoped.toLowerCase()) ? "" : "tenant-scope-not-affirmed";
const releaseFailures = [
  ["no", "false"].includes(releaseSecretBlocked.toLowerCase()) ? "" : "secretManagementBlocked-not-cleared",
  releaseNextAction.length > 0 ? "" : "nextAction-missing",
].filter(Boolean);
const vaultLiveEvidenceFailures = validateVaultLiveEvidence(vaultLiveEvidence, evidenceCommit, vaultLiveEvidencePath);

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
  runtimeAdapterFailure,
  vaultLiveEvidencePath,
  vaultLiveEvidenceFailures,
  vaultLiveEvidenceReady: vaultLiveEvidenceFailures.length === 0,
  tenantScopedFailure,
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
    !runtimeAdapterFailure &&
    vaultLiveEvidenceFailures.length === 0 &&
    !tenantScopedFailure &&
    releaseFailures.length === 0 &&
    decisionPass &&
    !decisionFail &&
    secretsLeakedNo &&
    !secretsLeakedYes &&
    leakedPhrases.length === 0,
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
        draftNote: "Draft files are intentionally incomplete and must fail secret:acceptance:evidence until every pending field is replaced with real Vault Transit evidence.",
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

function readLineValue(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = evidence.match(new RegExp(`^${escaped}\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function lineHasValue(label, value) {
  return readLineValue(label).toLowerCase() === value.toLowerCase();
}

function writeEvidenceDraft(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildEvidenceDraft());
}

function buildEvidenceDraft() {
  return [
    "# Secret Management Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run secret:evidence:draft`.",
    "Replace every `pending` value with real Vault Transit evidence before running `npm run secret:acceptance:evidence` as a release gate.",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "Commit: pending",
    "Secret provider: pending",
    "Runtime adapter: pending",
    "KMS key or store reference: pending",
    "Vault policy: pending",
    "Vault live evidence: pending",
    "Encryption context: pending",
    "Rotation policy: pending",
    "Audit log sink: pending",
    "Tenant scoped keys: pending",
    "Deletion proof: pending",
    "Admin access policy: pending",
    "Local secret decision: pending",
    "Decrypt failure audit: pending",
    "Backup recovery policy: pending",
    "Secret diagnostics: pending",
    "Release readiness secretManagementBlocked: pending",
    "Release readiness nextAction: pending",
    "",
    "Production preflight: pending",
    "Vault runtime smoke: pending",
    "Vault repository smoke: pending",
    "Vault live verifier: pending",
    "Redirect rejection: pending",
    "Oversized response rejection: pending",
    "Token file permission check: pending",
    "Secret audit smoke: pending",
    "Provider secret save: pending",
    "Provider secret preview only: pending",
    "Provider secret rotate: pending",
    "Provider secret delete: pending",
    "Account deletion cleanup: pending",
    "Tenant isolation proof: pending",
    "Admin plaintext denial: pending",
    "Decrypt failure audit proof: pending",
    "Backup/recovery proof: pending",
    "Local secret migration handled: pending",
    "Runtime provider decrypt: pending",
    "Export excludes plaintext: pending",
    "Browser response hides plaintext: pending",
    "",
    "Secrets leaked: pending",
    "Decision: pending",
    "Known issues: pending",
    "",
  ].join("\n");
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function validateVaultLiveEvidence(value, expectedCommit, file) {
  const failures = [];
  if (!value || typeof value !== "object") return ["vault-live-evidence-missing-or-invalid"];
  if (value.schemaVersion !== "ownminutes-vault-live-evidence:v1") failures.push("vault-live-schema-invalid");
  if (value.status !== "pass" || value.provider !== "managed-secret-store" || value.runtimeAdapter !== "vault-transit") {
    failures.push("vault-live-status-invalid");
  }
  if (value.leaksSecrets !== false) failures.push("vault-live-secret-leak-status-invalid");
  const requiredChecks = [
    "contractReady",
    "secureTransport",
    "syntheticRoundTrip",
    "userContextIsolation",
    "providerContextIsolation",
    "secretNameContextIsolation",
    "keyMetadataReadDenied",
    "sysMountsReadDenied",
    "tokenFilePrivate",
    "evidenceContainsNoPlaintext",
  ];
  if (!requiredChecks.every((key) => value.checks?.[key] === true)) failures.push("vault-live-checks-incomplete");
  const generatedAt = Date.parse(value.generatedAt || "");
  if (!Number.isFinite(generatedAt) || generatedAt > Date.now() + 5 * 60_000 || Date.now() - generatedAt > 24 * 60 * 60_000) {
    failures.push("vault-live-evidence-stale");
  }
  if (!expectedCommit || !value.commit || !(value.commit.startsWith(expectedCommit) || expectedCommit.startsWith(value.commit))) {
    failures.push("vault-live-commit-mismatch");
  }
  try {
    const stats = statSync(file);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) failures.push("vault-live-evidence-not-private");
  } catch {
    failures.push("vault-live-evidence-not-private");
  }
  return failures;
}
