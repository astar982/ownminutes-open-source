#!/usr/bin/env node

import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { spawnSyncWithInheritedFileLocks } from "./lib/inherited-file-lock.mjs";

const root = process.cwd();
const mode = argument("--mode") || "production";
const artifactArgument = argument("--artifact");
const supportedModes = new Set(["production", "production-like"]);
const mcImage = "quay.io/minio/mc:latest@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727";

if (!supportedModes.has(mode)) throw new Error(`Unsupported mode: ${mode}.`);

const source = loadSourceConfig();
const target = loadTargetConfig();
ensurePrivateBackupDirectory();
if (process.env.OWNMINUTES_BACKUP_OPERATION_LOCK_HELD !== "1") {
  runLockedReplication();
}
const artifact = resolveArtifact();
await validateTargetNetwork();
await replicate();

function loadSourceConfig() {
  if (mode === "production-like") {
    return {
      backupDir: path.resolve(process.env.OWNMINUTES_BACKUP_DIR || path.join(root, ".data", "production-like", "backups")),
      environment: {},
    };
  }

  const envFile = path.resolve(process.env.OWNMINUTES_PRODUCTION_ENV_FILE || path.join(root, "deploy", ".env.production"));
  if (!fs.existsSync(envFile)) throw new Error("Production environment is not initialized.");
  const env = parseEnv(fs.readFileSync(envFile, "utf8"));
  return {
    backupDir: path.resolve(process.env.OWNMINUTES_BACKUP_DIR || env.OWNMINUTES_BACKUP_DIR || path.join(root, ".data", "production-backups")),
    environment: env,
  };
}

function loadTargetConfig() {
  const endpoint = value("OWNMINUTES_BACKUP_OFFSITE_ENDPOINT");
  const bucket = value("OWNMINUTES_BACKUP_OFFSITE_BUCKET");
  const prefix = normalizePrefix(value("OWNMINUTES_BACKUP_OFFSITE_PREFIX") || "ownminutes/backups");
  const accessKeyFile = path.resolve(value("OWNMINUTES_BACKUP_OFFSITE_ACCESS_KEY_FILE") || "");
  const secretKeyFile = path.resolve(value("OWNMINUTES_BACKUP_OFFSITE_SECRET_KEY_FILE") || "");
  const evidencePath = path.resolve(
    value("OWNMINUTES_BACKUP_OFFSITE_EVIDENCE_PATH") || path.join(root, ".data", "acceptance", "backup-offsite-latest.json"),
  );
  const dockerNetwork = value("OWNMINUTES_BACKUP_OFFSITE_DOCKER_NETWORK");
  const allowInsecureTest = value("OWNMINUTES_BACKUP_OFFSITE_ALLOW_INSECURE_TEST") === "1";
  const retentionDays = boundedInteger(value("OWNMINUTES_BACKUP_OFFSITE_RETENTION_DAYS") || "35", 1, 365);
  const retentionTestSeconds = allowInsecureTest
    ? boundedInteger(value("OWNMINUTES_BACKUP_OFFSITE_RETENTION_TEST_SECONDS") || "0", 0, 60)
    : 0;
  const failAfterTemporaryVerification =
    value("OWNMINUTES_BACKUP_OFFSITE_TEST_FAIL_AFTER_TEMP_VERIFY") === "1";

  validateEndpoint(endpoint, allowInsecureTest);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Off-site backup bucket name is invalid.");
  readPrivateSecret(accessKeyFile, "off-site access key", 3);
  readPrivateSecret(secretKeyFile, "off-site secret key", 8);
  if (dockerNetwork && !allowInsecureTest) throw new Error("A custom Docker network is allowed only in an explicit insecure test.");
  if (failAfterTemporaryVerification && !allowInsecureTest) {
    throw new Error("Off-site backup failure injection is allowed only in an explicit insecure test.");
  }

  return {
    endpoint,
    bucket,
    prefix,
    accessKeyFile,
    secretKeyFile,
    evidencePath,
    dockerNetwork,
    allowInsecureTest,
    retentionDays,
    retentionTestSeconds,
    failAfterTemporaryVerification,
  };
}

