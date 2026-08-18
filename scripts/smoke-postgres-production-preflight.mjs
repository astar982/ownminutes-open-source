#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const cases = [
  {
    name: "missing-env",
    expectOk: false,
    env: {},
  },
  {
    name: "database-only",
    expectOk: false,
    env: {
      DATABASE_URL: "postgres://user:secret@example.invalid:5432/ownminutes",
    },
  },
  {
    name: "complete-env",
    expectOk: true,
    env: {
      DATABASE_URL: "postgres://user:secret@example.invalid:5432/ownminutes",
      OWNMINUTES_AUTH_REPOSITORY: "postgres",
      OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
      OWNMINUTES_DB_MIGRATION_COMMAND: "node scripts/run-postgres-migrations.mjs",
      OWNMINUTES_DB_BACKUP_POLICY: "managed daily backup, 30 day retention, quarterly restore drill",
      OWNMINUTES_DB_RESTORE_DRILL: "restore drill completed against staging snapshot on 2026-07-04",
      OWNMINUTES_DB_MIN_ROLE: "ownminutes_app_rw",
      OWNMINUTES_DB_AUDIT_LOG: "audit_events plus provider secret audit",
      OWNMINUTES_DB_SSL_REQUIRED: "1",
      OWNMINUTES_DB_LOCAL_STORE_DECISION: "import reviewed data, archive encrypted local store, then remove from production host",
    },
  },
];

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
    missing: payload?.missing ?? [],
    hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 10,
    hasRequiredEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.includes("OWNMINUTES_DB_BACKUP_POLICY"),
    hasRestoreDrillEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.includes("OWNMINUTES_DB_RESTORE_DRILL"),
    hasSslEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.includes("OWNMINUTES_DB_SSL_REQUIRED"),
    hasLocalStoreDecisionEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.includes("OWNMINUTES_DB_LOCAL_STORE_DECISION"),
    hasMeetingWriteLockEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.includes("OWNMINUTES_MEETING_WRITE_LOCK"),
    dryRunOk: payload?.dryRun?.ok === true,
    noSecretLeaks: !output.combined.includes("postgres://user:secret") &&
      !output.combined.includes("DATABASE_URL=") &&
      !output.combined.includes("POSTGRES_URL=") &&
      !output.combined.includes("AKL") &&
      !output.combined.includes("sk-proj"),
  };
});

const summary = {
  allExpected: results.every((result) => result.ok === result.expected),
  strictFailsWhenMissing: results.find((result) => result.name === "missing-env")?.status === 1,
  strictFailsWithDatabaseOnly: results.find((result) => result.name === "database-only")?.status === 1,
  strictPassesWithCompleteEnv: results.find((result) => result.name === "complete-env")?.status === 0,
  allHaveChecks: results.every((result) => result.hasChecks),
  allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
  allHaveRestoreDrillEnv: results.every((result) => result.hasRestoreDrillEnv),
  allHaveSslEnv: results.every((result) => result.hasSslEnv),
  allHaveLocalStoreDecisionEnv: results.every((result) => result.hasLocalStoreDecisionEnv),
  allHaveMeetingWriteLockEnv: results.every((result) => result.hasMeetingWriteLockEnv),
  allRunMigrationDryRun: results.every((result) => result.dryRunOk),
  noSecretLeaks: results.every((result) => result.noSecretLeaks),
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.allExpected ||
  !summary.strictFailsWhenMissing ||
  !summary.strictFailsWithDatabaseOnly ||
  !summary.strictPassesWithCompleteEnv ||
  !summary.allHaveChecks ||
  !summary.allHaveRequiredEnv ||
  !summary.allHaveRestoreDrillEnv ||
  !summary.allHaveSslEnv ||
  !summary.allHaveLocalStoreDecisionEnv ||
  !summary.allHaveMeetingWriteLockEnv ||
  !summary.allRunMigrationDryRun ||
  !summary.noSecretLeaks
) {
  process.exitCode = 1;
}

function runCase(env) {
  const result = spawnSync(process.execPath, ["scripts/check-postgres-production-env.mjs", "--strict"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      ...env,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid preflight JSON: ${error.message}\n${stdout}`);
  }
}
