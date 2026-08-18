import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { probeMeetingObjectStoreReadiness } from "@/lib/server/meeting-object-store";
import {
  meetingStorageIntegrityAuditVersion,
  meetingStorageIntegrityMaxAgeMs,
  meetingStorageWriterInvariantVersion,
} from "@/lib/server/meeting-catalog";
import { getFinalizationQueueInfo } from "@/lib/server/finalization-queue";
import { getPostgresDatabaseUrl, getRuntimeInstanceId } from "@/lib/server/postgres-runtime";
import {
  getSecretAuditInfo,
  type SecretAuditOutboxInfo,
} from "@/lib/server/secret-audit";
import { getSecretAuditOutboxInfo } from "@/lib/server/auth-repository";

export type RuntimeReadinessCheck = {
  id: "database" | "deletion-cleanup" | "object-store" | "queue-worker" | "secret-audit";
  blocksTraffic?: boolean;
  ok: boolean;
  detail: string;
  metrics?: Record<string, number | string | boolean | null>;
};

export type RuntimeReadinessReport = {
  ok: boolean;
  releaseReady: boolean;
  service: "ownminutes";
  status: "ready" | "not_ready";
  generatedAt: string;
  checks: RuntimeReadinessCheck[];
};

export type QueueWorkerReadinessFixture = {
  currentRuntimeRole: "app" | "worker";
  currentRuntimeWorkerEnabled: boolean;
  expectedWorkers: number;
  expiredLeases: number;
  freshnessMs: number;
  mode: "inline" | "postgres-queue";
  stalledRunnable: number;
  workerCount: number;
};

export type DeletionCleanupReadinessFixture = {
  deadLettered: number;
  expiredClaims: number;
  integrityFresh: boolean;
  oldestPendingAgeMs: number;
  overdueRunnable: number;
  pending: number;
  unattributedPrefixCount: number;
  writerInvariantCurrent: boolean;
};

type ReadinessPgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
};

const require = createRequire(import.meta.url);
const READINESS_CACHE_TTL_MS = 5_000;

let cachedReadiness:
  | {
      expiresAt: number;
      report: RuntimeReadinessReport;
    }
  | undefined;
let readinessInFlight: Promise<RuntimeReadinessReport> | undefined;

export async function getRuntimeReadinessReport(): Promise<RuntimeReadinessReport> {
  const now = Date.now();
  if (cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness.report;
  }
  if (readinessInFlight) return readinessInFlight;

  const probe = collectRuntimeReadinessReport()
    .catch(() => createUnexpectedReadinessFailureReport())
    .then((report) => {
      cachedReadiness = {
        expiresAt: Date.now() + READINESS_CACHE_TTL_MS,
        report,
      };
      return report;
    })
    .finally(() => {
      if (readinessInFlight === probe) readinessInFlight = undefined;
    });
  readinessInFlight = probe;
  return probe;
}

async function collectRuntimeReadinessReport(): Promise<RuntimeReadinessReport> {
  const [postgresChecks, objectStore, secretAuditOutbox] = await Promise.all([
    probePostgresReadiness(),
    probeMeetingObjectStoreReadiness(),
    probeSecretAuditOutboxReadiness(),
  ]);
  const auditInfo = getSecretAuditInfo();
  const secretAuditOk =
    auditInfo.sinkReady &&
    secretAuditOutbox.ok &&
    !(auditInfo.lastWriteOk === false && secretAuditOutbox.info.pendingCount > 0) &&
    (process.env.NODE_ENV !== "production" || auditInfo.managedPathConfigured);
  const checks: RuntimeReadinessCheck[] = [
    ...postgresChecks,
    {
      id: "object-store",
      ok: objectStore.ok,
      detail: objectStore.detail,
      metrics: {
        durable: objectStore.durable,
        provider: objectStore.provider,
      },
    },
    {
      id: "secret-audit",
      ok: secretAuditOk,
      detail: secretAuditOk
        ? "密钥审计 sink 与 durable outbox 均已就绪。"
        : !auditInfo.sinkReady
          ? `密钥审计 sink 未就绪（${auditInfo.sinkStatus}；legacyMigration=${auditInfo.legacyMigrationStatus}）。`
          : secretAuditOutbox.detail,
      metrics: {
        managedPathConfigured: auditInfo.managedPathConfigured,
        externalRotationConfigured: auditInfo.externalRotationConfigured,
        expiredLeaseCount: secretAuditOutbox.info.expiredLeaseCount,
        lastWriteOk: auditInfo.lastWriteOk,
        legacyMigrationReady: auditInfo.legacyMigrationReady,
        legacyMigrationStatus: auditInfo.legacyMigrationStatus,
        oldestPendingAgeMs: secretAuditOutbox.info.oldestPendingAgeMs,
        overduePendingCount: secretAuditOutbox.info.overduePendingCount,
        pendingCount: secretAuditOutbox.info.pendingCount,
        provider: secretAuditOutbox.info.provider,
        sinkReady: auditInfo.sinkReady,
      },
    },
  ];
  // Account deletion backlog is a release/operations blocker, but one user's
  // cleanup incident must not make Caddy remove every healthy Web replica.
  const { ok, releaseReady } = evaluateRuntimeReadinessChecks(checks);
  return {
    ok,
    releaseReady,
    service: "ownminutes",
    status: ok ? "ready" : "not_ready",
    generatedAt: new Date().toISOString(),
    checks,
  };
}

