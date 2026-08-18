import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type SecretAuditEventType = "provider_secret_delete" | "provider_secret_decrypt_failed" | "provider_secret_rotate" | "provider_secret_save";

export type SecretAuditReason =
  | "account_delete"
  | "provider_auth_switch"
  | "provider_delete"
  | "provider_runtime_decrypt"
  | "provider_save"
  | "provider_update";

export type SecretAuditEventInput = {
  eventType: SecretAuditEventType;
  providerId: string;
  reason: SecretAuditReason;
  secretNames: string[];
  userId: string;
};

export type SecretAuditEvent = {
  createdAt: string;
  eventType: SecretAuditEventType;
  id: string;
  metadata: {
    reason: SecretAuditReason;
  };
  providerRef: string;
  secretRefs: string[];
  userRef: string;
};

export type SecretAuditWriteResult =
  | { eventId: string; ok: true }
  | { errorCode: string; ok: false };

export type SecretAuditOutboxFlushResult = {
  claimed: boolean;
  delivered: boolean;
  errorCode?: string;
  eventId?: string;
};

export type SecretAuditOutboxInfo = {
  claimableCount: number;
  expiredLeaseCount: number;
  oldestPendingAgeMs: number;
  oldestPendingAt: string | null;
  overduePendingCount: number;
  pendingCount: number;
  provider: "local-file" | "postgres";
};

export class SecretAuditUnavailableError extends Error {
  readonly code = "secret_audit_unavailable";

  constructor() {
    super("密钥审计前置检查失败，Provider 凭据操作未执行。");
    this.name = "SecretAuditUnavailableError";
  }
}

type SecretAuditWriteStatus = {
  errorCode: string | null;
  sinkFingerprint: string;
  succeededAt: string | null;
  writeOk: boolean;
};

type ResolvedAuditSink = {
  configured: boolean;
  fingerprint: string;
  path: string;
  valid: boolean;
};

type SecretAuditLegacyMigrationStatus = {
  checkedAt: string | null;
  ready: boolean;
  status: string;
};

type SecretAuditLegacyMigrationCacheEntry = SecretAuditLegacyMigrationStatus & {
  signature: string;
};

const LOCAL_AUDIT_DIR = path.join(process.cwd(), ".data", "auth");
const LOCAL_AUDIT_PATH = path.join(LOCAL_AUDIT_DIR, "secret-audit.jsonl");
const AUDIT_RETENTION_DAYS = 180;
const AUDIT_MAX_EVENTS = 50_000;
const DEFAULT_AUDIT_MAX_BYTES = 256 * 1024 * 1024;
const MAX_AUDIT_EVENT_BYTES = 64 * 1024;
const auditStatusKey = Symbol.for("ownminutes.secret-audit-write-status");
const auditLegacyMigrationCacheKey = Symbol.for(
  "ownminutes.secret-audit-legacy-migration-cache",
);
const globalAuditStatus = globalThis as typeof globalThis & {
  [auditStatusKey]?: SecretAuditWriteStatus;
  [auditLegacyMigrationCacheKey]?: Map<string, SecretAuditLegacyMigrationCacheEntry>;
};

export function createSecretAuditEvent(input: SecretAuditEventInput): SecretAuditEvent {
  const providerId = normalizeAuditReferenceInput(input.providerId, "provider");
  const secretNames = normalizeSecretReferenceInputs(input.secretNames);
  const event: SecretAuditEvent = {
    id: `secret_audit_${crypto.randomBytes(12).toString("base64url")}`,
    eventType: input.eventType,
    userRef: secretAuditUserRef(input.userId),
    providerRef: secretAuditProviderRef(providerId),
    secretRefs: secretNames.map((secretName) =>
      secretAuditSecretRef(providerId, secretName)
    ),
    metadata: { reason: input.reason },
    createdAt: new Date().toISOString(),
  };
  assertSecretAuditOutboxPayloadSafe(event);
  return event;
}

