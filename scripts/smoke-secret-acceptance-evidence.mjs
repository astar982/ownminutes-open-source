#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/secret-evidence-pass.md";
const failPath = ".data/smoke/secret-evidence-fail.md";
const partialPath = ".data/smoke/secret-evidence-partial.md";
const draftPath = ".data/smoke/secret-evidence-draft.md";
const unsupportedKmsPath = ".data/smoke/secret-evidence-kms.md";
const liveEvidencePath = ".data/smoke/secret-vault-live-pass.json";
const insecureLiveEvidencePath = ".data/smoke/secret-vault-live-insecure.json";

const passEvidence = evidenceBlock();
const failEvidence = evidenceBlock({
  overrides: {
    "Secret provider": "local-app-secret",
    "Tenant scoped keys": "no",
    Decision: "fail",
  },
  extraLines: ["OPENAI_API_KEY=sk-proj-example"],
});
const partialEvidence = evidenceBlock({
  overrides: {
    "Provider secret rotate": "fail",
  },
});
const unsupportedKmsEvidence = evidenceBlock({ overrides: { "Secret provider": "kms", "Runtime adapter": "unsupported" } });

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, passEvidence);
writeFileSync(failPath, failEvidence);
writeFileSync(partialPath, partialEvidence);
writeFileSync(unsupportedKmsPath, unsupportedKmsEvidence);
writeFileSync(liveEvidencePath, JSON.stringify(liveEvidence(), null, 2), { mode: 0o600 });
writeFileSync(insecureLiveEvidencePath, JSON.stringify(liveEvidence({ secureTransport: false }), null, 2), { mode: 0o600 });

const pass = runChecker(passPath, liveEvidencePath);
const fail = runChecker(failPath, liveEvidencePath);
const partial = runChecker(partialPath, liveEvidencePath);
const unsupportedKms = runChecker(unsupportedKmsPath, liveEvidencePath);
const insecureLiveEvidence = runChecker(passPath, insecureLiveEvidencePath);
const draft = runDraft(draftPath);
const draftCheck = runChecker(draftPath, liveEvidencePath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  passFixtureAccepted: pass.status === 0 && pass.payload?.evidenceReady === true,
  failFixtureRejected:
    fail.status !== 0 &&
    fail.payload?.evidenceReady === false &&
    fail.payload?.providerFailure === "provider-not-vault-managed-store" &&
    fail.payload?.tenantScopedFailure === "tenant-scope-not-affirmed" &&
    fail.payload?.decisionFail === true &&
    fail.payload?.leakedPhrases?.includes("sk-proj"),
  partialFixtureRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingPassChecks?.includes("Provider secret rotate:") &&
    partial.payload?.failedChecks?.includes("Provider secret rotate:"),
  unsupportedKmsRejected:
    unsupportedKms.status !== 0 &&
    unsupportedKms.payload?.providerFailure === "provider-not-vault-managed-store" &&
    unsupportedKms.payload?.runtimeAdapterFailure === "runtime-adapter-not-vault-transit",
  insecureLiveEvidenceRejected:
    insecureLiveEvidence.status !== 0 &&
    insecureLiveEvidence.payload?.vaultLiveEvidenceFailures?.includes("vault-live-checks-incomplete"),
  draftGenerated:
    draft.status === 0 &&
    draft.payload?.draftWritten === true &&
    draft.payload?.draftDecision === "pending" &&
    readDraft(draftPath).includes("This file is an automated draft from `npm run secret:evidence:draft`.") &&
    readDraft(draftPath).includes("Secret provider: pending") &&
    readDraft(draftPath).includes("Production preflight: pending") &&
    readDraft(draftPath).includes("Decision: pending"),
  draftRejectedUntilManualChecks:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.providerFailure === "provider-not-vault-managed-store" &&
    draftCheck.payload?.runtimeAdapterFailure === "runtime-adapter-not-vault-transit" &&
    draftCheck.payload?.tenantScopedFailure === "tenant-scope-not-affirmed" &&
    draftCheck.payload?.missingPassChecks?.includes("Production preflight:") &&
    draftCheck.payload?.decisionPass === false,
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.passFixtureAccepted ||
  !summary.failFixtureRejected ||
  !summary.partialFixtureRejected ||
  !summary.unsupportedKmsRejected ||
  !summary.insecureLiveEvidenceRejected ||
  !summary.draftGenerated ||
  !summary.draftRejectedUntilManualChecks ||
  !summary.noForbiddenSourcePhrases
) {
  process.exitCode = 1;
}

