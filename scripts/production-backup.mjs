#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseEnv } from "node:util";
import {
  spawnSyncWithInheritedFileLocks,
  spawnWithInheritedFileLocks,
} from "./lib/inherited-file-lock.mjs";
import {
  claimLegacyStackOwner,
  legacyStackOwnerFile,
} from "./lib/production-like-stack-owner.mjs";

const root = process.cwd();
const action = process.argv[2] || "create";
const mode = argument("--mode") || "production";
const artifactArgument = argument("--artifact");
const supportedActions = new Set(["create", "verify", "restore-drill"]);

if (!supportedActions.has(action)) throw new Error(`Unsupported action: ${action}.`);
if (!new Set(["production", "production-like"]).has(mode)) throw new Error(`Unsupported mode: ${mode}.`);

const config = loadConfig();
await main();

async function main() {
  ensurePrivateBackupDirectory();
  if (process.env.OWNMINUTES_BACKUP_OPERATION_LOCK_HELD !== "1") {
    runLockedBackupOperation();
    return;
  }
  cleanupPendingBackups();
  assertProductionLikeStackOwner();

  if (action === "create") {
    assertExecutable("docker", ["info", "--format", "{{.ServerVersion}}"]);
    await createBackup();
    return;
  }

  const artifact = resolveArtifact();
  if (action === "verify") {
    const result = await withVerifiedBackup(
      artifact,
      async ({ manifest, artifactIdentity }) => ({ manifest, artifactIdentity }),
    );
    const evidence = {
      ok: true,
      format: "ownminutes-backup-verify-evidence:v1",
      action,
      mode,
      artifact,
      ...artifactIdentitySummary(result.artifactIdentity),
      backupFormat: result.manifest.format,
      backupCreatedAt: result.manifest.createdAt,
      verifiedAt: new Date().toISOString(),
    };
    atomicWritePrivateJson(config.verifyEvidencePath, evidence);
    printSummary({
      ...evidence,
      ...manifestSummary(result.manifest),
      evidencePath: config.verifyEvidencePath,
    });
    return;
  }

  assertExecutable("docker", ["info", "--format", "{{.ServerVersion}}"]);
  await withVerifiedBackup(artifact, async ({ extractDir, manifest, artifactIdentity }) => {
    const databaseRestore = restoreDatabase(path.join(extractDir, manifest.database.path));
    const referenceVerification = verifyDatabaseObjectReferences(
      path.join(extractDir, "objects"),
      databaseRestore.activeMeetings,
    );
    const database = { ...databaseRestore };
    delete database.activeMeetings;
    const objects = {
      ...restoreObjects(path.join(extractDir, "objects"), manifest.objects.files.length),
      ...referenceVerification,
    };
    verifyAuditSnapshot(extractDir, manifest);
    const audit = {
      verified:
        manifest.format === "ownminutes-backup:v2" &&
        Array.isArray(manifest.audit?.files),
      fileCount: manifest.audit?.files?.length || 0,
      restorePolicy: "Audit archives are verified but never auto-restored over the active evidence volume.",
    };
    const evidence = {
      ok: true,
      format: "ownminutes-backup-restore-evidence:v2",
      action,
      mode,
      artifact,
      artifactName: artifactIdentity.name,
      artifactBytes: artifactIdentity.bytes,
      artifactSha256: artifactIdentity.sha256,
      artifactDevice: artifactIdentity.device,
      artifactInode: artifactIdentity.inode,
      backupFormat: manifest.format,
      backupCreatedAt: manifest.createdAt,
      verifiedAt: new Date().toISOString(),
      database,
      objects,
      audit,
      boundary: manifest.boundary,
    };
    const evidencePath = config.restoreEvidencePath;
    atomicWritePrivateJson(evidencePath, evidence);
    printSummary({ ...evidence, evidencePath });
  });
}

