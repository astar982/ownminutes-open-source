#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync("Dockerfile", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");
const compose = readFileSync("deploy/compose.production-like.yml", "utf8");
const productionCompose = readFileSync("deploy/compose.production.yml", "utf8");
const minioAppPolicy = JSON.parse(readFileSync("deploy/minio-app-policy.json", "utf8"));
const minioCleanupPolicy = JSON.parse(readFileSync("deploy/minio-cleanup-policy.json", "utf8"));
const stackScript = readFileSync("scripts/production-like-stack.mjs", "utf8");
const stackBusinessSmoke = readFileSync("scripts/smoke-production-like-stack.mjs", "utf8");
const stackQueueSmoke = readFileSync("scripts/smoke-production-like-queue-recovery.mjs", "utf8");
const backupScript = readFileSync("scripts/production-backup.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const objectStoreSource = readFileSync("src/lib/server/meeting-object-store.ts", "utf8");
const remoteStoreSmoke = readFileSync("scripts/smoke-remote-object-store.mjs", "utf8");
const auditRotatorSource = readFileSync("scripts/rotate-secret-audit-log.mjs", "utf8");
const runtimeImageSmoke = readFileSync("scripts/smoke-container-runtime-image.mjs", "utf8");

const checks = {
  usesPinnedNodeRuntime:
    dockerfile.includes("FROM node:22.22.0-bookworm-slim@sha256:") &&
    dockerfile.includes("npm ci") &&
    dockerfile.includes("npm run build") &&
    dockerfile.includes("npm prune --omit=dev;") &&
    !dockerfile.includes("npm prune --omit=dev --omit=optional") &&
    dockerfile.includes("swc-linux-x64-gnu") &&
    dockerfile.includes("swc-linux-arm64-gnu") &&
    dockerfile.includes("sharp-linux-x64") &&
    dockerfile.includes("sharp-linux-arm64") &&
    dockerfile.includes("sharp-libvips-linux-x64") &&
    dockerfile.includes("sharp-libvips-linux-arm64") &&
    dockerfile.includes("COPY --from=production-dependencies /usr/local/lib/node_modules/npm") &&
    dockerfile.includes('test "$(npm --version)" = "$NPM_VERSION"') &&
    compose.includes("OWNMINUTES_INSTANCE_ID: ${OWNMINUTES_COMPOSE_PROJECT_NAME}-worker-1") &&
    compose.includes("OWNMINUTES_INSTANCE_ID: ${OWNMINUTES_COMPOSE_PROJECT_NAME}-worker-2") &&
    compose.includes("NPM_REGISTRY: ${OWNMINUTES_NPM_REGISTRY:-https://registry.npmmirror.com}") &&
    dockerfile.includes("ARG NPM_REGISTRY=https://registry.npmjs.org") &&
    productionCompose.includes("OWNMINUTES_INSTANCE_ID: ownminutes-production-worker-1") &&
    productionCompose.includes("OWNMINUTES_INSTANCE_ID: ownminutes-production-worker-2"),
  verifiesRuntimeImageSharp:
    runtimeImageSmoke.includes('npmVersion === "11.8.0"') &&
    runtimeImageSmoke.includes('require("sharp")') &&
    runtimeImageSmoke.includes('await import("sharp")') &&
    runtimeImageSmoke.includes('requiredSharp.versions.sharp === "0.35.3"') &&
    runtimeImageSmoke.includes("nextImageOptimizer.getSharp(null)") &&
    runtimeImageSmoke.includes("nextImageOptimizer.optimizeImage") &&
    runtimeImageSmoke.includes('"audit"') &&
    runtimeImageSmoke.includes('"--omit=dev"') &&
    runtimeImageSmoke.includes('"--registry=https://registry.npmjs.org"') &&
    runtimeImageSmoke.includes("installedSwcPackages") &&
    runtimeImageSmoke.includes("installedSharpPackages"),
  runsAsNonRoot: dockerfile.includes("USER node") && dockerfile.indexOf("USER node") < dockerfile.indexOf("CMD ["),
  hasContainerHealthcheck: dockerfile.includes("HEALTHCHECK") && dockerfile.includes("/api/health"),
  excludesSecretsAndLocalData:
    [
      ".data",
      "**/.env*",
      "stack.env",
      "**/stack.env",
      "**/*.pem",
      "**/*.p8",
      "**/*.key",
      "deploy/secrets",
      "deploy/private",
      "**/*PRIVATE-ENCRYPTED-SECRET*",
      "node_modules",
      ".git",
      "apps/mobile/node_modules",
    ].every((entry) => dockerignore.includes(entry)),
  hasDurableServices:
    ["postgres:", "minio:", "minio-transient-cleanup:", "secret-audit-rotator:", "postgres-role-bootstrap:", "migrate:", "legacy-cleanup-gate:", "app:", "worker-1:", "worker-2:"].every((entry) => compose.includes(entry)),
  blocksPromotionOnUnresolvedLegacyCleanup:
    [compose, productionCompose].every(
      (source) =>
        source.includes("legacy-cleanup-gate:") &&
        source.includes("scripts/check-legacy-meeting-deletion-gate.mjs") &&
        source.includes('"--strict"'),
    ),
  blocksPromotionOnUnresolvedAccountCleanup:
    stackScript.includes("scripts/check-account-deletion-cleanup-gate.mjs") &&
    packageJson.scripts?.["account-cleanup:gate"]?.includes("--strict") === true,
  workersRunDeletionCleanup:
    [compose, productionCompose].every(
      (source) => (source.match(/OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER: "1"/g) || []).length >= 2,
    ),
  hasSafeAdminBootstrap:
    productionCompose.includes("admin-bootstrap:") &&
    productionCompose.includes("scripts/bootstrap-admin.mjs") &&
    productionCompose.includes('OWNMINUTES_ALLOW_FIRST_USER_ADMIN: "0"') &&
    productionCompose.includes("admin_bootstrap_password"),
  configuresProductionLikeRuntime:
    compose.includes("OWNMINUTES_AUTH_REPOSITORY: postgres") &&
    compose.includes("OWNMINUTES_FINALIZATION_MODE: postgres-queue") &&
    compose.includes('OWNMINUTES_FINALIZATION_WORKER_INSTANCES: "2"') &&
    compose.includes("OWNMINUTES_MEETING_WRITE_LOCK: postgres-advisory") &&
    compose.includes("OWNMINUTES_SECRET_AUDIT_LOG: /app/.data/auth/secret-audit.jsonl") &&
    compose.includes("OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION: \"1\"") &&
    compose.includes("OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE: /app/.data/auth/.rotation-heartbeat.json") &&
    compose.includes("secret-audit-data:/app/.data/auth") &&
    compose.includes("S3_ENDPOINT: http://minio:9000") &&
    compose.includes("TRANSCRIPTION_PROVIDER: mock"),
  avoidsSharedNetworkMinioAliasCollision:
    productionCompose.includes("S3_ENDPOINT: http://ownminutes-minio:9000") &&
    productionCompose.includes("until mc alias set local http://ownminutes-minio:9000") &&
    productionCompose.includes("aliases:\n          - ownminutes-minio"),
  keepsInfrastructurePrivate:
    compose.includes("internal: true") &&
    compose.includes("egress:") &&
    compose.includes('published: "${OWNMINUTES_COMPOSE_PORT:-0}"') &&
    compose.includes("host_ip: 127.0.0.1") &&
    !compose.includes("9000:9000") &&
    !compose.includes("5432:5432"),
  initializesPrivateVersionedBucket:
    compose.includes("mc anonymous set none") &&
    compose.includes("mc version enable") &&
    [compose, productionCompose].every(
      (source) =>
        source.includes("The lifecycle configuration does not exist.") &&
        !source.includes("mc ilm rule remove --all --force local/ownminutes >/dev/null 2>&1 || true") &&
        !source.includes('mc ilm rule remove --all --force "local/$${OWNMINUTES_BUCKET}" >/dev/null 2>&1 || true'),
    ) &&
    compose.includes("--noncurrent-expire-days 7") &&
    compose.includes("--expire-delete-marker") &&
    compose.includes('command: ["node", "scripts/cleanup-transient-meeting-objects.mjs", "--loop"]') &&
    !compose.includes("mc ilm rule add --expire-days"),
  productionCleanupUsesLeastPrivilegeIdentity:
    productionCompose.includes("minio-cleanup-policy.json") &&
    productionCompose.includes("s3_cleanup_access_key_id") &&
    productionCompose.includes("s3_cleanup_secret_access_key") &&
    !productionCompose
      .slice(
        productionCompose.indexOf("  minio-transient-cleanup:"),
        productionCompose.indexOf("  postgres-role-bootstrap:"),
      )
      .includes("minio_root_") &&
    !productionCompose.includes("mc admin user add local \"$$APP_USER\" \"$$APP_PASSWORD\" >/dev/null 2>&1 || true") &&
    !productionCompose.includes("mc admin user add local \"$$CLEANUP_USER\" \"$$CLEANUP_PASSWORD\" >/dev/null 2>&1 || true") &&
    [minioAppPolicy, minioCleanupPolicy].every((policy) =>
      policy.Statement.flatMap((statement) => statement.Action).includes("s3:ListBucketVersions") &&
      policy.Statement.flatMap((statement) => statement.Action).includes("s3:DeleteObjectVersion")
    ) &&
    objectStoreSource.includes('versions: ""') &&
    objectStoreSource.includes("versionId: version.versionId") &&
    objectStoreSource.includes('config.provider !== "r2"') &&
    remoteStoreSmoke.includes("remainingMeetingVersionCount") &&
    remoteStoreSmoke.includes("sawVersionDelete"),
  productionProviderSecretsUseFilesOnly:
    [
      "VOLCANO_ASR_API_KEY_FILE: /run/secrets/volcano_asr_api_key",
      "VOLCANO_ASR_TOKEN_FILE: /run/secrets/volcano_asr_token",
      "ARK_API_KEY_FILE: /run/secrets/ark_api_key",
      "RESEND_API_KEY_FILE: /run/secrets/resend_api_key",
    ].every((entry) => productionCompose.includes(entry)) &&
    !/^\s+(?:VOLCANO_ASR_API_KEY|VOLCANO_ASR_TOKEN|ARK_API_KEY|RESEND_API_KEY):/m.test(productionCompose),
  rotatesSecretAuditWithHeartbeat:
    [compose, productionCompose].every(
      (source) =>
        source.includes("secret-audit-rotator:") &&
        source.includes("scripts/rotate-secret-audit-log.mjs") &&
        source.includes('test: ["CMD", "node", "scripts/rotate-secret-audit-log.mjs", "--healthcheck"]') &&
        source.includes("secret-audit-archive:/app/.data/audit-archive") &&
        source.includes("secret-audit-rotator:\n      condition: service_healthy"),
    ) &&
    auditRotatorSource.includes("writeHeartbeat") === false &&
    auditRotatorSource.includes("atomicWriteJson(input.heartbeatPath") &&
    auditRotatorSource.includes("audit_archive_checksum_mismatch") &&
    auditRotatorSource.includes("pruneArchives"),
  separatesDatabaseRoles:
    compose.includes("OWNMINUTES_DATABASE_OWNER_ROLE: ownminutes_owner") &&
    compose.includes("OWNMINUTES_DATABASE_MIGRATOR_ROLE: ownminutes_migrator") &&
    compose.includes("OWNMINUTES_DATABASE_APP_ROLE: ownminutes_runtime") &&
    compose.includes("OWNMINUTES_DATABASE_LEGACY_BOOTSTRAP_ROLE: ownminutes") &&
    compose.includes("scripts/bootstrap-postgres-roles.mjs") &&
    productionCompose.includes("OWNMINUTES_DATABASE_LEGACY_BOOTSTRAP_ROLE: ownminutes_app") &&
    productionCompose.includes("OWNMINUTES_DATABASE_USER: ownminutes_runtime"),
  pinsProductionLikeObjectStorage:
    compose.includes("quay.io/minio/minio:latest@sha256:") &&
    compose.includes("quay.io/minio/mc:latest@sha256:") &&
    !/^\s*image:\s+quay\.io\/minio\/(?:minio|mc):latest\s*$/m.test(compose),
  boundsMinioInitialization:
    [compose, productionCompose].every(
      (source) =>
        source.includes('if [ "$$attempt" -ge 60 ]') &&
        source.includes("MinIO initialization failed: service unavailable after 120 seconds."),
    ),
  generatesIgnoredLocalSecrets:
    stackScript.includes('path.join(root, ".data", "production-like")') &&
    stackScript.includes("crypto.randomBytes") &&
    stackScript.includes("mode: 0o600") &&
    stackScript.includes("OWNMINUTES_STACK_FORMAT") &&
    stackScript.includes("OWNMINUTES_COMPOSE_PROJECT_NAME") &&
    !compose.includes("ownminutes_local_secret"),
  isolatesProductionLikeResources:
    compose.includes("name: ${OWNMINUTES_COMPOSE_PROJECT_NAME:") &&
    compose.split("image: ${OWNMINUTES_COMPOSE_IMAGE:").length - 1 >= 6 &&
    stackScript.includes("claimLegacyStackOwner") &&
    stackScript.includes("inspectLegacyResources") &&
    stackScript.includes("worktreeStackIdentity") &&
    stackScript.includes("OWNMINUTES_STACK_OPERATION_LOCK_HELD") &&
    stackScript.includes("with-file-lock.pl") &&
    stackScript.includes('"--project-name"') &&
    stackScript.includes("discoverStackPort") &&
    stackScript.includes("runDeploymentLiveSmoke") &&
    stackQueueSmoke.includes("composeProjectName") &&
    stackQueueSmoke.includes('"--project-name"') &&
    backupScript.includes("composeProjectName") &&
    backupScript.includes('"--project-name"'),
  stagesUnicodeRepositorySafely:
    stackScript.includes("stageIdentity") &&
    stackScript.includes("ownminutes-production-like-stack-${stageIdentity}") &&
    stackScript.includes("fs.mkdtempSync") &&
    stackScript.includes('path.join(sessionRoot, "source")') &&
    stackScript.includes('path.join(sessionRoot, "stack.env")') &&
    stackScript.includes("fs.rmSync(sessionRoot, { force: true, recursive: true })") &&
    !stackScript.includes('path.join(stageRoot, "stack.env")') &&
    stackScript.includes("syncAsciiStage") &&
    stackScript.includes('"--exclude", ".data"') &&
    stackScript.includes('"--exclude", "deploy/secrets"') &&
    stackScript.includes('"--exclude", "**/*.p8"') &&
    stackScript.includes("fs.chmodSync(stagedEnvFile, 0o600)"),
  verifiesRuntimeTopology:
    stackScript.includes("/api/readyz") &&
    stackScript.includes("readRuntimeConfiguration") &&
    stackScript.includes("readServiceHealth") &&
    stackScript.includes("cleanupHealthy") &&
    stackScript.includes("readImageSourceFingerprint") &&
    stackScript.includes("fingerprintDirectory") &&
    dockerfile.includes("app.ownminutes.source-fingerprint") &&
    compose.includes("OWNMINUTES_SOURCE_FINGERPRINT") &&
    stackScript.includes("authRepositoryPostgres") &&
    stackScript.includes("twoWorkersRunning") &&
    stackScript.includes("remoteObjectStorage") &&
    stackScript.includes("meetingWriteLockDurable"),
  exposesStackCommands:
    ["stack:up", "stack:down", "stack:reset", "stack:status", "stack:verify", "stack:test", "smoke:container"].every(
      (name) => Boolean(packageJson.scripts?.[name]),
    ),
  verifiesQueuedBusinessFlow:
    stackScript.includes("runBusinessSmoke") &&
    stackBusinessSmoke.includes("waitForFinalization") &&
    stackBusinessSmoke.includes('status === "completed"') &&
    stackBusinessSmoke.includes("publicSharePublished") &&
    stackBusinessSmoke.includes("accountDeleted"),
  statesAcceptanceBoundary: stackScript.includes("does not clear managed production or public HTTPS blockers"),
  parsesOnlyS3CommonPrefixes:
    objectStoreSource.includes("extractCommonPrefixValues") &&
    objectStoreSource.includes('blockPattern = /<CommonPrefixes>') &&
    remoteStoreSmoke.includes('`<Prefix>${escapeXml(prefix)}</Prefix>`'),
};

console.log(JSON.stringify(checks, null, 2));
const staticChecksPassed = Object.values(checks).every((value) => value === true);
if (!staticChecksPassed) process.exitCode = 1;

const runtimeImage = process.env.OWNMINUTES_CONTAINER_RUNTIME_IMAGE?.trim();
if (staticChecksPassed && runtimeImage) {
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "node", runtimeImage, "scripts/smoke-container-runtime-image.mjs"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}
