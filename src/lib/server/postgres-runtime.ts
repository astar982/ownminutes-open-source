import { createRequire } from "module";
import crypto from "node:crypto";
import os from "node:os";

export type PgResult<T> = { rowCount: number | null; rows: T[] };
export type PgClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgResult<T>>;
  release(): void;
};
export type PgPool = {
  connect(): Promise<PgClient>;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgResult<T>>;
};

type RuntimePool = {
  connectionString: string;
  pool: PgPool;
};

const require = createRequire(import.meta.url);
const poolKey = Symbol.for("ownminutes.postgres-runtime-pool");
const POSTGRES_APPLICATION_NAME_MAX_BYTES = 63;
const globalPool = globalThis as typeof globalThis & { [poolKey]?: RuntimePool };

export function getPostgresRuntimePool(requirement = "PostgreSQL runtime"): PgPool {
  const connectionString = getPostgresDatabaseUrl();
  if (!connectionString) throw new Error(`${requirement} requires DATABASE_URL or POSTGRES_URL.`);

  const existing = globalPool[poolKey];
  if (existing?.connectionString === connectionString) return existing.pool;

  const { Pool } = require("pg") as {
    Pool: new (config: {
      application_name: string;
      connectionString: string;
      connectionTimeoutMillis: number;
      idleTimeoutMillis: number;
      max: number;
    }) => PgPool;
  };
  const pool = new Pool({
    application_name: getPostgresApplicationName(),
    connectionString,
    max: getBoundedInteger("OWNMINUTES_POSTGRES_POOL_MAX", 10, 1, 50),
    connectionTimeoutMillis: getBoundedInteger("OWNMINUTES_POSTGRES_CONNECT_TIMEOUT_MS", 10_000, 1_000, 60_000),
    idleTimeoutMillis: getBoundedInteger("OWNMINUTES_POSTGRES_IDLE_TIMEOUT_MS", 30_000, 1_000, 10 * 60_000),
  });
  globalPool[poolKey] = { connectionString, pool };
  return pool;
}

export function getPostgresApplicationName() {
  const role = process.env.OWNMINUTES_FINALIZATION_WORKER === "1"
    ? "ownminutes-finalization-worker"
    : "ownminutes-app";
  return compactPostgresApplicationName(`${role}:${getRuntimeInstanceId()}`);
}

export function getRuntimeInstanceId() {
  const normalized = (process.env.OWNMINUTES_INSTANCE_ID || os.hostname() || "local")
    .replace(/[^a-zA-Z0-9._-]/g, "-");
  if (normalized.length <= 48) return normalized;
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 35)}-${digest}`;
}

export function compactPostgresApplicationName(value: string) {
  if (Buffer.byteLength(value, "utf8") <= POSTGRES_APPLICATION_NAME_MAX_BYTES) {
    return value;
  }
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
  const suffix = `-${digest}`;
  const prefixBytes = POSTGRES_APPLICATION_NAME_MAX_BYTES - suffix.length;
  return `${Buffer.from(value, "utf8").subarray(0, prefixBytes).toString("utf8")}${suffix}`;
}

export function getPostgresDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

function getBoundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
