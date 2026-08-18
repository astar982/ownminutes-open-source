#!/usr/bin/env node

import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const composeSource = readFileSync(join(root, "deploy", "compose.production.yml"), "utf8");
const productionEnvExampleSource = readFileSync(join(root, "deploy", "production.env.example"), "utf8");
const appPolicy = JSON.parse(readFileSync(join(root, "deploy", "minio-app-policy.json"), "utf8"));
const cleanupPolicy = JSON.parse(readFileSync(join(root, "deploy", "minio-cleanup-policy.json"), "utf8"));
const selfHostedRunbookSource = readFileSync(join(root, "docs", "self-hosted-production-runbook.md"), "utf8");
const containerRunbookSource = readFileSync(join(root, "docs", "container-deployment-runbook.md"), "utf8");
const secretRunnerSource = readFileSync(join(root, "scripts", "run-with-secrets.mjs"), "utf8");
const productionStackSource = readFileSync(join(root, "scripts", "production-stack.mjs"), "utf8");
const vaultComposeSource = readFileSync(join(root, "deploy", "compose.vault.yml"), "utf8");
const publicStagingComposeSource = readFileSync(join(root, "deploy", "compose.public-staging.yml"), "utf8");
const sharedProxyComposeSource = readFileSync(join(root, "deploy", "compose.shared-proxy.yml"), "utf8");
const productionCaddySource = readFileSync(join(root, "deploy", "Caddyfile"), "utf8");
const publicStagingCaddySource = readFileSync(join(root, "deploy", "Caddyfile.staging"), "utf8");
const sharedStagingCaddySource = readFileSync(join(root, "deploy", "Caddyfile.shared-staging"), "utf8");
const arkRelaySource = readFileSync(join(root, "deploy", "nginx.ark-relay-location.conf"), "utf8");
const scratch = join(root, ".data", "smoke-production-deployment");
const envFile = join(scratch, ".env.production");
const secretsDir = join(scratch, "secrets");
rmSync(scratch, { force: true, recursive: true });

if (
  !composeSource.includes("legacy-cleanup-gate:") ||
  !composeSource.includes("scripts/check-legacy-meeting-deletion-gate.mjs") ||
  !composeSource.includes('"--strict"') ||
  !composeSource.includes("legacy-cleanup-gate:\n        condition: service_completed_successfully") ||
  !productionStackSource.includes('"run", "--rm", "--no-deps", "legacy-cleanup-gate"') ||
  !productionStackSource.includes('"exec",') ||
  !productionStackSource.includes("scripts/check-account-deletion-cleanup-gate.mjs")
) {
  throw new Error("Production promotion must stop when legacy or account deletion cleanup remains unresolved.");
}

if ((composeSource.match(/@sha256:/g) || []).length < 4 || /image:\s+[^\n]+:latest\s*$/m.test(composeSource)) {
  throw new Error("Production third-party images must be pinned by digest.");
}
if ((composeSource.match(/^\s+build:/gm) || []).length !== 1 || !composeSource.includes("pull_policy: never")) {
  throw new Error("Production App image must be built once and reused by migrations and Workers.");
}
if (
  !composeSource.includes('mc ilm rule remove --all --force local/ownminutes') ||
  !composeSource.includes('--noncurrent-expire-days "${OWNMINUTES_NONCURRENT_RETENTION_DAYS:-7}"') ||
  !composeSource.includes("--expire-delete-marker") ||
  composeSource.includes("mc ilm rule add --expire-days")
) {
  throw new Error("Production object lifecycle must be deterministic and clean up noncurrent versions and delete markers.");
}
const appActions = appPolicy.Statement.flatMap((statement) => statement.Action);
const cleanupActions = cleanupPolicy.Statement.flatMap((statement) => statement.Action);
const cleanupResources = cleanupPolicy.Statement.flatMap((statement) => statement.Resource);
const cleanupListPrefixes = cleanupPolicy.Statement
  .flatMap((statement) => statement.Condition?.StringLike?.["s3:prefix"] || []);
