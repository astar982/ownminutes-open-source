#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";

async function main() {
  const response = await fetch(`${baseUrl}/api/secrets/diagnostics`, { cache: "no-store" });
  const payload = await readJson(response, "/api/secrets/diagnostics");
  const diagnostics = payload.diagnostics;
  const text = JSON.stringify(payload);
  const provider = diagnostics?.provider;
  const checks = diagnostics?.checks ?? [];
  const summary = {
    ok: payload.ok === true,
    provider,
    productionReady: diagnostics?.productionReady,
    checkCount: checks.length,
    hasCapabilities: Boolean(diagnostics?.capabilities && typeof diagnostics.capabilities === "object"),
    hasMissingList: Array.isArray(diagnostics?.missing),
    hasProductionEvidenceFlags:
      typeof diagnostics?.configured?.deletionProof === "boolean" &&
      typeof diagnostics?.configured?.adminAccessPolicy === "boolean" &&
      typeof diagnostics?.configured?.localSecretDecision === "boolean" &&
      typeof diagnostics?.configured?.decryptFailureAudit === "boolean" &&
      typeof diagnostics?.configured?.backupRecoveryPolicy === "boolean" &&
      typeof diagnostics?.configured?.providerContract === "boolean" &&
      typeof diagnostics?.configured?.providerRuntime === "boolean" &&
      typeof diagnostics?.configured?.providerTransportSecure === "boolean",
    hasProductionCapabilities:
      typeof diagnostics?.capabilities?.supportsDeletionProof === "boolean" &&
      typeof diagnostics?.capabilities?.blocksAdminPlaintextAccess === "boolean" &&
      typeof diagnostics?.capabilities?.supportsBackupRecoveryPolicy === "boolean" &&
      typeof diagnostics?.capabilities?.supportsProviderContract === "boolean" &&
      typeof diagnostics?.capabilities?.usesManagedRuntime === "boolean" &&
      typeof diagnostics?.capabilities?.usesSecureManagedTransport === "boolean",
    hasSecretRunbook: diagnostics?.configured?.runbook === true,
    localMissingProvider:
      provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_KMS_KEY_ID or OWNMINUTES_SECRET_STORE") : true,
    localMissingRotation: provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_SECRET_ROTATION_POLICY") : true,
    localMissingAudit: provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_SECRET_AUDIT_LOG") : true,
    localMissingTenantScope: provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_TENANT_SCOPED_KEYS") : true,
    localMissingDeletionProof: provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_SECRET_DELETION_PROOF") : true,
    localMissingAdminPolicy: provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY") : true,
    localMissingDecryptFailureAudit: provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT") : true,
    localMissingBackupRecovery: provider === "local-app-secret" ? diagnostics?.missing?.includes("OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY") : true,
    statusesValid: checks.every((check) => ["pass", "fail", "manual"].includes(check.status)),
    localProviderBlocked: provider === "local-app-secret" ? diagnostics?.productionReady === false : true,
    localSecretPathRedacted: diagnostics?.localSecretPath === ".data/auth/local-secret",
    noSecretReturnCheck: checks.some((check) => check.id === "no-secret-return" && check.status === "pass"),
    secretRunbookCheck: checks.some((check) => check.id === "secret-runbook" && check.status === "pass"),
    deletionProofCheck: checks.some((check) => check.id === "deletion-proof"),
    adminAccessPolicyCheck: checks.some((check) => check.id === "admin-access-policy"),
    decryptFailureAuditCheck: checks.some((check) => check.id === "decrypt-failure-audit"),
    backupRecoveryPolicyCheck: checks.some((check) => check.id === "backup-recovery-policy"),
    providerContractCheck: checks.some((check) => check.id === "secret-provider-contract" && check.status === "pass"),
    leaksSecrets:
      text.includes("encryptedSecrets") ||
      text.includes("passwordHash") ||
      text.includes("local-secret/") ||
      text.includes("OWNMINUTES_APP_SECRET=") ||
      text.includes("AUTH_SECRET=") ||
      text.includes("Secret Access Key") ||
      text.includes("WVRCaE") ||
      text.includes("AKL") ||
      text.includes("sk-proj"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    !["local-app-secret", "kms", "managed-secret-store"].includes(summary.provider) ||
    summary.checkCount < 5 ||
    !summary.hasCapabilities ||
    !summary.hasMissingList ||
    !summary.hasProductionEvidenceFlags ||
    !summary.hasProductionCapabilities ||
    !summary.hasSecretRunbook ||
    !summary.localMissingProvider ||
    !summary.localMissingRotation ||
    !summary.localMissingAudit ||
    !summary.localMissingTenantScope ||
    !summary.localMissingDeletionProof ||
    !summary.localMissingAdminPolicy ||
    !summary.localMissingDecryptFailureAudit ||
    !summary.localMissingBackupRecovery ||
    !summary.statusesValid ||
    !summary.localProviderBlocked ||
    !summary.localSecretPathRedacted ||
    !summary.noSecretReturnCheck ||
    !summary.secretRunbookCheck ||
    !summary.deletionProofCheck ||
    !summary.adminAccessPolicyCheck ||
    !summary.decryptFailureAuditCheck ||
    !summary.backupRecoveryPolicyCheck ||
    !summary.providerContractCheck ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

async function readJson(response, path) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
