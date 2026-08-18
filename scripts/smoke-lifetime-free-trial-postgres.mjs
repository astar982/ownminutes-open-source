#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const suffix = crypto.randomBytes(5).toString("hex");
const container = `ownminutes-lifetime-trial-${suffix}`;
const databasePassword = crypto.randomBytes(24).toString("base64url");
let client;

try {
  run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--env",
    "POSTGRES_DB=ownminutes",
    "--env",
    "POSTGRES_USER=ownminutes",
    "--env",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "--publish",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  waitForPostgres();

  const port = run("docker", ["port", container, "5432/tcp"], true).trim().split(":").at(-1);
  if (!/^\d+$/.test(port || "")) throw new Error("Unable to resolve isolated PostgreSQL port.");

  const { Client } = await import("pg");
  const connectionString = `postgresql://ownminutes:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/ownminutes`;
  client = await connectWithRetry(Client, connectionString);

  const migrationFiles = fs
    .readdirSync(path.join(process.cwd(), "db", "migrations"))
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort();
  const legacyMigrationFiles = migrationFiles.filter((fileName) => fileName < "0014_");
  const upgradeMigrationFile = migrationFiles.find((fileName) => fileName === "0014_lifetime_free_trial.sql");
  if (legacyMigrationFiles.length !== 13 || !upgradeMigrationFile) {
    throw new Error("Expected migrations 0001-0013 followed by 0014_lifetime_free_trial.sql.");
  }

  for (const fileName of legacyMigrationFiles) {
    await client.query(readMigration(fileName));
  }

  const migrationCountBefore = Number((await client.query("select count(*)::int as count from ownminutes_schema_migrations")).rows[0].count);
  const trialColumnsBefore = Number(
    (
      await client.query(
        "select count(*)::int as count from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name like 'free_trial_%'",
      )
    ).rows[0].count,
  );

  await client.query(`
    insert into users (
      id,
      email,
      name,
      role,
      plan,
      official_minutes_total,
      official_minutes_used,
      official_minutes_period_start_at,
      official_minutes_period_end_at,
      official_minutes_period_source,
      password_salt,
      password_hash,
      created_at,
      deleted_at
    ) values
      ('legacy-free', 'legacy-free@example.com', 'Legacy Free', 'user', 'free', 60, 23,
       '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'free', 'salt', 'hash', '2026-01-01T00:00:00Z', null),
      ('legacy-plus', 'legacy-plus@example.com', 'Legacy Plus', 'user', 'plus', 600, 100,
       '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'apple_iap', 'salt', 'hash', '2026-01-02T00:00:00Z', null),
      ('legacy-pro', 'legacy-pro@example.com', 'Legacy Pro', 'user', 'pro', 1800, 900,
       '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'apple_iap', 'salt', 'hash', '2026-01-03T00:00:00Z', null),
      ('legacy-deleted', 'legacy-deleted@example.com', 'Legacy Deleted', 'user', 'free', 60, 10,
       '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'free', 'salt', 'hash', '2026-01-04T00:00:00Z', '2026-01-05T00:00:00Z')
  `);

  await client.query(readMigration(upgradeMigrationFile));

  const legacyUsers = Object.fromEntries(
    (
      await client.query(`
        select
          id,
          official_minutes_total,
          official_minutes_used,
          official_minutes_period_end_at,
          free_trial_minutes_total,
          free_trial_minutes_used,
          free_trial_granted_at,
          created_at
        from users
        where id like 'legacy-%'
        order by id
      `)
    ).rows.map((row) => [row.id, row]),
  );

  await client.query(`
    insert into users (
      id,
      email,
      name,
      role,
      plan,
      official_minutes_total,
      official_minutes_used,
      password_salt,
      password_hash,
      created_at
    ) values (
      'post-upgrade-default',
      'post-upgrade-default@example.com',
      'Post Upgrade Default',
      'user',
      'free',
      0,
      0,
      'salt',
      'hash',
      '2026-02-01T00:00:00Z'
    )
  `);
  const defaultUser = (
    await client.query(`
      select free_trial_minutes_total, free_trial_minutes_used, free_trial_granted_at
      from users
      where id = 'post-upgrade-default'
    `)
  ).rows[0];

  const columnMetadata = Object.fromEntries(
    (
      await client.query(`
        select column_name, column_default, is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'users'
          and column_name in ('free_trial_minutes_total', 'free_trial_minutes_used', 'free_trial_granted_at')
      `)
    ).rows.map((row) => [row.column_name, row]),
  );

  const rejectsUsedAboveTotal = await rejectsCheckViolation(
    "update users set free_trial_minutes_used = free_trial_minutes_total + 1 where id = 'post-upgrade-default'",
  );
  const rejectsNegativeTotal = await rejectsCheckViolation(
    "update users set free_trial_minutes_total = -1, free_trial_minutes_used = 0 where id = 'post-upgrade-default'",
  );

  const migrationCountAfter = Number((await client.query("select count(*)::int as count from ownminutes_schema_migrations")).rows[0].count);
  const migrationRecordedOnce =
    Number(
      (
        await client.query(
          "select count(*)::int as count from ownminutes_schema_migrations where version = '0014_lifetime_free_trial'",
        )
      ).rows[0].count,
    ) === 1;
  const constraintDefinition = (
    await client.query(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'users_free_trial_minutes_valid'
    `)
  ).rows[0]?.definition;

  const summary = {
    legacyMigrationsOnlyBeforeUpgrade: migrationCountBefore === 13 && trialColumnsBefore === 0,
    migration0014AppliedSeparately: migrationCountAfter === 14 && migrationRecordedOnce,
    freeUserPreservesVisibleRemainder:
      legacyUsers["legacy-free"]?.official_minutes_total - legacyUsers["legacy-free"]?.official_minutes_used === 37 &&
      legacyUsers["legacy-free"]?.free_trial_minutes_total - legacyUsers["legacy-free"]?.free_trial_minutes_used === 37 &&
      legacyUsers["legacy-free"]?.official_minutes_period_end_at === null,
    paidUsersMarkedTrialExhausted:
      legacyUsers["legacy-plus"]?.free_trial_minutes_total === 60 &&
      legacyUsers["legacy-plus"]?.free_trial_minutes_used === 60 &&
      legacyUsers["legacy-pro"]?.free_trial_minutes_total === 60 &&
      legacyUsers["legacy-pro"]?.free_trial_minutes_used === 60,
    deletedUserMarkedTrialExhausted:
      legacyUsers["legacy-deleted"]?.free_trial_minutes_total === 60 &&
      legacyUsers["legacy-deleted"]?.free_trial_minutes_used === 60,
    legacyGrantTimestampUsesCreatedAt: Object.values(legacyUsers).every(
      (user) => user.free_trial_granted_at?.getTime() === user.created_at?.getTime(),
    ),
    defaultsApplyToNewRows:
      defaultUser?.free_trial_minutes_total === 60 &&
      defaultUser?.free_trial_minutes_used === 0 &&
      defaultUser?.free_trial_granted_at instanceof Date,
    columnsAreNonNullable:
      Object.keys(columnMetadata).length === 3 && Object.values(columnMetadata).every((column) => column.is_nullable === "NO"),
    databaseDefaultsAreCorrect:
      columnMetadata.free_trial_minutes_total?.column_default === "60" &&
      columnMetadata.free_trial_minutes_used?.column_default === "0" &&
      columnMetadata.free_trial_granted_at?.column_default === "now()",
    constraintDefinitionIsCorrect:
      typeof constraintDefinition === "string" &&
      constraintDefinition.includes("free_trial_minutes_total >= 0") &&
      constraintDefinition.includes("free_trial_minutes_used >= 0") &&
      constraintDefinition.includes("free_trial_minutes_used <= free_trial_minutes_total"),
    constraintRejectsInvalidRanges: rejectsUsedAboveTotal && rejectsNegativeTotal,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} catch (error) {
  console.error(String(error instanceof Error ? error.stack || error.message : error).replaceAll(databasePassword, "[redacted]"));
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.end();
    } catch {}
  }
  spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
}

function readMigration(fileName) {
  return fs.readFileSync(path.join(process.cwd(), "db", "migrations", fileName), "utf8");
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "ownminutes", "-d", "ownminutes"], {
      encoding: "utf8",
    });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("Isolated PostgreSQL did not become ready.");
}

async function connectWithRetry(Client, connectionString) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = new Client({ connectionString });
    try {
      await candidate.connect();
      return candidate;
    } catch (error) {
      try {
        await candidate.end();
      } catch {}
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Unable to connect to isolated PostgreSQL.");
}

async function rejectsCheckViolation(sql) {
  try {
    await client.query(sql);
    return false;
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "23514";
  }
}

function run(executable, args, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: capture ? "pipe" : "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(detail || `${executable} exited ${result.status}`);
  }
  return result.stdout || "";
}