function loadConfig() {
  if (mode === "production-like") {
    const envFile = path.join(root, ".data", "production-like", "stack.env");
    if (!fs.existsSync(envFile)) throw new Error("Production-like stack is not initialized. Run `npm run stack:up` first.");
    const env = parseEnv(fs.readFileSync(envFile, "utf8"));
    const encryptionSecret = env.OWNMINUTES_BACKUP_ENCRYPTION_KEY?.trim();
    if (!encryptionSecret) throw new Error("Production-like backup key is missing. Run `npm run stack:up` once to migrate local secrets.");
    return {
      composeFile: path.join(root, "deploy", "compose.production-like.yml"),
      composeProjectName: requiredProductionLikeProjectName(
        env.OWNMINUTES_COMPOSE_PROJECT_NAME,
      ),
      stackId: requiredProductionLikeStackId(
        env.OWNMINUTES_STACK_FORMAT,
        env.OWNMINUTES_STACK_ID,
        env.OWNMINUTES_COMPOSE_PROJECT_NAME,
      ),
      envFile,
      backupDir: path.resolve(process.env.OWNMINUTES_BACKUP_DIR || path.join(root, ".data", "production-like", "backups")),
      retentionCount: positiveInteger(process.env.OWNMINUTES_BACKUP_RETENTION_COUNT, 3),
      databaseUser: "postgres",
      bucket: env.OWNMINUTES_COMPOSE_BUCKET || "ownminutes-local",
      storagePrefix: "ownminutes/meetings",
      encryptionSecret,
      restoreEvidencePath: path.resolve(
        process.env.OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH ||
        path.join(root, ".data", "acceptance", "backup-restore-latest.json"),
      ),
      verifyEvidencePath: path.resolve(
        process.env.OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH ||
        path.join(root, ".data", "acceptance", "backup-verify-latest.json"),
      ),
    };
  }

  const envFile = path.resolve(process.env.OWNMINUTES_PRODUCTION_ENV_FILE || path.join(root, "deploy", ".env.production"));
  if (!fs.existsSync(envFile)) throw new Error("Production environment is not initialized. Run `npm run production:init` first.");
  const env = parseEnv(fs.readFileSync(envFile, "utf8"));
  const keyFile = path.resolve(env.OWNMINUTES_BACKUP_ENCRYPTION_KEY_FILE || "");
  const encryptionSecret = readPrivateSecret(keyFile, "backup encryption key");
  return {
    composeFile: path.join(root, "deploy", "compose.production.yml"),
    composeProjectName: "",
    stackId: "",
    envFile,
    backupDir: path.resolve(process.env.OWNMINUTES_BACKUP_DIR || env.OWNMINUTES_BACKUP_DIR || path.join(root, ".data", "production-backups")),
    retentionCount: positiveInteger(process.env.OWNMINUTES_BACKUP_RETENTION_COUNT || env.OWNMINUTES_BACKUP_RETENTION_COUNT, 7),
    databaseUser: "postgres",
    bucket: "ownminutes",
    storagePrefix: "ownminutes/meetings",
    encryptionSecret,
    restoreEvidencePath: path.resolve(
      process.env.OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH ||
      env.OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH ||
      path.join(root, ".data", "acceptance", "backup-restore-latest.json"),
    ),
    verifyEvidencePath: path.resolve(
      process.env.OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH ||
      env.OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH ||
      path.join(root, ".data", "acceptance", "backup-verify-latest.json"),
    ),
  };
}

async function createBackup() {
  const createdAt = new Date();
  const stamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const artifact = path.join(config.backupDir, `ownminutes-${mode}-${stamp}.ombak`);
  const pendingArtifact = path.join(
    config.backupDir,
    `.${path.basename(artifact)}.pending-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-backup-create-"));
  fs.chmodSync(scratch, 0o700);
  let backupBarrier;
  try {
    const databasePath = path.join(scratch, "database.dump");
    const objectsDir = path.join(scratch, "objects");
    const auditDir = path.join(scratch, "audit");
    fs.mkdirSync(objectsDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });
    backupBarrier = await acquireBackupObjectBarrier();
    try {
      await dumpDatabase(databasePath);
      mirrorObjects(objectsDir);
      mirrorAuditLogs(auditDir);
    } finally {
      releaseBackupObjectBarrier(backupBarrier);
      backupBarrier = undefined;
    }

    const objectFiles = collectFiles(objectsDir).map((file) => ({
      path: path.relative(objectsDir, file).split(path.sep).join("/"),
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
    }));
    const auditFiles = collectFiles(auditDir).map((file) => ({
      path: path.relative(auditDir, file).split(path.sep).join("/"),
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
    }));
    const manifest = {
      format: "ownminutes-backup:v2",
      createdAt: createdAt.toISOString(),
      mode,
      database: {
        path: "database.dump",
        bytes: fs.statSync(databasePath).size,
        sha256: sha256File(databasePath),
        format: "postgres-custom",
      },
      objects: {
        count: objectFiles.length,
        files: objectFiles,
      },
      audit: {
        count: auditFiles.length,
        files: auditFiles,
      },
      boundary: "Includes PostgreSQL, current object versions, and active/rotated secret-audit files; deleted and noncurrent MinIO versions still require an independent version-aware off-host policy.",
    };
    fs.writeFileSync(path.join(scratch, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const archive = path.join(os.tmpdir(), `ownminutes-${crypto.randomUUID()}.tar.gz`);
    try {
      run("tar", ["-czf", archive, "-C", scratch, "manifest.json", "database.dump", "objects", "audit"]);
      if (fs.existsSync(artifact)) {
        throw new Error(`Backup artifact already exists: ${path.basename(artifact)}.`);
      }
      await encryptArchive(archive, pendingArtifact);
      fs.chmodSync(pendingArtifact, 0o600);
      fsyncFile(pendingArtifact);
      maybeCrashForTest("after_backup_pending_fsync");
      fs.renameSync(pendingArtifact, artifact);
      fsyncDirectory(config.backupDir);
    } finally {
      fs.rmSync(archive, { force: true });
      fs.rmSync(pendingArtifact, { force: true });
    }
    pruneBackups();
    printSummary({ ok: true, action, mode, artifact, ...manifestSummary(manifest), retentionCount: config.retentionCount });
  } finally {
    if (backupBarrier) releaseBackupObjectBarrier(backupBarrier);
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

async function acquireBackupObjectBarrier() {
  const applicationName =
    `ownminutes-backup-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const marker = `OWNMINUTES_BACKUP_BARRIER_ACQUIRED:${applicationName}`;
  const sql = [
    "select pg_advisory_lock(hashtextextended('ownminutes-backup-object-barrier:v1', 0));",
    `select '${marker}';`,
  ].join(" ");
  const child = spawnWithInheritedFileLocks(
    "docker",
    composeArguments([
      "exec",
      "-T",
      "postgres",
      "env",
      `PGAPPNAME=${applicationName}`,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      config.databaseUser,
      "-d",
      "ownminutes",
      "-At",
    ]),
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.write(`${sql}\n`);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 16_000) stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 16_000) stderr += chunk.toString("utf8");
  });
  const deadline = Date.now() + 120_000;
  while (!stdout.includes(marker)) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(
        `Backup object barrier exited before acquisition. ${stderr.trim().slice(-800)}`,
      );
    }
    if (Date.now() >= deadline) {
      releaseBackupObjectBarrier({ applicationName, child });
      throw new Error("Timed out acquiring the backup object consistency barrier.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { applicationName, child };
}

function releaseBackupObjectBarrier(barrier) {
  if (!barrier) return;
  const sql =
    `select pg_terminate_backend(pid) from pg_stat_activity ` +
    `where application_name = '${barrier.applicationName}' and pid <> pg_backend_pid();`;
  const result = compose(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      config.databaseUser,
      "-d",
      "ownminutes",
      "-At",
      "-c",
      sql,
    ],
    { allowFailure: true, encoding: "utf8" },
  );
  barrier.child.stdin.end("\\q\n");
  barrier.child.kill("SIGTERM");
  if (result.status !== 0) {
    throw new Error("Unable to terminate the PostgreSQL backup barrier session.");
  }
}