if (
  !["s3:ListBucket", "s3:ListBucketVersions", "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"]
    .every((action) => appActions.includes(action)) ||
  cleanupActions.some((action) => !["s3:ListBucket", "s3:ListBucketVersions", "s3:DeleteObject", "s3:DeleteObjectVersion"].includes(action)) ||
  !["s3:ListBucketVersions", "s3:DeleteObjectVersion"].every((action) => cleanupActions.includes(action)) ||
  cleanupResources.some((resource) => resource.includes("*") && !resource.includes("/transient") && !resource.includes("/uploads")) ||
  !cleanupListPrefixes.includes("ownminutes/meetings") ||
  !cleanupListPrefixes.includes("ownminutes/meetings/*") ||
  !composeSource.includes("minio-cleanup-policy.json") ||
  !productionEnvExampleSource.includes("OWNMINUTES_S3_CLEANUP_ACCESS_KEY_ID_FILE") ||
  !productionEnvExampleSource.includes("OWNMINUTES_S3_CLEANUP_SECRET_ACCESS_KEY_FILE")
) {
  throw new Error("The long-running object cleanup identity must be limited to listing/deleting transient and upload objects.");
}
if (
  !selfHostedRunbookSource.includes("Canonical current meeting objects do not expire automatically") ||
  !selfHostedRunbookSource.includes("transient ASR copies after 7 days") ||
  !selfHostedRunbookSource.includes("incomplete resumable uploads after 2 days") ||
  !containerRunbookSource.includes("Canonical current meeting objects do not expire automatically") ||
  selfHostedRunbookSource.includes("default current-object retention is 90 days") ||
  containerRunbookSource.includes("30-day local lifecycle")
) {
  throw new Error("Current retention runbooks must match the canonical/noncurrent/transient/upload lifecycle contract.");
}
if ((composeSource.match(/OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER: "1"/g) || []).length < 2) {
  throw new Error("Both production Workers must run durable meeting/account deletion cleanup.");
}
if (
  !composeSource.includes('if [ "$$attempt" -ge 60 ]') ||
  !composeSource.includes("MinIO initialization failed: service unavailable after 120 seconds.")
) {
  throw new Error("Production object storage initialization must fail clearly instead of waiting forever.");
}
if (
  !composeSource.includes("admin-bootstrap:") ||
  !composeSource.includes("scripts/bootstrap-admin.mjs") ||
  !composeSource.includes("OWNMINUTES_ALLOW_FIRST_USER_ADMIN: \"0\"") ||
  !composeSource.includes("OWNMINUTES_TRUST_PROXY_HEADERS: \"1\"") ||
  !composeSource.includes("OWNMINUTES_REQUIRE_EMAIL_VERIFICATION: \"1\"") ||
  !composeSource.includes("OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE: \"0\"") ||
  !composeSource.includes("condition: service_completed_successfully")
) {
  throw new Error("Production deployment must bootstrap an administrator and require email verification before exposing public registration.");
}
if (
  !composeSource.includes("OWNMINUTES_ASR_FILE_STRATEGY: ${OWNMINUTES_ASR_FILE_STRATEGY:-single}") ||
  !composeSource.includes("VOLCANO_ASR_MODE: ${VOLCANO_ASR_MODE:-flash}") ||
  !composeSource.includes("VOLCANO_ASR_RECOGNIZE_URL: ${VOLCANO_ASR_RECOGNIZE_URL:-https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash}") ||
  !composeSource.includes("VOLCANO_ASR_RESOURCE_ID: ${VOLCANO_ASR_RESOURCE_ID:-volc.bigasr.auc_turbo}") ||
  !composeSource.includes("OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: ${OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED:-1}") ||
  !composeSource.includes("OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: ${OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES:-30}") ||
  !composeSource.includes("VOLCANO_ASR_TURBO_RECOGNIZE_URL: ${VOLCANO_ASR_TURBO_RECOGNIZE_URL:-https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash}") ||
  !composeSource.includes("VOLCANO_ASR_TURBO_RESOURCE_ID: ${VOLCANO_ASR_TURBO_RESOURCE_ID:-volc.bigasr.auc_turbo}")
) {
  throw new Error("Production file ASR defaults must remain on the currently authorized single/flash route with a bounded future fallback contract.");
}
for (const costAwareAsrSetting of [
  "OWNMINUTES_ASR_FILE_STRATEGY=single",
  "VOLCANO_ASR_MODE=flash",
  "VOLCANO_ASR_RESOURCE_ID=volc.bigasr.auc_turbo",
  "OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1",
  "OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES=30",
  "VOLCANO_ASR_TURBO_RECOGNIZE_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  "VOLCANO_ASR_TURBO_RESOURCE_ID=volc.bigasr.auc_turbo",
]) {
  if (!productionEnvExampleSource.includes(costAwareAsrSetting)) {
    throw new Error(`Production environment example is missing ${costAwareAsrSetting}.`);
  }
}
for (const runtimePolicy of [
  "OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE",
  "OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY",
  "OWNMINUTES_ASR_FALLBACK_POLICY",
  "OWNMINUTES_ASR_PRIVACY_POLICY",
  "OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY",
  "OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY",
  "OWNMINUTES_REALTIME_ASR_WEAK_NETWORK_EVIDENCE",
  "OWNMINUTES_REALTIME_ASR_FAILURE_ISOLATION_EVIDENCE",
  "OWNMINUTES_REALTIME_ASR_REAL_MEETING_EVIDENCE",
  "OWNMINUTES_SUMMARY_JSON_ONLY",
  "OWNMINUTES_SUMMARY_HALLUCINATION_POLICY",
  "OWNMINUTES_SUMMARY_RETRY_POLICY",
  "OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY",
]) {
  if (!composeSource.includes(`${runtimePolicy}:`)) {
    throw new Error(`Production runtime does not receive ${runtimePolicy}.`);
  }
}
if (
  !composeSource.includes('user: "0:0"') ||
  !composeSource.includes('OWNMINUTES_RUNTIME_UID: "1000"') ||
  !composeSource.includes('OWNMINUTES_RUNTIME_GID: "1000"') ||
  !secretRunnerSource.includes("process.setgroups([runtimeGid])") ||
  !secretRunnerSource.includes("process.setgid(runtimeGid)") ||
  !secretRunnerSource.includes("process.setuid(runtimeUid)")
) {
  throw new Error("Production secret bootstrap must read protected files before dropping to the node runtime uid/gid.");
}
for (const appleRuntimeSetting of [
  "APPLE_ISSUER_ID:",
  "APPLE_KEY_ID:",
  "APPLE_PRIVATE_KEY_FILE: /run/secrets/apple_iap_private_key",
  "APPLE_BUNDLE_ID:",
  "APPLE_APP_APPLE_ID:",
  "APPLE_IAP_ENVIRONMENT: ${APPLE_IAP_ENVIRONMENT:-production}",
  "OWNMINUTES_APP_SECRET_VERSION:",
  "APPLE_IAP_PRODUCT_IDS:",
  "APPLE_IAP_ENABLE_ONLINE_CHECKS:",
  "APPLE_IAP_FETCH_TIMEOUT_MS:",
  "APPLE_ROOT_CERTIFICATE_PATHS: /run/secrets/apple_root_ca_g2,/run/secrets/apple_root_ca_g3",
  "OWNMINUTES_IAP_RECEIPT_VERIFICATION:",
  "OWNMINUTES_IAP_ENTITLEMENT_MAPPING:",
  "OWNMINUTES_IAP_REFUND_HANDLING:",
  "OWNMINUTES_ORDER_IDEMPOTENCY:",
  "OWNMINUTES_IAP_NOTIFICATION_URL: https://${OWNMINUTES_DOMAIN}/api/payments/apple/notifications",
  "OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF:",
  "OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF:",
  "OWNMINUTES_IAP_SANDBOX_REFUND_PROOF:",
  "OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF:",
  "OWNMINUTES_IAP_DB_LEDGER_PROOF:",
  'OWNMINUTES_ENABLE_IAP_MOCK: "0"',
]) {
  if (!composeSource.includes(appleRuntimeSetting)) {
    throw new Error(`Production App runtime does not receive ${appleRuntimeSetting}.`);
  }
}
for (const appleSecret of [
  "apple_iap_private_key:",
  "file: ${OWNMINUTES_APPLE_PRIVATE_KEY_FILE}",
  "apple_root_ca_g2:",
  "file: ${OWNMINUTES_APPLE_ROOT_CA_G2_FILE}",
  "apple_root_ca_g3:",
  "file: ${OWNMINUTES_APPLE_ROOT_CA_G3_FILE}",
]) {
  if (!composeSource.includes(appleSecret)) {
    throw new Error(`Production Compose is missing Apple file secret ${appleSecret}.`);
  }
}
for (const appleTemplateSetting of [
  "OWNMINUTES_APPLE_PRIVATE_KEY_FILE=/srv/ownminutes/deploy/secrets/apple-iap-private-key.p8",
  "OWNMINUTES_APPLE_ROOT_CA_G2_FILE=/srv/ownminutes/deploy/secrets/AppleRootCA-G2.cer",
  "OWNMINUTES_APPLE_ROOT_CA_G3_FILE=/srv/ownminutes/deploy/secrets/AppleRootCA-G3.cer",
  "APPLE_BUNDLE_ID=app.ownminutes.mobile",
  "APPLE_APP_APPLE_ID=6790795844",
  "APPLE_IAP_ENVIRONMENT=production",
  "OWNMINUTES_APP_SECRET_VERSION=v1",
  "APPLE_IAP_PRODUCT_IDS=ownminutes.plus.monthly,ownminutes.pro.monthly",
]) {
  if (!productionEnvExampleSource.includes(appleTemplateSetting)) {
    throw new Error(`Production environment template is missing ${appleTemplateSetting}.`);
  }
}
if (
  !secretRunnerSource.includes('{ allowNewlines: true, fileVariable: "APPLE_PRIVATE_KEY_FILE" }') ||
  !secretRunnerSource.includes("APPLE_ROOT_CERTIFICATE_PATHS") ||
  !secretRunnerSource.includes("APPLE_ROOT_CERTIFICATES = JSON.stringify(certificates)")
) {
  throw new Error("Production secret runner must preload Apple private key and root certificate files before dropping privileges.");
}
if (
  !vaultComposeSource.includes("OWNMINUTES_SECRET_STORE: vault-transit") ||
  !vaultComposeSource.includes("OWNMINUTES_VAULT_TOKEN_FILE: /run/secrets/vault_token") ||
  (vaultComposeSource.match(/^\s{2}(app|worker-1|worker-2):$/gm) || []).length !== 3
) {
  throw new Error("Vault production override must mount the token only into App and both Workers.");
}
for (const [name, source] of [
  ["production", productionCaddySource],
  ["public staging", publicStagingCaddySource],
  ["shared staging", sharedStagingCaddySource],
]) {
  if (
    !source.includes('header_up X-OwnMinutes-Proxy-Source "caddy-primary"') ||
    !source.includes("max_size 32KB") ||
    !source.includes("max_size 1MB") ||
    !source.includes("max_size 5MB") ||
    !source.includes("max_size 270MB") ||
    !source.includes("health_uri /api/readyz") ||
    !source.includes("Content-Security-Policy") ||
    !source.includes("frame-ancestors 'none'") ||
    !source.includes("Permissions-Policy")
  ) {
    throw new Error(`${name} Caddy policy is missing trusted proxy identity, route body limits, or browser security headers.`);
  }
}
if (
  !publicStagingComposeSource.includes("./Caddyfile.staging:/etc/caddy/Caddyfile:ro") ||
  !publicStagingComposeSource.includes("OWNMINUTES_REQUIRE_EMAIL_VERIFICATION: ${OWNMINUTES_REQUIRE_EMAIL_VERIFICATION:-1}") ||
  !publicStagingCaddySource.includes('X-Robots-Tag "noindex, nofollow, noarchive"') ||
  publicStagingCaddySource.includes("/api/auth/register") ||
  publicStagingCaddySource.includes("/api/auth/email-verification/*") ||
  publicStagingCaddySource.includes("/api/auth/password-reset/*") ||
  !publicStagingCaddySource.includes("respond @disabledPublicAuth 404")
) {
  throw new Error("Public staging must keep web registration closed while allowing rate-limited App verification and recovery flows.");
}
if (
  !sharedProxyComposeSource.includes("dedicated-ownminutes-gateway") ||
  !sharedProxyComposeSource.includes("OWNMINUTES_SHARED_PROXY_NETWORK:-ownminutes_proxy") ||
  !sharedProxyComposeSource.includes("another container") ||
  !sharedProxyComposeSource.includes("- ownminutes")
) {
  throw new Error("Shared staging must disable the dedicated gateway and expose only the App on its narrow external proxy network.");
}
if (
  !sharedStagingCaddySource.includes("staging.example.com") ||
  !sharedStagingCaddySource.includes('X-Robots-Tag "noindex, nofollow, noarchive"') ||
  sharedStagingCaddySource.includes("/api/auth/register") ||
  !sharedStagingCaddySource.includes("respond @disabledPublicAuth 404") ||
  !sharedStagingCaddySource.includes("dynamic a ownminutes 3000") ||
  !sharedStagingCaddySource.includes("resolvers 127.0.0.11") ||
  !sharedStagingCaddySource.includes("refresh 1s") ||
  (sharedStagingCaddySource.match(/dial_timeout 500ms/g) || []).length !== 2 ||
  !sharedStagingCaddySource.includes("fail_duration 30s") ||
  !sharedStagingCaddySource.includes("max_fails 1") ||
  !sharedStagingCaddySource.includes("lb_try_duration 10s") ||
  !sharedStagingCaddySource.includes("lb_try_interval 100ms") ||
  sharedStagingCaddySource.includes("reverse_proxy ownminutes:3000") ||
  sharedStagingCaddySource.includes("lb_retry_match") ||
  sharedStagingCaddySource.includes("unhealthy_status") ||
  sharedStagingCaddySource.includes("handle_response")
) {
  throw new Error("Shared Caddy snippet must retain staging privacy while dynamically resolving blue/green App containers.");
}
if (
  !arkRelaySource.includes("location = /ownminutes-ark/api/v3/chat/completions") ||
  !arkRelaySource.includes("allow 192.0.2.10;") ||
  !arkRelaySource.includes("deny all;") ||
  !arkRelaySource.includes("limit_except POST") ||
  !arkRelaySource.includes("access_log off;") ||
  !arkRelaySource.includes("proxy_ssl_verify on;") ||
  !arkRelaySource.includes("proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;") ||
  !arkRelaySource.includes("proxy_pass https://ark.cn-beijing.volces.com/api/v3/chat/completions;") ||
  /proxy_set_header\s+authorization|bearer\s+[a-z0-9]/i.test(arkRelaySource)
) {
  throw new Error("Ark relay must stay source-restricted, POST-only, certificate-verified, credential-free, and endpoint-specific.");
}

