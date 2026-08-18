#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const runbookPath = path.join(process.cwd(), "docs", "secret-management-runbook.md");
const runbook = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "";

const requiredPhrases = [
  "local-app-secret",
  "OWNMINUTES_KMS_KEY_ID",
  "OWNMINUTES_SECRET_STORE",
  "OWNMINUTES_SECRET_ROTATION_POLICY",
  "OWNMINUTES_SECRET_AUDIT_LOG",
  "OWNMINUTES_TENANT_SCOPED_KEYS",
  "OWNMINUTES_SECRET_DELETION_PROOF",
  "OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY",
  "OWNMINUTES_SECRET_LOCAL_SECRET_DECISION",
  "OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT",
  "OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY",
  "provider_credentials.encrypted_secrets",
  "provider_secret_rotate",
  "secretPreviews",
  "v2.<iv>.<tag>.<ciphertext>",
  "npm run secret:preflight",
  "npm run smoke:secret-preflight",
  "npm run smoke:secret-vault-live-verifier",
  "npm run secret:vault:live:verify",
  "npm run smoke:secret-audit",
  "npm run smoke:secrets",
  "npm run secret:evidence:draft",
  "npm run smoke:auth",
  "npm run smoke:settings",
  "npm run smoke:release",
  "dual-read period",
  ".data/auth/secret-audit.jsonl",
  ".data/acceptance/secret-management-latest.md",
  ".data/acceptance/vault-transit-live-latest.json",
  "Never expose decrypted provider keys",
  "Decrypt-failure audit sample",
  "Backup/recovery drill",
  "The draft is intentionally incomplete",
];

const summary = {
  exists: Boolean(runbook),
  hasCurrentBoundary: runbook.includes("Current Boundary"),
  hasRequiredEnvironment: runbook.includes("Required Environment"),
  hasRequiredGuarantees: runbook.includes("Required Guarantees"),
  hasPreflight: runbook.includes("Preflight"),
  hasMigrationSteps: runbook.includes("Migration Steps"),
  hasRotation: runbook.includes("Rotation"),
  hasRollback: runbook.includes("Rollback"),
  hasProductionVerification: runbook.includes("Production Verification"),
  requiredPhrasesPresent: requiredPhrases.every((phrase) => runbook.includes(phrase)),
  leaksSecrets:
    runbook.includes("AKL") ||
    runbook.includes("sk-proj") ||
    runbook.includes("Secret Access Key") ||
    runbook.includes("WVRCaE"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.exists ||
  !summary.hasCurrentBoundary ||
  !summary.hasRequiredEnvironment ||
  !summary.hasRequiredGuarantees ||
  !summary.hasPreflight ||
  !summary.hasMigrationSteps ||
  !summary.hasRotation ||
  !summary.hasRollback ||
  !summary.hasProductionVerification ||
  !summary.requiredPhrasesPresent ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}
