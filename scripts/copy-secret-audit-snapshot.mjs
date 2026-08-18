#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSyncWithInheritedFileLocks } from "./lib/inherited-file-lock.mjs";

const destination = path.resolve(process.argv[2] || "");
const activePath = path.resolve(
  process.env.OWNMINUTES_SECRET_AUDIT_LOG || "/app/.data/auth/secret-audit.jsonl",
);
const archiveDirectory = path.resolve(
  process.env.OWNMINUTES_SECRET_AUDIT_ARCHIVE_DIR || "/app/.data/audit-archive",
);

if (
  process.env.OWNMINUTES_SECRET_AUDIT_LOCK_HELD !== "1" ||
  !path.isAbsolute(destination) ||
  destination === path.parse(destination).root
) {
  throw new Error("audit_snapshot_lock_or_destination_invalid");
}

assertSafeDirectory(path.dirname(activePath));
assertSafeDirectory(archiveDirectory);
recoverRotationState();
const archivePairs = validateRotationState();
fs.mkdirSync(path.join(destination, "active"), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(destination, "archive"), { recursive: true, mode: 0o700 });

if (fs.existsSync(activePath)) {
  assertSafeFile(activePath);
  validateAuditJsonl(activePath, true);
  copyVerified(activePath, path.join(destination, "active", path.basename(activePath)));
}

for (const { archiveName, digestName } of archivePairs) {
  copyVerified(
    path.join(archiveDirectory, archiveName),
    path.join(destination, "archive", archiveName),
  );
  copyVerified(
    path.join(archiveDirectory, digestName),
    path.join(destination, "archive", digestName),
  );
  validateDigestSidecar(
    path.join(destination, "archive"),
    archiveName,
    digestName,
  );
}

fsyncDirectory(path.join(destination, "active"));
fsyncDirectory(path.join(destination, "archive"));
fsyncDirectory(destination);

function recoverRotationState() {
  const result = spawnSyncWithInheritedFileLocks(
    process.execPath,
    [path.join(process.cwd(), "scripts", "rotate-secret-audit-log.mjs"), "--sweep-locked"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      timeout: 40_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("audit_snapshot_rotation_recovery_failed");
  }
}

function validateRotationState() {
  const rotatingPrefix = `${path.basename(activePath)}.rotating-`;
  const activeResidue = fs.readdirSync(path.dirname(activePath))
    .filter((name) => name.startsWith(rotatingPrefix));
  if (activeResidue.length > 0) {
    throw new Error("audit_snapshot_rotating_residue");
  }

  const names = fs.readdirSync(archiveDirectory).sort();
  if (names.some((name) => name.endsWith(".pending"))) {
    throw new Error("audit_snapshot_pending_archive");
  }
  const archives = names.filter((name) => name.endsWith(".jsonl"));
  const sidecars = names.filter((name) => name.endsWith(".jsonl.sha256"));
  const expectedNames = new Set([
    ...archives,
    ...archives.map((name) => `${name}.sha256`),
  ]);
  if (names.some((name) => !expectedNames.has(name))) {
    throw new Error("audit_snapshot_unexpected_archive_entry");
  }
  if (sidecars.some((name) => !archives.includes(name.slice(0, -".sha256".length)))) {
    throw new Error("audit_snapshot_orphan_digest_sidecar");
  }

  return archives.map((archiveName) => {
    const digestName = `${archiveName}.sha256`;
    if (!sidecars.includes(digestName)) {
      throw new Error("audit_snapshot_missing_digest_sidecar");
    }
    validateDigestSidecar(archiveDirectory, archiveName, digestName);
    return { archiveName, digestName };
  });
}

function validateDigestSidecar(directory, archiveName, digestName) {
  const archivePath = path.join(directory, archiveName);
  const digestPath = path.join(directory, digestName);
  assertSafeFile(archivePath);
  assertSafeFile(digestPath);
  validateAuditJsonl(archivePath, false);
  const digestText = fs.readFileSync(digestPath, "utf8");
  const match = /^([0-9a-f]{64})  ([^/\0\r\n]+)\n$/.exec(digestText);
  if (
    !match ||
    match[2] !== archiveName ||
    match[1] !== sha256File(archivePath)
  ) {
    throw new Error("audit_snapshot_digest_sidecar_invalid");
  }
}

function validateAuditJsonl(filePath, allowEmpty) {
  const data = fs.readFileSync(filePath);
  if (data.length === 0) {
    if (allowEmpty) return;
    throw new Error("audit_snapshot_empty_archive");
  }
  if (data[data.length - 1] !== 0x0a) {
    throw new Error("audit_snapshot_truncated_jsonl");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("audit_snapshot_invalid_utf8");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error("audit_snapshot_blank_jsonl_record");
  }
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("audit_snapshot_invalid_jsonl_record");
    }
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      typeof event.id !== "string" ||
      event.id.length === 0 ||
      !new Set([
        "provider_secret_delete",
        "provider_secret_decrypt_failed",
        "provider_secret_rotate",
        "provider_secret_save",
      ]).has(event.eventType) ||
      !/^user_(?:[a-f0-9]{24}|unknown)$/.test(String(event.userRef || "")) ||
      Object.hasOwn(event, "userId") ||
      !Array.isArray(event.secretNames) ||
      event.secretNames.some((name) => typeof name !== "string") ||
      !isCanonicalIsoDate(event.createdAt)
    ) {
      throw new Error("audit_snapshot_event_schema_invalid");
    }
  }
}

function isCanonicalIsoDate(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function copyVerified(source, target) {
  const sourceBefore = fs.lstatSync(source);
  assertSafeFile(source);
  const sourceDigest = sha256File(source);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
  fsyncFile(target);
  const sourceAfter = fs.lstatSync(source);
  const targetStats = fs.statSync(target);
  if (
    sourceBefore.dev !== sourceAfter.dev ||
    sourceBefore.ino !== sourceAfter.ino ||
    sourceBefore.size !== sourceAfter.size ||
    sourceBefore.mtimeMs !== sourceAfter.mtimeMs ||
    sourceBefore.size !== targetStats.size ||
    sourceDigest !== sha256File(source) ||
    sourceDigest !== sha256File(target)
  ) {
    throw new Error("audit_snapshot_copy_mismatch");
  }
}

function assertSafeDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("unsafe_audit_snapshot_directory");
  }
}

function assertSafeFile(filePath) {
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("unsafe_audit_snapshot_file");
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fsyncFile(filePath) {
  const descriptor = fs.openSync(filePath, "r");
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