const baseEnv = {
  ...process.env,
  OWNMINUTES_PRODUCTION_ENV_FILE: envFile,
  OWNMINUTES_PRODUCTION_SECRETS_DIR: secretsDir,
  OWNMINUTES_PRODUCTION_ALLOW_DIRTY_SMOKE: "1",
};

run(
  "node",
  [
    "scripts/production-stack.mjs",
    "init",
    "--domain",
    "staging.ownminutes.test",
    "--email",
    "ops@ownminutes.test",
    "--admin-email",
    "owner@ownminutes.test",
    "--admin-name",
    "Owner",
    "--legal-operator-name",
    "OwnMinutes Test Operator",
    "--legal-operator-address",
    "100 Test Street, Test City",
    "--legal-operator-jurisdiction",
    "Test Jurisdiction",
  ],
  baseEnv,
);

const initialized = readFileSync(envFile, "utf8");
const commit = gitCommit();
const applePrivateKeyFile = join(secretsDir, "apple-iap-private-key.p8");
const appleRootCaG2File = join(secretsDir, "AppleRootCA-G2.cer");
const appleRootCaG3File = join(secretsDir, "AppleRootCA-G3.cer");
const volcanoApiKeyFile = join(secretsDir, "volcano-asr-api-key");
const volcanoTokenFile = join(secretsDir, "volcano-asr-token");
const arkApiKeyFile = join(secretsDir, "ark-api-key");
const resendApiKeyFile = join(secretsDir, "resend-api-key");
writeFileSync(applePrivateKeyFile, "production-smoke-private-key-fixture\n", { mode: 0o600 });
writeFileSync(appleRootCaG2File, "production-smoke-root-ca-g2-fixture\n", { mode: 0o600 });
writeFileSync(appleRootCaG3File, "production-smoke-root-ca-g3-fixture\n", { mode: 0o600 });
writeFileSync(volcanoApiKeyFile, "volcano-production-smoke-key\n", { mode: 0o600 });
writeFileSync(volcanoTokenFile, "volcano-production-smoke-token\n", { mode: 0o600 });
writeFileSync(arkApiKeyFile, "ark-production-smoke-key\n", { mode: 0o600 });
writeFileSync(resendApiKeyFile, "resend-production-smoke-key\n", { mode: 0o600 });
for (const filePath of [
  applePrivateKeyFile,
  appleRootCaG2File,
  appleRootCaG3File,
  volcanoApiKeyFile,
  volcanoTokenFile,
  arkApiKeyFile,
  resendApiKeyFile,
]) chmodSync(filePath, 0o600);
const corrected = initialized
  .replace(/^OWNMINUTES_DOMAIN=.*$/m, "OWNMINUTES_DOMAIN=staging.ownminutes.app")
  .replace(/^OWNMINUTES_TLS_EMAIL=.*$/m, "OWNMINUTES_TLS_EMAIL=ops@ownminutes.app")
  .replace(/^OWNMINUTES_VOLCANO_ASR_API_KEY_FILE=.*$/m, `OWNMINUTES_VOLCANO_ASR_API_KEY_FILE=${volcanoApiKeyFile}`)
  .replace(/^OWNMINUTES_VOLCANO_ASR_TOKEN_FILE=.*$/m, `OWNMINUTES_VOLCANO_ASR_TOKEN_FILE=${volcanoTokenFile}`)
  .replace(/^OWNMINUTES_ARK_API_KEY_FILE=.*$/m, `OWNMINUTES_ARK_API_KEY_FILE=${arkApiKeyFile}`)
  .replace(/^OWNMINUTES_RESEND_API_KEY_FILE=.*$/m, `OWNMINUTES_RESEND_API_KEY_FILE=${resendApiKeyFile}`)
  .replace(/^OWNMINUTES_EMAIL_FROM=.*$/m, 'OWNMINUTES_EMAIL_FROM="OwnMinutes <no-reply@ownminutes.app>"')
  .replace(/^OWNMINUTES_SUPPORT_EMAIL=.*$/m, "OWNMINUTES_SUPPORT_EMAIL=support@ownminutes.app")
  .replace(/^OWNMINUTES_EMAIL_DOMAIN_VERIFIED=.*$/m, "OWNMINUTES_EMAIL_DOMAIN_VERIFIED=1")
  .replace(/^OWNMINUTES_EMAIL_BOUNCE_POLICY=.*$/m, "OWNMINUTES_EMAIL_BOUNCE_POLICY=suppress bounced recipients")
  .replace(/^OWNMINUTES_EMAIL_COMPLAINT_POLICY=.*$/m, "OWNMINUTES_EMAIL_COMPLAINT_POLICY=suppress complained recipients")
  .replace(/^OWNMINUTES_APPLE_PRIVATE_KEY_FILE=.*$/m, `OWNMINUTES_APPLE_PRIVATE_KEY_FILE=${applePrivateKeyFile}`)
  .replace(/^OWNMINUTES_APPLE_ROOT_CA_G2_FILE=.*$/m, `OWNMINUTES_APPLE_ROOT_CA_G2_FILE=${appleRootCaG2File}`)
  .replace(/^OWNMINUTES_APPLE_ROOT_CA_G3_FILE=.*$/m, `OWNMINUTES_APPLE_ROOT_CA_G3_FILE=${appleRootCaG3File}`)
  .replace(/^APPLE_ISSUER_ID=.*$/m, "APPLE_ISSUER_ID=issuer-id-redacted")
  .replace(/^APPLE_KEY_ID=.*$/m, "APPLE_KEY_ID=key-id-redacted");
