#!/usr/bin/env node

import { readFileSync } from "node:fs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";

async function main() {
  const response = await fetch(`${baseUrl}/api/storage/diagnostics`, { cache: "no-store" });
  const payload = await readJson(response, "/api/storage/diagnostics");
  const diagnostics = payload.diagnostics;
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const text = JSON.stringify(payload);
  const provider = diagnostics?.provider;
  const checks = diagnostics?.checks ?? [];
  const summary = {
    ok: payload.ok === true,
    provider,
    productionReady: diagnostics?.productionReady,
    checkCount: checks.length,
    hasCapabilities: Boolean(diagnostics?.capabilities && typeof diagnostics.capabilities === "object"),
    hasEndpointFlag: typeof diagnostics?.configured?.endpoint === "boolean",
    hasKeyPrefixFlag: typeof diagnostics?.configured?.keyPrefix === "boolean",
    hasContractFlag: diagnostics?.configured?.contract === true,
    hasProductionEvidenceFlags:
      typeof diagnostics?.configured?.deleteProof === "boolean" &&
      typeof diagnostics?.configured?.costBudget === "boolean" &&
      typeof diagnostics?.configured?.localInventoryDecision === "boolean" &&
      typeof diagnostics?.configured?.privateAccess === "boolean" &&
      typeof diagnostics?.configured?.minimumPrivilege === "boolean" &&
      typeof diagnostics?.configured?.restoreReadProof === "boolean" &&
      typeof diagnostics?.configured?.crossInstanceWriteLock === "boolean" &&
      typeof diagnostics?.configured?.durableDeletionFence === "boolean",
    hasLocalInventory: Boolean(diagnostics?.localInventory && typeof diagnostics.localInventory === "object"),
    localInventoryValid:
      Number.isInteger(diagnostics?.localInventory?.meetingCount) &&
      Number.isInteger(diagnostics?.localInventory?.manifestCount) &&
      Number.isFinite(diagnostics?.localInventory?.totalBytes) &&
      typeof diagnostics?.localInventory?.hasLocalData === "boolean",
    resumableUploadPolicyValid:
      diagnostics?.recordingUploads?.assemblyMethod === "bounded-temp-file" &&
      diagnostics?.recordingUploads?.partBytes === 4 * 1024 * 1024 &&
      Number.isInteger(diagnostics?.recordingUploads?.maxActiveUploadsPerUser) &&
      diagnostics.recordingUploads.maxActiveUploadsPerUser >= 1 &&
      Number.isInteger(diagnostics?.recordingUploads?.maxStagedBytesPerUser) &&
      diagnostics.recordingUploads.maxStagedBytesPerUser >= 96 * 1024 * 1024 &&
      Number.isFinite(diagnostics?.recordingUploads?.staleAfterHours) &&
      diagnostics.recordingUploads.staleAfterHours >= 1,
    hasObjectStoreAdapter: diagnostics?.capabilities?.hasObjectStoreAdapter === true,
    supportsBoundedFilePut: diagnostics?.capabilities?.supportsBoundedFilePut === true,
    privateAsrUrlCapabilityDeclared: typeof diagnostics?.capabilities?.supportsPrivateAsrUrl === "boolean",
    hasObjectStoreContract: diagnostics?.capabilities?.hasObjectStoreContract === true,
    hasPrivateAccessCapability: typeof diagnostics?.capabilities?.enforcesPrivateAccess === "boolean",
    hasRestoreReadCapability: typeof diagnostics?.capabilities?.supportsRestoreReadEvidence === "boolean",
    hasCrossInstanceWriteCapability: typeof diagnostics?.capabilities?.supportsCrossInstanceWrites === "boolean",
    hasDeletionFenceCapability: typeof diagnostics?.capabilities?.preventsDeletedMeetingRecreation === "boolean",
    hasStorageRunbook: diagnostics?.configured?.runbook === true,
    productionImageIncludesRunbooks: dockerfile.includes("/app/docs ./docs"),
    objectStoreContractCheck: checks.some((check) => check.id === "object-store-contract" && check.status === "pass"),
    objectStoreAdapterCheck: checks.some((check) => check.id === "object-store-adapter" && check.status === "pass"),
    recordingUploadStagingCheck: checks.some((check) => check.id === "recording-upload-staging" && check.status === "pass"),
    keyPrefixCheck: checks.some((check) => check.id === "storage-key-prefix"),
    localInventoryCheck: checks.some((check) => check.id === "local-migration-inventory" && ["pass", "manual"].includes(check.status)),
    storageRunbookCheck: checks.some((check) => check.id === "storage-runbook" && check.status === "pass"),
    privateAccessCheck: checks.some((check) => check.id === "private-access"),
    minimumPrivilegeCheck: checks.some((check) => check.id === "minimum-privilege"),
    restoreReadProofCheck: checks.some((check) => check.id === "restore-read-proof"),
    costBudgetCheck: checks.some((check) => check.id === "cost-budget"),
    crossInstanceWriteCheck: checks.some((check) => check.id === "cross-instance-write-lock"),
    deletionFenceCheck: checks.some((check) => check.id === "durable-deletion-fence"),
    hasMissingList: Array.isArray(diagnostics?.missing),
    localMissingEndpoint: provider === "local" ? diagnostics?.missing?.includes("对象存储 endpoint") : true,
    localMissingKeyPrefix: provider === "local" ? diagnostics?.missing?.includes("OWNMINUTES_STORAGE_PREFIX") : true,
    localMissingPrivateAccess: provider === "local" ? diagnostics?.missing?.includes("OWNMINUTES_STORAGE_PRIVATE_ACCESS=1") : true,
    localMissingMinimumPrivilege: provider === "local" ? diagnostics?.missing?.includes("OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE") : true,
    localMissingRestoreRead: provider === "local" ? diagnostics?.missing?.includes("OWNMINUTES_STORAGE_RESTORE_READ_PROOF") : true,
    localMissingCrossInstanceWriteLock: provider === "local" ? diagnostics?.missing?.includes("PostgreSQL cross-instance meeting write lock") : true,
    localMissingDeletionFence: provider === "local" ? diagnostics?.missing?.includes("durable meeting deletion fence") : true,
    statusesValid: checks.every((check) => ["pass", "fail", "manual"].includes(check.status)),
    localProviderBlocked: provider === "local" ? diagnostics?.productionReady === false : true,
    leaksSecrets:
      text.includes("AKL") ||
      text.includes("Secret Access Key") ||
      text.includes("sk-proj") ||
      text.includes("WVRCaE"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    !["local", "s3", "r2", "volcano-tos"].includes(summary.provider) ||
    summary.checkCount < 5 ||
    !summary.hasCapabilities ||
    !summary.hasEndpointFlag ||
    !summary.hasKeyPrefixFlag ||
    !summary.hasContractFlag ||
    !summary.hasProductionEvidenceFlags ||
    !summary.hasLocalInventory ||
    !summary.localInventoryValid ||
    !summary.resumableUploadPolicyValid ||
    !summary.hasObjectStoreAdapter ||
    !summary.supportsBoundedFilePut ||
    !summary.privateAsrUrlCapabilityDeclared ||
    !summary.hasObjectStoreContract ||
    !summary.hasPrivateAccessCapability ||
    !summary.hasRestoreReadCapability ||
    !summary.hasCrossInstanceWriteCapability ||
    !summary.hasDeletionFenceCapability ||
    !summary.hasStorageRunbook ||
    !summary.productionImageIncludesRunbooks ||
    !summary.objectStoreContractCheck ||
    !summary.objectStoreAdapterCheck ||
    !summary.recordingUploadStagingCheck ||
    !summary.keyPrefixCheck ||
    !summary.localInventoryCheck ||
    !summary.storageRunbookCheck ||
    !summary.privateAccessCheck ||
    !summary.minimumPrivilegeCheck ||
    !summary.restoreReadProofCheck ||
    !summary.costBudgetCheck ||
    !summary.crossInstanceWriteCheck ||
    !summary.deletionFenceCheck ||
    !summary.hasMissingList ||
    !summary.localMissingEndpoint ||
    !summary.localMissingKeyPrefix ||
    !summary.localMissingPrivateAccess ||
    !summary.localMissingMinimumPrivilege ||
    !summary.localMissingRestoreRead ||
    !summary.localMissingCrossInstanceWriteLock ||
    !summary.localMissingDeletionFence ||
    !summary.statusesValid ||
    !summary.localProviderBlocked ||
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
