#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const migrationsDir = path.join(repoRoot, "db", "migrations");
const migrationRunnerPath = path.join(repoRoot, "scripts", "run-postgres-migrations.mjs");
const migrationRunbookPath = path.join(repoRoot, "docs", "postgres-migration-runbook.md");
const authRepositoryPath = path.join(repoRoot, "src", "lib", "server", "auth-repository.ts");
const postgresRuntimePath = path.join(repoRoot, "src", "lib", "server", "postgres-runtime.ts");
const meetingWriteLockPath = path.join(repoRoot, "src", "lib", "server", "meeting-write-lock.ts");
const meetingDeletionMigrationPath = path.join(repoRoot, "db", "migrations", "0009_meeting_deletion_tombstones.sql");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const shouldRunDryRun = process.env.OWNMINUTES_DB_PREFLIGHT_SKIP_DRY_RUN !== "1";
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_DB_PREFLIGHT_STRICT === "1";
const evidenceDraftPath = process.env.OWNMINUTES_POSTGRES_EVIDENCE_DRAFT_PATH?.trim() || "";

const requiredEnv = [
  "OWNMINUTES_AUTH_REPOSITORY",
  "OWNMINUTES_DB_MIGRATION_COMMAND",
  "OWNMINUTES_DB_BACKUP_POLICY",
  "OWNMINUTES_DB_RESTORE_DRILL",
  "OWNMINUTES_DB_MIN_ROLE",
  "OWNMINUTES_DB_AUDIT_LOG",
  "OWNMINUTES_DB_SSL_REQUIRED",
  "OWNMINUTES_DB_LOCAL_STORE_DECISION",
  "OWNMINUTES_MEETING_WRITE_LOCK",
];