writeFileSync(envFile, corrected, { mode: 0o600 });
chmodSync(envFile, 0o600);

const rejectedLocalSecret = spawnSync(
  "node",
  ["scripts/production-stack.mjs", "preflight"],
  { cwd: root, env: baseEnv, encoding: "utf8" },
);
if (
  rejectedLocalSecret.status === 0 ||
  !rejectedLocalSecret.stdout.includes('"secret:vault-transit-not-selected"')
) {
  throw new Error("Production preflight must reject the local app-secret provider.");
}

const vaultTokenFile = join(secretsDir, "vault-token");
writeFileSync(vaultTokenFile, "vault-production-smoke-token\n", { mode: 0o600 });
chmodSync(vaultTokenFile, 0o600);
const vaultReady = corrected
  .replace(/^OWNMINUTES_SECRET_STORE=.*$/m, "OWNMINUTES_SECRET_STORE=vault-transit")
  .replace(/^OWNMINUTES_VAULT_ADDR=.*$/m, "OWNMINUTES_VAULT_ADDR=https://vault.ownminutes.app")
  .replace(/^OWNMINUTES_VAULT_TOKEN_FILE=.*$/m, `OWNMINUTES_VAULT_TOKEN_FILE=${vaultTokenFile}`)
  .replace(/^OWNMINUTES_SECRET_ROTATION_POLICY=.*$/m, "OWNMINUTES_SECRET_ROTATION_POLICY=90-day rotation with dual-read rollback")
  .replace(/^OWNMINUTES_TENANT_SCOPED_KEYS=.*$/m, "OWNMINUTES_TENANT_SCOPED_KEYS=user provider and secret-name context")
  .replace(/^OWNMINUTES_SECRET_DELETION_PROOF=.*$/m, "OWNMINUTES_SECRET_DELETION_PROOF=provider rows removed on account deletion")
  .replace(/^OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY=.*$/m, "OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY=admin plaintext access denied")
  .replace(/^OWNMINUTES_SECRET_LOCAL_SECRET_DECISION=.*$/m, "OWNMINUTES_SECRET_LOCAL_SECRET_DECISION=legacy local secret isolated for migration only")
  .replace(/^OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT=.*$/m, "OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT=decrypt failures alert security operations")
  .replace(/^OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY=.*$/m, "OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY=Vault storage recovery drill every quarter");