async function dumpDatabase(destination) {
  await composeToFile(["exec", "-T", "postgres", "pg_dump", "-U", config.databaseUser, "-d", "ownminutes", "-Fc"], destination);
  if (fs.statSync(destination).size === 0) throw new Error("PostgreSQL dump is empty.");
}

function mirrorObjects(destination) {
  const mirrorScript = mode === "production"
    ? `ROOT_USER=$(cat /run/secrets/minio_root_user) && ROOT_PASSWORD=$(cat /run/secrets/minio_root_password) && mc alias set source http://minio:9000 "$ROOT_USER" "$ROOT_PASSWORD" >/dev/null && mc mirror --overwrite source/${shellQuote(config.bucket)} /backup >/dev/null`
    : `mc alias set source http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --overwrite source/${shellQuote(config.bucket)} /backup >/dev/null`;
  compose([
    "run", "--rm", "--no-deps",
    "-v", `${destination}:/backup`,
    "--entrypoint", "/bin/sh",
    "minio-init", "-c", withBackupScratchOwnershipRestore(mirrorScript),
  ], { inherit: true });
}

function mirrorAuditLogs(destination) {
  const snapshotScript = withBackupScratchOwnershipRestore(
    "perl scripts/with-file-lock.pl /app/.data/auth/secret-audit.jsonl.lock 30 node scripts/copy-secret-audit-snapshot.mjs /backup",
  );
  compose([
    "run", "--rm", "--no-deps",
    "-v", `${destination}:/backup`,
    "--entrypoint", "/bin/sh",
    "secret-audit-rotator",
    "-c",
    snapshotScript,
  ], { inherit: true });
}

function withBackupScratchOwnershipRestore(command) {
  return [
    "set -eu",
    'BACKUP_OWNER="$(stat -c \'%u:%g\' /backup)"',
    'case "$BACKUP_OWNER" in ""|*[!0-9:]*|*:*:*|:*|*:) echo "Unsafe backup scratch ownership." >&2; exit 64 ;; *:*) ;; *) echo "Unsafe backup scratch ownership." >&2; exit 64 ;; esac',
    "restore_backup_owner() {",
    "  status=$?",
    "  trap - 0",
    '  if ! chown -R "$BACKUP_OWNER" /backup; then',
    '    echo "Unable to restore backup scratch ownership." >&2',
    '    if [ "$status" -eq 0 ]; then status=70; fi',
    "  fi",
    '  exit "$status"',
    "}",
    "trap restore_backup_owner 0",
    command,
  ].join("\n");
}