export function deliverSecretAuditEvent(event: SecretAuditEvent): SecretAuditWriteResult {
  const sink = resolveAuditSink();
  try {
    assertSecretAuditOutboxPayloadSafe(event);
    if (!sink.valid) throw auditWriteError("invalid_audit_sink_path");
    if (sink.configured) {
      assertPersistentSinkParent(sink.path);
      assertAppendableAuditTarget(sink.path, getAuditMaxBytes());
    } else {
      fs.mkdirSync(LOCAL_AUDIT_DIR, { recursive: true, mode: 0o700 });
    }
    const legacyMigration = ensureLegacyAuditLogsCanonical(sink);
    if (!legacyMigration.ready) {
      throw auditWriteError(legacyMigration.status);
    }
    if (
      process.env.NODE_ENV === "test" &&
      process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY === "1"
    ) {
      throw auditWriteError("secret_audit_test_delivery_failure");
    }
    runLockedAuditFileOperation({
      action: "append",
      filePath: sink.path,
      input: `${JSON.stringify(event)}\n`,
      localMaintenance: !sink.configured,
      maxBytes: getAuditMaxBytes(),
    });
    globalAuditStatus[auditStatusKey] = {
      errorCode: null,
      sinkFingerprint: sink.fingerprint,
      succeededAt: event.createdAt,
      writeOk: true,
    };
    return { ok: true as const, eventId: event.id };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    globalAuditStatus[auditStatusKey] = {
      errorCode,
      sinkFingerprint: sink.fingerprint,
      succeededAt: null,
      writeOk: false,
    };
    console.error("Secret audit write failed.", {
      code: errorCode,
      eventId: event.id,
      eventType: event.eventType,
      managedSink: sink.configured,
    });
    return { ok: false as const, errorCode };
  }
}

export function assertSecretAuditOutboxPayloadSafe(event: SecretAuditEvent) {
  const topLevelKeys = Object.keys(event).sort();
  if (
    topLevelKeys.join(",") !==
    "createdAt,eventType,id,metadata,providerRef,secretRefs,userRef"
  ) {
    throw auditWriteError("unsafe_secret_audit_payload_shape");
  }
  if (!/^secret_audit_[A-Za-z0-9_-]{16,80}$/.test(event.id)) {
    throw auditWriteError("invalid_secret_audit_event_id");
  }
  if (!isSecretAuditEventType(event.eventType)) {
    throw auditWriteError("invalid_secret_audit_event_type");
  }
  if (!/^user_[a-f0-9]{24}$/.test(event.userRef)) {
    throw auditWriteError("invalid_secret_audit_user_ref");
  }
  if (!/^provider_[a-f0-9]{24}$/.test(event.providerRef)) {
    throw auditWriteError("invalid_secret_audit_provider_ref");
  }
  if (
    !Array.isArray(event.secretRefs) ||
    event.secretRefs.length > 32 ||
    new Set(event.secretRefs).size !== event.secretRefs.length ||
    event.secretRefs.some((reference) => !/^secret_[a-f0-9]{24}$/.test(reference))
  ) {
    throw auditWriteError("invalid_secret_audit_secret_refs");
  }
  if (
    !event.metadata ||
    typeof event.metadata !== "object" ||
    Array.isArray(event.metadata) ||
    Object.keys(event.metadata).join(",") !== "reason" ||
    !isSecretAuditReason(event.metadata.reason) ||
    !isSecretAuditReasonCompatible(event.eventType, event.metadata.reason)
  ) {
    throw auditWriteError("unsafe_secret_audit_metadata");
  }
  if (
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(
      event.createdAt,
    ) ||
    !Number.isFinite(Date.parse(event.createdAt)) ||
    new Date(event.createdAt).toISOString() !== event.createdAt
  ) {
    throw auditWriteError("invalid_secret_audit_created_at");
  }
  const serialized = JSON.stringify(event);
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_EVENT_BYTES ||
    /"(?:userId|user_id|providerId|provider_id|secretNames|secret_names|providerCredentialId|provider_credential_id|message|encryptedSecrets|encrypted_secrets|plaintext|rawSecret|raw_secret)"\s*:/.test(
      serialized,
    )
  ) {
    throw auditWriteError("unsafe_secret_audit_payload");
  }
}

export function getSecretAuditErrorCode(error: unknown) {
  return safeErrorCode(error);
}