writeFileSync(envFile, vaultReady, { mode: 0o600 });
chmodSync(envFile, 0o600);

const preflight = run("node", ["scripts/production-stack.mjs", "preflight"], baseEnv, true);
const parsed = JSON.parse(preflight.trim());
if (
  !parsed.ok ||
  parsed.failureIds.length !== 0 ||
  parsed.leaksSecrets ||
  parsed.configured.releaseId !== commit.slice(0, 12) ||
  parsed.secretManagement?.productionCandidate !== true
) {
  throw new Error(`Production preflight did not pass: ${preflight}`);
}

run("node", ["scripts/production-stack.mjs", "config"], baseEnv);
const renderedProductionCompose = JSON.parse(
  run(
    "docker",
    ["compose", "--env-file", envFile, "-f", join(root, "deploy", "compose.production.yml"), "config", "--format", "json"],
    {
      ...baseEnv,
      VOLCANO_ASR_API_KEY: "plaintext-canary-volcano",
      VOLCANO_ASR_TOKEN: "plaintext-canary-token",
      ARK_API_KEY: "plaintext-canary-ark",
      RESEND_API_KEY: "plaintext-canary-resend",
    },
    true,
  ),
);
const productionApp = renderedProductionCompose.services?.app;
if (
  productionApp?.environment?.APPLE_IAP_ENVIRONMENT !== "production" ||
  productionApp?.environment?.APPLE_PRIVATE_KEY_FILE !== "/run/secrets/apple_iap_private_key" ||
  productionApp?.environment?.APPLE_ROOT_CERTIFICATE_PATHS !== "/run/secrets/apple_root_ca_g2,/run/secrets/apple_root_ca_g3" ||
  productionApp?.environment?.APPLE_BUNDLE_ID !== "app.ownminutes.mobile" ||
  productionApp?.environment?.APPLE_APP_APPLE_ID !== "6790795844" ||
  productionApp?.environment?.APPLE_IAP_PRODUCT_IDS !== "ownminutes.plus.monthly,ownminutes.pro.monthly" ||
  productionApp?.environment?.OWNMINUTES_IAP_NOTIFICATION_URL !==
    "https://staging.ownminutes.app/api/payments/apple/notifications" ||
  productionApp?.environment?.OWNMINUTES_ENABLE_IAP_MOCK !== "0"
) {
  throw new Error("Rendered production App does not contain the safe Apple IAP runtime contract.");
}
const providerSecrets = ["volcano_asr_api_key", "volcano_asr_token", "ark_api_key", "resend_api_key"];
for (const serviceName of ["app", "worker-1", "worker-2"]) {
  const service = renderedProductionCompose.services?.[serviceName];
  for (const secretName of providerSecrets) {
    if (!hasSecret(service, secretName)) {
      throw new Error(`Rendered production ${serviceName} is missing provider secret ${secretName}.`);
    }
  }
  for (const rawName of ["VOLCANO_ASR_API_KEY", "VOLCANO_ASR_TOKEN", "ARK_API_KEY", "RESEND_API_KEY"]) {
    if (Object.hasOwn(service?.environment || {}, rawName)) {
      throw new Error(`Rendered production ${serviceName} exposes plaintext provider environment ${rawName}.`);
    }
  }
  for (const fileName of ["VOLCANO_ASR_API_KEY_FILE", "VOLCANO_ASR_TOKEN_FILE", "ARK_API_KEY_FILE", "RESEND_API_KEY_FILE"]) {
    if (!String(service?.environment?.[fileName] || "").startsWith("/run/secrets/")) {
      throw new Error(`Rendered production ${serviceName} is missing provider file boundary ${fileName}.`);
    }
  }
  if (
    service?.environment?.OWNMINUTES_TRUSTED_PROXY_SOURCES !== "caddy-primary" ||
    service?.environment?.OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION !== "1"
  ) {
    throw new Error(`Rendered production ${serviceName} is missing trusted proxy or audit rotation policy.`);
  }
}
for (const serviceName of ["minio", "minio-init", "minio-transient-cleanup", "secret-audit-rotator", "postgres", "postgres-role-bootstrap", "migrate"]) {
  for (const secretName of providerSecrets) {
    if (hasSecret(renderedProductionCompose.services?.[serviceName], secretName)) {
      throw new Error(`${secretName} must not be mounted into ${serviceName}.`);
    }
  }
}
const cleanupService = renderedProductionCompose.services?.["minio-transient-cleanup"];
for (const secretName of ["minio_root_user", "minio_root_password", "s3_access_key_id", "s3_secret_access_key"]) {
  if (hasSecret(cleanupService, secretName)) {
    throw new Error(`Long-running object cleanup must not receive broad credential ${secretName}.`);
  }
}
for (const secretName of ["s3_cleanup_access_key_id", "s3_cleanup_secret_access_key"]) {
  if (!hasSecret(cleanupService, secretName) || !hasSecret(renderedProductionCompose.services?.["minio-init"], secretName)) {
    throw new Error(`Cleanup credential ${secretName} must reach only the initializer and cleanup service.`);
  }
}
const auditRotator = renderedProductionCompose.services?.["secret-audit-rotator"];
if (
  auditRotator?.network_mode !== "none" ||
  !String(auditRotator?.command || "").includes("rotate-secret-audit-log.mjs") ||
  !String(auditRotator?.healthcheck?.test || "").includes("--healthcheck") ||
  !hasVolumeTarget(auditRotator, "/app/.data/auth") ||
  !hasVolumeTarget(auditRotator, "/app/.data/audit-archive") ||
  renderedProductionCompose.services?.app?.depends_on?.["secret-audit-rotator"]?.condition !== "service_healthy"
) {
  throw new Error("Production secret audit rotation must use an isolated, healthy sidecar and separate archive volume.");
}
for (const secretName of ["apple_iap_private_key", "apple_root_ca_g2", "apple_root_ca_g3"]) {
  if (!hasSecret(productionApp, secretName)) {
    throw new Error(`Rendered production App is missing ${secretName}.`);
  }
  for (const workerName of ["worker-1", "worker-2"]) {
    if (hasSecret(renderedProductionCompose.services?.[workerName], secretName)) {
      throw new Error(`${secretName} must not be mounted into ${workerName}.`);
    }
  }
}
for (const workerName of ["worker-1", "worker-2"]) {
  const workerEnvironment = renderedProductionCompose.services?.[workerName]?.environment || {};
  if (workerEnvironment.APPLE_PRIVATE_KEY_FILE || workerEnvironment.APPLE_ROOT_CERTIFICATE_PATHS) {
    throw new Error(`Apple IAP file paths must not be injected into ${workerName}.`);
  }
}
const renderedPublicStagingCompose = JSON.parse(
  run(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      join(root, "deploy", "compose.production.yml"),
      "-f",
      join(root, "deploy", "compose.public-staging.yml"),
      "config",
      "--format",
      "json",
    ],
    baseEnv,
    true,
  ),
);
const stagingCaddyConfig = renderedPublicStagingCompose.services?.caddy?.volumes?.find(
  (volume) => volume.target === "/etc/caddy/Caddyfile",
);
if (!stagingCaddyConfig?.source?.endsWith("/deploy/Caddyfile.staging") || stagingCaddyConfig.read_only !== true) {
  throw new Error("Public staging compose did not replace the Caddy config with the read-only staging policy.");
}
if (renderedPublicStagingCompose.services?.app?.environment?.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION !== "1") {
  throw new Error("Public staging App must honor the server-private email verification setting when delivery is configured.");
}
const renderedSharedProxyCompose = JSON.parse(
  run(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      join(root, "deploy", "compose.production.yml"),
      "-f",
      join(root, "deploy", "compose.public-staging.yml"),
      "-f",
      join(root, "deploy", "compose.shared-proxy.yml"),
      "config",
      "--format",
      "json",
    ],
    baseEnv,
    true,
  ),
);
if (
  renderedSharedProxyCompose.services?.caddy !== undefined ||
  renderedSharedProxyCompose.services?.app?.environment?.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION !== "1" ||
  !renderedSharedProxyCompose.services?.app?.networks?.["shared-proxy"]?.aliases?.includes("ownminutes") ||
  renderedSharedProxyCompose.networks?.["shared-proxy"]?.name !== "ownminutes_proxy" ||
  renderedSharedProxyCompose.networks?.["shared-proxy"]?.external !== true
) {
  throw new Error("Shared proxy compose did not isolate the dedicated gateway and attach the App with a stable alias.");
}

