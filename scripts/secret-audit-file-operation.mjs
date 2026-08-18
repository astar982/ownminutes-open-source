#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_AUDIT_EVENT_BYTES = 64 * 1024;
const action = process.argv[2] || "";
const filePath = requiredAbsoluteFilePath(process.argv[3]);
const maxBytes = boundedInteger(process.argv[4], 1024 * 1024, 2 * 1024 * 1024 * 1024);
const retentionDays = boundedInteger(process.argv[5] || "0", 0, 2_555);
const maxEvents = boundedInteger(process.argv[6] || "0", 0, 1_000_000);

try {
  if (process.env.OWNMINUTES_SECRET_AUDIT_LOCK_HELD !== "1") {
    throw operationError("secret_audit_lock_not_held");
  }
  assertSafeParent(filePath);
  if (action === "append") {
    const line = readBoundedStdin(MAX_AUDIT_EVENT_BYTES);
    if (retentionDays > 0 && maxEvents > 0) {
      maintainLocalAuditLog(filePath, retentionDays, maxEvents, maxBytes);
    }
    appendAuditLine(filePath, line, maxBytes);
  } else if (action === "normalize") {
    normalizeAuditLog(filePath, maxBytes);
  } else if (action === "preflight") {
    assertAppendableAuditTarget(filePath, maxBytes);
  } else {
    throw operationError("secret_audit_operation_invalid");
  }
} catch (error) {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "secret_audit_operation_failed";
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
}

