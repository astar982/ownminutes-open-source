#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { spawnSyncWithInheritedFileLocks } from "./lib/inherited-file-lock.mjs";

const root = process.cwd();
const mode = argument("--mode") || "production";
const strict = process.argv.includes("--strict");
const config = loadConfig();
ensurePrivateBackupDirectory();
if (process.env.OWNMINUTES_BACKUP_OPERATION_LOCK_HELD !== "1") {
  runLockedFreshnessCheck();
}
const now = Date.now();
const latest = latestArtifact(config.backupDir);
const offsite = readPrivateJson(config.offsiteEvidencePath);
const restore = readPrivateJson(config.restoreEvidencePath);
const verification = readPrivateJson(config.verifyEvidencePath);
const checks = [];

checks.push(check("backup-exists", Boolean(latest), "A local encrypted backup exists.", "No local .ombak backup exists."));
checks.push(check("backup-private", !latest || isPrivateFile(latest.path), "Latest backup is owner-only.", "Latest backup must be a 0600 regular file."));
checks.push(check("backup-verification-private", isPrivateFile(config.verifyEvidencePath), "Backup verification evidence is owner-only.", "Backup verification evidence must be a 0600 regular file."));
checks.push(check("backup-verification-valid", verification?.ok === true && verification?.format === "ownminutes-backup-verify-evidence:v1" && verification?.action === "verify" && verification?.mode === mode && verification?.backupFormat === "ownminutes-backup:v2" && Number.isSafeInteger(verification?.artifactBytes) && verification.artifactBytes > 0 && /^[0-9a-f]{64}$/.test(String(verification?.artifactSha256 || "")) && /^\d+$/.test(String(verification?.artifactDevice || "")) && /^\d+$/.test(String(verification?.artifactInode || "")), "Latest backup was decrypted and its current manifest was verified.", "Latest backup verification evidence is missing, invalid, or legacy."));
checks.push(check("backup-verification-matches-latest", !latest || (verification?.artifactName === latest.name && verification?.artifactBytes === latest.bytes && verification?.artifactSha256 === latest.sha256 && verification?.artifactDevice === latest.device && verification?.artifactInode === latest.inode), "Decrypted verification evidence matches the latest encrypted artifact.", "Decrypted verification evidence does not match the latest encrypted artifact."));
checks.push(check("backup-created-at-valid", validCanonicalDate(verification?.backupCreatedAt), "Decrypted backup creation time is present in verification evidence.", "Verification evidence is not bound to a valid decrypted manifest creation time."));
checks.push(check("backup-fresh", validCanonicalDate(verification?.backupCreatedAt) && ageHours(Date.parse(verification.backupCreatedAt)) <= config.maxBackupAgeHours, "Latest backup manifest creation time is fresh.", `Latest backup manifest creation time is older than ${config.maxBackupAgeHours} hours.`));
checks.push(check("backup-not-in-future", validCanonicalDate(verification?.backupCreatedAt) && Date.parse(verification.backupCreatedAt) <= now + config.maximumClockSkewMs, "Latest backup manifest creation time is plausible.", "Latest backup manifest creation time is too far in the future."));
checks.push(check("offsite-evidence-private", isPrivateFile(config.offsiteEvidencePath), "Off-site evidence is owner-only.", "Off-site evidence must be a 0600 regular file."));
checks.push(check("offsite-evidence-valid", offsite?.ok === true && offsite?.format === "ownminutes-backup-offsite-evidence:v1" && offsite?.mode === mode && offsite?.verification?.fullDownloadVerified === true && offsite?.secretsPrinted === false, "Off-site full-download verification passed.", "Off-site replication evidence is missing, invalid, or for a different mode."));
checks.push(check("offsite-fresh", validDate(offsite?.replicatedAt) && ageHours(Date.parse(offsite.replicatedAt)) <= config.maxOffsiteAgeHours, "Off-site replication is fresh.", `Off-site replication evidence is older than ${config.maxOffsiteAgeHours} hours.`));
checks.push(check("offsite-not-in-future", validDate(offsite?.replicatedAt) && Date.parse(offsite.replicatedAt) <= now + config.maximumClockSkewMs, "Off-site evidence timestamp is plausible.", "Off-site evidence timestamp is too far in the future."));
checks.push(check("offsite-matches-latest", !latest || (offsite?.artifactName === latest.name && offsite?.bytes === latest.bytes && offsite?.sha256 === latest.sha256 && offsite?.verification?.downloadedSha256 === latest.sha256), "Off-site evidence matches the latest local backup.", "Off-site evidence does not match the latest local backup."));
checks.push(
  check(
    "offsite-retention-enforced",
    offsite?.retention?.cleanupSucceeded === true && offsite?.retention?.days === config.offsiteRetentionDays,
    "Off-site objects older than the configured retention window were cleaned before replication.",
    "Off-site retention cleanup evidence is missing or does not match policy.",
  ),
);
checks.push(check("restore-evidence-private", isPrivateFile(config.restoreEvidencePath), "Restore evidence is owner-only.", "Restore evidence must be a 0600 regular file."));
checks.push(check("restore-evidence-valid", restore?.ok === true && restore?.database?.restored === true && restore?.objects?.restored === true, "Isolated database and object restore passed.", "Restore drill evidence is missing or invalid."));
checks.push(check("restore-evidence-schema", restore?.format === "ownminutes-backup-restore-evidence:v2", "Restore evidence schema is current.", "Restore evidence schema is missing or unsupported."));
checks.push(check(
  "restore-object-references-verified",
  restore?.objects?.referencesVerified === true &&
    Number.isSafeInteger(restore?.objects?.activeMeetingCount) &&
    restore.objects.activeMeetingCount >= 0 &&
    Number.isSafeInteger(restore?.objects?.referencedObjectCount) &&
    restore.objects.referencedObjectCount >= 0,
  "Every active database meeting reference was verified against the restored object store.",
  "Restore evidence does not prove database-to-object reference reconciliation with valid counts.",
));
checks.push(check("restore-evidence-scope", restore?.action === "restore-drill" && restore?.mode === mode, "Restore evidence action and mode match this gate.", "Restore evidence was produced for a different action or mode."));
checks.push(check("restore-backup-format-current", restore?.backupFormat === "ownminutes-backup:v2", "Restore used the current audit-bearing backup format.", "Restore evidence came from a legacy backup without the current audit manifest."));
checks.push(check("restore-backup-created-at-bound", validCanonicalDate(restore?.backupCreatedAt), "Restore evidence records the creation time from the decrypted manifest.", "Restore evidence does not contain a canonical decrypted manifest creation time."));
checks.push(check("restore-audit-verified", restore?.audit?.verified === true && Number.isInteger(restore?.audit?.fileCount) && restore.audit.fileCount >= 0, "Secret-audit files were included in manifest verification.", "Restore evidence does not prove the audit snapshot was verified."));
checks.push(check(
  "restore-artifact-identity-valid",
  typeof restore?.artifactName === "string" &&
    /^ownminutes-(?:production|production-like)-\d{8}T\d{6}Z\.ombak$/.test(restore.artifactName) &&
    Number.isSafeInteger(restore?.artifactBytes) &&
    restore.artifactBytes > 0 &&
    /^[0-9a-f]{64}$/.test(String(restore?.artifactSha256 || "")) &&
    /^\d+$/.test(String(restore?.artifactDevice || "")) &&
    /^\d+$/.test(String(restore?.artifactInode || "")),
  "Restore evidence is bound to the fixed artifact identity used by the drill.",
  "Restore evidence is missing its fixed artifact identity.",
));
checks.push(check("restore-fresh", validDate(restore?.verifiedAt) && ageDays(Date.parse(restore.verifiedAt)) <= config.maxRestoreAgeDays, "Restore drill is within policy.", `Restore drill evidence is older than ${config.maxRestoreAgeDays} days.`));
checks.push(check("restore-not-in-future", validDate(restore?.verifiedAt) && Date.parse(restore.verifiedAt) <= now + config.maximumClockSkewMs, "Restore evidence timestamp is plausible.", "Restore evidence timestamp is too far in the future."));

