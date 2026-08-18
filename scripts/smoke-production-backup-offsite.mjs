#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const suffix = crypto.randomBytes(5).toString("hex");
const network = `ownminutes-backup-offsite-${suffix}`;
const server = `ownminutes-backup-offsite-minio-${suffix}`;
const minioImage = "quay.io/minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const mcImage = "quay.io/minio/mc:latest@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727";
const rootUser = `root${suffix}`;
const rootPassword = randomCliSafeSecret("SmokeRoot");
const backupUser = `backup${suffix}`;
const backupPassword = randomCliSafeSecret("SmokeBackup");
const bucket = "ownminutes-offsite-smoke";
const prefix = "encrypted/daily";
const staleObjectKey = `${prefix}/ownminutes-production-like-20000101T000000Z.ombak`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-backup-offsite-smoke-"));
const backupDir = path.join(scratch, "backups");
const artifact = path.join(backupDir, "ownminutes-production-like-20990101T000000Z.ombak");
const productionBackupDir = path.join(scratch, "production-backups");
const productionArtifact = path.join(productionBackupDir, "ownminutes-production-20990101T000000Z.ombak");
const accessKeyFile = path.join(scratch, "access-key");
const secretKeyFile = path.join(scratch, "secret-key");
const offsiteEvidencePath = path.join(scratch, "offsite-evidence.json");
const restoreEvidencePath = path.join(scratch, "restore-evidence.json");
const verifyEvidencePath = path.join(scratch, "verify-evidence.json");
const productionEnvFixture = path.join(scratch, ".env.production");
const policyFile = path.join(scratch, "backup-policy.json");

fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(productionBackupDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(artifact, crypto.randomBytes(64 * 1024), { mode: 0o600 });
fs.copyFileSync(artifact, productionArtifact);
fs.chmodSync(productionArtifact, 0o600);
fs.writeFileSync(accessKeyFile, `${backupUser}\n`, { mode: 0o600 });
fs.writeFileSync(secretKeyFile, `${backupPassword}\n`, { mode: 0o600 });
fs.writeFileSync(
  policyFile,
  `${JSON.stringify({ Version: "2012-10-17", Statement: [
    { Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: [`arn:aws:s3:::${bucket}`] },
    { Effect: "Allow", Action: ["s3:ListBucket"], Resource: [`arn:aws:s3:::${bucket}`], Condition: { StringLike: { "s3:prefix": [prefix, `${prefix}/*`] } } },
    { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: [`arn:aws:s3:::${bucket}/${prefix}/*`] },
  ] }, null, 2)}\n`,
  { mode: 0o600 },
);
writeRestoreEvidence("production-like");
writeVerifyEvidence("production-like");

try {
  run("docker", ["network", "create", network]);
  run("docker", [
    "run", "-d", "--name", server, "--network", network,
    "-e", `MINIO_ROOT_USER=${rootUser}`,
    "-e", `MINIO_ROOT_PASSWORD=${rootPassword}`,
    minioImage, "server", "/data",
  ]);
  waitForMinio();
  bootstrapBackupUser();
  seedStaleOffsiteObject();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);

  const commonEnv = {
    ...process.env,
    OWNMINUTES_BACKUP_DIR: backupDir,
    OWNMINUTES_BACKUP_OFFSITE_ENDPOINT: `http://${server}:9000`,
    OWNMINUTES_BACKUP_OFFSITE_BUCKET: bucket,
    OWNMINUTES_BACKUP_OFFSITE_PREFIX: prefix,
    OWNMINUTES_BACKUP_OFFSITE_ACCESS_KEY_FILE: accessKeyFile,
    OWNMINUTES_BACKUP_OFFSITE_SECRET_KEY_FILE: secretKeyFile,
    OWNMINUTES_BACKUP_OFFSITE_EVIDENCE_PATH: offsiteEvidencePath,
    OWNMINUTES_BACKUP_OFFSITE_DOCKER_NETWORK: network,
    OWNMINUTES_BACKUP_OFFSITE_ALLOW_INSECURE_TEST: "1",
    OWNMINUTES_BACKUP_OFFSITE_RETENTION_DAYS: "35",
    OWNMINUTES_BACKUP_OFFSITE_RETENTION_TEST_SECONDS: "1",
    OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH: restoreEvidencePath,
    OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH: verifyEvidencePath,
  };
  fs.writeFileSync(
    productionEnvFixture,
    `${[
      "OWNMINUTES_DOMAIN=smoke.ownminutes.test",
      `OWNMINUTES_BACKUP_DIR=${productionBackupDir}`,
      `OWNMINUTES_BACKUP_OFFSITE_ENDPOINT=http://${server}:9000`,
      `OWNMINUTES_BACKUP_OFFSITE_BUCKET=${bucket}`,
      `OWNMINUTES_BACKUP_OFFSITE_PREFIX=${prefix}`,
      `OWNMINUTES_BACKUP_OFFSITE_ACCESS_KEY_FILE=${accessKeyFile}`,
      `OWNMINUTES_BACKUP_OFFSITE_SECRET_KEY_FILE=${secretKeyFile}`,
      `OWNMINUTES_BACKUP_OFFSITE_EVIDENCE_PATH=${offsiteEvidencePath}`,
      `OWNMINUTES_BACKUP_OFFSITE_DOCKER_NETWORK=${network}`,
      "OWNMINUTES_BACKUP_OFFSITE_ALLOW_INSECURE_TEST=1",
      "OWNMINUTES_BACKUP_OFFSITE_RETENTION_DAYS=35",
      "OWNMINUTES_BACKUP_OFFSITE_RETENTION_TEST_SECONDS=1",
      `OWNMINUTES_BACKUP_RESTORE_EVIDENCE_PATH=${restoreEvidencePath}`,
      `OWNMINUTES_BACKUP_VERIFY_EVIDENCE_PATH=${verifyEvidencePath}`,
      "OWNMINUTES_BACKUP_MAX_AGE_HOURS=26",
      "OWNMINUTES_BACKUP_OFFSITE_MAX_AGE_HOURS=26",
      "OWNMINUTES_BACKUP_RESTORE_MAX_AGE_DAYS=35",
    ].join("\n")}\n`,
    { mode: 0o600 },
  );

  const injectedFailure = spawnSync(
    "node",
    ["scripts/production-backup-replicate.mjs", "--mode", "production-like"],
    {
      cwd: root,
      env: {
        ...commonEnv,
        OWNMINUTES_BACKUP_OFFSITE_TEST_FAIL_AFTER_TEMP_VERIFY: "1",
      },
      encoding: "utf8",
    },
  );
  const stalePreservedAfterFailure = !staleOffsiteObjectWasRemoved();
  const failedRunWroteNoEvidence = !fs.existsSync(offsiteEvidencePath);

  const replicationOutput = run("node", ["scripts/production-backup-replicate.mjs", "--mode", "production-like"], { env: commonEnv, capture: true });
  const replication = JSON.parse(replicationOutput);
  const evidence = JSON.parse(fs.readFileSync(offsiteEvidencePath, "utf8"));
  const freshnessOutput = run("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production-like", "--strict"], { env: commonEnv, capture: true });
  const freshness = JSON.parse(freshnessOutput);
  const fileOnlyEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    OWNMINUTES_PRODUCTION_ENV_FILE: productionEnvFixture,
  };
  const fileConfiguredReplicationOutput = run("node", ["scripts/production-backup-replicate.mjs", "--mode", "production"], { env: fileOnlyEnv, capture: true });
  const fileConfiguredReplication = JSON.parse(fileConfiguredReplicationOutput);
  writeRestoreEvidence("production");
  writeVerifyEvidence("production");
  const fileConfiguredFreshnessOutput = run("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production", "--strict"], { env: fileOnlyEnv, capture: true });
  const fileConfiguredFreshness = JSON.parse(fileConfiguredFreshnessOutput);
  fs.writeFileSync(offsiteEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  writeRestoreEvidence("production-like");
  writeVerifyEvidence("production-like");
  const systemdDirectory = path.join(scratch, "systemd");
  const systemdOutput = run("node", ["scripts/render-production-backup-systemd.mjs", "--user", "ownminutes", "--working-directory", root, "--production-env-file", productionEnvFixture, "--output-dir", systemdDirectory], { capture: true });
  const serviceText = fs.readFileSync(path.join(systemdDirectory, "ownminutes-backup.service"), "utf8");
  const timerText = fs.readFileSync(path.join(systemdDirectory, "ownminutes-backup.timer"), "utf8");

  writeVerifyEvidence("production-like", {
    backupCreatedAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
  });
  fs.utimesSync(artifact, new Date(), new Date());
  const stale = spawnSync("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production-like", "--strict"], {
    cwd: root,
    env: { ...commonEnv, OWNMINUTES_BACKUP_MAX_AGE_HOURS: "26" },
    encoding: "utf8",
  });
  const stalePayload = JSON.parse(stale.stdout);
  writeVerifyEvidence("production-like");

  writeRestoreEvidence("production-like", {
    format: "ownminutes-backup-restore-evidence:v1",
  });
  const oldRestoreSchema = spawnSync("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production-like", "--strict"], {
    cwd: root,
    env: commonEnv,
    encoding: "utf8",
  });
  const oldRestoreSchemaPayload = JSON.parse(oldRestoreSchema.stdout);
  writeRestoreEvidence("production-like", {
    objects: { restored: true },
  });
  const missingReferenceProof = spawnSync("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production-like", "--strict"], {
    cwd: root,
    env: commonEnv,
    encoding: "utf8",
  });
  const missingReferenceProofPayload = JSON.parse(missingReferenceProof.stdout);

  writeRestoreEvidence("production-like", {
    backupFormat: "ownminutes-backup:v1",
    audit: { verified: false, fileCount: 0 },
  });
  const legacyRestore = spawnSync("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production-like", "--strict"], {
    cwd: root,
    env: commonEnv,
    encoding: "utf8",
  });
  const legacyRestorePayload = JSON.parse(legacyRestore.stdout);
  writeRestoreEvidence("production-like", { artifactSha256: "invalid" });
  const wrongRestoreArtifact = spawnSync("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production-like", "--strict"], {
    cwd: root,
    env: commonEnv,
    encoding: "utf8",
  });
  const wrongRestoreArtifactPayload = JSON.parse(wrongRestoreArtifact.stdout);
  writeRestoreEvidence("production-like");

  const mismatched = { ...evidence, sha256: "0".repeat(64) };
  fs.writeFileSync(offsiteEvidencePath, `${JSON.stringify(mismatched, null, 2)}\n`, { mode: 0o600 });
  const mismatch = spawnSync("node", ["scripts/check-production-backup-freshness.mjs", "--mode", "production-like", "--strict"], {
    cwd: root,
    env: commonEnv,
    encoding: "utf8",
  });
  const mismatchPayload = JSON.parse(mismatch.stdout);

  const outputText = `${injectedFailure.stdout}\n${injectedFailure.stderr}\n${replicationOutput}\n${freshnessOutput}\n${fileConfiguredReplicationOutput}\n${fileConfiguredFreshnessOutput}\n${systemdOutput}\n${stale.stdout}\n${oldRestoreSchema.stdout}\n${missingReferenceProof.stdout}\n${legacyRestore.stdout}\n${wrongRestoreArtifact.stdout}\n${mismatch.stdout}`;
  const checks = {
    generatedCredentialsCannotBeParsedAsFlags: !rootPassword.startsWith("-") && !backupPassword.startsWith("-"),
    failureBeforePromotionRejected:
      injectedFailure.status !== 0 &&
      `${injectedFailure.stdout}${injectedFailure.stderr}`.includes("Injected off-site backup failure after temporary verification"),
    expiredBackupPreservedOnFailedReplication: stalePreservedAfterFailure,
    failedReplicationWroteNoSuccessEvidence: failedRunWroteNoEvidence,
    replicationPassed: replication.ok === true,
    temporaryUploadVerified: replication.verification?.temporaryUploadVerified === true,
    promotionSucceeded: replication.verification?.promotionSucceeded === true,
    remoteStatSucceeded: replication.verification?.remoteStatSucceeded === true,
    fullDownloadVerified: replication.verification?.fullDownloadVerified === true,
    currentArtifactRetainedAfterCleanup:
      replication.verification?.retainedAfterCleanup === true &&
      evidence.retention?.currentArtifactPreserved === true,
    evidencePrivate: isPrivateFile(offsiteEvidencePath),
    evidenceMatchesArtifact: evidence.sha256 === sha256File(artifact) && evidence.bytes === fs.statSync(artifact).size,
    freshnessPassed: freshness.ok === true && freshness.failureIds.length === 0,
    staleOffsiteObjectRemoved: staleOffsiteObjectWasRemoved(),
    retentionEvidenceRecorded:
      evidence.retention?.cleanupSucceeded === true && evidence.retention?.days === 35,
    productionReadsFileConfiguration: fileConfiguredReplication.ok === true && fileConfiguredFreshness.ok === true,
    staleBackupRejected: stale.status !== 0 && stalePayload.failureIds.includes("backup-fresh"),
    oldRestoreEvidenceSchemaRejected:
      oldRestoreSchema.status !== 0 &&
      oldRestoreSchemaPayload.failureIds.includes("restore-evidence-schema"),
    missingRestoreReferenceProofRejected:
      missingReferenceProof.status !== 0 &&
      missingReferenceProofPayload.failureIds.includes("restore-object-references-verified"),
    legacyRestoreEvidenceRejected:
      legacyRestore.status !== 0 &&
      legacyRestorePayload.failureIds.includes("restore-backup-format-current") &&
      legacyRestorePayload.failureIds.includes("restore-audit-verified"),
    restoreEvidenceBoundToLatestArtifact:
      wrongRestoreArtifact.status !== 0 &&
      wrongRestoreArtifactPayload.failureIds.includes("restore-artifact-identity-valid"),
    mismatchRejected: mismatch.status !== 0 && mismatchPayload.failureIds.includes("offsite-matches-latest"),
    productionRejectsInsecureEndpoint: rejectsInsecureProduction(commonEnv),
    backupUserCannotCreateBucket: backupUserCannotCreateBucket(),
    systemdRunsFullChain:
      serviceText.includes("production:backup\n") &&
      serviceText.includes("production:backup:verify") &&
      serviceText.includes("production:backup:replicate") &&
      serviceText.includes("production:backup:freshness"),
    systemdUsesPrivateUmask: serviceText.includes("UMask=0077"),
    timerIsPersistent: timerText.includes("Persistent=true") && timerText.includes("RandomizedDelaySec=30m"),
    unitsContainNoSecrets: !serviceText.includes(backupUser) && !serviceText.includes(backupPassword) && !serviceText.includes(rootPassword) && !timerText.includes(backupUser) && !timerText.includes(backupPassword),
    secretsNotPrinted: !outputText.includes(backupUser) && !outputText.includes(backupPassword) && !outputText.includes(rootPassword),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  console.log(JSON.stringify({ ok: failed.length === 0, checks, failed }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
} finally {
  run("docker", ["rm", "-f", server], { allowFailure: true });
  run("docker", ["network", "rm", network], { allowFailure: true });
  fs.rmSync(scratch, { force: true, recursive: true });
}

function writeRestoreEvidence(evidenceMode, overrides = {}) {
  const evidenceArtifact = evidenceMode === "production" ? productionArtifact : artifact;
  const evidence = {
    ok: true,
    format: "ownminutes-backup-restore-evidence:v2",
    action: "restore-drill",
    mode: evidenceMode,
    backupFormat: "ownminutes-backup:v2",
    artifactName: path.basename(evidenceArtifact),
    artifactBytes: fs.statSync(evidenceArtifact).size,
    artifactSha256: sha256File(evidenceArtifact),
    artifactDevice: String(fs.statSync(evidenceArtifact).dev),
    artifactInode: String(fs.statSync(evidenceArtifact).ino),
    backupCreatedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    database: { restored: true },
    objects: {
      restored: true,
      referencesVerified: true,
      activeMeetingCount: 0,
      referencedObjectCount: 0,
    },
    audit: { verified: true, fileCount: 0 },
    ...overrides,
  };
  fs.writeFileSync(
    restoreEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function writeVerifyEvidence(evidenceMode, overrides = {}) {
  const evidenceArtifact = evidenceMode === "production" ? productionArtifact : artifact;
  const evidence = {
    ok: true,
    format: "ownminutes-backup-verify-evidence:v1",
    action: "verify",
    mode: evidenceMode,
    backupFormat: "ownminutes-backup:v2",
    artifactName: path.basename(evidenceArtifact),
    artifactBytes: fs.statSync(evidenceArtifact).size,
    artifactSha256: sha256File(evidenceArtifact),
    artifactDevice: String(fs.statSync(evidenceArtifact).dev),
    artifactInode: String(fs.statSync(evidenceArtifact).ino),
    backupCreatedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(
    verifyEvidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function rejectsInsecureProduction(env) {
  const result = spawnSync("node", ["scripts/production-backup-replicate.mjs", "--mode", "production-like"], {
    cwd: root,
    env: {
      ...env,
      OWNMINUTES_BACKUP_OFFSITE_ALLOW_INSECURE_TEST: "0",
      OWNMINUTES_BACKUP_OFFSITE_DOCKER_NETWORK: "",
    },
    encoding: "utf8",
  });
  return result.status !== 0 && `${result.stdout}${result.stderr}`.includes("public HTTPS");
}

function bootstrapBackupUser() {
  const command = [
    "set -eu",
    'mc alias set offsite "http://$MINIO_HOST:9000" "$ROOT_USER" "$ROOT_PASSWORD" >/dev/null',
    'mc mb --ignore-existing "offsite/$BACKUP_BUCKET" >/dev/null',
    'mc anonymous set none "offsite/$BACKUP_BUCKET" >/dev/null',
    'mc admin user add offsite "$BACKUP_USER" "$BACKUP_PASSWORD" >/dev/null',
    'mc admin policy create offsite ownminutes-offsite-backup /policy/backup-policy.json >/dev/null',
    'mc admin policy attach offsite ownminutes-offsite-backup --user "$BACKUP_USER" >/dev/null',
  ].join(" && ");
  run("docker", [
    "run", "--rm", "--network", network,
    "-e", `MINIO_HOST=${server}`,
    "-e", `ROOT_USER=${rootUser}`,
    "-e", `ROOT_PASSWORD=${rootPassword}`,
    "-e", `BACKUP_USER=${backupUser}`,
    "-e", `BACKUP_PASSWORD=${backupPassword}`,
    "-e", `BACKUP_BUCKET=${bucket}`,
    "-v", `${policyFile}:/policy/backup-policy.json:ro`,
    "--entrypoint", "/bin/sh", mcImage, "-c", command,
  ], { capture: true });
}

function backupUserCannotCreateBucket() {
  const command = [
    'ACCESS_KEY=$(cat /run/secrets/access-key)',
    'SECRET_KEY=$(cat /run/secrets/secret-key)',
    'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
    'mc mb "offsite/forbidden-bucket" >/dev/null 2>&1',
  ].join(" && ");
  const result = spawnSync("docker", [
    "run", "--rm", "--network", network,
    "-e", `OFFSITE_ENDPOINT=http://${server}:9000`,
    "-v", `${accessKeyFile}:/run/secrets/access-key:ro`,
    "-v", `${secretKeyFile}:/run/secrets/secret-key:ro`,
    "--entrypoint", "/bin/sh", mcImage, "-c", command,
  ], { encoding: "utf8" });
  return result.status !== 0;
}

function seedStaleOffsiteObject() {
  const command = [
    "set -eu",
    'ACCESS_KEY=$(cat /run/secrets/access-key)',
    'SECRET_KEY=$(cat /run/secrets/secret-key)',
    'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
    'mc cp /source/backup.ombak "offsite/$OFFSITE_BUCKET/$OFFSITE_OBJECT_KEY" >/dev/null',
  ].join(" && ");
  run("docker", [
    "run", "--rm", "--network", network,
    "-e", `OFFSITE_ENDPOINT=http://${server}:9000`,
    "-e", `OFFSITE_BUCKET=${bucket}`,
    "-e", `OFFSITE_OBJECT_KEY=${staleObjectKey}`,
    "-v", `${artifact}:/source/backup.ombak:ro`,
    "-v", `${accessKeyFile}:/run/secrets/access-key:ro`,
    "-v", `${secretKeyFile}:/run/secrets/secret-key:ro`,
    "--entrypoint", "/bin/sh", mcImage, "-c", command,
  ], { capture: true });
}

function staleOffsiteObjectWasRemoved() {
  const command = [
    'ACCESS_KEY=$(cat /run/secrets/access-key)',
    'SECRET_KEY=$(cat /run/secrets/secret-key)',
    'mc alias set offsite "$OFFSITE_ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" >/dev/null',
    'mc stat "offsite/$OFFSITE_BUCKET/$OFFSITE_OBJECT_KEY" >/dev/null 2>&1',
  ].join(" && ");
  const result = spawnSync("docker", [
    "run", "--rm", "--network", network,
    "-e", `OFFSITE_ENDPOINT=http://${server}:9000`,
    "-e", `OFFSITE_BUCKET=${bucket}`,
    "-e", `OFFSITE_OBJECT_KEY=${staleObjectKey}`,
    "-v", `${accessKeyFile}:/run/secrets/access-key:ro`,
    "-v", `${secretKeyFile}:/run/secrets/secret-key:ro`,
    "--entrypoint", "/bin/sh", mcImage, "-c", command,
  ], { encoding: "utf8" });
  return result.status !== 0;
}

function waitForMinio() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = spawnSync("docker", ["run", "--rm", "--network", network, mcImage, "alias", "set", "offsite", `http://${server}:9000`, rootUser, rootPassword], { encoding: "utf8" });
    if (probe.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
  }
  throw new Error("Timed out waiting for off-site MinIO smoke server.");
}

function isPrivateFile(file) {
  const stats = fs.statSync(file);
  return stats.isFile() && (stats.mode & 0o077) === 0;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function randomCliSafeSecret(prefix) {
  return `${prefix}-${crypto.randomBytes(32).toString("base64url")}`;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "ignore",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${executable} failed with status ${result.status}: ${result.stderr || result.stdout}`);
  return options.capture ? result.stdout : result;
}
