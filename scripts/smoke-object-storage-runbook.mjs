#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const runbookPath = path.join(process.cwd(), "docs", "object-storage-runbook.md");
const runbook = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "";

const requiredPhrases = [
  "src/lib/server/meeting-object-store.ts",
  "npm run smoke:storage-preflight",
  "npm run smoke:storage",
  "npm run storage:preflight",
  "npm run storage:evidence:draft",
  "OWNMINUTES_OBJECT_STORAGE_EVIDENCE_DRAFT_PATH",
  ".data/acceptance/object-storage-latest.md",
  "pending",
  "storage:acceptance:evidence",
  "npm run smoke:storage-remote",
  "npm run smoke:storage-real-verifier",
  "OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE=1 npm run storage:real:verify",
  "OWNMINUTES_STORAGE_PREFIX",
  ".data/acceptance/object-storage-live-latest.json",
  "npm run smoke:meetings",
  "npm run smoke:release",
  "localInventory.meetingCount",
  "localInventory.manifestCount",
  "localInventory.totalBytes",
  "OWNMINUTES_STORAGE_LIFECYCLE_POLICY",
  "OWNMINUTES_STORAGE_DELETE_PROOF",
  "OWNMINUTES_STORAGE_COST_BUDGET",
  "OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION",
  "OWNMINUTES_STORAGE_PRIVATE_ACCESS=1",
  "OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE",
  "OWNMINUTES_STORAGE_RESTORE_READ_PROOF",
  "S3_BUCKET",
  "R2_BUCKET",
  "VOLCANO_TOS_BUCKET",
  "meeting-object-store-contract:v3",
  "putFile",
  "getFile",
  "createPresignedGetUrl",
  "buildMeetingObjectKey",
  "Do not construct .data/meetings paths or remote object keys directly",
  "{{meetingId}}/manifest.json",
  "{{meetingId}}/chunks/{{fileName}}",
  "{{meetingId}}/transient/asr/{{fileName}}",
  "{{meetingId}}/chunks/chunk-000001.webm",
  "{{meetingId}}/processing.json",
  "{{meetingId}}/result.json",
  "{{meetingId}}/obsidian.md",
  "Deletion must remove the full meeting prefix",
  "must never contain audio bytes, provider credentials, or raw model responses",
  "Local migration inventory",
  "Public access block",
  "Minimum-privilege access-key policy proof",
  "Restore/read test from stored objects",
  "Roll back",
];

const summary = {
  exists: Boolean(runbook),
  hasCurrentBoundary: runbook.includes("Current Boundary"),
  hasRequiredEnvironment: runbook.includes("Required Environment"),
  hasPreflight: runbook.includes("Preflight"),
  hasMigrationSteps: runbook.includes("Migration Steps"),
  hasObjectLayout: runbook.includes("Object Layout"),
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
  !summary.hasPreflight ||
  !summary.hasMigrationSteps ||
  !summary.hasObjectLayout ||
  !summary.hasRollback ||
  !summary.hasProductionVerification ||
  !summary.requiredPhrasesPresent ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}