export function evaluateRuntimeReadinessChecks(
  checks: RuntimeReadinessCheck[],
): Pick<RuntimeReadinessReport, "ok" | "releaseReady"> {
  return {
    ok: checks.every((check) => check.ok || check.blocksTraffic === false),
    releaseReady: checks.every((check) => check.ok),
  };
}

async function probeSecretAuditOutboxReadiness() {
  try {
    const info = await getSecretAuditOutboxInfo();
    return evaluateSecretAuditOutboxReadiness(info);
  } catch {
    return {
      detail: "密钥审计 durable outbox 不可用或 schema 尚未应用。",
      info: {
        claimableCount: 0,
        expiredLeaseCount: 0,
        oldestPendingAgeMs: 0,
        oldestPendingAt: null,
        overduePendingCount: 0,
        pendingCount: 0,
        provider:
          process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres"
            ? "postgres" as const
            : "local-file" as const,
      },
      ok: false,
    };
  }
}

export function evaluateSecretAuditOutboxReadiness(
  info: SecretAuditOutboxInfo,
) {
  const ok =
    info.pendingCount === 0 &&
    info.expiredLeaseCount === 0 &&
    info.overduePendingCount === 0;
  return {
    detail: ok
      ? "密钥审计 durable outbox 没有待投递、过期 lease 或超时积压。"
      : `密钥审计 outbox 未就绪：待投递 ${info.pendingCount}，过期 lease ${info.expiredLeaseCount}，超时积压 ${info.overduePendingCount}。`,
    info,
    ok,
  };
}

function createUnexpectedReadinessFailureReport(): RuntimeReadinessReport {
  return {
    ok: false,
    releaseReady: false,
    service: "ownminutes",
    status: "not_ready",
    generatedAt: new Date().toISOString(),
    checks: [
      {
        id: "database",
        ok: false,
        detail: "运行时就绪探针发生内部错误。",
      },
      {
        id: "queue-worker",
        ok: false,
        detail: "运行时就绪探针发生内部错误。",
      },
      {
        id: "deletion-cleanup",
        blocksTraffic: false,
        ok: false,
        detail: "运行时就绪探针发生内部错误。",
      },
      {
        id: "object-store",
        ok: false,
        detail: "运行时就绪探针发生内部错误。",
      },
      {
        id: "secret-audit",
        ok: false,
        detail: "运行时就绪探针发生内部错误。",
      },
    ],
  };
}

