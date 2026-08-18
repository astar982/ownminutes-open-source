#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const action = process.argv.includes("--healthcheck")
  ? "healthcheck"
  : process.argv.includes("--sweep-locked")
    ? "sweep-locked"
  : process.argv.includes("--once")
    ? "once"
    : "loop";
const config = readConfig();

if (action === "healthcheck") {
  verifyHeartbeat(config);
} else if (action === "sweep-locked") {
  if (process.env.OWNMINUTES_SECRET_AUDIT_LOCK_HELD !== "1") {
    throw rotationError("audit_rotation_lock_not_held");
  }
  console.log(JSON.stringify(runSweep(config)));
} else if (action === "once") {
  console.log(JSON.stringify(runLockedSweep(config), null, 2));
} else {
  while (true) {
    let succeeded = false;
    try {
      console.log(JSON.stringify(runLockedSweep(config)));
      succeeded = true;
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        errorType: error instanceof Error ? error.name : "UnknownAuditRotationError",
      }));
    }
    const delaySeconds = succeeded ? config.intervalSeconds : Math.min(config.intervalSeconds, 60);
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
  }
}

function runLockedSweep(input) {
  const result = spawnSync(
    "perl",
    [
      path.join(process.cwd(), "scripts", "with-file-lock.pl"),
      `${input.activePath}.lock`,
      "30",
      process.execPath,
      path.join(process.cwd(), "scripts", "rotate-secret-audit-log.mjs"),
      "--sweep-locked",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      timeout: 40_000,
    },
  );
  if (result.status === 75) throw rotationError("audit_rotation_lock_timeout");
  if (result.status !== 0) throw rotationError("audit_rotation_locked_sweep_failed");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw rotationError("audit_rotation_locked_sweep_invalid");
  }
}

function runSweep(input) {
  assertSafeDirectory(input.activeDirectory, true);
  assertSafeDirectory(input.archiveDirectory, true);
  let archived = 0;
  let lastRotationAt = previousRotationAt(input.heartbeatPath);
  const recoveredOrphanSidecars = recoverOrphanDigestSidecars(input);

  for (const rotatingPath of pendingRotations(input)) {
    archiveRotatedFile(input, rotatingPath);
    archived += 1;
    lastRotationAt = new Date().toISOString();
  }

  if (fs.existsSync(input.activePath)) {
    const active = assertSafeRegularFile(input.activePath);
    if (active.size >= input.rotateBytes) {
      const rotatingPath = `${input.activePath}.rotating-${safeTimestamp()}-${crypto.randomBytes(6).toString("hex")}`;
      fs.renameSync(input.activePath, rotatingPath);
      archiveRotatedFile(input, rotatingPath);
      archived += 1;
      lastRotationAt = new Date().toISOString();
    }
  }

  const deletedArchives = pruneArchives(input);
  const heartbeat = {
    ok: true,
    checkedAt: new Date().toISOString(),
    lastRotationAt,
    archived,
    recoveredOrphanSidecars,
    deletedArchives,
    retentionDays: input.retentionDays,
    rotateBytes: input.rotateBytes,
  };
  atomicWriteJson(input.heartbeatPath, heartbeat);
  return heartbeat;
}

function recoverOrphanDigestSidecars(input) {
  const cutoff = Date.now() - input.retentionDays * 86_400_000;
  const sidecarNames = fs.readdirSync(input.archiveDirectory)
    .filter((name) => name.endsWith(".jsonl.sha256"))
    .sort();
  let recovered = 0;
  for (const sidecarName of sidecarNames) {
    const archiveName = sidecarName.slice(0, -".sha256".length);
    const archivePath = path.join(input.archiveDirectory, archiveName);
    try {
      assertSafeRegularFile(archivePath);
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const sidecarPath = path.join(input.archiveDirectory, sidecarName);
    const stats = assertSafeRegularFile(sidecarPath);
    if ((stats.mode & 0o077) !== 0) {
      throw rotationError("unsafe_audit_archive_digest_permissions");
    }
    const digestText = fs.readFileSync(sidecarPath, "utf8");
    const match = /^([0-9a-f]{64})  ([^/\0\r\n]+)\n$/.exec(digestText);
    if (!match || match[2] !== archiveName) {
      throw rotationError("audit_archive_orphan_digest_invalid");
    }
    if (stats.mtimeMs >= cutoff) {
      throw rotationError("audit_archive_orphan_digest_fresh");
    }
    fs.rmSync(sidecarPath);
    fsyncDirectory(input.archiveDirectory);
    recovered += 1;
  }
  return recovered;
}

function pendingRotations(input) {
  const prefix = `${path.basename(input.activePath)}.rotating-`;
  return fs.readdirSync(input.activeDirectory)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => path.join(input.activeDirectory, name));
}

