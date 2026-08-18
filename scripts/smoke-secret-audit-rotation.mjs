#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-audit-rotation-"));
const activeDirectory = path.join(scratch, "active");
const archiveDirectory = path.join(scratch, "archive");
const activePath = path.join(activeDirectory, "secret-audit.jsonl");
const heartbeatPath = path.join(activeDirectory, ".rotation-heartbeat.json");
const env = {
  ...process.env,
  OWNMINUTES_SECRET_AUDIT_LOG: activePath,
  OWNMINUTES_SECRET_AUDIT_ARCHIVE_DIR: archiveDirectory,
  OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE: heartbeatPath,
  OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS: "60",
  OWNMINUTES_SECRET_AUDIT_ROTATE_BYTES: String(1024 * 1024),
  OWNMINUTES_SECRET_AUDIT_RETENTION_DAYS: "30",
};

try {
  fs.mkdirSync(activeDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({
    id: "audit-rotation-smoke",
    eventType: "provider_secret_save",
    userRef: "user_0123456789abcdef01234567",
    secretNames: [],
    createdAt: new Date().toISOString(),
  })}\n`;
  const payload = line.repeat(Math.ceil((1024 * 1024 + 4096) / Buffer.byteLength(line)));
  fs.writeFileSync(activePath, payload, { mode: 0o600 });

  const raceLine = `${JSON.stringify({
    id: "audit-writer-rotation-race",
    eventType: "provider_secret_rotate",
    userRef: "user_0123456789abcdef01234567",
    secretNames: [],
    createdAt: new Date().toISOString(),
  })}\n`;
  const writerMarker = path.join(scratch, "writer-open.marker");
  const writer = spawn(
    "perl",
    [
      "scripts/with-file-lock.pl",
      `${activePath}.lock`,
      "5",
      process.execPath,
      "scripts/secret-audit-file-operation.mjs",
      "append",
      activePath,
      String(4 * 1024 * 1024),
      "0",
      "0",
    ],
    {
      cwd: root,
      env: {
        ...env,
        OWNMINUTES_SECRET_AUDIT_TEST_HOOKS: "1",
        OWNMINUTES_SECRET_AUDIT_TEST_MARKER_FILE: writerMarker,
        OWNMINUTES_SECRET_AUDIT_TEST_PAUSE_AFTER_OPEN_MS: "750",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let writerError = "";
  writer.stderr.on("data", (chunk) => {
    writerError += chunk.toString("utf8");
  });
  writer.stdin.end(raceLine);
  const writerFinished = childResult(writer);
  await waitForFile(writerMarker, 5_000);
  const first = run(["--once"], true);
  const writerStatus = await writerFinished;
  if (writerStatus !== 0) throw new Error(writerError || "Concurrent audit writer failed.");
  const firstSummary = JSON.parse(first.stdout);
  const archives = fs.readdirSync(archiveDirectory).filter((name) => name.endsWith(".jsonl"));
  if (archives.length !== 1 || fs.existsSync(activePath)) {
    throw new Error("Audit rotation did not move the full active log into one archive.");
  }
  const archivePath = path.join(archiveDirectory, archives[0]);
  const digestPath = `${archivePath}.sha256`;
  const archiveDigest = sha256File(archivePath);
  const digestText = fs.readFileSync(digestPath, "utf8");
  if (
    firstSummary.ok !== true ||
    firstSummary.archived !== 1 ||
    fs.readFileSync(archivePath, "utf8") !== `${payload}${raceLine}` ||
    !digestText.startsWith(archiveDigest) ||
    (fs.statSync(archivePath).mode & 0o777) !== 0o600 ||
    (fs.statSync(heartbeatPath).mode & 0o777) !== 0o600
  ) {
    throw new Error("Rotated audit archive integrity, permissions or heartbeat are invalid.");
  }
  run(["--healthcheck"]);

  const crashPhases = [
    "after_archive_pending_fsync",
    "after_archive_rename",
    "after_digest_write",
    "before_rotating_remove",
  ];
  for (const phase of crashPhases) {
    const phaseActivePath = path.join(activeDirectory, `secret-audit-${phase}.jsonl`);
    const phaseHeartbeatPath = path.join(activeDirectory, `.rotation-${phase}.json`);
    fs.writeFileSync(phaseActivePath, payload, { mode: 0o600 });
    const phaseEnv = {
      OWNMINUTES_SECRET_AUDIT_LOG: phaseActivePath,
      OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE: phaseHeartbeatPath,
      OWNMINUTES_SECRET_AUDIT_ROTATION_TEST_HOOKS: "1",
      OWNMINUTES_SECRET_AUDIT_ROTATION_TEST_CRASH_PHASE: phase,
    };
    const crashed = run(["--once"], false, phaseEnv);
    if (crashed.status === 0) throw new Error(`Audit rotator crash hook did not fire at ${phase}.`);
    run(["--once"], true, {
      ...phaseEnv,
      OWNMINUTES_SECRET_AUDIT_ROTATION_TEST_CRASH_PHASE: "",
    });
    const prefix = `${path.basename(phaseActivePath)}-`;
    const phaseArchives = fs.readdirSync(archiveDirectory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"));
    if (
      phaseArchives.length !== 1 ||
      fs.existsSync(phaseActivePath) ||
      sha256File(path.join(archiveDirectory, phaseArchives[0])) !== sha256Text(payload) ||
      !fs.existsSync(path.join(archiveDirectory, `${phaseArchives[0]}.sha256`))
    ) {
      throw new Error(`Audit rotator did not converge after crash phase ${phase}.`);
    }
  }

  const pruneCrashArchivePath = path.join(
    archiveDirectory,
    "secret-audit-prune-crash.jsonl",
  );
  fs.writeFileSync(pruneCrashArchivePath, line, { mode: 0o600 });
  fs.writeFileSync(
    `${pruneCrashArchivePath}.sha256`,
    `${sha256File(pruneCrashArchivePath)}  ${path.basename(pruneCrashArchivePath)}\n`,
    { mode: 0o600 },
  );
  const pruneCrashStaleDate = new Date(Date.now() - 31 * 86_400_000);
  fs.utimesSync(pruneCrashArchivePath, pruneCrashStaleDate, pruneCrashStaleDate);
  fs.utimesSync(
    `${pruneCrashArchivePath}.sha256`,
    pruneCrashStaleDate,
    pruneCrashStaleDate,
  );
  const pruneCrash = run(["--once"], false, {
    OWNMINUTES_SECRET_AUDIT_ROTATION_TEST_HOOKS: "1",
    OWNMINUTES_SECRET_AUDIT_ROTATION_TEST_CRASH_PHASE:
      "after_pruned_archive_remove",
  });
  if (
    pruneCrash.status === 0 ||
    fs.existsSync(pruneCrashArchivePath) ||
    !fs.existsSync(`${pruneCrashArchivePath}.sha256`)
  ) {
    throw new Error("Audit retention crash hook did not leave the expected orphan sidecar.");
  }
  const pruneRecovery = JSON.parse(run(["--once"], true).stdout);
  if (
    pruneRecovery.recoveredOrphanSidecars !== 1 ||
    fs.existsSync(`${pruneCrashArchivePath}.sha256`)
  ) {
    throw new Error("Audit retention did not recover its crash-window orphan sidecar.");
  }
  const repeatedPruneRecovery = JSON.parse(run(["--once"], true).stdout);
  if (repeatedPruneRecovery.recoveredOrphanSidecars !== 0) {
    throw new Error("Audit retention orphan recovery was not idempotent.");
  }

  const invalidOrphan = path.join(
    archiveDirectory,
    "secret-audit-invalid-orphan.jsonl.sha256",
  );
  fs.writeFileSync(
    invalidOrphan,
    `${"0".repeat(64)}  wrong-archive.jsonl\n`,
    { mode: 0o600 },
  );
  const invalidOrphanResult = run(["--once"], false);
  if (invalidOrphanResult.status === 0 || !fs.existsSync(invalidOrphan)) {
    throw new Error("Audit rotation accepted or removed an invalid orphan sidecar.");
  }
  fs.rmSync(invalidOrphan);

  const symlinkTarget = path.join(scratch, "unsafe-sidecar-target");
  const symlinkOrphan = path.join(
    archiveDirectory,
    "secret-audit-symlink-orphan.jsonl.sha256",
  );
  fs.writeFileSync(
    symlinkTarget,
    `${"0".repeat(64)}  secret-audit-symlink-orphan.jsonl\n`,
    { mode: 0o600 },
  );
  fs.symlinkSync(symlinkTarget, symlinkOrphan);
  const symlinkOrphanResult = run(["--once"], false);
  if (symlinkOrphanResult.status === 0 || !fs.lstatSync(symlinkOrphan).isSymbolicLink()) {
    throw new Error("Audit rotation accepted or followed a symbolic-link orphan sidecar.");
  }
  fs.rmSync(symlinkOrphan);

  const pendingPath = `${activePath}.rotating-recovery-fixture`;
  fs.writeFileSync(pendingPath, line, { mode: 0o600 });
  const staleArchivePath = path.join(archiveDirectory, "secret-audit-stale.jsonl");
  fs.writeFileSync(staleArchivePath, line, { mode: 0o600 });
  fs.writeFileSync(`${staleArchivePath}.sha256`, `${sha256File(staleArchivePath)}  secret-audit-stale.jsonl\n`, { mode: 0o600 });
  const staleDate = new Date(Date.now() - 31 * 86_400_000);
  fs.utimesSync(staleArchivePath, staleDate, staleDate);
  fs.utimesSync(`${staleArchivePath}.sha256`, staleDate, staleDate);
  const secondSummary = JSON.parse(run(["--once"], true).stdout);
  if (
    secondSummary.archived !== 1 ||
    secondSummary.deletedArchives !== 1 ||
    fs.existsSync(pendingPath) ||
    fs.existsSync(staleArchivePath)
  ) {
    throw new Error("Audit rotation did not recover a pending rotation or enforce retention.");
  }

  const snapshotRecoveryPath = `${activePath}.rotating-snapshot-recovery`;
  fs.writeFileSync(snapshotRecoveryPath, line, { mode: 0o600 });
  const validSnapshot = path.join(scratch, "snapshot-valid");
  fs.mkdirSync(validSnapshot, { mode: 0o700 });
  runSnapshot(validSnapshot, true);
  if (
    fs.existsSync(snapshotRecoveryPath) ||
    fs.readdirSync(path.join(validSnapshot, "archive"))
      .filter((name) => name.endsWith(".jsonl")).length === 0
  ) {
    throw new Error("Audit snapshot did not recover rotation state before copying.");
  }

  const archiveFixture = fs.readdirSync(archiveDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()[0];
  const archiveFixturePath = path.join(archiveDirectory, archiveFixture);
  const archiveFixtureDigestPath = `${archiveFixturePath}.sha256`;
  const correctDigest = `${sha256File(archiveFixturePath)}  ${archiveFixture}\n`;

  fs.writeFileSync(archiveFixtureDigestPath, `${"0".repeat(64)}  ${archiveFixture}\n`, { mode: 0o600 });
  if (runSnapshot(path.join(scratch, "snapshot-bad-sidecar"), false).status === 0) {
    throw new Error("Audit snapshot accepted an incorrect digest sidecar.");
  }
  fs.writeFileSync(archiveFixtureDigestPath, correctDigest, { mode: 0o600 });

  fs.rmSync(archiveFixtureDigestPath);
  if (runSnapshot(path.join(scratch, "snapshot-missing-sidecar"), false).status === 0) {
    throw new Error("Audit snapshot accepted a missing digest sidecar.");
  }
  fs.writeFileSync(archiveFixtureDigestPath, correctDigest, { mode: 0o600 });

  const orphanSidecar = path.join(archiveDirectory, "secret-audit-orphan.jsonl.sha256");
  fs.writeFileSync(orphanSidecar, `${"0".repeat(64)}  secret-audit-orphan.jsonl\n`, { mode: 0o600 });
  if (
    runSnapshot(path.join(scratch, "snapshot-fresh-orphan-sidecar"), false).status === 0 ||
    !fs.existsSync(orphanSidecar)
  ) {
    throw new Error("Audit snapshot accepted or removed a fresh orphan digest sidecar.");
  }
  const staleOrphanDate = new Date(Date.now() - 31 * 86_400_000);
  fs.utimesSync(orphanSidecar, staleOrphanDate, staleOrphanDate);
  if (
    runSnapshot(path.join(scratch, "snapshot-stale-orphan-sidecar"), true).status !== 0 ||
    fs.existsSync(orphanSidecar)
  ) {
    throw new Error("Audit snapshot did not recover a retention-expired orphan digest sidecar.");
  }

  const pendingArchive = path.join(archiveDirectory, "secret-audit-unfinished.jsonl.pending");
  fs.writeFileSync(pendingArchive, line, { mode: 0o600 });
  if (runSnapshot(path.join(scratch, "snapshot-pending"), false).status === 0) {
    throw new Error("Audit snapshot accepted an unfinished archive.");
  }
  fs.rmSync(pendingArchive);

  fs.writeFileSync(activePath, `${line}TRUNCATED`, { mode: 0o600 });
  if (runSnapshot(path.join(scratch, "snapshot-truncated"), false).status === 0) {
    throw new Error("Audit snapshot accepted a truncated active JSONL record.");
  }
  fs.rmSync(activePath);

  fs.writeFileSync(
    heartbeatPath,
    `${JSON.stringify({ ok: true, checkedAt: new Date(Date.now() - 1000 * 1_000).toISOString() })}\n`,
    { mode: 0o600 },
  );
  const staleHealth = run(["--healthcheck"], false);
  if (staleHealth.status === 0) throw new Error("Stale audit rotation heartbeat was accepted.");

  console.log(JSON.stringify({
    rotatesBeforeCapacityLimit: true,
    archiveChecksumVerified: true,
    archivePermissionsPrivate: true,
    writerRotationRacePreservesEvent: true,
    kernelLockReleasedAfterCrashes: true,
    crashRecoveryConvergesAtEveryArchivePhase: true,
    pruneCrashOrphanRecoveredIdempotently: true,
    invalidOrphanSidecarRejected: true,
    symlinkOrphanSidecarRejected: true,
    pendingRotationRecovered: true,
    snapshotRecoversBeforeCopy: true,
    snapshotRejectsWrongAndMissingSidecars: true,
    snapshotRejectsFreshOrphanSidecar: true,
    snapshotRecoversRetentionExpiredOrphanSidecar: true,
    snapshotRejectsPendingArchive: true,
    snapshotRejectsTruncatedJsonl: true,
    retentionEnforced: true,
    healthyHeartbeatAccepted: true,
    staleHeartbeatRejected: true,
  }, null, 2));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

function run(args, required = true, environment = {}) {
  const result = spawnSync(
    process.execPath,
    ["scripts/rotate-secret-audit-log.mjs", ...args],
    { cwd: root, env: { ...env, ...environment }, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (required && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Audit rotation command failed.");
  }
  return result;
}

function runSnapshot(destination, required) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const result = spawnSync(
    "perl",
    [
      "scripts/with-file-lock.pl",
      `${activePath}.lock`,
      "5",
      process.execPath,
      "scripts/copy-secret-audit-snapshot.mjs",
      destination,
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (required && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Audit snapshot command failed.");
  }
  return result;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function childResult(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(signal ? 128 : code ?? 1));
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the audit writer race marker.");
}