export function getSecretAuditOutboxLeaseMs() {
  return boundedAuditInteger(
    "OWNMINUTES_SECRET_AUDIT_OUTBOX_LEASE_MS",
    30_000,
    5_000,
    5 * 60_000,
  );
}

export function getSecretAuditOutboxMaxPendingAgeMs() {
  return boundedAuditInteger(
    "OWNMINUTES_SECRET_AUDIT_OUTBOX_MAX_PENDING_AGE_MS",
    60_000,
    10_000,
    60 * 60_000,
  );
}

export function getSecretAuditOutboxPollMs() {
  return boundedAuditInteger(
    "OWNMINUTES_SECRET_AUDIT_OUTBOX_POLL_MS",
    1_000,
    100,
    60_000,
  );
}

export function getSecretAuditOutboxRetryDelayMs(attemptCount: number) {
  const baseMs = boundedAuditInteger(
    "OWNMINUTES_SECRET_AUDIT_OUTBOX_RETRY_BASE_MS",
    1_000,
    100,
    60_000,
  );
  const exponent = Math.max(0, Math.min(8, Math.round(attemptCount) - 1));
  return Math.min(5 * 60_000, baseMs * 2 ** exponent);
}

export function assertSecretAuditSinkWritable() {
  const sink = resolveAuditSink();
  try {
    if (!sink.valid) throw auditWriteError("invalid_audit_sink_path");
    if (process.env.NODE_ENV === "production" && !sink.configured) {
      throw auditWriteError("managed_audit_sink_required");
    }
    if (
      sink.configured &&
      process.env.OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION !== "1"
    ) {
      throw auditWriteError("external_rotation_not_configured");
    }
    if (sink.configured && !inspectRotationHeartbeat().ready) {
      throw auditWriteError("external_rotation_unhealthy");
    }
    if (sink.configured) {
      assertPersistentSinkParent(sink.path);
      assertAppendableAuditTarget(sink.path, getAuditMaxBytes());
    } else {
      fs.mkdirSync(LOCAL_AUDIT_DIR, { recursive: true, mode: 0o700 });
    }
    const legacyMigration = ensureLegacyAuditLogsCanonical(sink);
    if (!legacyMigration.ready) {
      throw auditWriteError(legacyMigration.status);
    }
    assertAppendableAuditTarget(sink.path, getAuditMaxBytes());
  } catch (error) {
    const errorCode = safeErrorCode(error);
    globalAuditStatus[auditStatusKey] = {
      errorCode,
      sinkFingerprint: sink.fingerprint,
      succeededAt: null,
      writeOk: false,
    };
    console.error("Secret audit sink preflight failed.", {
      code: errorCode,
      managedSink: sink.configured,
    });
    throw new SecretAuditUnavailableError();
  }
}

export function getSecretAuditInfo() {
  const sink = resolveAuditSink();
  const readiness = inspectAuditSink(sink);
  const legacyMigration = readiness.ready
    ? ensureLegacyAuditLogsCanonical(sink)
    : {
        checkedAt: null,
        ready: false,
        status: "skipped_sink_not_ready",
      };
  const externalRotationRequired = sink.configured;
  const rotationHeartbeat = inspectRotationHeartbeat();
  const externalRotationConfigured =
    process.env.OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION === "1" &&
    rotationHeartbeat.ready;
  const sinkReady =
    readiness.ready &&
    legacyMigration.ready &&
    (!externalRotationRequired || externalRotationConfigured);
  const status = globalAuditStatus[auditStatusKey];
  const currentStatus = status?.sinkFingerprint === sink.fingerprint ? status : undefined;
  return {
    localAuditPath: ".data/auth/secret-audit.jsonl",
    localAuditExists: isRegularFile(LOCAL_AUDIT_PATH),
    managedPathConfigured: sink.configured,
    managedSinkExists: sink.configured && isRegularFile(sink.path),
    pathValid: sink.valid,
    sinkReady,
    sinkWritable: readiness.ready,
    sinkStatus: !readiness.ready
      ? readiness.status
      : !legacyMigration.ready
        ? legacyMigration.status
        : externalRotationRequired && !externalRotationConfigured
        ? "external_rotation_not_configured"
        : readiness.status,
    legacyMigrationReady: legacyMigration.ready,
    legacyMigrationStatus: legacyMigration.status,
    legacyMigrationCheckedAt: legacyMigration.checkedAt,
    externalRotationRequired,
    externalRotationConfigured,
    externalRotationHeartbeatStatus: rotationHeartbeat.status,
    externalRotationLastCheckedAt: rotationHeartbeat.checkedAt,
    maxBytes: getAuditMaxBytes(),
    lastWriteOk: currentStatus?.writeOk ?? null,
    lastWriteAt: currentStatus?.succeededAt ?? null,
    lastWriteErrorCode: currentStatus?.errorCode ?? null,
    retentionDays: sink.configured ? null : AUDIT_RETENTION_DAYS,
    maxEvents: sink.configured ? null : AUDIT_MAX_EVENTS,
    localRetentionEnforced: !sink.configured,
    userIdentifiersPseudonymized: true,
  };
}