function archiveRotatedFile(input, rotatingPath) {
  const stats = assertSafeRegularFile(rotatingPath);
  if (stats.size === 0) {
    fs.rmSync(rotatingPath, { force: true });
    fsyncDirectory(input.activeDirectory);
    return;
  }
  const archiveName = `${path.basename(rotatingPath).replace(".rotating-", "-")}.jsonl`;
  const archivePath = path.join(input.archiveDirectory, archiveName);
  const digestPath = `${archivePath}.sha256`;
  const sourceDigest = sha256File(rotatingPath);
  const pendingArchivePath = `${archivePath}.pending`;
  if (!fs.existsSync(archivePath)) {
    if (fs.existsSync(pendingArchivePath)) {
      const pendingDigest = sha256File(assertSafeRegularFilePath(pendingArchivePath));
      if (pendingDigest !== sourceDigest) fs.rmSync(pendingArchivePath);
    }
    if (!fs.existsSync(pendingArchivePath)) {
      fs.copyFileSync(rotatingPath, pendingArchivePath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(pendingArchivePath, 0o600);
      fsyncFile(pendingArchivePath);
      maybeCrashForTest("after_archive_pending_fsync");
    }
    if (sha256File(pendingArchivePath) !== sourceDigest) {
      throw rotationError("audit_archive_checksum_mismatch");
    }
    fs.renameSync(pendingArchivePath, archivePath);
    fsyncDirectory(input.archiveDirectory);
    maybeCrashForTest("after_archive_rename");
  } else {
    assertSafeRegularFile(archivePath);
    fs.rmSync(pendingArchivePath, { force: true });
  }
  const archiveDigest = sha256File(archivePath);
  if (sourceDigest !== archiveDigest) {
    throw rotationError("audit_archive_checksum_mismatch");
  }
  const expectedDigestText = `${archiveDigest}  ${path.basename(archivePath)}\n`;
  if (fs.existsSync(digestPath)) {
    assertSafeRegularFile(digestPath);
    if (fs.readFileSync(digestPath, "utf8") !== expectedDigestText) {
      throw rotationError("audit_archive_digest_mismatch");
    }
  } else {
    atomicWriteText(digestPath, expectedDigestText);
    maybeCrashForTest("after_digest_write");
  }
  fsyncDirectory(input.archiveDirectory);
  maybeCrashForTest("before_rotating_remove");
  fs.rmSync(rotatingPath);
  fsyncDirectory(input.activeDirectory);
}

function pruneArchives(input) {
  const cutoff = Date.now() - input.retentionDays * 86_400_000;
  const archiveNames = fs.readdirSync(input.archiveDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  let deleted = 0;
  for (const name of archiveNames) {
    const archivePath = path.join(input.archiveDirectory, name);
    const stats = assertSafeRegularFile(archivePath);
    if (stats.mtimeMs >= cutoff) continue;
    validateArchiveDigestPair(archivePath);
    fs.rmSync(archivePath);
    fsyncDirectory(input.archiveDirectory);
    maybeCrashForTest("after_pruned_archive_remove");
    fs.rmSync(`${archivePath}.sha256`);
    fsyncDirectory(input.archiveDirectory);
    deleted += 1;
  }
  return deleted;
}

function validateArchiveDigestPair(archivePath) {
  const digestPath = `${archivePath}.sha256`;
  const digestStats = assertSafeRegularFile(digestPath);
  if ((digestStats.mode & 0o077) !== 0) {
    throw rotationError("unsafe_audit_archive_digest_permissions");
  }
  const archiveDigest = sha256File(archivePath);
  const expected = `${archiveDigest}  ${path.basename(archivePath)}\n`;
  if (fs.readFileSync(digestPath, "utf8") !== expected) {
    throw rotationError("audit_archive_digest_mismatch");
  }
}

function verifyHeartbeat(input) {
  try {
    const stats = assertSafeRegularFile(input.heartbeatPath);
    const heartbeat = JSON.parse(fs.readFileSync(input.heartbeatPath, "utf8"));
    const checkedAt = Date.parse(String(heartbeat.checkedAt || ""));
    const maxAgeMs = (input.intervalSeconds + 300) * 1_000;
    if (
      heartbeat.ok !== true ||
      !Number.isFinite(checkedAt) ||
      Date.now() - checkedAt > maxAgeMs ||
      Date.now() - stats.mtimeMs > maxAgeMs
    ) {
      process.exitCode = 1;
    }
  } catch {
    process.exitCode = 1;
  }
}

function readConfig() {
  const activePath = requiredAbsoluteFilePath(
    "OWNMINUTES_SECRET_AUDIT_LOG",
    "/app/.data/auth/secret-audit.jsonl",
  );
  const archiveDirectory = requiredAbsoluteDirectory(
    "OWNMINUTES_SECRET_AUDIT_ARCHIVE_DIR",
    "/app/.data/audit-archive",
  );
  const heartbeatPath = requiredAbsoluteFilePath(
    "OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE",
    path.join(path.dirname(activePath), ".rotation-heartbeat.json"),
  );
  if (heartbeatPath === activePath || archiveDirectory === path.dirname(activePath)) {
    throw rotationError("audit_rotation_paths_not_isolated");
  }
  return {
    activeDirectory: path.dirname(activePath),
    activePath,
    archiveDirectory,
    heartbeatPath,
    intervalSeconds: boundedInteger("OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS", 300, 60, 86_400),
    retentionDays: boundedInteger("OWNMINUTES_SECRET_AUDIT_RETENTION_DAYS", 180, 30, 2_555),
    rotateBytes: boundedInteger("OWNMINUTES_SECRET_AUDIT_ROTATE_BYTES", 50 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
  };
}

function previousRotationAt(heartbeatPath) {
  try {
    const value = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
    return typeof value.lastRotationAt === "string" ? value.lastRotationAt : null;
  } catch {
    return null;
  }
}

function assertSafeDirectory(directory, create) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw rotationError("unsafe_audit_directory");
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  fs.chmodSync(directory, 0o700);
  return stats;
}

function assertSafeRegularFile(filePath) {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) throw rotationError("unsafe_audit_file");
  return stats;
}

function assertSafeRegularFilePath(filePath) {
  assertSafeRegularFile(filePath);
  return filePath;
}

function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, `${JSON.stringify(value)}\n`);
}

function atomicWriteText(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, value, { mode: 0o600, flag: "wx" });
  try {
    fsyncFile(temporaryPath);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
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

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requiredAbsoluteFilePath(name, fallback) {
  const value = String(process.env[name] || fallback).trim();
  if (!path.isAbsolute(value) || value.includes("\0") || path.basename(value).length === 0) {
    throw rotationError(`invalid_${name.toLowerCase()}`);
  }
  return path.normalize(value);
}

function requiredAbsoluteDirectory(name, fallback) {
  const value = String(process.env[name] || fallback).trim();
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw rotationError(`invalid_${name.toLowerCase()}`);
  }
  return path.normalize(value);
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw rotationError(`invalid_${name.toLowerCase()}`);
  }
  return value;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function maybeCrashForTest(phase) {
  if (
    process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_TEST_HOOKS === "1" &&
    process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_TEST_CRASH_PHASE === phase
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

function rotationError(code) {
  const error = new Error(code);
  error.name = "SecretAuditRotationError";
  return error;
}
