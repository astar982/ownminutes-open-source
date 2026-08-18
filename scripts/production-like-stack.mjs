#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  spawnSyncWithInheritedFileLocks as spawnSync,
} from "./lib/inherited-file-lock.mjs";
import {
  claimLegacyStackOwner,
  legacyStackOwnerFile,
} from "./lib/production-like-stack-owner.mjs";

const action = process.argv[2] || "status";
const root = process.cwd();
const realRoot = fs.realpathSync(root);
const stateDir = path.join(root, ".data", "production-like");
const envFile = path.join(stateDir, "stack.env");
const operationLockPath = path.join(stateDir, "operation.lock");
const stageIdentity = crypto.createHash("sha256").update(realRoot).digest("hex").slice(0, 12);
const supportedActions = new Set(["up", "down", "reset", "status", "verify", "test"]);

if (!supportedActions.has(action)) {
  throw new Error(`Unsupported action: ${action}. Use up, down, reset, status, verify, or test.`);
}

if (process.env.OWNMINUTES_STACK_OPERATION_LOCK_HELD !== "1") {
  runWithKernelOperationLock();
}

const sessionRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `ownminutes-production-like-stack-${stageIdentity}-`),
);
const stageRoot = path.join(sessionRoot, "source");
const stagedComposeFile = path.join(stageRoot, "deploy", "compose.production-like.yml");
const stagedEnvFile = path.join(sessionRoot, "stack.env");
let currentSourceFingerprint = "";

try {
  await main();
} finally {
  fs.rmSync(sessionRoot, { force: true, recursive: true });
}

async function main() {
  assertDocker();

  if (action === "up") {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    ensureLocalSecrets();
    ensureStackIdentity();
    syncAsciiStage();
    runCompose(["up", "--build", "--detach", "--remove-orphans"]);
    await verifyStack({ wait: true });
    return;
  }

  if (!fs.existsSync(envFile)) {
    if (action === "status" || action === "down" || action === "reset") {
      console.log(JSON.stringify({ ok: true, action, running: false, detail: "Production-like stack has not been initialized." }, null, 2));
      return;
    }
    throw new Error("Production-like stack is not initialized. Run `npm run stack:up` first.");
  }

  ensureStackIdentity();
  syncAsciiStage();

  if (action === "down") {
    runCompose(["down", "--remove-orphans"]);
    return;
  }

  if (action === "reset") {
    runCompose(["down", "--volumes", "--remove-orphans"]);
    fs.rmSync(envFile, { force: true });
    console.log(JSON.stringify({ ok: true, action, localSecretsRemoved: true, volumesRemoved: true }, null, 2));
    return;
  }

  if (action === "status") {
    runCompose(["ps"]);
    return;
  }

  await verifyStack({ wait: false });
  if (action === "test" && process.exitCode !== 1) {
    runDeploymentLiveSmoke();
    runBusinessSmoke();
    runQueueRecoverySmoke();
  }
}

function runWithKernelOperationLock() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const result = spawnSync(
    "perl",
    [
      path.join(root, "scripts", "with-file-lock.pl"),
      operationLockPath,
      "2",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      path.join(root, "scripts", "production-like-stack.mjs"),
      action,
    ],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function assertDocker() {
  const result = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Docker Desktop or the Docker daemon is not available.");
}

function ensureLocalSecrets() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(envFile)) {
    const existing = parseEnvFile(envFile);
    if (!existing.OWNMINUTES_BACKUP_ENCRYPTION_KEY) {
      setEnvValues(envFile, {
        OWNMINUTES_BACKUP_ENCRYPTION_KEY: randomSecret(48),
      });
    }
    return;
  }

  const stackId = `wt-${stageIdentity}`;
  const values = {
    OWNMINUTES_APP_SECRET: randomSecret(48),
    OWNMINUTES_BACKUP_ENCRYPTION_KEY: randomSecret(48),
    OWNMINUTES_COMPOSE_BUCKET: "ownminutes-local",
    OWNMINUTES_COMPOSE_IMAGE: `ownminutes:pl-${stackId}`,
    OWNMINUTES_COMPOSE_MINIO_ROOT_PASSWORD: randomSecret(32),
    OWNMINUTES_COMPOSE_MINIO_ROOT_USER: "ownminutes_local",
    OWNMINUTES_COMPOSE_PORT: process.env.OWNMINUTES_COMPOSE_PORT || "0",
    OWNMINUTES_COMPOSE_PROJECT_NAME: `ownminutes-pl-${stackId}`,
    OWNMINUTES_COMPOSE_POSTGRES_PASSWORD: randomSecret(32),
    OWNMINUTES_STACK_FORMAT: "2",
    OWNMINUTES_STACK_ID: stackId,
  };
  const content = Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  fs.writeFileSync(envFile, `${content}\n`, { mode: 0o600 });
}

