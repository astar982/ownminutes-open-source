import fs from "fs";
import path from "path";
import { getAuthRepositoryInfo, type AuthRepositoryProvider } from "@/lib/server/auth-repository";
import { getMeetingWriteCoordinatorInfo } from "@/lib/server/meeting-write-lock";

export type DatabaseProvider = "local-file" | "postgres";
export type DatabaseCheckStatus = "pass" | "fail" | "manual";

export type DatabaseDiagnosticCheck = {
  id: string;
  title: string;
  status: DatabaseCheckStatus;
  detail: string;
};

export type DatabaseDiagnostics = {
  generatedAt: string;
  provider: DatabaseProvider;
  productionReady: boolean;
  localStorePath: string;
  configured: {
    authRepository: AuthRepositoryProvider;
    databaseUrl: boolean;
    migrationFiles: boolean;
    migrationRunner: boolean;
    migrationRunbook: boolean;
    migrationCommand: boolean;
    backupPolicy: boolean;
    restoreDrill: boolean;
    minimumPrivilegeRole: boolean;
    auditLog: boolean;
    sslRequired: boolean;
    localStoreDecision: boolean;
    crossInstanceMeetingWrites: boolean;
    durableMeetingDeletionFence: boolean;
  };
  capabilities: {
    storesAccounts: boolean;
    supportsMultiTenantQueries: boolean;
    supportsManagedBackups: boolean;
    supportsRestoreDrillEvidence: boolean;
    enforcesEncryptedTransport: boolean;
    supportsMigrationFiles: boolean;
    supportsMigrationRunner: boolean;
    supportsMigrationTracking: boolean;
    supportsPostgresRuntimeWrites: boolean;
    usesLocalFilesystem: boolean;
    supportsCrossInstanceMeetingWrites: boolean;
    supportsDurableMeetingDeletionFence: boolean;
  };
  missing: string[];
  checks: DatabaseDiagnosticCheck[];
  notes: string[];
};

const localStorePath = path.join(process.cwd(), ".data", "auth", "store.json");
const migrationsDir = path.join(process.cwd(), "db", "migrations");
const migrationRunnerPath = path.join(process.cwd(), "scripts", "run-postgres-migrations.mjs");
const migrationRunbookPath = path.join(process.cwd(), "docs", "postgres-migration-runbook.md");