async function withVerifiedBackup(artifact, callback) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-backup-verify-"));
  fs.chmodSync(scratch, 0o700);
  const fixedArtifact = path.join(scratch, "artifact.ombak");
  const archive = path.join(scratch, "backup.tar.gz");
  const extractDir = path.join(scratch, "extracted");
  fs.mkdirSync(extractDir, { mode: 0o700 });
  try {
    const artifactIdentity = snapshotArtifact(artifact, fixedArtifact);
    await decryptArchive(fixedArtifact, archive);
    const listing = run("tar", ["-tzf", archive], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
    if (listing.length === 0 || listing.some(unsafeArchivePath)) throw new Error("Backup archive contains an unsafe or empty path listing.");
    run("tar", ["-xzf", archive, "-C", extractDir]);
    const manifestPath = path.join(extractDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    verifyManifest(extractDir, manifest);
    return await callback({ extractDir, manifest, artifactIdentity });
  } finally {
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

function verifyManifest(extractDir, manifest) {
  if (!["ownminutes-backup:v1", "ownminutes-backup:v2"].includes(manifest.format)) {
    throw new Error("Unsupported OwnMinutes backup format.");
  }
  if (!isCanonicalIsoDate(manifest.createdAt) || manifest.mode !== mode) {
    throw new Error("Backup manifest creation time or mode is invalid.");
  }
  const databasePath = safeJoin(extractDir, manifest.database?.path);
  assertChecksum(databasePath, manifest.database);
  if (!Array.isArray(manifest.objects?.files)) throw new Error("Backup object manifest is invalid.");
  assertManifestEntries(manifest.objects.files);
  for (const expected of manifest.objects.files) {
    assertChecksum(safeJoin(path.join(extractDir, "objects"), expected.path), expected);
  }
  if (manifest.objects.count !== manifest.objects.files.length) throw new Error("Backup object count does not match its manifest.");
  assertExactManifestTree(path.join(extractDir, "objects"), manifest.objects.files);
  if (manifest.format === "ownminutes-backup:v2") {
    if (!Array.isArray(manifest.audit?.files)) throw new Error("Backup audit manifest is invalid.");
    assertManifestEntries(manifest.audit.files);
    for (const expected of manifest.audit.files) {
      assertChecksum(safeJoin(path.join(extractDir, "audit"), expected.path), expected);
    }
    if (manifest.audit.count !== manifest.audit.files.length) {
      throw new Error("Backup audit file count does not match its manifest.");
    }
    assertExactManifestTree(path.join(extractDir, "audit"), manifest.audit.files);
    verifyAuditSnapshot(extractDir, manifest);
  }
}

function assertManifestEntries(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      unsafeArchivePath(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(String(entry.sha256 || "")) ||
      seen.has(entry.path)
    ) {
      throw new Error("Backup manifest file entry is invalid.");
    }
    seen.add(entry.path);
  }
}

function assertExactManifestTree(directory, entries) {
  const actual = collectRelativeRegularFiles(directory);
  const expected = entries.map((entry) => entry.path).sort();
  if (
    actual.length !== expected.length ||
    actual.some((relative, index) => relative !== expected[index])
  ) {
    throw new Error("Backup archive files do not exactly match the manifest.");
  }
}

function verifyAuditSnapshot(extractDir, manifest) {
  if (manifest.format !== "ownminutes-backup:v2") return;
  const auditRoot = path.join(extractDir, "audit");
  const relativeFiles = collectRelativeRegularFiles(auditRoot);
  if (
    relativeFiles.some(
      (relative) =>
        relative.includes(".rotating-") ||
        relative.endsWith(".pending"),
    )
  ) {
    throw new Error("Backup audit snapshot contains unfinished rotation state.");
  }

  const activeFiles = relativeFiles.filter((relative) => relative.startsWith("active/"));
  if (
    activeFiles.length > 1 ||
    activeFiles.some(
      (relative) =>
        relative.split("/").length !== 2 ||
        !relative.endsWith(".jsonl"),
    )
  ) {
    throw new Error("Backup audit active-log snapshot is invalid.");
  }
  for (const relative of activeFiles) {
    validateAuditJsonl(safeJoin(auditRoot, relative), true);
  }

  const archiveFiles = relativeFiles.filter((relative) => relative.startsWith("archive/"));
  if (activeFiles.length + archiveFiles.length !== relativeFiles.length) {
    throw new Error("Backup audit snapshot contains an unexpected path.");
  }
  const archives = archiveFiles.filter((relative) => relative.endsWith(".jsonl"));
  const sidecars = archiveFiles.filter((relative) => relative.endsWith(".jsonl.sha256"));
  if (archives.length * 2 !== archiveFiles.length || sidecars.length !== archives.length) {
    throw new Error("Backup audit archive/sidecar set is incomplete.");
  }

  for (const archiveRelative of archives) {
    const digestRelative = `${archiveRelative}.sha256`;
    if (!sidecars.includes(digestRelative)) {
      throw new Error("Backup audit archive is missing its digest sidecar.");
    }
    const archivePath = safeJoin(auditRoot, archiveRelative);
    const digestPath = safeJoin(auditRoot, digestRelative);
    validateAuditJsonl(archivePath, false);
    const digestText = fs.readFileSync(digestPath, "utf8");
    const archiveName = path.basename(archivePath);
    const match = /^([0-9a-f]{64})  ([^/\0\r\n]+)\n$/.exec(digestText);
    if (
      !match ||
      match[2] !== archiveName ||
      match[1] !== sha256File(archivePath)
    ) {
      throw new Error("Backup audit digest sidecar is invalid.");
    }
  }
}

function validateAuditJsonl(filePath, allowEmpty) {
  const data = fs.readFileSync(filePath);
  if (data.length === 0) {
    if (allowEmpty) return;
    throw new Error("Backup audit archive is empty.");
  }
  if (data[data.length - 1] !== 0x0a) {
    throw new Error("Backup audit JSONL is truncated.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("Backup audit JSONL is not valid UTF-8.");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) {
    throw new Error("Backup audit JSONL contains a blank record.");
  }
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("Backup audit JSONL record is invalid.");
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
      throw new Error("Backup audit event schema is invalid.");
    }
  }
}

function restoreDatabase(dumpPath) {
  const name = `ownminutes-restore-postgres-${crypto.randomBytes(5).toString("hex")}`;
  const password = crypto.randomBytes(32).toString("base64url");
  try {
    run("docker", ["run", "-d", "--name", name, "-e", "POSTGRES_DB=ownminutes", "-e", "POSTGRES_USER=ownminutes", "-e", `POSTGRES_PASSWORD=${password}`, "postgres:16-alpine"]);
    waitFor(
      () =>
        run(
          "docker",
          [
            "exec",
            name,
            "/bin/sh",
            "-ec",
            'test "$(cat /proc/1/comm)" = postgres && psql -v ON_ERROR_STOP=1 -U ownminutes -d ownminutes -Atqc \'select 1\' >/dev/null',
          ],
          { allowFailure: true },
        ).status === 0,
      60_000,
      "final temporary PostgreSQL",
    );
    run("docker", ["cp", dumpPath, `${name}:/tmp/database.dump`]);
    run("docker", ["exec", name, "pg_restore", "-U", "ownminutes", "-d", "ownminutes", "--no-owner", "--no-privileges", "/tmp/database.dump"]);
    const values = run("docker", ["exec", name, "psql", "-U", "ownminutes", "-d", "ownminutes", "-At", "-F", ",", "-c", "select (select count(*) from ownminutes_schema_migrations),(select count(*) from users),(select count(*) from meetings);"], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
    if (values.some((value) => !Number.isInteger(value))) throw new Error("Restored PostgreSQL verification query returned invalid counts.");
    const catalogText = run(
      "docker",
      [
        "exec",
        name,
        "psql",
        "-U",
        "ownminutes",
        "-d",
        "ownminutes",
        "-At",
        "-c",
        `select coalesce(json_agg(row_to_json(candidate)), '[]'::json)::text
         from (
           select id, owner_user_id, object_prefix, total_bytes, total_chunks, has_result
           from meetings
           where deleted_at is null
           order by id
         ) candidate;`,
      ],
      { encoding: "utf8" },
    ).stdout.trim();
    let activeMeetings;
    try {
      activeMeetings = JSON.parse(catalogText || "[]");
    } catch {
      throw new Error("Restored PostgreSQL meeting catalog could not be parsed.");
    }
    if (!Array.isArray(activeMeetings)) {
      throw new Error("Restored PostgreSQL meeting catalog is invalid.");
    }
    return {
      restored: true,
      migrationCount: values[0],
      userCount: values[1],
      meetingCount: values[2],
      activeMeetings,
    };
  } finally {
    run("docker", ["rm", "-f", name], { allowFailure: true });
  }
}

function verifyDatabaseObjectReferences(objectsDir, activeMeetings) {
  let referencedObjectCount = 0;
  let legacyChunkWithoutSha256Count = 0;
  for (const row of activeMeetings) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(row.id) ||
      row.object_prefix !== row.id ||
      typeof row.owner_user_id !== "string" ||
      !Number.isSafeInteger(Number(row.total_bytes)) ||
      Number(row.total_bytes) < 0 ||
      !Number.isSafeInteger(Number(row.total_chunks)) ||
      Number(row.total_chunks) < 0 ||
      typeof row.has_result !== "boolean"
    ) {
      throw new Error("Restored meeting catalog contains an unsafe object reference.");
    }
    const meetingRoot = safeJoin(
      objectsDir,
      `${config.storagePrefix}/${row.object_prefix}`,
    );
    const manifestPath = safeJoin(meetingRoot, "manifest.json");
    assertExistingRegularFile(manifestPath, "meeting manifest");
    referencedObjectCount += 1;
    let audioManifest;
    try {
      audioManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      throw new Error("Restored meeting manifest is invalid JSON.");
    }
    if (
      audioManifest?.meetingId !== row.id ||
      audioManifest?.ownerUserId !== row.owner_user_id ||
      !Array.isArray(audioManifest?.chunks) ||
      audioManifest.chunks.length !== Number(row.total_chunks) ||
      Number(audioManifest.totalBytes) !== Number(row.total_bytes)
    ) {
      throw new Error("Restored meeting manifest does not match the PostgreSQL catalog.");
    }
    let chunkBytes = 0;
    const seenSequences = new Set();
    for (const chunk of audioManifest.chunks) {
      const chunkSha256 = chunk?.sha256;
      const chunkSha256Missing = chunkSha256 === undefined || chunkSha256 === "";
      if (
        !chunk ||
        !Number.isSafeInteger(chunk.sequence) ||
        chunk.sequence < 1 ||
        seenSequences.has(chunk.sequence) ||
        typeof chunk.fileName !== "string" ||
        !/^[A-Za-z0-9._-]{1,255}$/.test(chunk.fileName) ||
        chunk.fileName.includes("..") ||
        !Number.isSafeInteger(chunk.bytes) ||
        chunk.bytes < 0 ||
        (!chunkSha256Missing &&
          (typeof chunkSha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(chunkSha256)))
      ) {
        throw new Error("Restored meeting manifest contains an invalid chunk reference.");
      }
      seenSequences.add(chunk.sequence);
      const chunkPath = safeJoin(
        meetingRoot,
        `chunks/${chunk.fileName}`,
      );
      const chunkInfo = assertExistingRegularFile(chunkPath, "meeting audio chunk");
      if (
        chunkInfo.size !== chunk.bytes ||
        (!chunkSha256Missing && sha256File(chunkPath) !== chunkSha256)
      ) {
        throw new Error("Restored meeting audio chunk does not match its manifest.");
      }
      if (chunkSha256Missing) legacyChunkWithoutSha256Count += 1;
      chunkBytes += chunk.bytes;
      referencedObjectCount += 1;
    }
    if (chunkBytes !== Number(row.total_bytes)) {
      throw new Error("Restored meeting chunk bytes do not match the PostgreSQL catalog.");
    }
    if (row.has_result) {
      const resultPath = safeJoin(meetingRoot, "result.json");
      assertExistingRegularFile(resultPath, "meeting result");
      try {
        JSON.parse(fs.readFileSync(resultPath, "utf8"));
      } catch {
        throw new Error("Restored meeting result is invalid JSON.");
      }
      referencedObjectCount += 1;
    }
  }
  return {
    referencesVerified: true,
    activeMeetingCount: activeMeetings.length,
    referencedObjectCount,
    legacyChunkWithoutSha256Count,
  };
}

function assertExistingRegularFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Restored ${label} is missing.`);
  }
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Restored ${label} is unsafe.`);
  }
  return info;
}

function restoreObjects(objectsDir, expectedCount) {
  const suffix = crypto.randomBytes(5).toString("hex");
  const network = `ownminutes-restore-${suffix}`;
  const server = `ownminutes-restore-minio-${suffix}`;
  const client = `ownminutes-restore-mc-${suffix}`;
  const user = `restore${suffix}`;
  const password = crypto.randomBytes(32).toString("base64url");
  try {
    run("docker", ["network", "create", network]);
    run("docker", ["run", "-d", "--name", server, "--network", network, "-e", `MINIO_ROOT_USER=${user}`, "-e", `MINIO_ROOT_PASSWORD=${password}`, "quay.io/minio/minio:latest", "server", "/data"]);
    waitFor(() => {
      const probe = run("docker", ["run", "--rm", "--network", network, "quay.io/minio/mc:latest", "alias", "set", "restore", `http://${server}:9000`, user, password], { allowFailure: true });
      return probe.status === 0;
    }, 60_000, "temporary MinIO");
    const script = `mc alias set restore http://${server}:9000 "$ROOT_USER" "$ROOT_PASSWORD" >/dev/null && mc mb restore/ownminutes >/dev/null && mc mirror --overwrite /backup restore/ownminutes >/dev/null && mc find restore/ownminutes | wc -l`;
    const result = run("docker", ["run", "--name", client, "--network", network, "-e", `ROOT_USER=${user}`, "-e", `ROOT_PASSWORD=${password}`, "-v", `${objectsDir}:/backup:ro`, "--entrypoint", "/bin/sh", "quay.io/minio/mc:latest", "-c", script], { encoding: "utf8" });
    const restoredCount = Number(result.stdout.trim());
    if (!Number.isInteger(restoredCount) || restoredCount !== expectedCount) throw new Error(`Restored object count mismatch: expected ${expectedCount}, received ${result.stdout.trim() || "empty"}.`);
    return { restored: true, objectCount: restoredCount };
  } finally {
    run("docker", ["rm", "-f", client, server], { allowFailure: true });
    run("docker", ["network", "rm", network], { allowFailure: true });
  }
}