function main() {
  const migrationFiles = listMigrationFiles();
  const authRepositorySource = fs.existsSync(authRepositoryPath) ? fs.readFileSync(authRepositoryPath, "utf8") : "";
  const postgresRuntimeSource = fs.existsSync(postgresRuntimePath) ? fs.readFileSync(postgresRuntimePath, "utf8") : "";
  const meetingWriteLockSource = fs.existsSync(meetingWriteLockPath) ? fs.readFileSync(meetingWriteLockPath, "utf8") : "";
  const dryRun = shouldRunDryRun ? runMigrationDryRun() : { skipped: true };
  const checks = [
    check("database-url", Boolean(databaseUrl), "DATABASE_URL 或 POSTGRES_URL 已配置。", "缺少 DATABASE_URL 或 POSTGRES_URL。"),
    check(
      "auth-repository-env",
      process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres",
      "OWNMINUTES_AUTH_REPOSITORY=postgres 已配置。",
      "缺少 OWNMINUTES_AUTH_REPOSITORY=postgres；生产仍会使用本地 JSON。",
    ),
    check(
      "migration-command",
      Boolean(process.env.OWNMINUTES_DB_MIGRATION_COMMAND),
      "OWNMINUTES_DB_MIGRATION_COMMAND 已声明。",
      "缺少 OWNMINUTES_DB_MIGRATION_COMMAND。",
    ),
    check(
      "backup-policy",
      Boolean(process.env.OWNMINUTES_DB_BACKUP_POLICY),
      "OWNMINUTES_DB_BACKUP_POLICY 已声明。",
      "缺少 OWNMINUTES_DB_BACKUP_POLICY。",
    ),
    check(
      "restore-drill",
      Boolean(process.env.OWNMINUTES_DB_RESTORE_DRILL),
      "OWNMINUTES_DB_RESTORE_DRILL 已声明。",
      "缺少 OWNMINUTES_DB_RESTORE_DRILL；生产切换前必须有备份恢复演练证据或计划。",
    ),
    check(
      "minimum-privilege-role",
      Boolean(process.env.OWNMINUTES_DB_MIN_ROLE),
      "OWNMINUTES_DB_MIN_ROLE 已声明。",
      "缺少 OWNMINUTES_DB_MIN_ROLE。",
    ),
    check(
      "audit-log",
      Boolean(process.env.OWNMINUTES_DB_AUDIT_LOG),
      "OWNMINUTES_DB_AUDIT_LOG 已声明。",
      "缺少 OWNMINUTES_DB_AUDIT_LOG。",
    ),
    check(
      "ssl-required",
      process.env.OWNMINUTES_DB_SSL_REQUIRED === "1",
      "OWNMINUTES_DB_SSL_REQUIRED=1 已声明。",
      "缺少 OWNMINUTES_DB_SSL_REQUIRED=1；生产数据库连接必须强制 SSL/TLS。",
    ),
    check(
      "local-store-decision",
      Boolean(process.env.OWNMINUTES_DB_LOCAL_STORE_DECISION),
      "OWNMINUTES_DB_LOCAL_STORE_DECISION 已声明。",
      "缺少 OWNMINUTES_DB_LOCAL_STORE_DECISION；必须声明本地 JSON store 导入、隔离或销毁策略。",
    ),
    check("migration-files", migrationFiles.length > 0, `检测到 ${migrationFiles.length} 个 migration。`, "缺少 db/migrations/*.sql。"),
    check(
      "migration-runner",
      fs.existsSync(migrationRunnerPath),
      "迁移执行脚本存在。",
      "缺少 scripts/run-postgres-migrations.mjs。",
    ),
    check(
      "migration-runbook",
      fs.existsSync(migrationRunbookPath),
      "PostgreSQL migration runbook 存在。",
      "缺少 docs/postgres-migration-runbook.md。",
    ),
    check(
      "runtime-implementation",
      authRepositorySource.includes("const postgresAuthRepository: AuthRepository") &&
        authRepositorySource.includes("getPostgresRuntimePool") &&
        authRepositorySource.includes("postgresTransaction") &&
        postgresRuntimeSource.includes("new Pool") &&
        postgresRuntimeSource.includes('Symbol.for("ownminutes.postgres-runtime-pool")'),
      "PostgreSQL auth repository runtime 已实现。",
      "PostgreSQL auth repository runtime 缺失或不完整。",
    ),
    check(
      "meeting-write-coordination",
      process.env.OWNMINUTES_MEETING_WRITE_LOCK === "postgres-advisory" &&
        meetingWriteLockSource.includes("pg_advisory_lock") &&
        fs.existsSync(meetingDeletionMigrationPath),
      "跨实例会议写锁与 0009 删除 tombstone migration 已配置。",
      "缺少 OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory、advisory lock 实现或 0009 删除 tombstone migration。",
    ),
    check(
      "migration-dry-run",
      dryRun.skipped || dryRun.ok,
      dryRun.skipped ? "migration dry-run 已按环境变量跳过。" : "migration dry-run 通过。",
      dryRun.error || "migration dry-run 未通过。",
    ),
  ];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const summary = {
    ok: missing.length === 0,
    strict,
    provider: databaseUrl ? "postgres" : "local-file",
    productionCandidate: missing.length === 0,
    migrationCount: migrationFiles.length,
    configured: {
      databaseUrl: Boolean(databaseUrl),
      authRepository: process.env.OWNMINUTES_AUTH_REPOSITORY || "local-file",
      migrationCommand: Boolean(process.env.OWNMINUTES_DB_MIGRATION_COMMAND),
      backupPolicy: Boolean(process.env.OWNMINUTES_DB_BACKUP_POLICY),
      restoreDrill: Boolean(process.env.OWNMINUTES_DB_RESTORE_DRILL),
      minimumPrivilegeRole: Boolean(process.env.OWNMINUTES_DB_MIN_ROLE),
      auditLog: Boolean(process.env.OWNMINUTES_DB_AUDIT_LOG),
      sslRequired: process.env.OWNMINUTES_DB_SSL_REQUIRED === "1",
      localStoreDecision: Boolean(process.env.OWNMINUTES_DB_LOCAL_STORE_DECISION),
      meetingWriteLock: process.env.OWNMINUTES_MEETING_WRITE_LOCK || "auto",
    },
    requiredEnv,
    missing,
    checks,
    dryRun,
    nextAction:
      missing.length === 0
        ? "Run real migrations against the managed PostgreSQL database, verify restore drill, SSL/TLS, minimum privilege, local store handling, then execute OWNMINUTES_AUTH_REPOSITORY=postgres smoke tests against the same deployment."
        : "Set the missing production database environment and rerun npm run database:preflight.",
    leaksSecrets: leaksSecrets(JSON.stringify({ checks, missing, dryRun })),
  };

  if (evidenceDraftPath) {
    writeEvidenceDraft(evidenceDraftPath, summary);
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.leaksSecrets || (strict && !summary.ok)) {
    process.exitCode = 1;
  }
}

function check(id, passed, passDetail, failDetail) {
  return {
    id,
    status: passed ? "pass" : "fail",
    detail: passed ? passDetail : failDetail,
  };
}

function listMigrationFiles() {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir).filter((fileName) => /^\d+_.+\.sql$/.test(fileName)).sort();
}

function runMigrationDryRun() {
  const result = spawnSync(process.execPath, [migrationRunnerPath, "--dry-run"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OWNMINUTES_DB_MIGRATION_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      error: `Invalid migration dry-run JSON: ${error.message}`,
    };
  }

  const structured = {
    migrationCount: payload.migrationCount,
    hasInitialMigration: payload.hasInitialMigration,
    hasUniqueVersions: payload.hasUniqueVersions,
    hasMonotonicOrder: payload.hasMonotonicOrder,
    eachMigrationRecordsItself: payload.eachMigrationRecordsItself,
    destructiveSqlFree: payload.destructiveSqlFree,
    destructiveSqlReviewed: payload.destructiveSqlReviewed,
    approvedDestructiveMigrations: payload.approvedDestructiveMigrations,
    unapprovedDestructiveMatches: payload.unapprovedDestructiveMatches,
    leaksSecrets: payload.leaksSecrets,
  };

  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: stripOutput(result.stderr || "migration dry-run rejected by safety policy"),
      ...structured,
    };
  }

  return {
    ok:
      payload.dryRun === true &&
      payload.hasInitialMigration === true &&
      payload.hasUniqueVersions === true &&
      payload.hasMonotonicOrder === true &&
      payload.eachMigrationRecordsItself === true &&
      payload.destructiveSqlReviewed === true &&
      payload.leaksSecrets === false,
    ...structured,
  };
}

