#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const backupSource = fs.readFileSync(path.join(root, "scripts", "production-backup.mjs"), "utf8");
const productionSource = fs.readFileSync(path.join(root, "scripts", "production-stack.mjs"), "utf8");
const localSource = fs.readFileSync(path.join(root, "scripts", "production-like-stack.mjs"), "utf8");
const envTemplate = fs.readFileSync(path.join(root, "deploy", "production.env.example"), "utf8");

const checks = {
  encryptsWithAuthenticatedCipher: backupSource.includes('createCipheriv("aes-256-gcm"') && backupSource.includes("setAuthTag"),
  derivesKeyWithScrypt: backupSource.includes("scryptSync"),
  createsPostgresCustomDump: backupSource.includes('"pg_dump"') && backupSource.includes('"-Fc"'),
  mirrorsObjectStorage: backupSource.includes('"mc mirror --overwrite"') || backupSource.includes("mc mirror --overwrite"),
  includesSecretAuditArchives:
    backupSource.includes("mirrorAuditLogs") &&
    backupSource.includes('"ownminutes-backup:v2"') &&
    backupSource.includes("auditFileCount") &&
    backupSource.includes('"secret-audit-rotator"'),
  serializesAllBackupOperations:
    backupSource.includes("OWNMINUTES_BACKUP_OPERATION_LOCK_HELD") &&
    backupSource.includes(".backup-operation.lock"),
  publishesAtomically:
    backupSource.includes("after_backup_pending_fsync") &&
    backupSource.includes("fsyncFile(pendingArtifact)") &&
    backupSource.includes("fs.renameSync(pendingArtifact, artifact)") &&
    backupSource.includes("fsyncDirectory(config.backupDir)"),
  verifiesFixedArtifactIdentity:
    backupSource.includes("snapshotArtifact") &&
    backupSource.includes("artifactDevice") &&
    backupSource.includes("artifactInode") &&
    backupSource.includes("sameArtifactState"),
  bindsVerifiedManifestCreationTime:
    backupSource.includes('"ownminutes-backup-verify-evidence:v1"') &&
    backupSource.includes("backupCreatedAt: result.manifest.createdAt"),
  restoreEvidenceProvesDatabaseObjectReferences:
    backupSource.includes('"ownminutes-backup-restore-evidence:v2"') &&
    backupSource.includes("referencesVerified: true") &&
    backupSource.includes("activeMeetingCount") &&
    backupSource.includes("referencedObjectCount") &&
    backupSource.includes("legacyChunkWithoutSha256Count"),
  recordsChecksums: backupSource.includes("sha256") && backupSource.includes("verifyManifest"),
  rejectsPathTraversal: backupSource.includes("unsafeArchivePath") && backupSource.includes("safeJoin"),
  restoresIntoTemporaryPostgres: backupSource.includes("ownminutes-restore-postgres-") && backupSource.includes('"pg_restore"'),
  waitsForFinalTemporaryPostgres:
    backupSource.includes('/proc/1/comm') &&
    backupSource.includes("final temporary PostgreSQL") &&
    backupSource.includes("psql -v ON_ERROR_STOP=1"),
  restoresIntoTemporaryMinio: backupSource.includes("ownminutes-restore-minio-") && backupSource.includes("restoredCount !== expectedCount"),
  restoresOrdinaryUserScratchOwnership:
    backupSource.includes("withBackupScratchOwnershipRestore") &&
    backupSource.includes("BACKUP_OWNER") &&
    backupSource.includes('trap restore_backup_owner 0') &&
    backupSource.includes('chown -R "$BACKUP_OWNER" /backup'),
  cleansTemporaryRuntime: backupSource.includes('"rm", "-f", client, server') && backupSource.includes('"network", "rm"'),
  documentsVersionBoundary:
    backupSource.includes("current object versions") &&
    backupSource.includes("active/rotated secret-audit files") &&
    backupSource.includes("noncurrent MinIO versions"),
  productionGeneratesBackupKey: productionSource.includes('"backup-encryption-key": token(48)'),
  localStackMigratesBackupKey:
    localSource.includes("OWNMINUTES_BACKUP_ENCRYPTION_KEY") &&
    localSource.includes("setEnvValues(envFile") &&
    localSource.includes("fs.renameSync(temporaryPath, filePath)"),
  productionTemplateUsesSecretFile: envTemplate.includes("OWNMINUTES_BACKUP_ENCRYPTION_KEY_FILE=/srv/ownminutes/deploy/secrets/backup-encryption-key"),
  productionTemplateHasRetention: envTemplate.includes("OWNMINUTES_BACKUP_RETENTION_COUNT=7"),
  doesNotPrintEncryptionSecret: !backupSource.includes("printSummary({ encryptionSecret") && !backupSource.includes("console.log(config.encryptionSecret"),
};

