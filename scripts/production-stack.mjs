#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

const root = process.cwd();
const composeFile = join(root, "deploy", "compose.production.yml");
const vaultComposeFile = join(root, "deploy", "compose.vault.yml");
const envFile = resolve(process.env.OWNMINUTES_PRODUCTION_ENV_FILE || join(root, "deploy", ".env.production"));
const secretsDir = resolve(process.env.OWNMINUTES_PRODUCTION_SECRETS_DIR || join(root, "deploy", "secrets"));
const command = process.argv[2] || "status";
const providerSecretPairs = [
  ["VOLCANO_ASR_API_KEY", "OWNMINUTES_VOLCANO_ASR_API_KEY_FILE"],
  ["VOLCANO_ASR_TOKEN", "OWNMINUTES_VOLCANO_ASR_TOKEN_FILE"],
  ["ARK_API_KEY", "OWNMINUTES_ARK_API_KEY_FILE"],
  ["RESEND_API_KEY", "OWNMINUTES_RESEND_API_KEY_FILE"],
];

if (command === "init") {
  initialize();
  process.exit(0);
}

if (!existsSync(envFile)) {
  throw new Error(`Production environment not initialized: ${envFile}. Run npm run production:init -- --domain <host> --email <address>.`);
}

const fileEnvironment = parseEnv(readFileSync(envFile, "utf8"));
const preflightEnvironment = hydrateProviderFileSecrets({
  ...process.env,
  ...fileEnvironment,
  OWNMINUTES_CURRENT_COMMIT: gitCommit(),
  OWNMINUTES_WORKTREE_CLEAN: gitClean() ? "1" : "0",
}, fileEnvironment);
const composeEnvironment = stripProviderSecrets(preflightEnvironment);
const vaultSelected = preflightEnvironment.OWNMINUTES_SECRET_STORE === "vault-transit";
const composeFiles = vaultSelected ? [composeFile, vaultComposeFile] : [composeFile];
const composeArgs = ["compose", "--env-file", envFile, ...composeFiles.flatMap((file) => ["-f", file])];

if (command === "preflight") {
  runPreflight();
} else if (command === "config") {
  runPreflight();
  run("docker", [...composeArgs, "config", "--quiet"]);
  console.log(JSON.stringify({ ok: true, composeFiles, envFile, action: "config" }, null, 2));
} else if (command === "up") {
  runPreflight();
  run("docker", [...composeArgs, "config", "--quiet"]);
  run("docker", [...composeArgs, "up", "-d", "--build", "--remove-orphans"]);
  run("docker", [...composeArgs, "ps"]);
} else if (command === "status") {
  run("docker", [...composeArgs, "ps"]);
} else if (command === "verify") {
  runPreflight();
  run("docker", [...composeArgs, "ps"]);
  run("docker", [...composeArgs, "run", "--rm", "--no-deps", "legacy-cleanup-gate"]);
  run("docker", [
    ...composeArgs,
    "exec",
    "-T",
    "app",
    "node",
    "scripts/run-with-secrets.mjs",
    "--",
    "node",
    "scripts/check-account-deletion-cleanup-gate.mjs",
    "--strict",
  ]);
  const origin = `https://${preflightEnvironment.OWNMINUTES_DOMAIN}`;
  run("node", ["scripts/verify-public-deployment-live.mjs"], {
    ...composeEnvironment,
    OWNMINUTES_APP_URL: origin,
    EXPO_PUBLIC_API_BASE_URL: origin,
    OWNMINUTES_PRIVACY_URL: `${origin}/privacy`,
    OWNMINUTES_TERMS_URL: `${origin}/terms`,
    OWNMINUTES_SUPPORT_URL: `${origin}/support`,
    OWNMINUTES_HEALTH_CHECK_URL: `${origin}/api/health`,
  });
} else if (command === "logs") {
  run("docker", [...composeArgs, "logs", "--tail", "200", "migrate", "admin-bootstrap", "caddy", "app", "worker-1", "worker-2"]);
} else if (command === "down") {
  run("docker", [...composeArgs, "down"]);
} else {
  throw new Error(`Unknown production command: ${command}`);
}