export function secretAuditUserRef(userId: string) {
  return `user_${crypto
    .createHmac("sha256", secretAuditKey())
    .update("ownminutes-secret-audit-user-ref:v1\u0000")
    .update(userId)
    .digest("hex")
    .slice(0, 24)}`;
}

function secretAuditProviderRef(providerId: string) {
  return secretAuditStableRef(
    "provider",
    "ownminutes-secret-audit-provider-ref:v1",
    [providerId],
  );
}

function secretAuditSecretRef(providerId: string, secretName: string) {
  return secretAuditStableRef(
    "secret",
    "ownminutes-secret-audit-secret-ref:v1",
    [providerId, secretName],
  );
}

function secretAuditStableRef(
  prefix: "provider" | "secret",
  domain: string,
  values: string[],
) {
  const hmac = crypto.createHmac("sha256", secretAuditKey()).update(domain);
  for (const value of values) {
    hmac.update("\u0000").update(value);
  }
  return `${prefix}_${hmac.digest("hex").slice(0, 24)}`;
}

function resolveAuditSink(): ResolvedAuditSink {
  const configuredValue = process.env.OWNMINUTES_SECRET_AUDIT_LOG?.trim() || "";
  const configured = Boolean(configuredValue);
  const targetPath = configured ? configuredValue : LOCAL_AUDIT_PATH;
  const valid =
    !targetPath.includes("\u0000") &&
    path.isAbsolute(targetPath) &&
    path.basename(targetPath).length > 0;
  return {
    configured,
    fingerprint: crypto.createHash("sha256").update(targetPath).digest("hex").slice(0, 24),
    path: targetPath,
    valid,
  };
}

function inspectAuditSink(sink: ResolvedAuditSink) {
  if (!sink.valid) return { ready: false, status: "invalid_path" as const };
  try {
    const parent = path.dirname(sink.path);
    if (sink.configured) {
      const parentInfo = fs.statSync(parent);
      if (!parentInfo.isDirectory()) return { ready: false, status: "parent_not_directory" as const };
      fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
    } else {
      const existingParent = nearestExistingParent(parent);
      fs.accessSync(existingParent, fs.constants.W_OK | fs.constants.X_OK);
    }
    if (fs.existsSync(sink.path)) {
      const info = fs.lstatSync(sink.path);
      if (info.isSymbolicLink() || !info.isFile()) {
        return { ready: false, status: "unsafe_existing_target" as const };
      }
      if (info.size >= getAuditMaxBytes()) {
        return { ready: false, status: "capacity_exceeded" as const };
      }
      fs.accessSync(sink.path, fs.constants.W_OK);
    }
    return { ready: true, status: "ready" as const };
  } catch {
    return { ready: false, status: "unwritable" as const };
  }
}