function ensureStackIdentity() {
  const existing = parseEnvFile(envFile);
  const identityFields = [
    "OWNMINUTES_STACK_FORMAT",
    "OWNMINUTES_STACK_ID",
    "OWNMINUTES_COMPOSE_PROJECT_NAME",
    "OWNMINUTES_COMPOSE_IMAGE",
  ];
  const configuredCount = identityFields.filter((name) => Boolean(existing[name])).length;
  if (configuredCount === 0) {
    const legacyResources = inspectLegacyResources();
    if (legacyResources.present) {
      assertLegacyStackClaimSafe(existing, legacyResources);
      setEnvValues(envFile, legacyStackIdentity());
    } else {
      setEnvValues(envFile, worktreeStackIdentity());
    }
    return;
  }
  if (configuredCount !== identityFields.length) {
    throw new Error("Production-like stack identity is partially configured; refusing to guess resource ownership.");
  }
  validateStackIdentity(existing);
  if (existing.OWNMINUTES_STACK_ID === "legacy-fixed") {
    assertConfiguredLegacyOwner(existing);
  }
}

function assertLegacyStackClaimSafe(environment, legacyResources) {
  if (!legacyResources.present) {
    throw new Error("Legacy production-like ownership cannot be claimed without legacy resources.");
  }
  const containers = spawnSync(
    "docker",
    [
      "ps",
      "--all",
      "--filter",
      "label=com.docker.compose.project=ownminutes-production-like",
      "--filter",
      "label=com.docker.compose.service=app",
      "--format",
      "{{.Image}}",
    ],
    { encoding: "utf8" },
  );
  if (containers.status !== 0) {
    throw new Error("Unable to inspect the legacy production-like stack before ownership migration.");
  }
  const image = containers.stdout.trim().split(/\r?\n/).filter(Boolean)[0];
  if (!image) {
    throw new Error(
      "Legacy production-like data exists without an attributable App container; refusing to guess its owner.",
    );
  }
  const inspected = spawnSync(
    "docker",
    [
      "image",
      "inspect",
      "--format",
      '{{ index .Config.Labels "app.ownminutes.source-fingerprint" }}',
      image,
    ],
    { encoding: "utf8" },
  );
  const runningFingerprint = inspected.status === 0 ? inspected.stdout.trim() : "";
  const recordedFingerprint = environment.OWNMINUTES_SOURCE_FINGERPRINT || "";
  if (!runningFingerprint || !recordedFingerprint) {
    throw new Error(
      "Legacy production-like stack lacks a complete source fingerprint; refusing to claim it.",
    );
  }
  if (runningFingerprint !== recordedFingerprint) {
    throw new Error("Legacy production-like stack belongs to a different source fingerprint; refusing to claim it.");
  }
  claimCurrentWorktreeAsLegacyOwner();
}

function assertConfiguredLegacyOwner(environment) {
  const legacyResources = inspectLegacyResources();
  const ownerFile = legacyOwnerFile();
  if (!fs.existsSync(ownerFile)) {
    assertLegacyStackClaimSafe(environment, legacyResources);
    return;
  }
  claimCurrentWorktreeAsLegacyOwner();
}

function inspectLegacyResources() {
  const resourceCommands = [
    ["ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=ownminutes-production-like"],
    ["volume", "ls", "--quiet", "--filter", "label=com.docker.compose.project=ownminutes-production-like"],
    ["network", "ls", "--quiet", "--filter", "label=com.docker.compose.project=ownminutes-production-like"],
  ];
  const ids = [];
  for (const args of resourceCommands) {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error("Unable to inspect legacy production-like Docker resources.");
    }
    ids.push(...result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  }
  return { present: ids.length > 0, count: ids.length };
}

function claimCurrentWorktreeAsLegacyOwner() {
  const dockerEngineId = readDockerEngineId();
  return claimLegacyStackOwner({
    ownerFile: legacyOwnerFile(dockerEngineId),
    dockerEngineId,
    stageIdentity,
  });
}

function legacyOwnerFile(engineId = readDockerEngineId()) {
  return legacyStackOwnerFile({
    dockerEngineId: engineId,
    homeDirectory: os.homedir(),
  });
}