async function encryptArchive(source, destination) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(`${JSON.stringify({ magic: "OWNMINUTES_BACKUP_V1", kdf: "scrypt", cipher: "aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64") })}\n`);
  const key = crypto.scryptSync(config.encryptionSecret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const output = fs.createWriteStream(destination, { mode: 0o600, flags: "wx" });
  output.write(header);
  await pipeline(fs.createReadStream(source), cipher, output, { end: false });
  await new Promise((resolvePromise, reject) => {
    output.once("finish", resolvePromise);
    output.once("error", reject);
    output.end(cipher.getAuthTag());
  });
}

async function decryptArchive(source, destination) {
  const stats = fs.statSync(source);
  const descriptor = fs.openSync(source, "r");
  const prefix = Buffer.alloc(Math.min(stats.size, 4096));
  fs.readSync(descriptor, prefix, 0, prefix.length, 0);
  fs.closeSync(descriptor);
  const newline = prefix.indexOf(10);
  if (newline < 0) throw new Error("Backup header is missing.");
  const header = prefix.subarray(0, newline + 1);
  const metadata = JSON.parse(header.toString("utf8"));
  if (metadata.magic !== "OWNMINUTES_BACKUP_V1" || metadata.cipher !== "aes-256-gcm") throw new Error("Unsupported encrypted backup header.");
  const tag = Buffer.alloc(16);
  const tagDescriptor = fs.openSync(source, "r");
  fs.readSync(tagDescriptor, tag, 0, tag.length, stats.size - tag.length);
  fs.closeSync(tagDescriptor);
  const key = crypto.scryptSync(config.encryptionSecret, Buffer.from(metadata.salt, "base64"), 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(metadata.iv, "base64"));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await pipeline(fs.createReadStream(source, { start: header.length, end: stats.size - tag.length - 1 }), decipher, fs.createWriteStream(destination, { mode: 0o600 }));
}

function compose(args, options = {}) {
  return run("docker", composeArguments(args), options);
}

async function composeToFile(args, destination) {
  const child = spawnWithInheritedFileLocks("docker", composeArguments(args), {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 12_000) stderr += chunk.toString("utf8");
  });
  child.stdout.pipe(output);
  const [code] = await Promise.all([
    new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", resolvePromise);
    }),
    new Promise((resolvePromise, reject) => {
      output.once("error", reject);
      output.once("finish", resolvePromise);
    }),
  ]);
  if (code !== 0) throw new Error(`PostgreSQL dump failed with status ${code}. ${stderr.trim().slice(-1200)}`);
}

function composeArguments(args) {
  return [
    "compose",
    ...(config.composeProjectName
      ? ["--project-name", config.composeProjectName]
      : []),
    "--env-file",
    config.envFile,
    "--file",
    config.composeFile,
    ...args,
  ];
}

function requiredProductionLikeProjectName(value) {
  const project = String(value || "");
  if (!/^ownminutes-(?:production-like|pl-wt-[a-f0-9]{12})$/.test(project)) {
    throw new Error("Production-like backup requires a valid persisted Compose project name.");
  }
  return project;
}

function requiredProductionLikeStackId(format, stackId, composeProjectName) {
  if (format !== "2" || !/^(?:legacy-fixed|wt-[a-f0-9]{12})$/.test(String(stackId || ""))) {
    throw new Error("Production-like backup requires a valid persisted stack identity.");
  }
  const expectedProject = stackId === "legacy-fixed"
    ? "ownminutes-production-like"
    : `ownminutes-pl-${stackId}`;
  if (composeProjectName !== expectedProject) {
    throw new Error("Production-like backup stack identity and Compose project do not match.");
  }
  if (stackId !== "legacy-fixed") {
    const expectedWorktreeId = `wt-${crypto
      .createHash("sha256")
      .update(fs.realpathSync(root))
      .digest("hex")
      .slice(0, 12)}`;
    if (stackId !== expectedWorktreeId) {
      throw new Error("Production-like backup stack belongs to a different worktree.");
    }
  }
  return stackId;
}