function inspectRotationHeartbeat() {
  const heartbeatPath =
    process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE?.trim() || "";
  if (!heartbeatPath || !path.isAbsolute(heartbeatPath) || heartbeatPath.includes("\u0000")) {
    return { ready: false, status: "heartbeat_path_missing" as const, checkedAt: null };
  }
  try {
    const info = fs.lstatSync(heartbeatPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { ready: false, status: "heartbeat_unsafe" as const, checkedAt: null };
    }
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath, "utf8")) as {
      checkedAt?: unknown;
      ok?: unknown;
    };
    const checkedAt =
      typeof parsed.checkedAt === "string" ? parsed.checkedAt : "";
    const checkedAtMs = Date.parse(checkedAt);
    const intervalSeconds = boundedAuditInteger(
      "OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS",
      300,
      60,
      86_400,
    );
    const maximumAgeMs = (intervalSeconds + 300) * 1_000;
    const fresh =
      parsed.ok === true &&
      Number.isFinite(checkedAtMs) &&
      Date.now() - checkedAtMs <= maximumAgeMs &&
      Date.now() - info.mtimeMs <= maximumAgeMs;
    return {
      ready: fresh,
      status: fresh ? "ready" as const : "heartbeat_stale" as const,
      checkedAt: checkedAt || null,
    };
  } catch {
    return { ready: false, status: "heartbeat_unavailable" as const, checkedAt: null };
  }
}

function assertPersistentSinkParent(filePath: string) {
  const parent = path.dirname(filePath);
  const info = fs.statSync(parent);
  if (!info.isDirectory()) throw auditWriteError("audit_sink_parent_not_directory");
  fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
  if (fs.existsSync(filePath)) {
    const target = fs.lstatSync(filePath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw auditWriteError("unsafe_audit_sink_target");
    }
  }
}

function assertAppendableAuditTarget(filePath: string, maxBytes: number) {
  runLockedAuditFileOperation({
    action: "preflight",
    filePath,
    input: "",
    localMaintenance: false,
    maxBytes,
  });
}

function ensureLegacyAuditLogsCanonical(
  sink: ResolvedAuditSink,
): SecretAuditLegacyMigrationStatus {
  if (!sink.valid) {
    return {
      checkedAt: new Date().toISOString(),
      ready: false,
      status: "invalid_audit_sink_path",
    };
  }
  const targets = [LOCAL_AUDIT_PATH];
  if (sink.path !== LOCAL_AUDIT_PATH) targets.push(sink.path);
  let checkedAt: string | null = null;
  for (const target of targets) {
    const result = ensureLegacyAuditLogCanonical(target);
    checkedAt = result.checkedAt || checkedAt;
    if (!result.ready) return result;
  }
  return {
    checkedAt,
    ready: true,
    status: "ready",
  };
}

function ensureLegacyAuditLogCanonical(
  filePath: string,
): SecretAuditLegacyMigrationStatus {
  if (!fs.existsSync(filePath)) {
    return { checkedAt: new Date().toISOString(), ready: true, status: "not_needed" };
  }
  const cache =
    globalAuditStatus[auditLegacyMigrationCacheKey] ??
    new Map<string, SecretAuditLegacyMigrationCacheEntry>();
  globalAuditStatus[auditLegacyMigrationCacheKey] = cache;
  try {
    const before = fs.lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      return {
        checkedAt: new Date().toISOString(),
        ready: false,
        status: "unsafe_audit_sink_target",
      };
    }
    const signature = auditFileSignature(before);
    const cached = cache.get(filePath);
    if (cached?.ready && cached.signature === signature) {
      return {
        checkedAt: cached.checkedAt,
        ready: true,
        status: cached.status,
      };
    }
    runLockedAuditFileOperation({
      action: "normalize",
      filePath,
      input: "",
      localMaintenance: false,
      maxBytes: getAuditMaxBytes(),
    });
    const after = fs.lstatSync(filePath);
    if (after.isSymbolicLink() || !after.isFile()) {
      throw auditWriteError("unsafe_audit_sink_target");
    }
    const result: SecretAuditLegacyMigrationCacheEntry = {
      checkedAt: new Date().toISOString(),
      ready: true,
      signature: auditFileSignature(after),
      status: "ready",
    };
    cache.set(filePath, result);
    return result;
  } catch (error) {
    const result: SecretAuditLegacyMigrationCacheEntry = {
      checkedAt: new Date().toISOString(),
      ready: false,
      signature: "",
      status: safeErrorCode(error),
    };
    cache.set(filePath, result);
    return result;
  }
}

function auditFileSignature(info: fs.Stats) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
}