function readDockerEngineId() {
  const result = spawnSync("docker", ["info", "--format", "{{.ID}}"], { encoding: "utf8" });
  const engineId = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(engineId)) {
    throw new Error("Unable to identify the Docker engine for legacy resource ownership.");
  }
  return engineId;
}

function worktreeStackIdentity() {
  const stackId = `wt-${stageIdentity}`;
  return {
    OWNMINUTES_STACK_FORMAT: "2",
    OWNMINUTES_STACK_ID: stackId,
    OWNMINUTES_COMPOSE_PROJECT_NAME: `ownminutes-pl-${stackId}`,
    OWNMINUTES_COMPOSE_IMAGE: `ownminutes:pl-${stackId}`,
  };
}

function legacyStackIdentity() {
  return {
    OWNMINUTES_STACK_FORMAT: "2",
    OWNMINUTES_STACK_ID: "legacy-fixed",
    OWNMINUTES_COMPOSE_PROJECT_NAME: "ownminutes-production-like",
    OWNMINUTES_COMPOSE_IMAGE: "ownminutes:production-like",
  };
}

function validateStackIdentity(environment) {
  if (environment.OWNMINUTES_STACK_FORMAT !== "2") {
    throw new Error("Unsupported production-like stack state format.");
  }
  if (!/^(?:legacy-fixed|wt-[a-f0-9]{12})$/.test(environment.OWNMINUTES_STACK_ID || "")) {
    throw new Error("Production-like stack ID is invalid.");
  }
  if (!/^(?:ownminutes-production-like|ownminutes-pl-wt-[a-f0-9]{12})$/.test(environment.OWNMINUTES_COMPOSE_PROJECT_NAME || "")) {
    throw new Error("Production-like Compose project name is invalid.");
  }
  if (!/^ownminutes:(?:production-like|pl-wt-[a-f0-9]{12})$/.test(environment.OWNMINUTES_COMPOSE_IMAGE || "")) {
    throw new Error("Production-like image tag is invalid.");
  }
  const legacy = environment.OWNMINUTES_STACK_ID === "legacy-fixed";
  if (
    legacy !==
    (
      environment.OWNMINUTES_COMPOSE_PROJECT_NAME === "ownminutes-production-like" &&
      environment.OWNMINUTES_COMPOSE_IMAGE === "ownminutes:production-like"
    )
  ) {
    throw new Error("Production-like stack identity fields do not describe one resource owner.");
  }
}