function appendAuditLine(targetPath, data, capacity) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    targetPath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile()) throw operationError("unsafe_audit_sink_target");
    fs.fchmodSync(descriptor, 0o600);
    if (info.size + data.byteLength > capacity) {
      throw operationError("audit_sink_capacity_exceeded");
    }
    runTestPauseAfterOpen();
    let written = 0;
    while (written < data.byteLength) {
      const bytes = fs.writeSync(descriptor, data, written, data.byteLength - written);
      if (bytes <= 0) throw operationError("short_audit_write");
      written += bytes;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function runTestPauseAfterOpen() {
  if (process.env.OWNMINUTES_SECRET_AUDIT_TEST_HOOKS !== "1") return;
  const pauseMs = Number(process.env.OWNMINUTES_SECRET_AUDIT_TEST_PAUSE_AFTER_OPEN_MS || 0);
  if (!Number.isSafeInteger(pauseMs) || pauseMs < 1 || pauseMs > 5_000) return;
  const marker = process.env.OWNMINUTES_SECRET_AUDIT_TEST_MARKER_FILE?.trim() || "";
  if (marker) {
    const markerPath = requiredAbsoluteFilePath(marker);
    fs.writeFileSync(markerPath, `${process.pid}\n`, { mode: 0o600 });
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
}

function assertAppendableAuditTarget(targetPath, capacity) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    targetPath,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile()) throw operationError("unsafe_audit_sink_target");
    if (info.size >= capacity) throw operationError("audit_sink_capacity_exceeded");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function maintainLocalAuditLog(targetPath, retention, maximumEvents, capacity) {
  if (!fs.existsSync(targetPath)) return;
  const target = fs.lstatSync(targetPath);
  if (target.isSymbolicLink() || !target.isFile()) {
    throw operationError("unsafe_audit_sink_target");
  }
  if (target.size >= capacity) {
    throw operationError("audit_sink_capacity_exceeded");
  }
  const cutoff = Date.now() - retention * 86_400_000;
  const lines = fs.readFileSync(targetPath, "utf8").split("\n").filter(Boolean);
  const normalized = lines
    .map((line) => normalizeStoredAuditEvent(line))
    .filter((event) => Date.parse(String(event.createdAt || "")) >= cutoff)
    .slice(-maximumEvents);
  rewriteAuditLogAtomically(targetPath, normalized, capacity);
}

function normalizeAuditLog(targetPath, capacity) {
  if (!fs.existsSync(targetPath)) return;
  const target = fs.lstatSync(targetPath);
  if (target.isSymbolicLink() || !target.isFile()) {
    throw operationError("unsafe_audit_sink_target");
  }
  if (target.size > capacity) {
    throw operationError("audit_sink_capacity_exceeded");
  }
  const current = fs.readFileSync(targetPath, "utf8");
  const normalized = current
    .split("\n")
    .filter(Boolean)
    .map((line) => normalizeStoredAuditEvent(line));
  const canonical =
    normalized.length > 0
      ? `${normalized.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "";
  if (canonical === current) return;
  rewriteAuditLogAtomically(targetPath, normalized, capacity);
}

function rewriteAuditLogAtomically(targetPath, events, capacity) {
  const canonical =
    events.length > 0
      ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "";
  if (Buffer.byteLength(canonical, "utf8") > capacity) {
    throw operationError("audit_sink_capacity_exceeded");
  }
  const temporaryPath = `${targetPath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, canonical, { mode: 0o600, flag: "wx" });
  try {
    fsyncFile(temporaryPath);
    fs.renameSync(temporaryPath, targetPath);
    fs.chmodSync(targetPath, 0o600);
    fsyncDirectory(path.dirname(targetPath));
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function normalizeStoredAuditEvent(line) {
  try {
    const parsed = JSON.parse(line);
    const eventId =
      typeof parsed.id === "string" &&
      /^secret_audit_[A-Za-z0-9_-]{16,80}$/.test(parsed.id)
        ? parsed.id
        : `secret_audit_${crypto
          .createHash("sha256")
          .update(`legacy-event\u0000${line}`)
          .digest("hex")
          .slice(0, 24)}`;
    const eventType = isSecretAuditEventType(parsed.eventType)
      ? parsed.eventType
      : "provider_secret_decrypt_failed";
    const rawUserId = typeof parsed.userId === "string" ? parsed.userId : "";
    const userRef =
      typeof parsed.userRef === "string" && /^user_[a-f0-9]{24}$/.test(parsed.userRef)
        ? parsed.userRef
        : rawUserId
          ? secretAuditUserRef(rawUserId)
          : secretAuditUserRef(`legacy-unknown-user\u0000${eventId}`);
    const rawProviderId =
      typeof parsed.providerId === "string" && parsed.providerId
        ? parsed.providerId
        : `legacy-unknown-provider\u0000${eventId}`;
    const providerRef =
      typeof parsed.providerRef === "string" &&
      /^provider_[a-f0-9]{24}$/.test(parsed.providerRef)
        ? parsed.providerRef
        : secretAuditProviderRef(rawProviderId);
    const rawSecretNames = Array.isArray(parsed.secretNames)
      ? parsed.secretNames.filter((value) => typeof value === "string").slice(0, 32)
      : [];
    const secretRefs = Array.isArray(parsed.secretRefs)
      ? parsed.secretRefs
        .filter((value) => typeof value === "string" && /^secret_[a-f0-9]{24}$/.test(value))
        .slice(0, 32)
      : rawSecretNames.map((secretName) =>
        secretAuditSecretRef(rawProviderId, secretName)
      );
    return {
      id: eventId,
      eventType,
      userRef,
      providerRef,
      secretRefs: [...new Set(secretRefs)].sort(),
      metadata: {
        reason: normalizeSecretAuditReason(parsed.metadata?.reason, eventType),
      },
      createdAt: Number.isFinite(Date.parse(String(parsed.createdAt || "")))
        ? new Date(parsed.createdAt).toISOString()
        : new Date().toISOString(),
    };
  } catch {
    const digest = crypto.createHash("sha256").update(line).digest("hex");
    return {
      id: `secret_audit_${digest.slice(0, 24)}`,
      eventType: "provider_secret_decrypt_failed",
      userRef: secretAuditUserRef(`corrupt-legacy-user\u0000${digest}`),
      providerRef: secretAuditProviderRef(`corrupt-legacy-provider\u0000${digest}`),
      secretRefs: [],
      metadata: { reason: "provider_runtime_decrypt" },
      createdAt: new Date().toISOString(),
    };
  }
}

function secretAuditUserRef(userId) {
  return `user_${crypto
    .createHmac("sha256", secretAuditKey())
    .update("ownminutes-secret-audit-user-ref:v1\u0000")
    .update(userId)
    .digest("hex")
    .slice(0, 24)}`;
}

function secretAuditProviderRef(providerId) {
  return secretAuditStableRef(
    "provider",
    "ownminutes-secret-audit-provider-ref:v1",
    [providerId],
  );
}

function secretAuditSecretRef(providerId, secretName) {
  return secretAuditStableRef(
    "secret",
    "ownminutes-secret-audit-secret-ref:v1",
    [providerId, secretName],
  );
}

function secretAuditStableRef(prefix, domain, values) {
  const hmac = crypto.createHmac("sha256", secretAuditKey()).update(domain);
  for (const value of values) {
    hmac.update("\u0000").update(value);
  }
  return `${prefix}_${hmac.digest("hex").slice(0, 24)}`;
}

function secretAuditKey() {
  const secret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) {
    return crypto.createHash("sha256").update(`${secret}:secret-audit-user-ref`).digest();
  }
  if (process.env.NODE_ENV === "production") {
    throw operationError("secret_audit_pseudonymization_key_missing");
  }
  return crypto.createHash("sha256").update("ownminutes-local-secret-audit-user-ref-v1").digest();
}

function isSecretAuditEventType(value) {
  return [
    "provider_secret_delete",
    "provider_secret_decrypt_failed",
    "provider_secret_rotate",
    "provider_secret_save",
  ].includes(value);
}

function normalizeSecretAuditReason(value, eventType) {
  const allowedByEventType = {
    provider_secret_delete: [
      "account_delete",
      "provider_auth_switch",
      "provider_delete",
    ],
    provider_secret_decrypt_failed: ["provider_runtime_decrypt"],
    provider_secret_rotate: ["provider_update"],
    provider_secret_save: ["provider_save"],
  };
  const allowed = allowedByEventType[eventType];
  if (allowed.includes(value)) return value;
  return allowed[0];
}

function readBoundedStdin(maximumBytes) {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.allocUnsafe(16 * 1024);
  while (true) {
    const bytes = fs.readSync(0, buffer, 0, buffer.length);
    if (bytes === 0) break;
    total += bytes;
    if (total > maximumBytes) throw operationError("audit_event_too_large");
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  const data = Buffer.concat(chunks);
  if (data.byteLength === 0 || data[data.byteLength - 1] !== 0x0a) {
    throw operationError("audit_event_invalid");
  }
  return data;
}

function assertSafeParent(targetPath) {
  const parent = path.dirname(targetPath);
  const info = fs.lstatSync(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw operationError("audit_sink_parent_not_directory");
  }
  fs.accessSync(parent, fs.constants.W_OK | fs.constants.X_OK);
  if (fs.existsSync(targetPath)) {
    const target = fs.lstatSync(targetPath);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw operationError("unsafe_audit_sink_target");
    }
  }
}

function requiredAbsoluteFilePath(value) {
  const candidate = String(value || "").trim();
  if (!path.isAbsolute(candidate) || candidate.includes("\0") || !path.basename(candidate)) {
    throw operationError("invalid_audit_sink_path");
  }
  return path.normalize(candidate);
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw operationError("invalid_audit_operation_limit");
  }
  return parsed;
}

function fsyncFile(targetPath) {
  const descriptor = fs.openSync(targetPath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function operationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