Object.assign(checks, await runIntegrityRegressionChecks());

const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
console.log(JSON.stringify({ ok: failed.length === 0, checks, failed }, null, 2));
if (failed.length > 0) process.exit(1);

async function runIntegrityRegressionChecks() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-backup-integrity-"));
  try {
    const key = crypto.randomBytes(48).toString("base64url");
    const keyFile = path.join(scratch, "backup-key");
    fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    const backupDir = path.join(scratch, "backups");
    const verifyEvidencePath = path.join(scratch, "verify-evidence.json");
    fs.mkdirSync(backupDir, { mode: 0o700 });
    const envFile = path.join(scratch, ".env.production");
    fs.writeFileSync(
      envFile,
      `${[
        `OWNMINUTES_BACKUP_ENCRYPTION_KEY_FILE=${keyFile}`,
        `OWNMINUTES_BACKUP_DIR=${backupDir}`,
        `OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH=${verifyEvidencePath}`,
      ].join("\n")}\n`,
      { mode: 0o600 },
    );
    const createdAt = new Date().toISOString();
    const artifact = path.join(
      backupDir,
      `ownminutes-production-${fileTimestamp(createdAt)}.ombak`,
    );
    writeFixtureBackup({ artifact, createdAt, key });
    const commonEnv = {
      ...process.env,
      OWNMINUTES_PRODUCTION_ENV_FILE: envFile,
    };
    const verified = runBackup(
      ["verify", "--mode", "production", "--artifact", artifact],
      commonEnv,
    );
    const verification = JSON.parse(fs.readFileSync(verifyEvidencePath, "utf8"));

    const badArtifact = path.join(
      backupDir,
      "ownminutes-production-20990101T000000Z.ombak",
    );
    writeFixtureBackup({
      artifact: badArtifact,
      createdAt,
      key,
      badSidecar: true,
    });
    const badSidecar = runBackup(
      ["verify", "--mode", "production", "--artifact", badArtifact],
      commonEnv,
      false,
    );
    fs.rmSync(badArtifact);

    const replacement = path.join(scratch, "replacement.ombak");
    writeFixtureBackup({
      artifact: replacement,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      key,
    });
    const marker = path.join(scratch, "artifact-open.marker");
    const proceed = path.join(scratch, "artifact-open.proceed");
    const replacementProbe = spawn(
      process.execPath,
      [
        "scripts/production-backup.mjs",
        "verify",
        "--mode",
        "production",
        "--artifact",
        artifact,
      ],
      {
        cwd: root,
        env: {
          ...commonEnv,
          OWNMINUTES_BACKUP_TEST_HOOKS: "1",
          OWNMINUTES_BACKUP_TEST_ARTIFACT_OPEN_MARKER: marker,
          OWNMINUTES_BACKUP_TEST_ARTIFACT_OPEN_PROCEED: proceed,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const replacementResult = childResult(replacementProbe);
    await waitForFile(marker, 5_000);
    const concurrentLock = spawnSync(
      "perl",
      [
        "scripts/with-file-lock.pl",
        path.join(backupDir, ".backup-operation.lock"),
        "1",
        "--held-env=OWNMINUTES_BACKUP_OPERATION_LOCK_HELD",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { cwd: root, encoding: "utf8" },
    );
    const openedArtifact = `${artifact}.opened`;
    fs.renameSync(artifact, openedArtifact);
    fs.renameSync(replacement, artifact);
    fs.writeFileSync(proceed, "continue\n", { mode: 0o600 });
    const replaced = await replacementResult;

    const createDir = path.join(scratch, "create-backups");
    fs.mkdirSync(createDir, { mode: 0o700 });
    const createEvidence = path.join(scratch, "create-verify-evidence.json");
    const createEnvFile = path.join(scratch, ".env.production-create");
    fs.writeFileSync(
      createEnvFile,
      `${[
        `OWNMINUTES_BACKUP_ENCRYPTION_KEY_FILE=${keyFile}`,
        `OWNMINUTES_BACKUP_DIR=${createDir}`,
        `OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH=${createEvidence}`,
      ].join("\n")}\n`,
      { mode: 0o600 },
    );
    const fakeBin = path.join(scratch, "fake-bin");
    fs.mkdirSync(fakeBin, { mode: 0o700 });
    const fakeDocker = path.join(fakeBin, "docker");
    fs.writeFileSync(
      fakeDocker,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'info') { process.stdout.write('smoke-engine\\n'); process.exit(0); }",
        "if (args[0] === 'compose' && args.some((value) => value.startsWith('PGAPPNAME=ownminutes-backup-'))) {",
        "  let input = '';",
        "  let marked = false;",
        "  process.stdin.on('data', (chunk) => {",
        "    input += chunk.toString();",
        "    const marker = input.match(/OWNMINUTES_BACKUP_BARRIER_ACQUIRED:[A-Za-z0-9-]+/)?.[0];",
        "    if (marker && !marked) { marked = true; process.stdout.write(`${marker}\\n`); }",
        "  });",
        "  process.stdin.on('end', () => process.exit(marked ? 0 : 1));",
        "} else if (args[0] === 'compose' && args.some((value) => value.includes('pg_terminate_backend'))) process.exit(0);",
        "else if (args[0] === 'compose' && args.includes('pg_dump')) {",
        "  const fs = require('node:fs');",
        "  const marker = process.env.FAKE_DOCKER_PG_DUMP_MARKER;",
        "  const finished = process.env.FAKE_DOCKER_PG_DUMP_FINISHED;",
        "  if (marker) {",
        "    fs.writeFileSync(marker, 'started\\n', { mode: 0o600 });",
        "    setTimeout(() => {",
        "      if (finished) fs.writeFileSync(finished, 'finished\\n', { mode: 0o600 });",
        "      process.stdout.write('PGDMP-smoke-fixture');",
        "    }, 1800);",
        "  } else { process.stdout.write('PGDMP-smoke-fixture'); process.exit(0); }",
        "}",
        "else if (args[0] === 'compose' && (args.includes('minio-init') || args.includes('secret-audit-rotator'))) {",
        "  const command = args.join(' ');",
        "  if (!command.includes('BACKUP_OWNER') || !command.includes('trap restore_backup_owner 0') || !command.includes('chown -R')) process.exit(41);",
        "  process.exit(0);",
        "}",
        "else if (args[0] === 'compose') process.exit(0);",
        "else if (args[0] === 'exec' && args.join(' ').includes('/proc/1/comm')) {",
        "  const fs = require('node:fs');",
        "  const marker = process.env.FAKE_DOCKER_FINAL_READY_MARKER;",
        "  if (!args.join(' ').includes('psql -v ON_ERROR_STOP=1') || !marker) process.exit(42);",
        "  fs.writeFileSync(marker, 'ready\\n', { mode: 0o600 });",
        "  process.exit(0);",
        "}",
        "else if (args[0] === 'exec' && args.includes('pg_isready')) process.exit(0);",
        "else if (args[0] === 'exec' && args.includes('pg_restore')) {",
        "  const fs = require('node:fs');",
        "  process.exit(process.env.FAKE_DOCKER_FINAL_READY_MARKER && fs.existsSync(process.env.FAKE_DOCKER_FINAL_READY_MARKER) ? 0 : 43);",
        "}",
        "else if (args[0] === 'exec' && args.includes('psql')) {",
        "  const sql = args.at(-1);",
        "  if (sql.includes('ownminutes_schema_migrations')) process.stdout.write('26,1,1\\n');",
        "  else if (sql.includes('json_agg')) process.stdout.write(`${process.env.FAKE_DOCKER_RESTORE_CATALOG || '[]'}\\n`);",
        "  process.exit(0);",
        "}",
        "else if (args[0] === 'cp' || args[0] === 'rm' || args[0] === 'network') process.exit(0);",
        "else if (args[0] === 'run') {",
        "  if (args.includes('-d')) process.stdout.write('smoke-container\\n');",
        "  else if (args.some((value) => value.includes('mc find'))) process.stdout.write(`${process.env.FAKE_DOCKER_OBJECT_COUNT || '0'}\\n`);",
        "  process.exit(0);",
        "}",
        "else process.exit(1);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    fs.chmodSync(fakeDocker, 0o700);
    const createEnv = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      OWNMINUTES_PRODUCTION_ENV_FILE: createEnvFile,
      OWNMINUTES_BACKUP_TEST_HOOKS: "1",
      OWNMINUTES_BACKUP_TEST_CRASH_PHASE: "after_backup_pending_fsync",
    };
    const crashedCreate = runBackup(
      ["create", "--mode", "production"],
      createEnv,
      false,
    );
    const pendingAfterCrash = fs.readdirSync(createDir)
      .filter((name) => name.includes(".ombak.pending-"));
    const finalAfterCrash = fs.readdirSync(createDir)
      .filter((name) => name.endsWith(".ombak"));
    const pendingAfterCrashPrivate =
      pendingAfterCrash.length === 1 &&
      (fs.statSync(path.join(createDir, pendingAfterCrash[0])).mode & 0o077) === 0;
    const completedCreate = runBackup(
      ["create", "--mode", "production"],
      {
        ...createEnv,
        OWNMINUTES_BACKUP_TEST_CRASH_PHASE: "",
      },
    );
    const finalArtifacts = fs.readdirSync(createDir)
      .filter((name) => name.endsWith(".ombak"));
    const pendingAfterRecovery = fs.readdirSync(createDir)
      .filter((name) => name.includes(".ombak.pending-"));
    const finalPath = path.join(createDir, finalArtifacts[0] || "");

    const killBackupDir = path.join(scratch, "kill-backups");
    fs.mkdirSync(killBackupDir, { mode: 0o700 });
    const killEnvFile = path.join(scratch, ".env.production-kill");
    fs.writeFileSync(
      killEnvFile,
      `${[
        `OWNMINUTES_BACKUP_ENCRYPTION_KEY_FILE=${keyFile}`,
        `OWNMINUTES_BACKUP_DIR=${killBackupDir}`,
        `OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH=${path.join(scratch, "kill-verify.json")}`,
      ].join("\n")}\n`,
      { mode: 0o600 },
    );
    const dumpMarker = path.join(scratch, "dump-started");
    const dumpFinished = path.join(scratch, "dump-finished");
    const killLockPath = path.join(killBackupDir, ".backup-operation.lock");
    const killedOwner = spawn(
      "perl",
      [
        "scripts/with-file-lock.pl",
        killLockPath,
        "5",
        "--held-env=OWNMINUTES_BACKUP_OPERATION_LOCK_HELD",
        process.execPath,
        "scripts/production-backup.mjs",
        "create",
        "--mode",
        "production",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          OWNMINUTES_PRODUCTION_ENV_FILE: killEnvFile,
          FAKE_DOCKER_PG_DUMP_MARKER: dumpMarker,
          FAKE_DOCKER_PG_DUMP_FINISHED: dumpFinished,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const killedOwnerResult = childResult(killedOwner);
    await waitForFile(dumpMarker, 5_000);
    killedOwner.kill("SIGKILL");
    await killedOwnerResult;
    const blockedWhileGrandchildRuns = spawnSync(
      "perl",
      [
        "scripts/with-file-lock.pl",
        killLockPath,
        "1",
        "--held-env=OWNMINUTES_BACKUP_OPERATION_LOCK_HELD",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { cwd: root, encoding: "utf8" },
    );
    await waitForFile(dumpFinished, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const acquiredAfterGrandchildExit = spawnSync(
      "perl",
      [
        "scripts/with-file-lock.pl",
        killLockPath,
        "2",
        "--held-env=OWNMINUTES_BACKUP_OPERATION_LOCK_HELD",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { cwd: root, encoding: "utf8" },
    );

    const missingReferenceArtifact = path.join(
      killBackupDir,
      "ownminutes-production-20980101T000000Z.ombak",
    );
    writeFixtureBackup({
      artifact: missingReferenceArtifact,
      createdAt,
      key,
      missingReferencedChunk: true,
    });
    const missingReferenceRestore = runBackup(
      [
        "restore-drill",
        "--mode",
        "production",
        "--artifact",
        missingReferenceArtifact,
      ],
      {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        OWNMINUTES_PRODUCTION_ENV_FILE: killEnvFile,
        FAKE_DOCKER_RESTORE_CATALOG: JSON.stringify([
          {
            id: "meeting-smoke",
            owner_user_id: "user-smoke",
            object_prefix: "meeting-smoke",
            total_bytes: 5,
            total_chunks: 1,
            has_result: false,
          },
        ]),
        FAKE_DOCKER_FINAL_READY_MARKER: path.join(scratch, "final-postgres-ready"),
      },
      false,
    );

    const legacyReferenceArtifact = path.join(
      killBackupDir,
      "ownminutes-production-20970101T000000Z.ombak",
    );
    writeFixtureBackup({
      artifact: legacyReferenceArtifact,
      createdAt,
      key,
      referencedChunkMode: "legacy-without-sha256",
    });
    const legacyRestoreEvidencePath = path.join(scratch, "legacy-restore-evidence.json");
    const legacyReferenceRestore = runBackup(
      [
        "restore-drill",
        "--mode",
        "production",
        "--artifact",
        legacyReferenceArtifact,
      ],
      {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        OWNMINUTES_PRODUCTION_ENV_FILE: killEnvFile,
        OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH: legacyRestoreEvidencePath,
        FAKE_DOCKER_RESTORE_CATALOG: JSON.stringify([
          {
            id: "meeting-smoke",
            owner_user_id: "user-smoke",
            object_prefix: "meeting-smoke",
            total_bytes: 5,
            total_chunks: 1,
            has_result: false,
          },
        ]),
        FAKE_DOCKER_OBJECT_COUNT: "2",
        FAKE_DOCKER_FINAL_READY_MARKER: path.join(scratch, "legacy-final-postgres-ready"),
      },
    );
    const legacyRestoreEvidence = JSON.parse(
      fs.readFileSync(legacyRestoreEvidencePath, "utf8"),
    );

    const malformedReferenceArtifact = path.join(
      killBackupDir,
      "ownminutes-production-20960101T000000Z.ombak",
    );
    writeFixtureBackup({
      artifact: malformedReferenceArtifact,
      createdAt,
      key,
      referencedChunkMode: "malformed-sha256",
    });
    const malformedReferenceRestore = runBackup(
      [
        "restore-drill",
        "--mode",
        "production",
        "--artifact",
        malformedReferenceArtifact,
      ],
      {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        OWNMINUTES_PRODUCTION_ENV_FILE: killEnvFile,
        FAKE_DOCKER_RESTORE_CATALOG: JSON.stringify([
          {
            id: "meeting-smoke",
            owner_user_id: "user-smoke",
            object_prefix: "meeting-smoke",
            total_bytes: 5,
            total_chunks: 1,
            has_result: false,
          },
        ]),
        FAKE_DOCKER_OBJECT_COUNT: "2",
        FAKE_DOCKER_FINAL_READY_MARKER: path.join(scratch, "malformed-final-postgres-ready"),
      },
      false,
    );

    return {
      validEncryptedFixtureVerified:
        verified.status === 0 &&
        verification.format === "ownminutes-backup-verify-evidence:v1",
      verificationEvidenceBindsDecryptedCreatedAt:
        verification.backupCreatedAt === createdAt &&
        verification.artifactName === path.basename(artifact) &&
        verification.artifactSha256 === sha256File(openedArtifact) &&
        /^\d+$/.test(verification.artifactDevice) &&
        /^\d+$/.test(verification.artifactInode),
      semanticSidecarMismatchRejected:
        badSidecar.status !== 0 &&
        `${badSidecar.stdout}${badSidecar.stderr}`.includes("digest sidecar"),
      sameNameReplacementRejected:
        replaced.code !== 0 &&
        `${replaced.stdout}${replaced.stderr}`.includes("changed while its fixed copy"),
      backupKernelLockShared:
        concurrentLock.status === 75 &&
        concurrentLock.stderr.includes("file_lock_timeout"),
      crashBeforePromotionLeavesNoFinalArtifact:
        crashedCreate.status !== 0 &&
        pendingAfterCrash.length === 1 &&
        finalAfterCrash.length === 0 &&
        pendingAfterCrashPrivate,
      pendingCrashArtifactRecovered:
        completedCreate.status === 0 &&
        pendingAfterRecovery.length === 0 &&
        finalArtifacts.length === 1 &&
        (fs.statSync(finalPath).mode & 0o077) === 0,
      killedOwnerCannotReleaseLockBeforeDockerGrandchild:
        blockedWhileGrandchildRuns.status === 75 &&
        blockedWhileGrandchildRuns.stderr.includes("file_lock_timeout") &&
        fs.existsSync(dumpFinished),
      barrierPipeAndGrandchildReleaseLockAfterOwnerDeath:
        acquiredAfterGrandchildExit.status === 0,
      restoreRejectsMissingDatabaseReferencedObject:
        missingReferenceRestore.status !== 0 &&
        `${missingReferenceRestore.stdout}${missingReferenceRestore.stderr}`.includes("audio chunk is missing"),
      restoreAcceptsLegacyChunkWithoutInnerSha256:
        legacyReferenceRestore.status === 0 &&
        legacyRestoreEvidence.objects.referencesVerified === true &&
        legacyRestoreEvidence.objects.activeMeetingCount === 1 &&
        legacyRestoreEvidence.objects.referencedObjectCount === 2 &&
        legacyRestoreEvidence.objects.legacyChunkWithoutSha256Count === 1,
      restoreRejectsMalformedChunkSha256:
        malformedReferenceRestore.status !== 0 &&
        `${malformedReferenceRestore.stdout}${malformedReferenceRestore.stderr}`.includes("invalid chunk reference"),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function writeFixtureBackup({
  artifact,
  createdAt,
  key,
  badSidecar = false,
  missingReferencedChunk = false,
  referencedChunkMode = "none",
}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-backup-fixture-"));
  try {
    const objectsDir = path.join(scratch, "objects");
    const activeDir = path.join(scratch, "audit", "active");
    const archiveDir = path.join(scratch, "audit", "archive");
    fs.mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(activeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const databasePath = path.join(scratch, "database.dump");
    fs.writeFileSync(databasePath, "PGDMP-fixture", { mode: 0o600 });
    const event = `${JSON.stringify({
      id: "secret_audit_fixture",
      eventType: "provider_secret_save",
      userRef: "user_0123456789abcdef01234567",
      secretNames: [],
      createdAt,
    })}\n`;
    const archiveName = "secret-audit-fixture.jsonl";
    const archivePath = path.join(archiveDir, archiveName);
    fs.writeFileSync(archivePath, event, { mode: 0o600 });
    const digestText = badSidecar
      ? `${"0".repeat(64)}  ${archiveName}\n`
      : `${sha256File(archivePath)}  ${archiveName}\n`;
    fs.writeFileSync(`${archivePath}.sha256`, digestText, { mode: 0o600 });
    const auditFiles = [
      {
        path: `archive/${archiveName}`,
        bytes: fs.statSync(archivePath).size,
        sha256: sha256File(archivePath),
      },
      {
        path: `archive/${archiveName}.sha256`,
        bytes: fs.statSync(`${archivePath}.sha256`).size,
        sha256: sha256File(`${archivePath}.sha256`),
      },
    ];
    const objectFiles = [];
    if (missingReferencedChunk || referencedChunkMode !== "none") {
      const meetingDirectory = path.join(objectsDir, "ownminutes", "meetings", "meeting-smoke");
      fs.mkdirSync(path.join(meetingDirectory, "chunks"), { recursive: true, mode: 0o700 });
      const chunk = Buffer.from("audio");
      const chunkPath = path.join(meetingDirectory, "chunks", "chunk-000001.wav");
      const chunkReference = {
        sequence: 1,
        fileName: "chunk-000001.wav",
        bytes: chunk.length,
      };
      if (missingReferencedChunk || referencedChunkMode === "valid") {
        chunkReference.sha256 = crypto.createHash("sha256").update(chunk).digest("hex");
      } else if (referencedChunkMode === "malformed-sha256") {
        chunkReference.sha256 = "invalid";
      } else if (referencedChunkMode !== "legacy-without-sha256") {
        throw new Error(`Unsupported referenced chunk fixture mode: ${referencedChunkMode}.`);
      }
      const meetingManifestPath = path.join(meetingDirectory, "manifest.json");
      fs.writeFileSync(
        meetingManifestPath,
        `${JSON.stringify({
          meetingId: "meeting-smoke",
          ownerUserId: "user-smoke",
          chunks: [chunkReference],
          totalBytes: chunk.length,
        })}\n`,
        { mode: 0o600 },
      );
      objectFiles.push({
        path: "ownminutes/meetings/meeting-smoke/manifest.json",
        bytes: fs.statSync(meetingManifestPath).size,
        sha256: sha256File(meetingManifestPath),
      });
      if (!missingReferencedChunk) {
        fs.writeFileSync(chunkPath, chunk, { mode: 0o600 });
        objectFiles.push({
          path: "ownminutes/meetings/meeting-smoke/chunks/chunk-000001.wav",
          bytes: fs.statSync(chunkPath).size,
          sha256: sha256File(chunkPath),
        });
      }
    }
    const manifest = {
      format: "ownminutes-backup:v2",
      createdAt,
      mode: "production",
      database: {
        path: "database.dump",
        bytes: fs.statSync(databasePath).size,
        sha256: sha256File(databasePath),
        format: "postgres-custom",
      },
      objects: { count: objectFiles.length, files: objectFiles },
      audit: { count: auditFiles.length, files: auditFiles },
      boundary: "smoke fixture",
    };
    fs.writeFileSync(
      path.join(scratch, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    const tarPath = path.join(os.tmpdir(), `ownminutes-fixture-${crypto.randomUUID()}.tar.gz`);
    try {
      const tar = spawnSync(
        "tar",
        ["-czf", tarPath, "-C", scratch, "manifest.json", "database.dump", "objects", "audit"],
        { encoding: "utf8" },
      );
      if (tar.status !== 0) throw new Error(tar.stderr || "Unable to build backup fixture.");
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const header = Buffer.from(`${JSON.stringify({
        magic: "OWNMINUTES_BACKUP_V1",
        kdf: "scrypt",
        cipher: "aes-256-gcm",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
      })}\n`);
      const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        crypto.scryptSync(key, salt, 32),
        iv,
      );
      cipher.setAAD(header);
      const encrypted = Buffer.concat([
        cipher.update(fs.readFileSync(tarPath)),
        cipher.final(),
      ]);
      fs.writeFileSync(
        artifact,
        Buffer.concat([header, encrypted, cipher.getAuthTag()]),
        { mode: 0o600 },
      );
    } finally {
      fs.rmSync(tarPath, { force: true });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function runBackup(args, env, required = true) {
  const result = spawnSync(
    process.execPath,
    ["scripts/production-backup.mjs", ...args],
    { cwd: root, env, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (required && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Backup command failed.");
  }
  return result;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileTimestamp(value) {
  return value.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: signal ? 128 : code ?? 1,
      signal,
      stdout,
      stderr,
    }));
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}
