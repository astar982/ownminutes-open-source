#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-secret-preflight-"));
const privateTokenFile = path.join(tempDir, "vault-token-private");
const publicTokenFile = path.join(tempDir, "vault-token-public");
fs.writeFileSync(privateTokenFile, "vault-smoke-token-private", { mode: 0o600 });
fs.writeFileSync(publicTokenFile, "vault-smoke-token-public", { mode: 0o644 });

const commonEvidenceEnv = {
  OWNMINUTES_SECRET_ROTATION_POLICY: "90 day rotation, dual-read window, rollback key retained for 14 days",
  OWNMINUTES_SECRET_AUDIT_LOG: "managed audit sink for save rotate delete decrypt_failure admin_access_denied",
  OWNMINUTES_TENANT_SCOPED_KEYS: "tenant scoped encryption context: userId/providerId/secretName",
  OWNMINUTES_SECRET_DELETION_PROOF: "account delete removes provider credentials and ciphertext references",
  OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY: "support and admin roles cannot view decrypted provider keys",
  OWNMINUTES_SECRET_LOCAL_SECRET_DECISION: "local .data/auth/local-secret rotated and isolated before production cutover",
  OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT: "decrypt failures are logged and alert routed to production audit sink",
  OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY: "Vault key recovery and restore drill documented",
};

const fullVaultEnv = {
  OWNMINUTES_SECRET_STORE: "vault-transit",
  OWNMINUTES_VAULT_ADDR: "https://vault.example.invalid",
  OWNMINUTES_VAULT_TRANSIT_KEY: "ownminutes-provider-secrets",
  OWNMINUTES_VAULT_TOKEN_FILE: privateTokenFile,
  ...commonEvidenceEnv,
};

const cases = [
  { name: "missing-env", expectOk: false, env: {}, expectedProvider: "local-app-secret", expectedAdapter: "local-aes-gcm" },
  {
    name: "kms-only",
    expectOk: false,
    env: { OWNMINUTES_KMS_KEY_ID: "kms-key-id-only" },
    expectedProvider: "kms",
    expectedAdapter: "unsupported",
  },
  {
    name: "declared-kms-with-policies",
    expectOk: false,
    env: { OWNMINUTES_KMS_KEY_ID: "kms-key-id-redacted", ...commonEvidenceEnv },
    expectedProvider: "kms",
    expectedAdapter: "unsupported",
  },
  {
    name: "unsupported-managed-secret-store",
    expectOk: false,
    env: { OWNMINUTES_SECRET_STORE: "managed-secret-store-reference", ...commonEvidenceEnv },
    expectedProvider: "managed-secret-store",
    expectedAdapter: "unsupported",
  },
  {
    name: "vault-missing-token",
    expectOk: false,
    env: { ...fullVaultEnv, OWNMINUTES_VAULT_TOKEN_FILE: "" },
    expectedProvider: "managed-secret-store",
    expectedAdapter: "vault-transit",
  },
  {
    name: "vault-public-token-file",
    expectOk: false,
    env: { ...fullVaultEnv, OWNMINUTES_VAULT_TOKEN_FILE: publicTokenFile },
    expectedProvider: "managed-secret-store",
    expectedAdapter: "vault-transit",
  },
  {
    name: "complete-vault",
    expectOk: true,
    env: fullVaultEnv,
    expectedProvider: "managed-secret-store",
    expectedAdapter: "vault-transit",
  },
];

try {
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
      runtimeAdapter: payload?.runtimeAdapter,
      providerMatches: payload?.provider === testCase.expectedProvider,
      adapterMatches: payload?.runtimeAdapter === testCase.expectedAdapter,
      missing: payload?.missing ?? [],
      hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 12,
      hasRequiredEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.length > 0,
      hasRuntimeGate: payload?.checks?.some((check) => check.id === "runtime-adapter"),
      hasVaultConfigGate: payload?.checks?.some((check) => check.id === "vault-runtime-config"),
      hasRotationGate: payload?.checks?.some((check) => check.id === "rotation-policy"),
      hasAuditGate: payload?.checks?.some((check) => check.id === "audit-log"),
      hasTenantGate: payload?.checks?.some((check) => check.id === "tenant-scoped-keys"),
      hasDeletionProofGate: payload?.checks?.some((check) => check.id === "deletion-proof"),
      hasAdminPolicyGate: payload?.checks?.some((check) => check.id === "admin-access-policy"),
      hasLocalSecretDecisionGate: payload?.checks?.some((check) => check.id === "local-secret-decision"),
      hasDecryptFailureAuditGate: payload?.checks?.some((check) => check.id === "decrypt-failure-audit"),
      hasBackupRecoveryGate: payload?.checks?.some((check) => check.id === "backup-recovery-policy"),
      hasProviderContractGate: payload?.checks?.some((check) => check.id === "secret-provider-contract"),
      noSecretLeaks:
        !output.combined.includes("kms-key-id-redacted") &&
        !output.combined.includes("managed-secret-store-reference") &&
        !output.combined.includes("vault-smoke-token") &&
        !output.combined.includes(privateTokenFile) &&
        !output.combined.includes(publicTokenFile) &&
        !output.combined.includes("AKL") &&
        !output.combined.includes("sk-proj") &&
        !output.combined.includes("Secret Access Key") &&
        !output.combined.includes("WVRCaE"),
    };
  });

  const summary = {
    allExpected: results.every((result) => result.ok === result.expected),
    strictFailsWithoutRuntime: results.filter((result) => !result.expected).every((result) => result.status === 1),
    strictPassesWithCompleteVault: results.find((result) => result.name === "complete-vault")?.status === 0,
    rejectsDeclaredKmsWithoutAdapter: results.find((result) => result.name === "declared-kms-with-policies")?.status === 1,
    rejectsUnsupportedManagedStore: results.find((result) => result.name === "unsupported-managed-secret-store")?.status === 1,
    rejectsUnsafeTokenPermissions: results.find((result) => result.name === "vault-public-token-file")?.status === 1,
    allProvidersDetected: results.every((result) => result.providerMatches),
    allAdaptersDetected: results.every((result) => result.adapterMatches),
    allHaveChecks: results.every((result) => result.hasChecks),
    allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
    allHaveProductionGates: results.every(
      (result) =>
        result.hasRuntimeGate &&
        result.hasVaultConfigGate &&
        result.hasRotationGate &&
        result.hasAuditGate &&
        result.hasTenantGate &&
        result.hasDeletionProofGate &&
        result.hasAdminPolicyGate &&
        result.hasLocalSecretDecisionGate &&
        result.hasDecryptFailureAuditGate &&
        result.hasBackupRecoveryGate &&
        result.hasProviderContractGate,
    ),
    noSecretLeaks: results.every((result) => result.noSecretLeaks),
    results,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (Object.entries(summary).some(([key, value]) => key !== "results" && value !== true)) process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runCase(env) {
  const result = spawnSync(process.execPath, ["scripts/check-secret-production-env.mjs", "--strict"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, combined: `${result.stdout}\n${result.stderr}` };
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid secret preflight JSON: ${error.message}\n${stdout}`);
  }
}