writeFileSync(envFile, vaultReady, { mode: 0o600 });
const vaultPreflightText = run("node", ["scripts/production-stack.mjs", "preflight"], baseEnv, true);
const vaultPreflight = JSON.parse(vaultPreflightText.trim());
if (vaultPreflight.secretManagement?.productionCandidate !== true || vaultPreflight.secretManagement?.runtimeAdapter !== "vault-transit") {
  throw new Error(`Production preflight did not select the Vault runtime: ${vaultPreflightText}`);
}
const renderedVaultCompose = JSON.parse(
  run(
    "docker",
    ["compose", "--env-file", envFile, "-f", join(root, "deploy", "compose.production.yml"), "-f", join(root, "deploy", "compose.vault.yml"), "config", "--format", "json"],
    baseEnv,
    true,
  ),
);
for (const serviceName of ["app", "worker-1", "worker-2"]) {
  const service = renderedVaultCompose.services?.[serviceName];
  if (service?.environment?.OWNMINUTES_SECRET_STORE !== "vault-transit" || service?.environment?.OWNMINUTES_VAULT_TOKEN_FILE !== "/run/secrets/vault_token") {
    throw new Error(`Vault environment is missing from ${serviceName}.`);
  }
  if (!service?.secrets?.some((secret) => secret.source === "vault_token" && secret.target === "/run/secrets/vault_token")) {
    throw new Error(`Vault token secret is missing from ${serviceName}.`);
  }
}