function run(executable, args, options = {}) {
  const result = spawnSyncWithInheritedFileLocks(executable, args, {
    cwd: root,
    encoding: options.encoding,
    stdio: options.inherit
      ? ["inherit", "inherit", "inherit"]
      : ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.encoding ? String(result.stderr || result.stdout || "").trim().slice(-1200) : "";
    throw new Error(`${executable} command failed with status ${result.status}.${detail ? ` ${detail}` : ""}`);
  }
  return result;
}

function assertExecutable(executable, args) {
  const result = run(executable, args, { allowFailure: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${executable} is unavailable.`);
}

function ensurePrivateBackupDirectory() {
  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(config.backupDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Backup directory must be a real private directory.");
  }
  fs.chmodSync(config.backupDir, 0o700);
}

function assertProductionLikeStackOwner() {
  if (mode !== "production-like" || config.stackId !== "legacy-fixed") return;
  const engine = run(
    "docker",
    ["info", "--format", "{{.ID}}"],
    { allowFailure: true, encoding: "utf8" },
  );
  const dockerEngineId = String(engine.stdout || "").trim();
  if (
    engine.status !== 0 ||
    !/^[A-Za-z0-9._:-]{8,160}$/.test(dockerEngineId)
  ) {
    throw new Error("Unable to identify the Docker engine for legacy backup ownership.");
  }
  const ownerFile = legacyStackOwnerFile({
    dockerEngineId,
    homeDirectory: os.homedir(),
  });
  if (!fs.existsSync(ownerFile)) {
    throw new Error(
      "Legacy production-like backup ownership is unclaimed; run the stack command from its owning worktree first.",
    );
  }
  const stageIdentity = crypto
    .createHash("sha256")
    .update(fs.realpathSync(root))
    .digest("hex")
    .slice(0, 12);
  claimLegacyStackOwner({
    ownerFile,
    dockerEngineId,
    stageIdentity,
  });
}

function runLockedBackupOperation() {
  const wrapper = path.join(root, "scripts", "with-file-lock.pl");
  const script = path.resolve(process.argv[1]);
  const result = spawnSyncWithInheritedFileLocks(
    "perl",
    [
      wrapper,
      path.join(config.backupDir, ".backup-operation.lock"),
      "120",
      "--held-env=OWNMINUTES_BACKUP_OPERATION_LOCK_HELD",
      process.execPath,
      script,
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
    throw new Error(`Backup operation lock child terminated by ${result.signal}.`);
  }
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function cleanupPendingBackups() {
  const pendingPattern =
    /^\.(ownminutes-(?:production|production-like)-\d{8}T\d{6}Z\.ombak)\.pending-\d+-[0-9a-f]{12}$/;
  for (const name of fs.readdirSync(config.backupDir).sort()) {
    if (!pendingPattern.test(name)) continue;
    const pendingPath = path.join(config.backupDir, name);
    assertPrivateRegularFile(pendingPath, "Pending backup artifact");
    fs.rmSync(pendingPath);
  }
  fsyncDirectory(config.backupDir);
}

function snapshotArtifact(source, destination) {
  if (!managedArtifactName(path.basename(source)) || path.dirname(source) !== config.backupDir) {
    throw new Error("Backup artifact path is outside the managed backup directory.");
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const sourceDescriptor = fs.openSync(
    source,
    fs.constants.O_RDONLY | noFollow,
  );
  let destinationDescriptor;
  try {
    const before = fs.fstatSync(sourceDescriptor, { bigint: true });
    const beforePath = fs.lstatSync(source, { bigint: true });
    assertSamePrivateRegularFile(before, beforePath, "Backup artifact");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Backup artifact is too large to bind safely.");
    }
    runArtifactSnapshotTestHook();

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
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          destinationDescriptor,
          buffer,
          written,
          bytesRead - written,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      total += BigInt(bytesRead);
    }
    fs.fsyncSync(destinationDescriptor);

    const after = fs.fstatSync(sourceDescriptor, { bigint: true });
    let afterPath;
    try {
      afterPath = fs.lstatSync(source, { bigint: true });
    } catch {
      throw new Error("Backup artifact changed while its fixed copy was created.");
    }
    if (
      !sameArtifactState(before, after) ||
      !sameArtifactState(before, afterPath) ||
      total !== before.size
    ) {
      throw new Error("Backup artifact changed while its fixed copy was created.");
    }
    fs.fchmodSync(destinationDescriptor, 0o400);
    const sha256 = hash.digest("hex");
    return {
      source,
      name: path.basename(source),
      bytes: Number(before.size),
      sha256,
      device: String(before.dev),
      inode: String(before.ino),
    };
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
}

function assertSamePrivateRegularFile(descriptorInfo, pathInfo, label) {
  if (
    !descriptorInfo.isFile() ||
    !pathInfo.isFile() ||
    pathInfo.isSymbolicLink() ||
    descriptorInfo.dev !== pathInfo.dev ||
    descriptorInfo.ino !== pathInfo.ino ||
    (descriptorInfo.mode & 0o077n) !== 0n
  ) {
    throw new Error(`${label} must be the same 0600 regular file opened without following links.`);
  }
}

function sameArtifactState(left, right) {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function runArtifactSnapshotTestHook() {
  if (process.env.OWNMINUTES_BACKUP_TEST_HOOKS !== "1") return;
  const marker = process.env.OWNMINUTES_BACKUP_TEST_ARTIFACT_OPEN_MARKER?.trim() || "";
  const proceed = process.env.OWNMINUTES_BACKUP_TEST_ARTIFACT_OPEN_PROCEED?.trim() || "";
  if (!path.isAbsolute(marker) || !path.isAbsolute(proceed)) {
    throw new Error("Backup artifact snapshot test hook paths are invalid.");
  }
  fs.writeFileSync(marker, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(proceed)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the backup artifact snapshot test hook.");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

function managedArtifactName(name) {
  return new RegExp(
    `^ownminutes-${mode.replaceAll("-", "\\-")}-\\d{8}T\\d{6}Z\\.ombak$`,
  ).test(name);
}

function resolveArtifact() {
  if (artifactArgument) {
    const resolved = path.resolve(artifactArgument);
    if (
      path.dirname(resolved) !== config.backupDir ||
      !managedArtifactName(path.basename(resolved))
    ) {
      throw new Error("Backup artifact must be a managed file inside the configured backup directory.");
    }
    return resolved;
  }
  const candidates = fs.readdirSync(config.backupDir)
    .filter(managedArtifactName)
    .sort()
    .reverse();
  if (!candidates[0]) throw new Error(`No encrypted backup exists in ${config.backupDir}.`);
  return path.join(config.backupDir, candidates[0]);
}

function pruneBackups() {
  const backups = fs.readdirSync(config.backupDir)
    .filter(managedArtifactName)
    .sort()
    .reverse();
  for (const stale of backups.slice(config.retentionCount)) {
    const stalePath = path.join(config.backupDir, stale);
    assertPrivateRegularFile(stalePath, "Backup artifact");
    fs.rmSync(stalePath);
  }
  fsyncDirectory(config.backupDir);
}

function collectFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

function collectRelativeRegularFiles(directory, base = directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const child = path.join(directory, name);
    const info = fs.lstatSync(child);
    if (info.isSymbolicLink()) {
      throw new Error("Backup archive contains a symbolic link.");
    }
    if (info.isDirectory()) {
      files.push(...collectRelativeRegularFiles(child, base));
    } else if (info.isFile()) {
      files.push(path.relative(base, child).split(path.sep).join("/"));
    } else {
      throw new Error("Backup archive contains an unsupported file type.");
    }
  }
  return files.sort();
}

function assertChecksum(file, expected) {
  if (
    !expected ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    !/^[0-9a-f]{64}$/.test(String(expected.sha256 || ""))
  ) {
    throw new Error("Backup checksum manifest entry is invalid.");
  }
  if (!fs.existsSync(file)) throw new Error(`Backup file is missing: ${path.basename(file)}.`);
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Backup file is unsafe: ${path.basename(file)}.`);
  }
  const bytes = info.size;
  const sha256 = sha256File(file);
  if (bytes !== expected.bytes || sha256 !== expected.sha256) throw new Error(`Backup checksum failed: ${path.basename(file)}.`);
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

function safeJoin(base, relative) {
  if (typeof relative !== "string" || unsafeArchivePath(relative)) throw new Error("Backup manifest contains an unsafe path.");
  const target = path.resolve(base, relative);
  if (target !== path.resolve(base) && !target.startsWith(`${path.resolve(base)}${path.sep}`)) throw new Error("Backup manifest path escapes its root.");
  return target;
}

function unsafeArchivePath(value) {
  const normalized = value.replaceAll("\\", "/");
  return normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0");
}

function readPrivateSecret(file, label) {
  if (!file || !fs.existsSync(file)) throw new Error(`The ${label} file is missing.`);
  const stats = fs.statSync(file);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new Error(`The ${label} file must be a 0600 regular file.`);
  const value = fs.readFileSync(file, "utf8").trim();
  if (value.length < 43) throw new Error(`The ${label} is too short.`);
  return value;
}

function assertPrivateRegularFile(file, label) {
  const info = fs.lstatSync(file);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} must be a private regular file.`);
  }
  return info;
}

function atomicWritePrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = fs.lstatSync(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Backup evidence directory is unsafe.");
  }
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600, flag: "wx" },
  );
  try {
    fsyncFile(temporaryPath);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(directory);
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

function maybeCrashForTest(phase) {
  if (
    process.env.OWNMINUTES_BACKUP_TEST_HOOKS === "1" &&
    process.env.OWNMINUTES_BACKUP_TEST_CRASH_PHASE === phase
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) throw new Error("Backup retention count must be an integer between 1 and 365.");
  return parsed;
}

function shellQuote(value) {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error("Bucket name contains unsupported shell characters.");
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function manifestSummary(manifest) {
  return {
    createdAt: manifest.createdAt,
    databaseBytes: manifest.database.bytes,
    objectCount: manifest.objects.count,
    auditFileCount: manifest.audit?.count || 0,
    boundary: manifest.boundary,
  };
}

function artifactIdentitySummary(identity) {
  return {
    artifactName: identity.name,
    artifactBytes: identity.bytes,
    artifactSha256: identity.sha256,
    artifactDevice: identity.device,
    artifactInode: identity.inode,
  };
}

function isCanonicalIsoDate(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function printSummary(summary) {
  console.log(JSON.stringify(summary, null, 2));
}
