#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const runbookPath = path.join(process.cwd(), "docs", "postgres-migration-runbook.md");
const runbook = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "";

const requiredPhrases = [
  "OWNMINUTES_AUTH_REPOSITORY=postgres",
  "DATABASE_URL",
  "POSTGRES_URL",
  "OWNMINUTES_DB_MIGRATION_COMMAND",
  "OWNMINUTES_DB_BACKUP_POLICY",
  "OWNMINUTES_DB_RESTORE_DRILL",
  "OWNMINUTES_DB_MIN_ROLE",
  "OWNMINUTES_DB_AUDIT_LOG",
  "OWNMINUTES_DB_SSL_REQUIRED=1",
  "OWNMINUTES_DB_LOCAL_STORE_DECISION",
  "npm run smoke:database-schema",
  "npm run smoke:database-preflight",
  "npm run smoke:database-migrate",
  "npm run smoke:database-export",
  "npm run smoke:database",
  "npm run smoke:auth-repository",
  "scripts/run-postgres-migrations.mjs",
  "npm run database:preflight",
  "npm run database:evidence:draft",
  "OWNMINUTES_POSTGRES_EVIDENCE_DRAFT_PATH",
  ".data/acceptance/postgres-latest.md",
  "pending",
  "database:acceptance:evidence",
  "scripts/export-auth-store-to-postgres.mjs",
  "Current PostgreSQL runtime writes: implemented",
  "supportsPostgresRuntimeWrites: false",
  "PostgreSQL runtime methods exist",
  "Do not set `OWNMINUTES_AUTH_REPOSITORY=postgres` in production until the target database has been migrated",
  "Roll back",
  "SSL/TLS",
  "local JSON store",
  "PostgreSQL durable queue",
  "OWNMINUTES_FINALIZATION_MODE=postgres-queue",
  "OWNMINUTES_FINALIZATION_WORKER=1",
  "OWNMINUTES_FINALIZATION_WORKER_INSTANCES",
  "npm run smoke:finalization-queue",
  "Queue expired lease reclaim: pass",
  "Release readiness finalizationQueueBlocked: no",
];

const summary = {
  exists: Boolean(runbook),
  hasCurrentBoundary: runbook.includes("Current Boundary"),
  hasRequiredEnvironment: runbook.includes("Required Environment"),
  hasPreflight: runbook.includes("Preflight"),
  hasMigrationSteps: runbook.includes("Migration Steps"),
  hasRollback: runbook.includes("Rollback"),
  hasPostRuntimeGate: runbook.includes("Verification After Runtime Switch"),
  requiredPhrasesPresent: requiredPhrases.every((phrase) => runbook.includes(phrase)),
  leaksSecrets:
    runbook.includes("postgres://") ||
    runbook.includes("postgresql://") ||
    runbook.includes("AKL") ||
    runbook.includes("sk-proj") ||
    runbook.includes("Secret Access Key"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.exists ||
  !summary.hasCurrentBoundary ||
  !summary.hasRequiredEnvironment ||
  !summary.hasPreflight ||
  !summary.hasMigrationSteps ||
  !summary.hasRollback ||
  !summary.hasPostRuntimeGate ||
  !summary.requiredPhrasesPresent ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}