const appSecret = join(secretsDir, "app-secret");
const runner = run(
  "node",
  [
    "scripts/run-with-secrets.mjs",
    "--",
    "node",
    "-e",
    "process.stdout.write(JSON.stringify({secret:Boolean(process.env.OWNMINUTES_APP_SECRET),database:process.env.DATABASE_URL?.startsWith('postgresql://ownminutes_app:'),admin:Boolean(process.env.OWNMINUTES_ADMIN_PASSWORD),applePrivateKey:Boolean(process.env.APPLE_PRIVATE_KEY),appleRoots:(()=>{try{return JSON.parse(process.env.APPLE_ROOT_CERTIFICATES||'[]').length===2}catch{return false}})()}))",
  ],
  {
    ...baseEnv,
    OWNMINUTES_APP_SECRET_FILE: appSecret,
    POSTGRES_PASSWORD_FILE: join(secretsDir, "postgres-password"),
    OWNMINUTES_ADMIN_PASSWORD_FILE: join(secretsDir, "admin-bootstrap-password"),
    APPLE_PRIVATE_KEY_FILE: applePrivateKeyFile,
    APPLE_ROOT_CERTIFICATE_PATHS: `${appleRootCaG2File},${appleRootCaG3File}`,
    OWNMINUTES_DATABASE_HOST: "postgres",
    OWNMINUTES_DATABASE_NAME: "ownminutes",
    OWNMINUTES_DATABASE_USER: "ownminutes_app",
  },
  true,
);
const runnerResult = JSON.parse(runner);
if (!runnerResult.secret || !runnerResult.database || !runnerResult.admin || !runnerResult.applePrivateKey || !runnerResult.appleRoots) {
  throw new Error("Secret runner did not map runtime/bootstrap/Apple file secrets and DATABASE_URL.");
}