function ensurePrivateBackupDirectory() {
  fs.mkdirSync(source.backupDir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(source.backupDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Backup directory must be a real private directory.");
  }
  fs.chmodSync(source.backupDir, 0o700);
}

function runLockedReplication() {
  const result = spawnSyncWithInheritedFileLocks(
    "perl",
    [
      path.join(root, "scripts", "with-file-lock.pl"),
      path.join(source.backupDir, ".backup-operation.lock"),
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
    throw new Error(`Backup replication lock child terminated by ${result.signal}.`);
  }
  process.exit(result.status ?? 1);
}

async function validateTargetNetwork() {
  if (target.allowInsecureTest) return;
  const hostname = new URL(target.endpoint).hostname;
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("Off-site backup endpoint hostname could not be resolved.");
  }
  if (records.length === 0 || records.some((record) => isPrivateHostname(record.address))) {
    throw new Error("Off-site backup endpoint resolves to a private or unsupported address.");
  }
}

async function replicate() {
  assertDocker();
  const artifactName = path.basename(artifact);
  const objectKey = `${target.prefix}/${artifactName}`;
  const temporaryObjectKey = `${target.prefix}/.pending-${crypto.randomUUID()}-${artifactName}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-offsite-verify-"));
  fs.chmodSync(scratch, 0o700);
  const fixedArtifact = path.join(scratch, "source.ombak");
  const artifactIdentity = snapshotArtifact(artifact, fixedArtifact);
  const bytes = artifactIdentity.bytes;
  const sha256 = artifactIdentity.sha256;
  const temporaryDownload = path.join(scratch, "temporary.ombak");
  const finalDownload = path.join(scratch, "final.ombak");
  const retainedDownload = path.join(scratch, "retained.ombak");

  try {
    const temporaryVerificationCommand = [
      "set -eu",
      'ACCESS_KEY=$(cat /run/secrets/access-key)',
      'SECRET_KEY=$(cat /run/secrets/secret-key)',
      'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
      'mc ls "offsite/$OFFSITE_BUCKET/$OFFSITE_PREFIX/" >/dev/null',
      'mc cp --attr "X-Amz-Meta-Ownminutes-Sha256=$ARTIFACT_SHA256" /source/backup.ombak "offsite/$OFFSITE_BUCKET/$OFFSITE_TEMPORARY_OBJECT_KEY" >/dev/null',
      'mc stat "offsite/$OFFSITE_BUCKET/$OFFSITE_TEMPORARY_OBJECT_KEY" >/dev/null',
      'mc cp "offsite/$OFFSITE_BUCKET/$OFFSITE_TEMPORARY_OBJECT_KEY" /verify/temporary.ombak >/dev/null',
    ].join(" && ");
    runBackupClient(temporaryVerificationCommand, {
      artifact: fixedArtifact,
      scratch,
      objectKey,
      temporaryObjectKey,
      sha256,
    });
    verifyDownloadedBackup(temporaryDownload, bytes, sha256, "temporary");

    if (target.failAfterTemporaryVerification) {
      throw new Error("Injected off-site backup failure after temporary verification.");
    }

    const promotionCommand = [
      "set -eu",
      'ACCESS_KEY=$(cat /run/secrets/access-key)',
      'SECRET_KEY=$(cat /run/secrets/secret-key)',
      'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
      'mc cp "offsite/$OFFSITE_BUCKET/$OFFSITE_TEMPORARY_OBJECT_KEY" "offsite/$OFFSITE_BUCKET/$OFFSITE_OBJECT_KEY" >/dev/null',
      'mc stat "offsite/$OFFSITE_BUCKET/$OFFSITE_OBJECT_KEY" >/dev/null',
      'mc cp "offsite/$OFFSITE_BUCKET/$OFFSITE_OBJECT_KEY" /verify/final.ombak >/dev/null',
    ].join(" && ");
    runBackupClient(promotionCommand, { scratch, objectKey, temporaryObjectKey });
    const promoted = verifyDownloadedBackup(finalDownload, bytes, sha256, "promoted");

    const removeTemporaryCommand = [
      "set -eu",
      'ACCESS_KEY=$(cat /run/secrets/access-key)',
      'SECRET_KEY=$(cat /run/secrets/secret-key)',
      'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
      'mc rm --force "offsite/$OFFSITE_BUCKET/$OFFSITE_TEMPORARY_OBJECT_KEY" >/dev/null',
    ].join(" && ");
    runBackupClient(removeTemporaryCommand, { temporaryObjectKey });

    const listCommand = [
      "set -eu",
      'ACCESS_KEY=$(cat /run/secrets/access-key)',
      'SECRET_KEY=$(cat /run/secrets/secret-key)',
      'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
      'mc ls --recursive --json "offsite/$OFFSITE_BUCKET/$OFFSITE_PREFIX/"',
    ].join(" && ");
    const listed = runBackupClient(listCommand).stdout;
    const retentionCutoff = Date.now() - (
      target.retentionTestSeconds
        ? target.retentionTestSeconds * 1_000
        : target.retentionDays * 24 * 60 * 60 * 1_000
    );
    const retentionTargets = selectRetentionTargets(listed, objectKey, retentionCutoff);
    if (retentionTargets.length > 0) {
      const deleteTargetsFile = path.join(scratch, "delete-targets.txt");
      fs.writeFileSync(
        deleteTargetsFile,
        `${retentionTargets.map((key) => `offsite/${target.bucket}/${key}`).join("\n")}\n`,
        { mode: 0o600 },
      );
      const retentionDeleteCommand = [
        "set -eu",
        'ACCESS_KEY=$(cat /run/secrets/access-key)',
        'SECRET_KEY=$(cat /run/secrets/secret-key)',
        'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
        'mc rm --force --stdin < /verify/delete-targets.txt >/dev/null',
      ].join(" && ");
      runBackupClient(retentionDeleteCommand, { scratch });
    }

    const retainedVerificationCommand = [
      "set -eu",
      'ACCESS_KEY=$(cat /run/secrets/access-key)',
      'SECRET_KEY=$(cat /run/secrets/secret-key)',
      'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
      'mc stat "offsite/$OFFSITE_BUCKET/$OFFSITE_OBJECT_KEY" >/dev/null',
      'mc cp "offsite/$OFFSITE_BUCKET/$OFFSITE_OBJECT_KEY" /verify/retained.ombak >/dev/null',
    ].join(" && ");
    runBackupClient(retainedVerificationCommand, {
      scratch,
      objectKey,
    });
    verifyDownloadedBackup(retainedDownload, bytes, sha256, "post-retention");

    const endpointUrl = new URL(target.endpoint);
    const evidence = {
      ok: true,
      format: "ownminutes-backup-offsite-evidence:v1",
      replicatedAt: new Date().toISOString(),
      mode,
      artifactName,
      artifactDevice: artifactIdentity.device,
      artifactInode: artifactIdentity.inode,
      bytes,
      sha256,
      target: {
        protocol: endpointUrl.protocol,
        hostname: endpointUrl.hostname,
        port: endpointUrl.port || (endpointUrl.protocol === "https:" ? "443" : "80"),
        bucket: target.bucket,
        objectKey,
      },
      verification: {
        temporaryUploadVerified: true,
        promotionSucceeded: true,
        remoteStatSucceeded: true,
        fullDownloadVerified: true,
        downloadedBytes: promoted.bytes,
        downloadedSha256: promoted.sha256,
        retainedAfterCleanup: true,
      },
      retention: {
        cleanupSucceeded: true,
        days: target.retentionDays,
        deletedObjects: retentionTargets.length,
        currentArtifactPreserved: true,
      },
      secretsPrinted: false,
    };
    atomicWritePrivateJson(target.evidencePath, evidence);
    console.log(JSON.stringify({ ...evidence, evidencePath: target.evidencePath }, null, 2));
  } finally {
    const cleanupTemporaryCommand = [
      'ACCESS_KEY=$(cat /run/secrets/access-key)',
      'SECRET_KEY=$(cat /run/secrets/secret-key)',
      'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
      'mc rm --force "offsite/$OFFSITE_BUCKET/$OFFSITE_TEMPORARY_OBJECT_KEY" >/dev/null 2>&1',
    ].join(" && ");
    runBackupClient(cleanupTemporaryCommand, { temporaryObjectKey }, { allowFailure: true });
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

function selectRetentionTargets(output, currentObjectKey, cutoffMs) {
  const entries = String(output)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error("Off-site backup retention listing returned invalid JSON.");
      }
    });
  const managed = new Map();
  for (const entry of entries) {
    if (entry.status && entry.status !== "success") {
      throw new Error("Off-site backup retention listing reported a failure.");
    }
    if (entry.type && entry.type !== "file") continue;
    const objectKey = normalizeListedObjectKey(entry.key);
    if (!objectKey || !isManagedOffsiteObject(objectKey)) continue;
    const modifiedAt = Date.parse(entry.lastModified);
    if (!Number.isFinite(modifiedAt)) {
      throw new Error("Off-site backup retention listing omitted a valid modification time.");
    }
    managed.set(objectKey, modifiedAt);
  }
  if (!managed.has(currentObjectKey)) {
    throw new Error("The verified current off-site backup is missing from the retention listing.");
  }
  return [...managed.entries()]
    .filter(([objectKey, modifiedAt]) => objectKey !== currentObjectKey && modifiedAt < cutoffMs)
    .map(([objectKey]) => objectKey)
    .slice(0, 5_000);
}

function normalizeListedObjectKey(raw) {
  if (typeof raw !== "string" || raw.includes("\0") || raw.includes("\n") || raw.includes("\r")) return "";
  const key = raw.replace(/^\/+/, "");
  if (key.startsWith(`${target.prefix}/`)) return key;
  if (key.startsWith(`${target.bucket}/${target.prefix}/`)) return key.slice(target.bucket.length + 1);
  if (!key.includes("/")) return `${target.prefix}/${key}`;
  return "";
}

function isManagedOffsiteObject(objectKey) {
  const prefix = `${target.prefix}/`;
  if (!objectKey.startsWith(prefix)) return false;
  const name = objectKey.slice(prefix.length);
  const artifactPattern = /^ownminutes-(?:production|production-like)-\d{8}T\d{6}Z\.ombak$/;
  const pendingPattern = /^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-ownminutes-(?:production|production-like)-\d{8}T\d{6}Z\.ombak$/i;
  return artifactPattern.test(name) || pendingPattern.test(name);
}

function runBackupClient(command, options = {}, runOptions = {}) {
  const args = [
    "run", "--rm",
    ...(target.dockerNetwork ? ["--network", target.dockerNetwork] : []),
    "-e", `OFFSITE_ENDPOINT=${target.endpoint}`,
    "-e", `OFFSITE_BUCKET=${target.bucket}`,
    "-e", `OFFSITE_PREFIX=${target.prefix}`,
    ...(options.objectKey ? ["-e", `OFFSITE_OBJECT_KEY=${options.objectKey}`] : []),
    ...(options.temporaryObjectKey ? ["-e", `OFFSITE_TEMPORARY_OBJECT_KEY=${options.temporaryObjectKey}`] : []),
    ...(options.sha256 ? ["-e", `ARTIFACT_SHA256=${options.sha256}`] : []),
    ...(options.artifact ? ["-v", `${options.artifact}:/source/backup.ombak:ro`] : []),
    ...(options.scratch ? ["-v", `${options.scratch}:/verify`] : []),
    "-v", `${target.accessKeyFile}:/run/secrets/access-key:ro`,
    "-v", `${target.secretKeyFile}:/run/secrets/secret-key:ro`,
    "--entrypoint", "/bin/sh",
    mcImage,
    "-c", command,
  ];
  return run("docker", args, runOptions);
}

function verifyDownloadedBackup(file, expectedBytes, expectedSha256, stage) {
  if (!fs.existsSync(file)) throw new Error(`Off-site ${stage} verification download is missing.`);
  const bytes = fs.statSync(file).size;
  const sha256 = sha256File(file);
  if (bytes !== expectedBytes || sha256 !== expectedSha256) {
    throw new Error(`Off-site ${stage} backup failed full download checksum verification.`);
  }
  return { bytes, sha256 };
}

function resolveArtifact() {
  if (artifactArgument) {
    const resolved = path.resolve(artifactArgument);
    if (
      path.dirname(resolved) !== source.backupDir ||
      !managedArtifactName(path.basename(resolved))
    ) {
      throw new Error("Backup artifact must be a managed file inside the configured backup directory.");
    }
    return resolved;
  }
  if (!fs.existsSync(source.backupDir)) throw new Error(`Backup directory does not exist: ${source.backupDir}.`);
  const candidates = fs.readdirSync(source.backupDir)
    .filter(managedArtifactName)
    .sort()
    .reverse();
  if (!candidates[0]) throw new Error(`No encrypted backup exists in ${source.backupDir}.`);
  return path.join(source.backupDir, candidates[0]);
}

function managedArtifactName(name) {
  const prefix = `ownminutes-${mode}-`;
  return name.startsWith(prefix) && /^\d{8}T\d{6}Z\.ombak$/.test(name.slice(prefix.length));
}

function snapshotArtifact(file, destination) {
  assertPrivateArtifact(file);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const sourceDescriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  let destinationDescriptor;
  try {
    const before = fs.fstatSync(sourceDescriptor, { bigint: true });
    const beforePath = fs.lstatSync(file, { bigint: true });
    if (
      !before.isFile() ||
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      (before.mode & 0o077n) !== 0n ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("Backup artifact identity is unsafe.");
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0n;
    while (true) {
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(destinationDescriptor, buffer, offset, bytesRead - offset);
      }
      hash.update(buffer.subarray(0, bytesRead));
      total += BigInt(bytesRead);
    }
    fs.fsyncSync(destinationDescriptor);
    fs.fchmodSync(destinationDescriptor, 0o400);
    const after = fs.fstatSync(sourceDescriptor, { bigint: true });
    const afterPath = fs.lstatSync(file, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== afterPath.dev ||
      before.ino !== afterPath.ino ||
      before.size !== afterPath.size ||
      before.mtimeNs !== afterPath.mtimeNs ||
      before.ctimeNs !== afterPath.ctimeNs ||
      total !== before.size
    ) {
      throw new Error("Backup artifact changed while its fixed replication copy was created.");
    }
    return {
      bytes: Number(before.size),
      sha256: hash.digest("hex"),
      device: String(before.dev),
      inode: String(before.ino),
    };
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
}

function validateEndpoint(raw, allowInsecureTest) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Off-site backup endpoint must be an absolute URL.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Off-site backup endpoint must not contain credentials, path, query, or hash.");
  }
  if (allowInsecureTest) {
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Test endpoint must use HTTP or HTTPS.");
    return;
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || isPrivateHostname(url.hostname)) {
    throw new Error("Production off-site endpoint must use public HTTPS on the default port.");
  }
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "host.docker.internal" || normalized.endsWith(".local")) return true;
  if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function normalizePrefix(raw) {
  const prefix = raw.replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.split("/").some((part) => !/^[a-zA-Z0-9._-]+$/.test(part) || part === "..")) {
    throw new Error("Off-site backup prefix is invalid.");
  }
  return prefix;
}

function assertPrivateArtifact(file) {
  if (!fs.existsSync(file)) throw new Error(`Backup artifact is missing: ${file}.`);
  const stats = fs.lstatSync(file);
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o077) !== 0 || !file.endsWith(".ombak")) {
    throw new Error("Backup artifact must be a 0600 .ombak regular file.");
  }
}

function atomicWritePrivateJson(filePath, valueToWrite) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = fs.lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Off-site backup evidence directory is unsafe.");
  }
  fs.chmodSync(directory, 0o700);
  const temporaryPath =
    `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(valueToWrite, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  try {
    const descriptor = fs.openSync(temporaryPath, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readPrivateSecret(file, label, minimumLength) {
  if (!file || !fs.existsSync(file)) throw new Error(`The ${label} file is missing.`);
  const stats = fs.statSync(file);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new Error(`The ${label} file must be a 0600 regular file.`);
  const secret = fs.readFileSync(file, "utf8").trim();
  if (secret.length < minimumLength) throw new Error(`The ${label} is too short.`);
  return secret;
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

function assertDocker() {
  const result = run("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  if (result.status !== 0) throw new Error("Docker is unavailable.");
}

function run(executable, args, options = {}) {
  const result = spawnSyncWithInheritedFileLocks(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${executable} command failed with status ${result.status}. ${String(result.stderr || result.stdout || "").trim().slice(-1200)}`);
  }
  return result;
}

function value(name) {
  return process.env[name]?.trim() || source.environment?.[name]?.trim() || "";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function boundedInteger(raw, minimum, maximum) {
  const number = Number(raw);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`Off-site retention must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}