const failures = checks.filter((item) => !item.ok);
const summary = {
  ok: failures.length === 0,
  strict,
  mode,
  policy: {
    maxBackupAgeHours: config.maxBackupAgeHours,
    maxOffsiteAgeHours: config.maxOffsiteAgeHours,
      offsiteRetentionDays: config.offsiteRetentionDays,
      maxRestoreAgeDays: config.maxRestoreAgeDays,
      maximumClockSkewMinutes: config.maximumClockSkewMs / 60_000,
  },
  latestBackup: latest
    ? {
        name: latest.name,
        bytes: latest.bytes,
        backupCreatedAt: verification?.backupCreatedAt || null,
        ageHours: validCanonicalDate(verification?.backupCreatedAt)
          ? rounded(ageHours(Date.parse(verification.backupCreatedAt)))
          : null,
        sha256: latest.sha256,
      }
    : null,
  offsite: offsite
    ? { replicatedAt: offsite.replicatedAt, hostname: offsite.target?.hostname, bucket: offsite.target?.bucket, objectKey: offsite.target?.objectKey, fullDownloadVerified: offsite.verification?.fullDownloadVerified === true }
    : null,
  verification: verification
    ? {
        verifiedAt: verification.verifiedAt,
        backupCreatedAt: verification.backupCreatedAt,
        backupFormat: verification.backupFormat,
        artifactName: verification.artifactName,
      }
    : null,
  restore: restore
    ? {
        verifiedAt: restore.verifiedAt,
        backupCreatedAt: restore.backupCreatedAt,
        backupFormat: restore.backupFormat,
        artifactName: restore.artifactName,
        databaseRestored: restore.database?.restored === true,
        objectsRestored: restore.objects?.restored === true,
        auditVerified: restore.audit?.verified === true,
      }
    : null,
  checks,
  failureIds: failures.map((item) => item.id),
  secretsPrinted: false,
};

console.log(JSON.stringify(summary, null, 2));
if (strict && !summary.ok) process.exit(1);

