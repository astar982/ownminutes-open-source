#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/postgres-evidence-pass.md";
const failPath = ".data/smoke/postgres-evidence-fail.md";
const partialPath = ".data/smoke/postgres-evidence-partial.md";
const draftPath = ".data/smoke/postgres-evidence-draft.md";

const passEvidence = evidenceBlock();
const failEvidence = evidenceBlock({
  overrides: {
    "Runtime repository": "local-file",
    "SSL/TLS required": "no",
    Decision: "fail",
  },
  extraLines: ["DATABASE_URL=postgres://user:password@example.com:5432/ownminutes"],
});
const partialEvidence = evidenceBlock({
  overrides: {
    "Account deletion cleanup": "fail",
  },
});

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, passEvidence);
writeFileSync(failPath, failEvidence);
writeFileSync(partialPath, partialEvidence);

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const partial = runChecker(partialPath);
const draft = runDraft(draftPath);
const draftCheck = runChecker(draftPath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  passFixtureAccepted: pass.status === 0 && pass.payload?.evidenceReady === true,
  failFixtureRejected:
    fail.status !== 0 &&
    fail.payload?.evidenceReady === false &&
    fail.payload?.runtimeFailure === "runtime-not-postgres" &&
    fail.payload?.sslFailure === "ssl-tls-not-affirmed" &&
    fail.payload?.decisionFail === true &&
    fail.payload?.leakedPhrases?.includes("postgres://"),
  partialFixtureRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingPassChecks?.includes("Account deletion cleanup:") &&
    partial.payload?.failedChecks?.includes("Account deletion cleanup:"),
  draftGenerated:
    draft.status === 0 &&
    draft.evidence.includes("# PostgreSQL Acceptance Evidence") &&
    draft.evidence.includes("This file is an automated draft from `npm run database:preflight`.") &&
    draft.evidence.includes("Runtime repository: postgres") &&
    draft.evidence.includes("Meeting write lock: postgres-advisory") &&
    draft.evidence.includes("Migration dry run: pass") &&
    draft.evidence.includes("Runtime writes: pending") &&
    draft.evidence.includes("Account deletion cleanup: pending") &&
    draft.evidence.includes("Decision: pending"),
  draftRejectedUntilManualChecks:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.missingPassChecks?.includes("Runtime writes:") &&
    draftCheck.payload?.missingPassChecks?.includes("Account deletion cleanup:") &&
    draftCheck.payload?.releaseFailures?.includes("databaseBlocked-not-cleared"),
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.passFixtureAccepted ||
  !summary.failFixtureRejected ||
  !summary.partialFixtureRejected ||
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
    "Database provider": "managed postgres",
    "Runtime repository": "postgres",
    "Finalization mode": "postgres-queue",
    "Worker instances": "2",
    "Meeting write lock": "postgres-advisory",
    "Migration command": "node scripts/run-postgres-migrations.mjs",
    "Migration version": "0009_meeting_deletion_tombstones",
    "Backup policy": "managed daily backups with retention recorded",
    "Restore drill": "restore drill evidence recorded",
    "Minimum privilege role": "app role scoped to required tables and migrations",
    "Audit log policy": "connection and mutation audit policy recorded",
    "SSL/TLS required": "yes",
    "Local JSON store decision": "imported then archived outside runtime path",
    "Database diagnostics": "pass",
    "Release readiness databaseBlocked": "no",
    "Release readiness finalizationQueueBlocked": "no",
    "Release readiness nextAction": "Continue ASR and TestFlight evidence.",
    "Production preflight": "pass",
    "Schema smoke": "pass",
    "Migration dry run": "pass",
    "Migration applied": "pass",
    "Auth export reviewed": "pass",
    "Runtime writes": "pass",
    "Register/login": "pass",
    "Password reset token": "pass",
    "Provider credentials save/delete": "pass",
    "Meeting metadata write/read": "pass",
    "Usage event write/read": "pass",
    "Admin metrics": "pass",
    "Account deletion cleanup": "pass",
    "Queue migration applied": "pass",
    "Queue duplicate enqueue": "pass",
    "Queue atomic claim": "pass",
    "Queue expired lease reclaim": "pass",
    "Queue retry recovery": "pass",
    "Queue deletion cancellation": "pass",
    "Queue account cleanup": "pass",
    "Meeting deletion fence migration": "pass",
    "Cross-instance chunk write": "pass",
    "Deleted meeting recreation blocked": "pass",
    "Backup snapshot": "pass",
    "Restore drill proof": "pass",
    "Minimum privilege proof": "pass",
    "Audit log proof": "pass",
    "SSL/TLS proof": "pass",
    "Local JSON store handled": "pass",
    "Secrets leaked": "no",
    Decision: "pass",
    "Known issues": "other release blockers remain",
    ...overrides,
  };

  return [
    "# PostgreSQL Acceptance Evidence",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    ...extraLines,
    "",
  ].join("\n");
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-postgres-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_POSTGRES_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-postgres-production-env.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "postgres://example.invalid:5432/ownminutes",
      OWNMINUTES_AUTH_REPOSITORY: "postgres",
      OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
      OWNMINUTES_DB_AUDIT_LOG: "configured",
      OWNMINUTES_DB_BACKUP_POLICY: "configured",
      OWNMINUTES_DB_LOCAL_STORE_DECISION: "configured",
      OWNMINUTES_DB_MIGRATION_COMMAND: "node scripts/run-postgres-migrations.mjs",
      OWNMINUTES_DB_MIN_ROLE: "configured",
      OWNMINUTES_DB_PREFLIGHT_SKIP_DRY_RUN: "0",
      OWNMINUTES_DB_RESTORE_DRILL: "configured",
      OWNMINUTES_DB_SSL_REQUIRED: "1",
      OWNMINUTES_POSTGRES_EVIDENCE_DRAFT_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    evidence: readDraft(path),
  };
}

function readDraft(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["postgres://", "postgresql://", "DATABASE_URL=", "POSTGRES_URL=", "AKL", "sk-proj", "Secret Access Key"];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/postgres-migration-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
