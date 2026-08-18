#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = process.cwd();
const runnerPath = resolve(repoRoot, "scripts/run-postgres-migrations.mjs");
const scratch = mkdtempSync(join(tmpdir(), "ownminutes-migration-policy-"));
const expectedApprovedMigrations = [
  {
    version: "0031_meeting_catalog_purge",
    checksum: "fa0724abd54055673a87959924a2e37f2b950521393396df1c4c93e07b1c79cc",
  },
  {
    version: "0032_meeting_transfer_intents",
    checksum: "1330343e8eba103945f28d7daab897732a0459a0c03bb40ed88b3d792c8cdc35",
  },
];

try {
  const baseline = runDryRun(repoRoot);

  const tamperedRoot = join(scratch, "tampered-reviewed-migration");
  copyMigrations(tamperedRoot);
  const reviewedMigration = join(tamperedRoot, "db/migrations/0031_meeting_catalog_purge.sql");
  writeFileSync(reviewedMigration, `${readFileSync(reviewedMigration, "utf8")}\n-- checksum tamper probe\n`);
  const tampered = runDryRun(tamperedRoot);
  const tamperedRealExecution = runRealMigration(tamperedRoot);

  const unreviewedRoot = join(scratch, "unreviewed-destructive-migration");
  copyMigrations(unreviewedRoot);
  writeFileSync(
    join(unreviewedRoot, "db/migrations/0033_unreviewed_delete.sql"),
    [
      "delete from users where false;",
      "",
      "insert into ownminutes_schema_migrations (version)",
      "values ('0033_unreviewed_delete')",
      "on conflict (version) do nothing;",
      "",
    ].join("\n"),
  );
  const unreviewed = runDryRun(unreviewedRoot);

  const checks = {
    baselinePasses: baseline.status === 0,
    baselineReportsDestructiveSqlHonestly: baseline.payload?.destructiveSqlFree === false,
    baselineReviewed:
      baseline.payload?.destructiveSqlReviewed === true &&
      (baseline.payload?.unapprovedDestructiveMatches ?? []).length === 0,
    onlyExpectedMigrationsApproved:
      JSON.stringify(baseline.payload?.approvedDestructiveMigrations) ===
      JSON.stringify(expectedApprovedMigrations),
    checksumTamperFailsClosed:
      tampered.status !== 0 &&
      tampered.payload?.destructiveSqlReviewed === false &&
      (tampered.payload?.unapprovedDestructiveMatches ?? []).some((finding) =>
        finding.includes("0031_meeting_catalog_purge.sql"),
      ) &&
      !(tampered.payload?.approvedDestructiveMigrations ?? []).some(
        (entry) => entry.version === "0031_meeting_catalog_purge",
      ),
    realMigrationChecksPolicyBeforeDatabaseConnection:
      tamperedRealExecution.status !== 0 &&
      tamperedRealExecution.stderr.includes("Migration safety policy failed before database connection") &&
      !tamperedRealExecution.combined.includes("ECONNREFUSED"),
    newDestructiveMigrationFailsClosed:
      unreviewed.status !== 0 &&
      unreviewed.payload?.destructiveSqlReviewed === false &&
      (unreviewed.payload?.unapprovedDestructiveMatches ?? []).some((finding) =>
        finding.includes("0033_unreviewed_delete.sql"),
      ),
  };

  console.log(JSON.stringify(checks, null, 2));
  if (Object.values(checks).some((value) => value !== true)) process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function copyMigrations(targetRoot) {
  const targetMigrations = join(targetRoot, "db/migrations");
  mkdirSync(dirname(targetMigrations), { recursive: true });
  cpSync(join(repoRoot, "db/migrations"), targetMigrations, { recursive: true });
}

function runDryRun(cwd) {
  const result = spawnSync(process.execPath, [runnerPath, "--dry-run"], {
    cwd,
    env: {
      PATH: process.env.PATH,
      OWNMINUTES_DB_MIGRATION_DRY_RUN: "1",
    },
    encoding: "utf8",
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    // The assertions below report malformed output without echoing raw logs.
  }
  return { payload, status: result.status };
}

function runRealMigration(cwd) {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd,
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: "postgresql://127.0.0.1:1/ownminutes",
    },
    encoding: "utf8",
  });
  return {
    combined: `${result.stdout}\n${result.stderr}`,
    status: result.status,
    stderr: result.stderr,
  };
}