function runLockedAuditFileOperation(input: {
  action: "append" | "normalize" | "preflight";
  filePath: string;
  input: string;
  localMaintenance: boolean;
  maxBytes: number;
}) {
  if (Buffer.byteLength(input.input, "utf8") > MAX_AUDIT_EVENT_BYTES) {
    throw auditWriteError("audit_event_too_large");
  }
  const lockTimeoutSeconds = boundedAuditInteger(
    "OWNMINUTES_SECRET_AUDIT_LOCK_TIMEOUT_SECONDS",
    5,
    1,
    30,
  );
  const result = spawnSync(
    "perl",
    [
      path.join(process.cwd(), "scripts", "with-file-lock.pl"),
      `${input.filePath}.lock`,
      String(lockTimeoutSeconds),
      process.execPath,
      path.join(process.cwd(), "scripts", "secret-audit-file-operation.mjs"),
      input.action,
      input.filePath,
      String(input.maxBytes),
      input.localMaintenance ? String(AUDIT_RETENTION_DAYS) : "0",
      input.localMaintenance ? String(AUDIT_MAX_EVENTS) : "0",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: input.input,
      timeout: (lockTimeoutSeconds + 5) * 1_000,
    },
  );
  if (result.status === 0) return;
  if (result.status === 75) throw auditWriteError("secret_audit_lock_timeout");
  const parsedCode = String(result.stderr || "").match(/"code":"([a-z0-9_]{1,80})"/)?.[1];
  throw auditWriteError(parsedCode || "secret_audit_operation_failed");
}

function secretAuditKey() {
  const secret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) {
    return crypto.createHash("sha256").update(`${secret}:secret-audit-user-ref`).digest();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Secret audit pseudonymization requires OWNMINUTES_APP_SECRET or AUTH_SECRET.");
  }
  return crypto.createHash("sha256").update("ownminutes-local-secret-audit-user-ref-v1").digest();
}

function isSecretAuditEventType(value: string): value is SecretAuditEventType {
  return [
    "provider_secret_delete",
    "provider_secret_decrypt_failed",
    "provider_secret_rotate",
    "provider_secret_save",
  ].includes(value);
}

function isSecretAuditReason(value: unknown): value is SecretAuditReason {
  return [
    "account_delete",
    "provider_auth_switch",
    "provider_delete",
    "provider_runtime_decrypt",
    "provider_save",
    "provider_update",
  ].includes(String(value));
}

function isSecretAuditReasonCompatible(
  eventType: SecretAuditEventType,
  reason: SecretAuditReason,
) {
  if (eventType === "provider_secret_save") return reason === "provider_save";
  if (eventType === "provider_secret_rotate") return reason === "provider_update";
  if (eventType === "provider_secret_decrypt_failed") {
    return reason === "provider_runtime_decrypt";
  }
  return [
    "account_delete",
    "provider_auth_switch",
    "provider_delete",
  ].includes(reason);
}

function normalizeAuditReferenceInput(
  value: string,
  kind: "provider" | "secret",
) {
  const normalized = kind === "provider" ? value.trim() : value;
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > 1_024
  ) {
    throw auditWriteError(`invalid_secret_audit_${kind}_reference_input`);
  }
  return normalized;
}

function normalizeSecretReferenceInputs(secretNames: string[]) {
  if (!Array.isArray(secretNames) || secretNames.length > 32) {
    throw auditWriteError("invalid_secret_audit_secret_reference_inputs");
  }
  return [...new Set(
    secretNames.map((name) =>
      normalizeAuditReferenceInput(name, "secret")
    ),
  )].sort();
}

function nearestExistingParent(startPath: string) {
  let current = startPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function getAuditMaxBytes() {
  const configured = Number(process.env.OWNMINUTES_SECRET_AUDIT_MAX_BYTES);
  if (!Number.isSafeInteger(configured)) return DEFAULT_AUDIT_MAX_BYTES;
  return Math.max(1024 * 1024, Math.min(2 * 1024 * 1024 * 1024, configured));
}

function boundedAuditInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function isRegularFile(filePath: string) {
  try {
    const info = fs.lstatSync(filePath);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function auditWriteError(code: string) {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function safeErrorCode(error: unknown) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return error instanceof Error ? error.name.slice(0, 80) : "unknown_error";
}