function initialize() {
  const domain = argument("--domain") || process.env.OWNMINUTES_DOMAIN || "";
  const email = argument("--email") || process.env.OWNMINUTES_TLS_EMAIL || "";
  const adminEmail = argument("--admin-email") || process.env.OWNMINUTES_ADMIN_EMAIL || "";
  const adminName = argument("--admin-name") || process.env.OWNMINUTES_ADMIN_NAME || "OwnMinutes Admin";
  const supportEmail = argument("--support-email") || process.env.OWNMINUTES_SUPPORT_EMAIL || adminEmail;
  const legalOperatorName = argument("--legal-operator-name") || process.env.OWNMINUTES_LEGAL_OPERATOR_NAME || "";
  const legalOperatorAddress = argument("--legal-operator-address") || process.env.OWNMINUTES_LEGAL_OPERATOR_ADDRESS || "";
  const legalOperatorJurisdiction = argument("--legal-operator-jurisdiction") || process.env.OWNMINUTES_LEGAL_OPERATOR_JURISDICTION || "";
  const force = process.argv.includes("--force");
  if (!domain || !email || !adminEmail || !legalOperatorName || !legalOperatorAddress || !legalOperatorJurisdiction) {
    throw new Error(
      "Usage: npm run production:init -- --domain app.example.com --email ops@example.com --admin-email owner@example.com --legal-operator-name \"Real Company\" --legal-operator-address \"Real address\" --legal-operator-jurisdiction \"Real jurisdiction\" [--admin-name \"Owner\"] [--support-email support@example.com]",
    );
  }
  if (
    [domain, email, adminEmail, adminName, supportEmail, legalOperatorName, legalOperatorAddress, legalOperatorJurisdiction].some(
      (item) => /[\r\n\0]/.test(item),
    ) ||
    [adminName, legalOperatorName, legalOperatorAddress, legalOperatorJurisdiction].some((item) => /[#=]/.test(item))
  ) {
    throw new Error("Production initialization values must be single-line environment-safe text.");
  }
  if (![adminEmail, supportEmail].every((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) || adminName.length < 2 || adminName.length > 80) {
    throw new Error("Provide valid admin/support emails and an --admin-name containing 2-80 characters.");
  }
  if (
    legalOperatorName.length < 2 ||
    legalOperatorName.length > 160 ||
    legalOperatorAddress.length < 8 ||
    legalOperatorAddress.length > 300 ||
    legalOperatorJurisdiction.length < 2 ||
    legalOperatorJurisdiction.length > 120
  ) {
    throw new Error("Provide the real legal operator name, address, and jurisdiction.");
  }
  if (!gitClean() && process.env.OWNMINUTES_PRODUCTION_ALLOW_DIRTY_SMOKE !== "1") {
    throw new Error("Production initialization requires a clean Git worktree.");
  }
  if ((existsSync(envFile) || existsSync(secretsDir)) && !force) {
    throw new Error("Production files already exist. Refusing to overwrite; pass --force only after backing them up.");
  }

  mkdirSync(dirname(envFile), { recursive: true });
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  chmodSync(secretsDir, 0o700);
  const secretFiles = {
    "app-secret": token(48),
    "postgres-password": token(36),
    "postgres-migrator-password": token(36),
    "postgres-app-password": token(36),
    "minio-root-user": `root-${token(18)}`,
    "minio-root-password": token(36),
    "s3-access-key-id": `app-${token(18)}`,
    "s3-secret-access-key": token(36),
    "s3-cleanup-access-key-id": `cleanup-${token(18)}`,
    "s3-cleanup-secret-access-key": token(36),
    "admin-bootstrap-password": token(36),
    "backup-encryption-key": token(48),
  };
  for (const [name, secret] of Object.entries(secretFiles)) {
    const path = join(secretsDir, name);
    writeFileSync(path, `${secret}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  const release = gitCommit();
  const templatePath = join(root, "deploy", "production.env.example");
  const paths = Object.fromEntries(Object.keys(secretFiles).map((name) => [name, join(secretsDir, name)]));
  let content = readFileSync(templatePath, "utf8")
    .replace(/^OWNMINUTES_DOMAIN=.*$/m, `OWNMINUTES_DOMAIN=${domain}`)
    .replace(/^OWNMINUTES_TLS_EMAIL=.*$/m, `OWNMINUTES_TLS_EMAIL=${email}`)
    .replace(/^OWNMINUTES_RELEASE_ID=.*$/m, `OWNMINUTES_RELEASE_ID=${release}`)
    .replace(/^OWNMINUTES_IMAGE=.*$/m, `OWNMINUTES_IMAGE=ownminutes:${release.slice(0, 12)}`)
    .replace(/^OWNMINUTES_ADMIN_EMAIL=.*$/m, () => `OWNMINUTES_ADMIN_EMAIL=${adminEmail}`)
    .replace(/^OWNMINUTES_ADMIN_NAME=.*$/m, () => `OWNMINUTES_ADMIN_NAME=${adminName}`)
    .replace(/^OWNMINUTES_SUPPORT_EMAIL=.*$/m, () => `OWNMINUTES_SUPPORT_EMAIL=${supportEmail}`)
    .replace(/^OWNMINUTES_LEGAL_OPERATOR_NAME=.*$/m, () => `OWNMINUTES_LEGAL_OPERATOR_NAME=${legalOperatorName}`)
    .replace(/^OWNMINUTES_LEGAL_OPERATOR_ADDRESS=.*$/m, () => `OWNMINUTES_LEGAL_OPERATOR_ADDRESS=${legalOperatorAddress}`)
    .replace(/^OWNMINUTES_LEGAL_OPERATOR_JURISDICTION=.*$/m, () => `OWNMINUTES_LEGAL_OPERATOR_JURISDICTION=${legalOperatorJurisdiction}`)
    .replace("/srv/ownminutes/deploy/secrets/app-secret", paths["app-secret"])
    .replace("/srv/ownminutes/deploy/secrets/postgres-password", paths["postgres-password"])
    .replace("/srv/ownminutes/deploy/secrets/postgres-migrator-password", paths["postgres-migrator-password"])
    .replace("/srv/ownminutes/deploy/secrets/postgres-app-password", paths["postgres-app-password"])
    .replace("/srv/ownminutes/deploy/secrets/minio-root-user", paths["minio-root-user"])
    .replace("/srv/ownminutes/deploy/secrets/minio-root-password", paths["minio-root-password"])
    .replace("/srv/ownminutes/deploy/secrets/s3-access-key-id", paths["s3-access-key-id"])
    .replace("/srv/ownminutes/deploy/secrets/s3-secret-access-key", paths["s3-secret-access-key"])
    .replace("/srv/ownminutes/deploy/secrets/s3-cleanup-access-key-id", paths["s3-cleanup-access-key-id"])
    .replace("/srv/ownminutes/deploy/secrets/s3-cleanup-secret-access-key", paths["s3-cleanup-secret-access-key"]);
  content = content.replace("/srv/ownminutes/deploy/secrets/admin-bootstrap-password", paths["admin-bootstrap-password"]);
  content = content.replace("/srv/ownminutes/deploy/secrets/backup-encryption-key", paths["backup-encryption-key"]);
  writeFileSync(envFile, content, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(JSON.stringify({ ok: true, envFile, secretsDir, release: release.slice(0, 12), next: "npm run production:preflight" }, null, 2));
}

function runPreflight() {
  const infrastructure = runJson("node", ["scripts/check-self-hosted-production-env.mjs", "--strict"], preflightEnvironment);
  const origin = `https://${preflightEnvironment.OWNMINUTES_DOMAIN}`;
  const publicDeployment = runJson("node", ["scripts/check-public-deployment-env.mjs"], {
    ...preflightEnvironment,
    OWNMINUTES_APP_URL: origin,
    EXPO_PUBLIC_API_BASE_URL: origin,
    OWNMINUTES_PRIVACY_URL: `${origin}/privacy`,
    OWNMINUTES_TERMS_URL: `${origin}/terms`,
    OWNMINUTES_SUPPORT_URL: `${origin}/support`,
    OWNMINUTES_HEALTH_CHECK_URL: `${origin}/api/health`,
  });
  const email = runJson("node", ["scripts/check-email-production-env.mjs", "--strict"], {
    ...preflightEnvironment,
    OWNMINUTES_APP_URL: origin,
  });
  const secretManagement = vaultSelected
    ? runJson("node", ["scripts/check-secret-production-env.mjs", "--strict"], preflightEnvironment)
    : { ok: false, provider: "local-app-secret", runtimeAdapter: "local-aes-gcm", productionCandidate: false, missing: ["vault-transit-not-selected"] };
  const summary = {
        ok:
          infrastructure.ok === true &&
          publicDeployment.productionDeploymentReady === true &&
          email.ok === true &&
          secretManagement.productionCandidate === true &&
          secretManagement.leaksSecrets !== true,
        failureIds: [
          ...(infrastructure.failureIds || []),
          ...(publicDeployment.missing || []).map((id) => `deployment:missing:${id}`),
          ...(publicDeployment.invalid || []).map((id) => `deployment:invalid:${id}`),
          ...(publicDeployment.originWarnings || []).map((id) => `deployment:origin:${id}`),
          ...(publicDeployment.pathWarnings || []).map((id) => `deployment:path:${id}`),
          ...(email.missing || []).map((id) => `email:${id}`),
          ...(secretManagement.missing || []).map((id) => `secret:${id}`),
          ...(secretManagement.leaksSecrets === true ? ["secret:leaks"] : []),
        ],
        configured: infrastructure.configured,
        publicDeployment: {
          productionDeploymentReady: publicDeployment.productionDeploymentReady,
          supportEmailConfigured: publicDeployment.checks?.supportEmail?.configured === true,
        },
        email: {
          provider: email.provider,
          productionCandidate: email.productionCandidate,
        },
        secretManagement: {
          provider: secretManagement.provider,
          runtimeAdapter: secretManagement.runtimeAdapter,
          productionCandidate: secretManagement.productionCandidate,
          missing: secretManagement.missing,
        },
        leaksSecrets: infrastructure.leaksSecrets === true || email.leaksSecrets === true || secretManagement.leaksSecrets === true,
      };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

function runJson(executable, args, env) {
  const result = spawnSync(executable, args, { cwd: root, env, encoding: "utf8" });
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status ?? 1);
  }
}

function run(executable, args, env = composeEnvironment) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to determine current Git commit.");
  return result.stdout.trim();
}

function gitClean() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to inspect Git worktree state.");
  return result.stdout.trim() === "";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function token(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function hydrateProviderFileSecrets(input, declaredEnvironment) {
  const hydrated = { ...input };
  for (const [target, fileVariable] of providerSecretPairs) {
    if (String(declaredEnvironment[target] || "").trim()) {
      throw new Error(`${target} plaintext environment injection is forbidden in production; use ${fileVariable}.`);
    }
    delete hydrated[target];
    const file = String(hydrated[fileVariable] || "").trim();
    if (!file || file === "/dev/null") continue;
    let secret;
    try {
      const stats = statSync(file);
      if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
        throw new Error("unsafe-provider-secret-file");
      }
      secret = readFileSync(file, "utf8").trim();
    } catch {
      throw new Error(`${fileVariable} must point to a readable owner-only regular credential file.`);
    }
    if (!secret || /[\0\r\n]/.test(secret)) {
      throw new Error(`${fileVariable} must contain one non-empty single-line credential.`);
    }
    hydrated[target] = secret;
  }
  return hydrated;
}

function stripProviderSecrets(input) {
  const stripped = { ...input };
  for (const [target] of providerSecretPairs) delete stripped[target];
  return stripped;
}