export function getDatabaseDiagnostics(): DatabaseDiagnostics {
  const databaseUrl = getEnv("DATABASE_URL", "POSTGRES_URL");
  const provider: DatabaseProvider = databaseUrl ? "postgres" : "local-file";
  const isPostgres = provider === "postgres";
  const localStoreExists = fs.existsSync(localStorePath);
  const migrationFiles = hasMigrationFiles();
  const migrationRunner = fs.existsSync(migrationRunnerPath);
  const migrationRunbook = fs.existsSync(migrationRunbookPath);
  const migrationCommand = hasEnv("OWNMINUTES_DB_MIGRATION_COMMAND");
  const backupPolicy = hasEnv("OWNMINUTES_DB_BACKUP_POLICY");
  const restoreDrill = hasEnv("OWNMINUTES_DB_RESTORE_DRILL");
  const minimumPrivilegeRole = hasEnv("OWNMINUTES_DB_MIN_ROLE");
  const auditLog = hasEnv("OWNMINUTES_DB_AUDIT_LOG");
  const sslRequired = process.env.OWNMINUTES_DB_SSL_REQUIRED === "1";
  const localStoreDecision = hasEnv("OWNMINUTES_DB_LOCAL_STORE_DECISION");
  const authRepository = getAuthRepositoryInfo();
  const meetingWrites = getMeetingWriteCoordinatorInfo();
  const productionReady =
    isPostgres &&
    migrationFiles &&
    migrationRunner &&
    migrationRunbook &&
    migrationCommand &&
    backupPolicy &&
    restoreDrill &&
    minimumPrivilegeRole &&
    auditLog &&
    sslRequired &&
    localStoreDecision &&
    authRepository.provider === "postgres" &&
    authRepository.productionReady &&
    meetingWrites.crossInstance &&
    meetingWrites.durableDeletionFence;
  const missing = getMissingConfig({
    isPostgres,
    migrationFiles,
    migrationRunner,
    migrationRunbook,
    migrationCommand,
    backupPolicy,
    restoreDrill,
    minimumPrivilegeRole,
    auditLog,
    sslRequired,
    localStoreDecision,
    postgresRuntimeWrites: authRepository.provider === "postgres" && authRepository.productionReady,
    crossInstanceMeetingWrites: meetingWrites.crossInstance,
    durableMeetingDeletionFence: meetingWrites.durableDeletionFence,
  });

  return {
    generatedAt: new Date().toISOString(),
    provider,
    productionReady,
    localStorePath: ".data/auth/store.json",
    configured: {
      authRepository: authRepository.provider,
      databaseUrl: Boolean(databaseUrl),
      migrationFiles,
      migrationRunner,
      migrationRunbook,
      migrationCommand,
      backupPolicy,
      restoreDrill,
      minimumPrivilegeRole,
      auditLog,
      sslRequired,
      localStoreDecision,
      crossInstanceMeetingWrites: meetingWrites.crossInstance,
      durableMeetingDeletionFence: meetingWrites.durableDeletionFence,
    },
    capabilities: {
      storesAccounts: authRepository.provider === "postgres" && authRepository.productionReady,
      supportsMultiTenantQueries: isPostgres,
      supportsManagedBackups: isPostgres && backupPolicy,
      supportsRestoreDrillEvidence: isPostgres && restoreDrill,
      enforcesEncryptedTransport: isPostgres && sslRequired,
      supportsMigrationFiles: migrationFiles,
      supportsMigrationRunner: migrationRunner,
      supportsMigrationTracking: isPostgres && migrationFiles && migrationRunner && migrationCommand,
      supportsPostgresRuntimeWrites: authRepository.provider === "postgres" && authRepository.productionReady,
      usesLocalFilesystem: provider === "local-file",
      supportsCrossInstanceMeetingWrites: meetingWrites.crossInstance,
      supportsDurableMeetingDeletionFence: meetingWrites.durableDeletionFence,
    },
    missing,
    checks: [
      {
        id: "database-url",
        title: "生产数据库连接",
        status: isPostgres ? "pass" : "fail",
        detail: isPostgres ? "已检测到 PostgreSQL 连接配置。" : "缺少 DATABASE_URL 或 POSTGRES_URL，当前账号数据仍使用本地 JSON。",
      },
      {
        id: "local-store-visible",
        title: "本地账号文件",
        status: localStoreExists ? "manual" : "pass",
        detail: localStoreExists ? "本地账号 store 已存在，生产迁移前需要导入、清理或隔离。" : "未检测到本地账号 store。",
      },
      {
        id: "migration-files",
        title: "数据库迁移文件",
        status: migrationFiles ? "pass" : "fail",
        detail: migrationFiles ? "已检测到 db/migrations 下的 PostgreSQL 初始 schema。" : "缺少可审查的数据库 schema/migration 文件。",
      },
      {
        id: "migration-runner",
        title: "迁移执行脚本",
        status: migrationRunner ? "pass" : "fail",
        detail: migrationRunner ? "已检测到 scripts/run-postgres-migrations.mjs，可执行 db/migrations。" : "缺少数据库迁移执行脚本。",
      },
      {
        id: "migration-runbook",
        title: "迁移 Runbook",
        status: migrationRunbook ? "pass" : "fail",
        detail: migrationRunbook ? "已检测到 PostgreSQL 迁移 runbook。" : "缺少 PostgreSQL 迁移 runbook。",
      },
      {
        id: "auth-repository-boundary",
        title: "账号运行时边界",
        status: "pass",
        detail:
          authRepository.provider === "postgres"
            ? "运行时已选择 PostgreSQL auth repository，并检测到数据库连接。仍需结合迁移、备份、权限和审计门禁判断生产就绪。"
            : "运行时已通过 auth repository 边界访问账号、会话、Provider 凭据和用量；当前默认仍使用本地文件。",
      },
      {
        id: "meeting-write-coordination",
        title: "跨实例会议写入",
        status: meetingWrites.crossInstance && meetingWrites.durableDeletionFence ? "pass" : "fail",
        detail:
          meetingWrites.crossInstance && meetingWrites.durableDeletionFence
            ? `会议写入使用 ${meetingWrites.mode}，并启用持久删除 tombstone。`
            : "缺少 PostgreSQL 跨实例会议写锁或持久删除 tombstone。",
      },
      {
        id: "migration-command",
        title: "迁移命令",
        status: migrationCommand ? "pass" : "fail",
        detail: migrationCommand ? "已声明数据库 migration 命令。" : "缺少可重复执行的 migration 命令声明。",
      },
      {
        id: "backup-policy",
        title: "备份策略",
        status: backupPolicy ? "manual" : "fail",
        detail: backupPolicy ? "已声明备份策略，仍需部署侧验证恢复演练。" : "缺少备份、恢复和保留周期策略。",
      },
      {
        id: "restore-drill",
        title: "恢复演练",
        status: restoreDrill ? "manual" : "fail",
        detail: restoreDrill ? "已声明备份恢复演练证据，仍需生产侧抽样验证。" : "缺少备份恢复演练证据或计划。",
      },
      {
        id: "minimum-privilege",
        title: "最小权限账号",
        status: minimumPrivilegeRole ? "manual" : "fail",
        detail: minimumPrivilegeRole ? "已声明最小权限数据库角色，仍需生产侧验证。" : "缺少最小权限数据库角色声明。",
      },
      {
        id: "audit-log",
        title: "审计日志",
        status: auditLog ? "manual" : "fail",
        detail: auditLog ? "已声明审计日志策略。" : "缺少账号、用量、Provider 配置变更的审计日志策略。",
      },
      {
        id: "encrypted-transport",
        title: "数据库加密传输",
        status: sslRequired ? "manual" : "fail",
        detail: sslRequired ? "已声明生产数据库连接强制 SSL/TLS。" : "缺少 OWNMINUTES_DB_SSL_REQUIRED=1；生产数据库连接必须强制加密传输。",
      },
      {
        id: "local-store-decision",
        title: "本地账号文件处置",
        status: localStoreDecision ? "manual" : "fail",
        detail: localStoreDecision ? "已声明本地 JSON 账号 store 的导入、隔离或销毁决策。" : "缺少本地账号 JSON store 迁移、隔离或销毁决策。",
      },
    ],
    notes: [
      "诊断只输出配置存在性，不输出 DATABASE_URL 或任何账号数据。",
      "db/migrations/0001_initial.sql 已定义账号、会话、Provider 凭据、用量、会议索引、对象索引和审计事件的初始表结构。",
      "scripts/run-postgres-migrations.mjs 可在配置 DATABASE_URL 或 POSTGRES_URL 后执行迁移；无数据库时可用 OWNMINUTES_DB_MIGRATION_DRY_RUN=1 做 dry-run。",
      ...authRepository.notes,
      "productionReady=true 只表示数据库 runtime、迁移资产、备份、恢复演练、SSL/TLS、最小权限、本地 store 处置和审计声明齐备；仍需要真实 migration、备份恢复和权限演练证据。",
    ],
  };
}