function evidenceBlock({ overrides = {}, extraLines = [] } = {}) {
  const values = {
    Date: "2026-07-05",
    Commit: "abc1234",
    "Secret provider": "managed-secret-store",
    "Runtime adapter": "vault-transit",
    "KMS key or store reference": "Vault Transit key reference recorded privately",
    "Vault policy": "encrypt and decrypt only on the dedicated Transit key",
    "Vault live evidence": "private vault-transit-live-latest.json recorded",
    "Encryption context": "tenant:userId provider:providerId secret:secretName",
    "Rotation policy": "90-day key rotation and old-key read window recorded",
    "Audit log sink": "managed audit sink recorded",
    "Tenant scoped keys": "yes",
    "Deletion proof": "account and provider credential deletion evidence recorded",
    "Admin access policy": "support cannot view plaintext provider keys",
    "Local secret decision": "local app-secret ciphertext dual-read then migrated",
    "Decrypt failure audit": "audit event and alert threshold recorded",
    "Backup recovery policy": "Vault storage and Transit key recovery proof recorded",
    "Secret diagnostics": "pass",
    "Release readiness secretManagementBlocked": "no",
    "Release readiness nextAction": "Continue ASR and TestFlight evidence.",
    "Production preflight": "pass",
    "Vault runtime smoke": "pass",
    "Vault repository smoke": "pass",
    "Vault live verifier": "pass",
    "Redirect rejection": "pass",
    "Oversized response rejection": "pass",
    "Token file permission check": "pass",
    "Secret audit smoke": "pass",
    "Provider secret save": "pass",
    "Provider secret preview only": "pass",
    "Provider secret rotate": "pass",
    "Provider secret delete": "pass",
    "Account deletion cleanup": "pass",
    "Tenant isolation proof": "pass",
    "Admin plaintext denial": "pass",
    "Decrypt failure audit proof": "pass",
    "Backup/recovery proof": "pass",
    "Local secret migration handled": "pass",
    "Runtime provider decrypt": "pass",
    "Export excludes plaintext": "pass",
    "Browser response hides plaintext": "pass",
    "Secrets leaked": "no",
    Decision: "pass",
    "Known issues": "other release blockers remain",
    ...overrides,
  };

  return [
    "# Secret Management Acceptance Evidence",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    ...extraLines,
    "",
  ].join("\n");
}

function runChecker(path, vaultEvidencePath) {
  const result = spawnSync("node", ["scripts/check-secret-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_SECRET_EVIDENCE_PATH: path,
      OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH: vaultEvidencePath,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function liveEvidence(checkOverrides = {}) {
  return {
    schemaVersion: "ownminutes-vault-live-evidence:v1",
    generatedAt: new Date().toISOString(),
    commit: "abc1234",
    status: "pass",
    provider: "managed-secret-store",
    runtimeAdapter: "vault-transit",
    endpointHost: "vault.example.test",
    keyReferenceHash: "0123456789abcdef", // gitleaks:allow - deterministic test fixture, not a credential
    namespaceConfigured: false,
    ciphertextVersion: "v3",
    checks: {
      contractReady: true,
      secureTransport: true,
      syntheticRoundTrip: true,
      userContextIsolation: true,
      providerContextIsolation: true,
      secretNameContextIsolation: true,
      keyMetadataReadDenied: true,
      sysMountsReadDenied: true,
      tokenFilePrivate: true,
      evidenceContainsNoPlaintext: true,
      ...checkOverrides,
    },
    leaksSecrets: false,
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-secret-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_SECRET_EVIDENCE_DRAFT_PATH: path,
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "OPENAI_API_KEY="];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/secret-management-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