const missingEmailEnv = vaultReady.replace(/^OWNMINUTES_RESEND_API_KEY_FILE=.*$/m, "OWNMINUTES_RESEND_API_KEY_FILE=/dev/null");
writeFileSync(envFile, missingEmailEnv, { mode: 0o600 });
const rejectedEmail = spawnSync("node", ["scripts/production-stack.mjs", "preflight"], { cwd: root, env: baseEnv, encoding: "utf8" });
if (rejectedEmail.status === 0 || !rejectedEmail.stdout.includes('"email:resend-api-key"')) {
  throw new Error("Production preflight did not reject missing email delivery.");
}

const plaintextOnlyEmailEnv = `${missingEmailEnv}\nRESEND_API_KEY=plaintext-production-secret-is-forbidden\n`;
writeFileSync(envFile, plaintextOnlyEmailEnv, { mode: 0o600 });
const rejectedPlaintextEmail = spawnSync(
  "node",
  ["scripts/production-stack.mjs", "preflight"],
  { cwd: root, env: baseEnv, encoding: "utf8" },
);
if (
  rejectedPlaintextEmail.status === 0 ||
  !rejectedPlaintextEmail.stderr.includes("plaintext environment injection is forbidden")
) {
  throw new Error("Production preflight accepted a plaintext-only provider credential.");
}

const missingSupportEnv = vaultReady.replace(/^OWNMINUTES_SUPPORT_EMAIL=.*$/m, "OWNMINUTES_SUPPORT_EMAIL=");
writeFileSync(envFile, missingSupportEnv, { mode: 0o600 });
const rejectedSupport = spawnSync("node", ["scripts/production-stack.mjs", "preflight"], { cwd: root, env: baseEnv, encoding: "utf8" });
if (rejectedSupport.status === 0 || !rejectedSupport.stdout.includes('"deployment:missing:supportEmail"')) {
  throw new Error("Production preflight did not reject a missing public support email.");
}

const badEnv = vaultReady.replace(/^OWNMINUTES_DOMAIN=.*$/m, "OWNMINUTES_DOMAIN=localhost");
writeFileSync(envFile, badEnv, { mode: 0o600 });
const rejected = spawnSync("node", ["scripts/production-stack.mjs", "preflight"], { cwd: root, env: baseEnv, encoding: "utf8" });
if (rejected.status === 0 || !rejected.stdout.includes('"domain"')) throw new Error("Localhost production domain was not rejected.");

const badAuditPath = vaultReady.replace(
  /^OWNMINUTES_SECRET_AUDIT_LOG=.*$/m,
  "OWNMINUTES_SECRET_AUDIT_LOG=central immutable audit sink",
);
writeFileSync(envFile, badAuditPath, { mode: 0o600 });
const rejectedAuditPath = spawnSync(
  "node",
  ["scripts/production-stack.mjs", "preflight"],
  { cwd: root, env: baseEnv, encoding: "utf8" },
);
if (rejectedAuditPath.status === 0 || !rejectedAuditPath.stdout.includes('"secret-audit-path"')) {
  throw new Error("Production preflight accepted a non-runtime secret audit path.");
}

const disabledAuditRotation = vaultReady.replace(
  /^OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION=.*$/m,
  "OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION=0",
);
writeFileSync(envFile, disabledAuditRotation, { mode: 0o600 });
const rejectedAuditRotation = spawnSync(
  "node",
  ["scripts/production-stack.mjs", "preflight"],
  { cwd: root, env: baseEnv, encoding: "utf8" },
);
if (
  rejectedAuditRotation.status === 0 ||
  !rejectedAuditRotation.stdout.includes('"secret-audit-external-rotation"')
) {
  throw new Error("Production preflight accepted disabled secret audit rotation.");
}

rmSync(scratch, { force: true, recursive: true });
console.log(JSON.stringify({ ok: true, bootstrapsAdminBeforePublicRegistration: true, requiresWorkingEmailBeforeProduction: true, rejectsMissingEmailDelivery: true, rejectsMissingSupportEmail: true, buildsApplicationImageOnce: true, hasDeterministicObjectLifecycle: true, cleanupUsesDedicatedLeastPrivilegeIdentity: true, retentionRunbooksMatchRuntime: true, initializesPrivateSecrets: true, pinsThirdPartyImages: true, validatesImmutableRelease: true, validatesCompose: true, mapsFileSecrets: true, mapsAppleIapFileSecrets: true, appleIapEnvironmentProductionOnly: true, appleIapSecretsOnlyMountedIntoApp: true, dropsPrivilegesAfterReadingProtectedSecrets: true, selectsVaultOverride: true, mountsVaultTokenOnlyIntoRuntimeServices: true, productionFileAsrUsesAuthorizedSingleFlashDefault: true, productionProviderPoliciesReachRuntime: true, proxyUsesReadinessBeforeTraffic: true, publicStagingNoindex: true, publicStagingPrivateBetaRegistration: true, publicStagingCaddyOverrideReadOnly: true, supportsSharedProxyWithoutPortCollision: true, restrictsArkRelayToApplicationHost: true, rejectsLocalhost: true }, null, 2));

function run(executable, args, env, capture = false) {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: capture ? "utf8" : undefined, stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${executable} exited ${result.status}`);
  return result.stdout || "";
}

function gitCommit() {
  return run("git", ["rev-parse", "HEAD"], process.env, true).trim();
}

function hasSecret(service, name) {
  return (service?.secrets || []).some((secret) => (typeof secret === "string" ? secret === name : secret.source === name));
}

function hasVolumeTarget(service, target) {
  return (service?.volumes || []).some((volume) =>
    typeof volume === "string"
      ? volume.endsWith(`:${target}`)
      : volume.target === target
  );
}