function loadConfig() {
  let backupDir = "";
  let fileEnvironment = {};
  if (mode === "production-like") {
    backupDir = path.resolve(process.env.OWNMINUTES_BACKUP_DIR || path.join(root, ".data", "production-like", "backups"));
  } else if (mode === "production") {
    const envFile = path.resolve(process.env.OWNMINUTES_PRODUCTION_ENV_FILE || path.join(root, "deploy", ".env.production"));
    if (!fs.existsSync(envFile)) throw new Error("Production environment is not initialized.");
    const env = parseEnv(fs.readFileSync(envFile, "utf8"));
    fileEnvironment = env;
    backupDir = path.resolve(process.env.OWNMINUTES_BACKUP_DIR || env.OWNMINUTES_BACKUP_DIR || path.join(root, ".data", "production-backups"));
  } else {
    throw new Error(`Unsupported mode: ${mode}.`);
  }

  return {
    backupDir,
    offsiteEvidencePath: path.resolve(process.env.OWNMINUTES_BACKUP_OFFSITE_EVIDENCE_PATH || fileEnvironment.OWNMINUTES_BACKUP_OFFSITE_EVIDENCE_PATH || path.join(root, ".data", "acceptance", "backup-offsite-latest.json")),
    restoreEvidencePath: path.resolve(process.env.OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH || fileEnvironment.OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH || path.join(root, ".data", "acceptance", "backup-restore-latest.json")),
    verifyEvidencePath: path.resolve(process.env.OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH || fileEnvironment.OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH || path.join(root, ".data", "acceptance", "backup-verify-latest.json")),
    maxBackupAgeHours: boundedNumber("OWNMINUTES_BACKUP_MAX_AGE_HOURS", fileEnvironment, 26, 1, 168),
    maxOffsiteAgeHours: boundedNumber("OWNMINUTES_BACKUP_OFFSITE_MAX_AGE_HOURS", fileEnvironment, 26, 1, 168),
    offsiteRetentionDays: boundedInteger("OWNMINUTES_BACKUP_OFFSITE_RETENTION_DAYS", fileEnvironment, 35, 1, 365),
    maxRestoreAgeDays: boundedNumber("OWNMINUTES_BACKUP_RESTORE_MAX_AGE_DAYS", fileEnvironment, 35, 1, 365),
    maximumClockSkewMs: 5 * 60_000,
  };
}

function ensurePrivateBackupDirectory() {
  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(config.backupDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Backup directory must be a real private directory.");
  }
  fs.chmodSync(config.backupDir, 0o700);
}

function runLockedFreshnessCheck() {
  const result = spawnSyncWithInheritedFileLocks(
    "perl",
    [
      path.join(root, "scripts", "with-file-lock.pl"),
      path.join(config.backupDir, ".backup-operation.lock"),
      "120",
      "--held-env=OWNMINUTES_BACKUP_OPERATION_LOCK_HELD",
      process.execPath,
      path.resolve(process.argv[1]),
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`Backup freshness lock child terminated by ${result.signal}.`);
  }
  process.exit(result.status ?? 1);
}

function latestArtifact(directory) {
  if (!fs.existsSync(directory)) return null;
  const candidates = fs.readdirSync(directory)
    .filter((name) => managedArtifactName(name))
    .sort()
    .reverse()
    .map((name) => {
      const artifactPath = path.join(directory, name);
      const before = fs.lstatSync(artifactPath);
      if (before.isSymbolicLink() || !before.isFile()) return null;
      const sha256 = sha256File(artifactPath);
      const after = fs.lstatSync(artifactPath);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        throw new Error("Latest backup artifact changed during freshness verification.");
      }
      return {
        path: artifactPath,
        name,
        bytes: before.size,
        sha256,
        device: String(before.dev),
        inode: String(before.ino),
      };
    })
    .filter(Boolean);
  if (!candidates[0]) return null;
  return candidates[0];
}

function readPrivateJson(file) {
  if (!isPrivateFile(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isPrivateFile(file) {
  try {
    const stats = fs.lstatSync(file);
    return !stats.isSymbolicLink() && stats.isFile() && (stats.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
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

function boundedNumber(name, fileEnvironment, fallback, minimum, maximum) {
  const number = Number(process.env[name] || fileEnvironment[name] || fallback);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return number;
}

function boundedInteger(name, fileEnvironment, fallback, minimum, maximum) {
  const number = boundedNumber(name, fileEnvironment, fallback, minimum, maximum);
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
  return number;
}

function check(id, ok, pass, fail) {
  return { id, ok: Boolean(ok), detail: ok ? pass : fail };
}

function ageHours(timestamp) {
  return Math.max(0, now - timestamp) / 3_600_000;
}

function ageDays(timestamp) {
  return Math.max(0, now - timestamp) / 86_400_000;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCanonicalDate(value) {
  if (!validDate(value)) return false;
  return new Date(Date.parse(value)).toISOString() === value;
}

function managedArtifactName(name) {
  const escapedMode = mode.replaceAll("-", "\\-");
  return new RegExp(`^ownminutes-${escapedMode}-\\d{8}T\\d{6}Z\\.ombak$`).test(name);
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
