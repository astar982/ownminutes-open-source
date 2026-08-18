#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const migrationsDir = path.join(process.cwd(), "db", "migrations");
const dryRun = process.env.OWNMINUTES_DB_MIGRATION_DRY_RUN === "1" || process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const ownerRole = optionalRoleName(process.env.OWNMINUTES_DATABASE_MIGRATION_ROLE || "");
const appRole = optionalRoleName(process.env.OWNMINUTES_DATABASE_APP_ROLE || "");
const migrationLockKey = [1836021357, 1835627634];
const reviewedDestructiveMigrationChecksums = new Map([
  ["0031_meeting_catalog_purge", "fa0724abd54055673a87959924a2e37f2b950521393396df1c4c93e07b1c79cc"],
  ["0032_meeting_transfer_intents", "1330343e8eba103945f28d7daab897732a0459a0c03bb40ed88b3d792c8cdc35"],
]);

async function main() {
  const migrations = listMigrations();
  const safety = validateMigrations(migrations);
  const safetySummary = buildMigrationSafetySummary(migrations, safety);

  if (dryRun) {
    const summary = {
      dryRun: true,
      migrationCount: migrations.length,
      migrations: migrations.map((migration) => migration.version),
      ...safetySummary,
      wouldConnect: Boolean(databaseUrl),
    };
    console.log(JSON.stringify(summary, null, 2));

    if (!migrationSafetyReady(summary)) process.exitCode = 1;
    return;
  }

  if (!migrationSafetyReady(safetySummary)) {
    throw new Error(
      `Migration safety policy failed before database connection: ${JSON.stringify({
        duplicateVersions: safetySummary.duplicateVersions,
        orderViolations: safetySummary.orderViolations,
        missingSelfRecords: safetySummary.missingSelfRecords,
        unapprovedDestructiveMatches: safetySummary.unapprovedDestructiveMatches,
        hasInitialMigration: safetySummary.hasInitialMigration,
        hasChecksums: safetySummary.hasChecksums,
        leaksSecrets: safetySummary.leaksSecrets,
      })}`,
    );
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required unless --dry-run is used.");
  }

  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const applied = [];
  const skipped = [];
  let lockAcquired = false;

  try {
    await client.query("select pg_advisory_lock($1, $2)", migrationLockKey);
    lockAcquired = true;
    const session = await client.query(
      "select rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = current_user",
    );
    if (
      ownerRole &&
      (session.rows[0]?.rolsuper ||
        session.rows[0]?.rolcreatedb ||
        session.rows[0]?.rolcreaterole ||
        session.rows[0]?.rolreplication ||
        session.rows[0]?.rolbypassrls)
    ) {
      throw new Error("The configured PostgreSQL migrator must not hold elevated cluster privileges.");
    }

    await client.query("begin");
    if (ownerRole) await client.query(`set local role ${identifier(ownerRole)}`);
    await client.query(
      "create table if not exists ownminutes_schema_migrations (version text primary key, applied_at timestamptz not null default now(), checksum text)",
    );
    await client.query("alter table ownminutes_schema_migrations add column if not exists checksum text");

    for (const migration of migrations) {
      const existing = await client.query(
        "select version, checksum from ownminutes_schema_migrations where version = $1",
        [migration.version],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        const storedChecksum = String(existing.rows[0]?.checksum || "");
        if (storedChecksum && storedChecksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch for ${migration.version}. Refusing to run modified migration history.`);
        }
        if (!storedChecksum) {
          await client.query(
            "update ownminutes_schema_migrations set checksum = $2 where version = $1 and checksum is null",
            [migration.version, migration.checksum],
          );
        }
        skipped.push(migration.version);
        continue;
      }

      await client.query(migration.sql);
      await client.query("insert into ownminutes_schema_migrations (version) values ($1) on conflict (version) do nothing", [migration.version]);
      await client.query("update ownminutes_schema_migrations set checksum = $2 where version = $1", [
        migration.version,
        migration.checksum,
      ]);
      applied.push(migration.version);
    }

    if (appRole) await grantRuntimePrivileges(client, appRole, ownerRole);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    if (lockAcquired) {
      await client.query("select pg_advisory_unlock($1, $2)", migrationLockKey).catch(() => {});
    }
    await client.end();
  }

  console.log(
    JSON.stringify(
      {
        dryRun: false,
        applied,
        skipped,
        checksumEnforced: true,
        migrationLock: "postgres-advisory",
        migrationCount: migrations.length,
        destructiveSqlReviewed: safetySummary.destructiveSqlReviewed,
        approvedDestructiveMigrations: safetySummary.approvedDestructiveMigrations,
      },
      null,
      2,
    ),
  );
}

function buildMigrationSafetySummary(migrations, safety) {
  return {
    hasInitialMigration: migrations.some((migration) => migration.version === "0001_initial"),
    hasUniqueVersions: safety.duplicateVersions.length === 0,
    hasMonotonicOrder: safety.orderViolations.length === 0,
    eachMigrationRecordsItself: safety.missingSelfRecords.length === 0,
    destructiveSqlFree: safety.destructiveMatches.length === 0,
    destructiveSqlReviewed: safety.unapprovedDestructiveMatches.length === 0,
    approvedDestructiveMigrations: safety.approvedDestructiveMigrations,
    duplicateVersions: safety.duplicateVersions,
    orderViolations: safety.orderViolations,
    missingSelfRecords: safety.missingSelfRecords,
    destructiveMatches: safety.destructiveMatches,
    unapprovedDestructiveMatches: safety.unapprovedDestructiveMatches,
    hasChecksums: migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum)),
    leaksSecrets: leaksSecrets(JSON.stringify(migrations)),
  };
}

function migrationSafetyReady(summary) {
  return (
    summary.hasInitialMigration &&
    summary.hasUniqueVersions &&
    summary.hasMonotonicOrder &&
    summary.eachMigrationRecordsItself &&
    summary.destructiveSqlReviewed &&
    summary.hasChecksums &&
    !summary.leaksSecrets
  );
}

function listMigrations() {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error("Missing db/migrations directory.");
  }

  return fs
    .readdirSync(migrationsDir)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort()
    .map((fileName) => {
      const filePath = path.join(migrationsDir, fileName);
      return {
        fileName,
        version: fileName.replace(/\.sql$/, ""),
        sql: fs.readFileSync(filePath, "utf8"),
      };
    })
    .map((migration) => ({
      ...migration,
      checksum: crypto.createHash("sha256").update(migration.sql).digest("hex"),
    }));
}

async function grantRuntimePrivileges(client, runtimeRole, migrationOwnerRole) {
  const runtime = identifier(runtimeRole);
  await client.query("revoke create on schema public from public");
  await client.query(`grant usage on schema public to ${runtime}`);
  await client.query(`revoke all on all tables in schema public from public`);
  await client.query(`revoke all on all sequences in schema public from public`);
  await client.query(`grant select, insert, update, delete on all tables in schema public to ${runtime}`);
  await client.query(`grant usage, select, update on all sequences in schema public to ${runtime}`);
  await client.query(`grant execute on all functions in schema public to ${runtime}`);
  if (migrationOwnerRole) {
    const owner = identifier(migrationOwnerRole);
    await client.query(`alter default privileges for role ${owner} in schema public revoke all on tables from public`);
    await client.query(`alter default privileges for role ${owner} in schema public revoke all on sequences from public`);
    await client.query(`alter default privileges for role ${owner} in schema public revoke execute on functions from public`);
    await client.query(
      `alter default privileges for role ${owner} in schema public grant select, insert, update, delete on tables to ${runtime}`,
    );
    await client.query(
      `alter default privileges for role ${owner} in schema public grant usage, select, update on sequences to ${runtime}`,
    );
    await client.query(`alter default privileges for role ${owner} in schema public grant execute on functions to ${runtime}`);
  }
}

function validateMigrations(migrations) {
  const seen = new Set();
  const duplicateVersions = [];
  const orderViolations = [];
  const missingSelfRecords = [];
  const destructiveMatches = [];
  const unapprovedDestructiveMatches = [];
  const approvedDestructiveMigrations = [];
  const destructivePatterns = [
    /\bdrop\s+table\b/i,
    /\bdrop\s+schema\b/i,
    /\btruncate\b/i,
    /\bdelete\s+from\b/i,
    /\balter\s+table\b[\s\S]{0,120}\bdrop\b/i,
  ];

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (seen.has(migration.version)) duplicateVersions.push(migration.version);
    seen.add(migration.version);

    if (index > 0 && migrations[index - 1].version.localeCompare(migration.version) >= 0) {
      orderViolations.push(`${migrations[index - 1].version} >= ${migration.version}`);
    }

    if (!migration.sql.includes(`values ('${migration.version}')`) && !migration.sql.includes(`values (\\'${migration.version}\\')`)) {
      missingSelfRecords.push(migration.version);
    }

    const normalizedSql = stripSqlComments(migration.sql);
    const destructiveScanSql = normalizedSql.replace(
      /\balter\s+table\s+[a-zA-Z0-9_."]+\s+alter\s+column\s+[a-zA-Z0-9_"]+\s+drop\s+not\s+null\s*;?/gi,
      "",
    );
    let migrationHasDestructiveSql = false;
    for (const pattern of destructivePatterns) {
      const match = destructiveScanSql.match(pattern);
      if (match) {
        migrationHasDestructiveSql = true;
        const finding = `${migration.fileName}: ${match[0].replace(/\s+/g, " ").trim()}`;
        destructiveMatches.push(finding);
        if (reviewedDestructiveMigrationChecksums.get(migration.version) !== migration.checksum) {
          unapprovedDestructiveMatches.push(finding);
        }
      }
    }
    if (
      migrationHasDestructiveSql &&
      reviewedDestructiveMigrationChecksums.get(migration.version) === migration.checksum
    ) {
      approvedDestructiveMigrations.push({
        version: migration.version,
        checksum: migration.checksum,
      });
    }
  }

  return {
    approvedDestructiveMigrations,
    destructiveMatches,
    duplicateVersions,
    missingSelfRecords,
    orderViolations,
    unapprovedDestructiveMatches,
  };
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function leaksSecrets(text) {
  return text.includes("postgres://") || text.includes("postgresql://") || text.includes("DATABASE_URL=") || text.includes("AKL") || text.includes("sk-proj");
}

function optionalRoleName(value) {
  if (!value) return "";
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(value)) {
    throw new Error("PostgreSQL role names must use lowercase letters, numbers, and underscores.");
  }
  return value;
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