async function probePostgresReadiness(): Promise<RuntimeReadinessCheck[]> {
  const queueInfo = getFinalizationQueueInfo();
  const databaseUrl = getPostgresDatabaseUrl();
  if (!databaseUrl) {
    const localDevelopment =
      process.env.NODE_ENV !== "production" &&
      process.env.OWNMINUTES_AUTH_REPOSITORY !== "postgres" &&
      queueInfo.mode === "inline";
    return [
      {
        id: "database",
        ok: localDevelopment,
        detail: localDevelopment
          ? "本地开发使用文件 repository；生产数据库门禁未启用。"
          : "缺少 PostgreSQL 连接，无法验证生产 schema。",
        metrics: { provider: "local" },
      },
      {
        id: "queue-worker",
        ok: queueInfo.mode === "inline" && localDevelopment,
        detail: queueInfo.mode === "inline"
          ? "本地开发使用 inline finalization。"
          : "PostgreSQL 队列模式缺少数据库连接。",
        metrics: { mode: queueInfo.mode },
      },
      {
        id: "deletion-cleanup",
        blocksTraffic: false,
        ok: localDevelopment,
        detail: localDevelopment
          ? "本地开发没有 PostgreSQL 账号删除清理队列。"
          : "缺少 PostgreSQL 连接，无法验证账号删除清理队列。",
        metrics: { provider: "local" },
      },
    ];
  }

  const { Client } = require("pg") as {
    Client: new (config: {
      application_name: string;
      connectionString: string;
      connectionTimeoutMillis: number;
    }) => ReadinessPgClient;
  };
  const client = new Client({
    application_name: `ownminutes-readyz:${getRuntimeInstanceId()}`,
    connectionString: databaseUrl,
    connectionTimeoutMillis: 4_000,
  });

  try {
    await client.connect();
    await client.query("select set_config('statement_timeout', '4000', false)");
    const requiredTables = [
      "ownminutes_schema_migrations",
      "users",
      "meetings",
      "meeting_deletion_tombstones",
      "auth_rate_limit_entries",
      "account_deletion_cleanup_jobs",
      "secret_audit_outbox",
      ...(queueInfo.mode === "postgres-queue" ? ["meeting_finalization_jobs"] : []),
    ];
    const tables = await client.query<{ table_name: string; table_ref: string | null }>(
      `select table_name, to_regclass('public.' || table_name)::text as table_ref
       from unnest($1::text[]) as table_name`,
      [requiredTables],
    );
    const missingTables = tables.rows.filter((row) => !row.table_ref).map((row) => row.table_name);
    const expectedMigration = getExpectedMigrationVersion();
    let latestApplied = "";
    if (!missingTables.includes("ownminutes_schema_migrations")) {
      const applied = await client.query<{ version: string }>(
        "select version from ownminutes_schema_migrations order by version desc limit 1",
      );
      latestApplied = applied.rows[0]?.version || "";
    }
    const schemaCurrent = Boolean(expectedMigration) && latestApplied === expectedMigration;
    const databaseOk = missingTables.length === 0 && schemaCurrent;
    const databaseCheck: RuntimeReadinessCheck = {
      id: "database",
      ok: databaseOk,
      detail: databaseOk
        ? `PostgreSQL schema 已应用到 ${expectedMigration}。`
        : missingTables.length
          ? `PostgreSQL 缺少必需表：${missingTables.join(", ")}。`
          : expectedMigration
            ? `PostgreSQL migration 落后：期望 ${expectedMigration}，当前 ${latestApplied || "unknown"}。`
            : "无法确定构建期望的最新 migration。",
      metrics: {
        expectedMigration: expectedMigration || null,
        latestApplied: latestApplied || null,
        missingTableCount: missingTables.length,
      },
    };
    const queueCheck = await probeQueueReadiness(client, queueInfo);
    const deletionCleanupCheck = await probeDeletionCleanupReadiness(client).catch(() => ({
      id: "deletion-cleanup" as const,
      blocksTraffic: false,
      ok: false,
      detail: "账号删除清理诊断不可用或 schema 尚未应用。",
    }));
    return [databaseCheck, queueCheck, deletionCleanupCheck];
  } catch (error) {
    const detail = sanitizeReadinessError(error, "PostgreSQL readiness 探针失败。");
    return [
      {
        id: "database",
        ok: false,
        detail,
      },
      {
        id: "queue-worker",
        ok: false,
        detail: "数据库不可用，无法验证队列和 worker 新鲜度。",
        metrics: { mode: queueInfo.mode },
      },
      {
        id: "deletion-cleanup",
        blocksTraffic: false,
        ok: false,
        detail: "数据库不可用，无法验证账号删除清理积压。",
      },
    ];
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function probeDeletionCleanupReadiness(
  client: ReadinessPgClient,
): Promise<RuntimeReadinessCheck> {
  const staleAgeMs = 5 * 60 * 1_000;
  const rows = await client.query<{
    dead_lettered: number | string;
    expired_claims: number | string;
    oldest_pending_age_ms: number | string | null;
    overdue_runnable: number | string;
    pending: number | string;
  }>(
    `select
       count(*)::int as pending,
       count(*) filter (where job.dead_lettered_at is not null)::int as dead_lettered,
       count(*) filter (
         where job.dead_lettered_at is null and job.status = 'processing'
           and job.claimed_at < now() - ($1::bigint * interval '1 millisecond')
       )::int as expired_claims,
       count(*) filter (
         where job.dead_lettered_at is null and job.status = 'pending'
           and job.available_at < now() - ($1::bigint * interval '1 millisecond')
       )::int as overdue_runnable,
       coalesce(max(extract(epoch from (now() - job.created_at)) * 1000), 0)::bigint as oldest_pending_age_ms
     from account_deletion_cleanup_jobs job
     join users on users.id = job.user_id
     where users.deleted_at is not null`,
    [staleAgeMs],
  );
  const row = rows.rows[0];
  const integrityRows = await client.query<{
    audit_version: number | string;
    completed_at: Date | string;
    unattributed_prefix_count: number | string;
    writer_invariant_version: number | string;
  }>(
    `select audit_version, writer_invariant_version,
            unattributed_prefix_count, completed_at
     from meeting_storage_integrity_state
     where integrity_key = 'meeting-storage-integrity'`,
  );
  const integrity = integrityRows.rows[0];
  const integrityCompletedAt = integrity?.completed_at
    ? new Date(integrity.completed_at).getTime()
    : 0;
  return evaluateDeletionCleanupReadiness({
    deadLettered: Number(row?.dead_lettered || 0),
    expiredClaims: Number(row?.expired_claims || 0),
    integrityFresh:
      integrityCompletedAt > 0 && Date.now() - integrityCompletedAt <= meetingStorageIntegrityMaxAgeMs,
    oldestPendingAgeMs: Number(row?.oldest_pending_age_ms || 0),
    overdueRunnable: Number(row?.overdue_runnable || 0),
    pending: Number(row?.pending || 0),
    unattributedPrefixCount: Number(integrity?.unattributed_prefix_count || 0),
    writerInvariantCurrent:
      Number(integrity?.audit_version || 0) === meetingStorageIntegrityAuditVersion &&
      Number(integrity?.writer_invariant_version || 0) === meetingStorageWriterInvariantVersion,
  });
}

export function evaluateDeletionCleanupReadiness(
  input: DeletionCleanupReadinessFixture,
): RuntimeReadinessCheck {
  const ok =
    input.deadLettered === 0 &&
    input.expiredClaims === 0 &&
    input.overdueRunnable === 0 &&
    input.integrityFresh &&
    input.unattributedPrefixCount === 0 &&
    input.writerInvariantCurrent;
  return {
    id: "deletion-cleanup",
    blocksTraffic: false,
    ok,
    detail: ok
      ? `账号删除清理队列正常；当前待处理 ${input.pending}。`
      : `账号删除清理未就绪：dead-letter ${input.deadLettered}，过期 claim ${input.expiredClaims}，超时可运行任务 ${input.overdueRunnable}，未归属前缀 ${input.unattributedPrefixCount}，归属审计新鲜=${input.integrityFresh}。`,
    metrics: {
      deadLettered: input.deadLettered,
      expiredClaims: input.expiredClaims,
      integrityFresh: input.integrityFresh,
      oldestPendingAgeMs: input.oldestPendingAgeMs,
      overdueRunnable: input.overdueRunnable,
      pending: input.pending,
      unattributedPrefixCount: input.unattributedPrefixCount,
      writerInvariantCurrent: input.writerInvariantCurrent,
    },
  };
}

async function probeQueueReadiness(
  client: ReadinessPgClient,
  queueInfo: ReturnType<typeof getFinalizationQueueInfo>,
): Promise<RuntimeReadinessCheck> {
  if (queueInfo.mode === "inline") {
    const allowed = process.env.NODE_ENV !== "production";
    return {
      id: "queue-worker",
      ok: allowed,
      detail: allowed
        ? "本地开发使用 inline finalization。"
        : "生产环境必须使用 PostgreSQL finalization queue。",
      metrics: { mode: queueInfo.mode },
    };
  }

  const expectedWorkers = boundedInteger("OWNMINUTES_FINALIZATION_WORKER_INSTANCES", 1, 1, 64);
  const freshnessMs = Math.max(15_000, queueInfo.pollMs * 5);
  const stalledAgeMs = Math.max(60_000, queueInfo.pollMs * 30);
  const workerRows = await client.query<{ worker_count: number | string }>(
    `select count(distinct application_name)::int as worker_count
     from pg_stat_activity
     where application_name like 'ownminutes-finalization-worker:%'
       and pid <> pg_backend_pid()
       and state_change >= now() - ($1::bigint * interval '1 millisecond')`,
    [freshnessMs],
  );
  const jobs = await client.query<{
    expired_leases: number | string;
    stalled_runnable: number | string;
  }>(
    `select
       count(*) filter (
         where status = 'processing' and lease_expires_at is not null and lease_expires_at < now()
       )::int as expired_leases,
       count(*) filter (
         where status in ('queued', 'retry_wait')
           and available_at < now() - ($1::bigint * interval '1 millisecond')
       )::int as stalled_runnable
     from meeting_finalization_jobs`,
    [stalledAgeMs],
  );
  const workerCount = Number(workerRows.rows[0]?.worker_count || 0);
  const expiredLeases = Number(jobs.rows[0]?.expired_leases || 0);
  const stalledRunnable = Number(jobs.rows[0]?.stalled_runnable || 0);
  return evaluateQueueWorkerReadiness({
    currentRuntimeRole: queueInfo.workerEnabled ? "worker" : "app",
    currentRuntimeWorkerEnabled: queueInfo.workerEnabled,
    expectedWorkers,
    expiredLeases,
    freshnessMs,
    mode: queueInfo.mode,
    stalledRunnable,
    workerCount,
  });
}

export function evaluateQueueWorkerReadiness(
  input: QueueWorkerReadinessFixture,
): RuntimeReadinessCheck {
  // The public app deliberately runs with OWNMINUTES_FINALIZATION_WORKER=0.
  // Cluster readiness depends on fresh external workers; only a worker
  // container's own self-check requires its local worker flag.
  const currentRuntimeReady =
    input.currentRuntimeRole !== "worker" || input.currentRuntimeWorkerEnabled;
  const ok =
    input.mode === "postgres-queue" &&
    currentRuntimeReady &&
    input.workerCount >= input.expectedWorkers &&
    input.expiredLeases === 0 &&
    input.stalledRunnable === 0;

  return {
    id: "queue-worker",
    ok,
    detail: ok
      ? `检测到 ${input.workerCount}/${input.expectedWorkers} 个新鲜 worker，且没有过期 lease 或长期滞留任务。`
      : !currentRuntimeReady
        ? "当前 worker 容器没有启用 finalization worker。"
        : `队列未就绪：worker ${input.workerCount}/${input.expectedWorkers}，过期 lease ${input.expiredLeases}，长期滞留任务 ${input.stalledRunnable}。`,
    metrics: {
      currentRuntimeRole: input.currentRuntimeRole,
      currentRuntimeWorkerEnabled: input.currentRuntimeWorkerEnabled,
      expiredLeases: input.expiredLeases,
      expectedWorkers: input.expectedWorkers,
      freshnessMs: input.freshnessMs,
      mode: input.mode,
      stalledRunnable: input.stalledRunnable,
      workerCount: input.workerCount,
    },
  };
}

function getExpectedMigrationVersion() {
  const configured = process.env.OWNMINUTES_EXPECTED_DB_MIGRATION?.trim();
  if (configured) return configured;
  try {
    return fs
      .readdirSync(path.join(process.cwd(), "db", "migrations"))
      .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
      .sort()
      .at(-1)
      ?.replace(/\.sql$/, "") || "";
  } catch {
    return "";
  }
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.round(value)))
    : fallback;
}

function sanitizeReadinessError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  return error.message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://[redacted]")
    .replace(/(?:password|token|secret|credential)=[^\s&]+/gi, "$1=[redacted]")
    .slice(0, 240) || fallback;
}