function getMissingConfig(input: {
  isPostgres: boolean;
  migrationFiles: boolean;
  migrationRunner: boolean;
  migrationRunbook: boolean;
  migrationCommand: boolean;
  backupPolicy: boolean;
  restoreDrill: boolean;
  minimumPrivilegeRole: boolean;
  auditLog: boolean;
  sslRequired: boolean;
  localStoreDecision: boolean;
  postgresRuntimeWrites: boolean;
  crossInstanceMeetingWrites: boolean;
  durableMeetingDeletionFence: boolean;
}) {
  const missing: string[] = [];
  if (!input.isPostgres) missing.push("DATABASE_URL or POSTGRES_URL");
  if (!input.migrationFiles) missing.push("db/migrations/*.sql");
  if (!input.migrationRunner) missing.push("scripts/run-postgres-migrations.mjs");
  if (!input.migrationRunbook) missing.push("docs/postgres-migration-runbook.md");
  if (!input.migrationCommand) missing.push("OWNMINUTES_DB_MIGRATION_COMMAND");
  if (!input.backupPolicy) missing.push("OWNMINUTES_DB_BACKUP_POLICY");
  if (!input.restoreDrill) missing.push("OWNMINUTES_DB_RESTORE_DRILL");
  if (!input.minimumPrivilegeRole) missing.push("OWNMINUTES_DB_MIN_ROLE");
  if (!input.auditLog) missing.push("OWNMINUTES_DB_AUDIT_LOG");
  if (!input.sslRequired) missing.push("OWNMINUTES_DB_SSL_REQUIRED=1");
  if (!input.localStoreDecision) missing.push("OWNMINUTES_DB_LOCAL_STORE_DECISION");
  if (!input.postgresRuntimeWrites) missing.push("OWNMINUTES_AUTH_REPOSITORY=postgres runtime writes");
  if (!input.crossInstanceMeetingWrites) missing.push("OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory");
  if (!input.durableMeetingDeletionFence) missing.push("meeting_deletion_tombstones migration/runtime fence");
  return missing;
}

function hasMigrationFiles() {
  if (!fs.existsSync(migrationsDir)) return false;
  return fs.readdirSync(migrationsDir).some((fileName) => /^\d+_.+\.sql$/.test(fileName));
}

function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  return "";
}

function hasEnv(name: string) {
  return Boolean(process.env[name]);
}