function randomSecret(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function syncAsciiStage() {
  fs.rmSync(stageRoot, { force: true, recursive: true });
  fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  const result = spawnSync(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude", ".data",
      "--exclude", ".git",
      "--exclude", ".next",
      "--exclude", "node_modules",
      "--exclude", "apps/mobile/node_modules",
      "--exclude", ".env*",
      "--exclude", "**/.env*",
      "--exclude", "stack.env",
      "--exclude", "**/stack.env",
      "--exclude", "deploy/secrets",
      "--exclude", "deploy/private",
      "--exclude", "**/*.pem",
      "--exclude", "**/*.p8",
      "--exclude", "**/*.p12",
      "--exclude", "**/*.pfx",
      "--exclude", "**/*.key",
      "--exclude", "**/*.token",
      "--exclude", "**/*.credentials",
      "--exclude", "**/*PRIVATE-ENCRYPTED-SECRET*",
      `${root}/`,
      `${stageRoot}/`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`Unable to prepare ASCII Docker staging directory: ${result.stderr || result.stdout}`);
  currentSourceFingerprint = fingerprintDirectory(stageRoot);
  setEnvValue(envFile, "OWNMINUTES_SOURCE_FINGERPRINT", currentSourceFingerprint);
  fs.copyFileSync(envFile, stagedEnvFile);
  fs.chmodSync(stagedEnvFile, 0o600);
}

function composeBaseArgs() {
  const environment = parseEnvFile(stagedEnvFile);
  validateStackIdentity(environment);
  return [
    "compose",
    "--project-name",
    environment.OWNMINUTES_COMPOSE_PROJECT_NAME,
    "--env-file",
    stagedEnvFile,
    "--file",
    stagedComposeFile,
  ];
}

function runCompose(args, options = {}) {
  const result = spawnSync("docker", [...composeBaseArgs(), ...args], {
    cwd: stageRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(`docker compose ${args.join(" ")} failed.`);
  }
  return result.stdout || "";
}

function runBusinessSmoke() {
  const port = discoverStackPort();
  const result = spawnSync("node", ["scripts/smoke-production-like-stack.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SMOKE_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Production-like business smoke test failed.");
}

function runDeploymentLiveSmoke() {
  const port = discoverStackPort();
  const result = spawnSync("npm", ["run", "smoke:deployment-live"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SMOKE_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Production-like deployment boundary smoke test failed.");
}

function runQueueRecoverySmoke() {
  const env = parseEnvFile(envFile);
  const port = discoverStackPort();
  const result = spawnSync("node", ["scripts/smoke-production-like-queue-recovery.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SMOKE_BASE_URL: `http://127.0.0.1:${port}`,
      OWNMINUTES_COMPOSE_FILE: stagedComposeFile,
      OWNMINUTES_COMPOSE_ENV_FILE: stagedEnvFile,
      OWNMINUTES_COMPOSE_CWD: stageRoot,
      OWNMINUTES_COMPOSE_PROJECT_NAME: env.OWNMINUTES_COMPOSE_PROJECT_NAME,
    },
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Production-like queue recovery smoke test failed.");
}

async function verifyStack({ wait }) {
  const port = discoverStackPort();
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const readinessUrl = `http://127.0.0.1:${port}/api/readyz`;
  const deadline = Date.now() + (wait ? 180_000 : 1);
  let health = null;
  let readiness = null;
  let accountCleanupGateOk = false;
  let lastError = "";

  do {
    try {
      const healthResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (!healthResponse.ok) throw new Error(`Liveness HTTP ${healthResponse.status}`);
      health = await healthResponse.json();
      const readinessResponse = await fetch(readinessUrl, { signal: AbortSignal.timeout(10_000) });
      readiness = await readinessResponse.json();
      if (!readinessResponse.ok || readiness?.ok !== true || readiness?.releaseReady !== true) {
        throw new Error(
          `Readiness HTTP ${readinessResponse.status}; releaseReady=${String(readiness?.releaseReady)}`,
        );
      }
      if (readServiceHealth("minio-transient-cleanup") !== "healthy") {
        throw new Error("Transient cleanup service is not healthy.");
      }
      if (readServiceHealth("secret-audit-rotator") !== "healthy") {
        throw new Error("Secret audit rotator is not healthy.");
      }
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!wait || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  } while (Date.now() < deadline);

  if (readiness?.ok === true && readiness?.releaseReady === true) {
    runCompose([
      "exec",
      "-T",
      "app",
      "node",
      "scripts/check-account-deletion-cleanup-gate.mjs",
      "--strict",
    ]);
    accountCleanupGateOk = true;
  }

  const runningServices = runCompose(["ps", "--status", "running", "--services"], { capture: true })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const requiredServices = [
    "app",
    "postgres",
    "minio",
    "minio-transient-cleanup",
    "secret-audit-rotator",
    "worker-1",
    "worker-2",
  ];
  const missingServices = requiredServices.filter((service) => !runningServices.includes(service));
  const runtimeConfig = runningServices.includes("app") ? readRuntimeConfiguration() : {};
  const imageSourceFingerprint = readImageSourceFingerprint();
  const cleanupHealth = readServiceHealth("minio-transient-cleanup");
  const auditRotatorHealth = readServiceHealth("secret-audit-rotator");
  const checks = {
    healthOk: health?.ok === true,
    readinessOk: readiness?.ok === true && readiness?.releaseReady === true,
    accountCleanupGateOk,
    authRepositoryPostgres: runtimeConfig.authRepositoryPostgres === true,
    finalizationQueueEnabled: runtimeConfig.finalizationQueueEnabled === true,
    meetingWriteLockDurable: runtimeConfig.meetingWriteLockDurable === true,
    remoteObjectStorage: runtimeConfig.remoteObjectStorage === true,
    managedSecretAudit: runtimeConfig.managedSecretAudit === true,
    cleanupHealthy: cleanupHealth === "healthy",
    auditRotatorHealthy: auditRotatorHealth === "healthy",
    imageMatchesCurrentSource: imageSourceFingerprint === currentSourceFingerprint,
    runtimeMatchesCurrentSource: runtimeConfig.sourceFingerprint === currentSourceFingerprint,
    twoWorkersRunning: runningServices.includes("worker-1") && runningServices.includes("worker-2"),
    missingServices,
  };
  const ok = Object.entries(checks).every(([name, value]) => name === "missingServices" ? Array.isArray(value) && value.length === 0 : value === true);
  const summary = {
    ok,
    healthUrl,
    readinessUrl,
    sourceFingerprint: currentSourceFingerprint,
    imageSourceFingerprint: imageSourceFingerprint || null,
    services: runningServices,
    checks,
    lastError: ok ? undefined : lastError,
    boundary: "Local production-like evidence only; this does not clear managed production or public HTTPS blockers.",
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!ok) {
    runCompose(["ps"]);
    runCompose(["logs", "--tail", "120", "app", "worker-1", "worker-2", "minio-transient-cleanup", "secret-audit-rotator", "migrate", "minio-init", "postgres-role-bootstrap", "postgres"]);
    process.exitCode = 1;
  }
}

function discoverStackPort() {
  const output = runCompose(["port", "app", "3000"], { capture: true })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)[0] || "";
  const match = output.match(/:(\d+)$/);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Unable to discover the production-like app port from Docker Compose.");
  }
  return port;
}

function readRuntimeConfiguration() {
  try {
    const output = runCompose(
      [
        "exec",
        "-T",
        "app",
        "node",
        "-e",
        [
          "const e=process.env;",
          "process.stdout.write(JSON.stringify({",
          "authRepositoryPostgres:e.OWNMINUTES_AUTH_REPOSITORY==='postgres',",
          "finalizationQueueEnabled:e.OWNMINUTES_FINALIZATION_MODE==='postgres-queue',",
          "meetingWriteLockDurable:e.OWNMINUTES_MEETING_WRITE_LOCK==='postgres-advisory',",
          "remoteObjectStorage:Boolean(e.S3_ENDPOINT&&e.S3_BUCKET&&e.S3_ACCESS_KEY_ID&&e.S3_SECRET_ACCESS_KEY),",
          "managedSecretAudit:Boolean(e.OWNMINUTES_SECRET_AUDIT_LOG?.startsWith('/')&&e.OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION==='1'),",
          "sourceFingerprint:e.OWNMINUTES_SOURCE_FINGERPRINT||''",
          "}));",
        ].join(""),
      ],
      { capture: true },
    );
    return JSON.parse(output);
  } catch {
    return {};
  }
}

function readServiceHealth(service) {
  try {
    const output = runCompose(["ps", "--format", "json", service], { capture: true }).trim();
    if (!output) return "";
    const parsed = output.startsWith("[")
      ? JSON.parse(output)
      : output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    return String(row?.Health || "").toLowerCase();
  } catch {
    return "";
  }
}

function readImageSourceFingerprint() {
  try {
    const imageId = runCompose(["images", "-q", "app"], { capture: true }).trim().split(/\r?\n/)[0];
    if (!imageId) return "";
    const result = spawnSync(
      "docker",
      ["image", "inspect", "--format", '{{ index .Config.Labels "app.ownminutes.source-fingerprint" }}', imageId],
      { encoding: "utf8" },
    );
    return result.status === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}

function fingerprintDirectory(directory) {
  const hash = crypto.createHash("sha256");
  visit(directory, "");
  return hash.digest("hex");

  function visit(absoluteDirectory, relativeDirectory) {
    const names = fs.readdirSync(absoluteDirectory).sort();
    for (const name of names) {
      const absolutePath = path.join(absoluteDirectory, name);
      const relativePath = path.posix.join(relativeDirectory, name);
      const stats = fs.lstatSync(absolutePath);
      const mode = (stats.mode & 0o777).toString(8);
      if (stats.isDirectory()) {
        hash.update(`directory\0${relativePath}\0${mode}\0`);
        visit(absolutePath, relativePath);
      } else if (stats.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${mode}\0${fs.readlinkSync(absolutePath)}\0`);
      } else if (stats.isFile()) {
        hash.update(`file\0${relativePath}\0${mode}\0${stats.size}\0`);
        hash.update(fs.readFileSync(absolutePath));
        hash.update("\0");
      }
    }
  }
}

function setEnvValue(filePath, name, value) {
  setEnvValues(filePath, { [name]: value });
}

function setEnvValues(filePath, values) {
  const names = new Set(Object.keys(values));
  const lines = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      if (!line) return false;
      const index = line.indexOf("=");
      return index < 0 || !names.has(line.slice(0, index));
    });
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Z0-9_]+$/.test(name) || String(value).includes("\n")) {
      throw new Error("Unsafe production-like environment update.");
    }
    lines.push(`${name}=${value}`);
  }
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporaryPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseEnvFile(filePath) {
  return Object.fromEntries(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}