function stripOutput(output) {
  return String(output).replace(/postgres(?:ql)?:\/\/\S+/g, "[redacted-postgres-url]").slice(0, 600);
}

function leaksSecrets(text) {
  return (
    text.includes("postgres://") ||
    text.includes("postgresql://") ||
    text.includes("DATABASE_URL=") ||
    text.includes("POSTGRES_URL=") ||
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key")
  );
}

function writeEvidenceDraft(outputPath, summary) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildEvidenceDraft(summary));
}

function buildEvidenceDraft(summary) {
  const checkMap = new Map(summary.checks.map((item) => [item.id, item]));
  const runtimeRepository = process.env.OWNMINUTES_AUTH_REPOSITORY || "local-file";
  const sslRequired = process.env.OWNMINUTES_DB_SSL_REQUIRED === "1" ? "yes" : "pending";
  const migrationVersion = listMigrationFiles().at(-1)?.replace(/\.sql$/, "") || "pending";
  const preflightPass = summary.ok && summary.productionCandidate ? "pass" : "fail";
  const decision = summary.ok && runtimeRepository === "postgres" ? "pending" : "fail";

  return [
    "# PostgreSQL Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run database:preflight`.",
    "Manual runtime, migration, backup, restore, minimum privilege, audit, SSL/TLS, and local JSON store checks must be reviewed before this can pass acceptance.",
    "",
    `Date: ${new Date().toISOString()}`,
    `Commit: ${process.env.OWNMINUTES_DATABASE_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "pending"}`,
    `Database provider: ${databaseUrl ? "postgres" : "pending"}`,
    `Runtime repository: ${runtimeRepository}`,
    `Finalization mode: ${process.env.OWNMINUTES_FINALIZATION_MODE || "pending"}`,
    `Worker instances: ${process.env.OWNMINUTES_FINALIZATION_WORKER_INSTANCES || "pending"}`,
    `Meeting write lock: ${process.env.OWNMINUTES_MEETING_WRITE_LOCK || "pending"}`,
    `Migration command: ${process.env.OWNMINUTES_DB_MIGRATION_COMMAND || "pending"}`,
    `Migration version: ${migrationVersion}`,
    `Backup policy: ${process.env.OWNMINUTES_DB_BACKUP_POLICY ? "configured" : "pending"}`,
    `Restore drill: ${process.env.OWNMINUTES_DB_RESTORE_DRILL ? "configured" : "pending"}`,
    `Minimum privilege role: ${process.env.OWNMINUTES_DB_MIN_ROLE ? "configured" : "pending"}`,
    `Audit log policy: ${process.env.OWNMINUTES_DB_AUDIT_LOG ? "configured" : "pending"}`,
    `SSL/TLS required: ${sslRequired}`,
    `Local JSON store decision: ${process.env.OWNMINUTES_DB_LOCAL_STORE_DECISION ? "configured" : "pending"}`,
    `Database diagnostics: ${summary.ok ? "pass" : "fail"}`,
    `Release readiness databaseBlocked: ${summary.ok && runtimeRepository === "postgres" ? "pending" : "yes"}`,
    "Release readiness finalizationQueueBlocked: yes",
    `Release readiness nextAction: ${summary.nextAction || "pending"}`,
    `Production preflight: ${preflightPass}`,
    `Schema smoke: ${passFail(checkMap.get("migration-files"))}`,
    `Migration dry run: ${summary.dryRun?.ok ? "pass" : "fail"}`,
    "Migration applied: pending",
    "Auth export reviewed: pending",
    "Runtime writes: pending",
    "Register/login: pending",
    "Password reset token: pending",
    "Provider credentials save/delete: pending",
    "Meeting metadata write/read: pending",
    "Usage event write/read: pending",
    "Admin metrics: pending",
    "Account deletion cleanup: pending",
    "Queue migration applied: pending",
    "Queue duplicate enqueue: pending",
    "Queue atomic claim: pending",
    "Queue expired lease reclaim: pending",
    "Queue retry recovery: pending",
    "Queue deletion cancellation: pending",
    "Queue account cleanup: pending",
    "Meeting deletion fence migration: pending",
    "Cross-instance chunk write: pending",
    "Deleted meeting recreation blocked: pending",
    "Backup snapshot: pending",
    "Restore drill proof: pending",
    "Minimum privilege proof: pending",
    "Audit log proof: pending",
    "SSL/TLS proof: pending",
    "Local JSON store handled: pending",
    `Secrets leaked: ${summary.leaksSecrets ? "yes" : "no"}`,
    `Decision: ${decision}`,
    `Known issues: ${summary.missing.length ? `missing ${summary.missing.join(", ")}` : "manual checks still pending"}`,
    "",
  ].join("\n");
}

function passFail(check) {
  if (!check) return "pending";
  return check.status === "pass" ? "pass" : "fail";
}

main();
