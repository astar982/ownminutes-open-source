#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const runbookPath = path.join(repoRoot, "docs", "secret-management-runbook.md");
const auditPath = path.join(repoRoot, "src", "lib", "server", "secret-audit.ts");
const authStorePath = path.join(repoRoot, "src", "lib", "server", "auth-store.ts");
const authRepositoryPath = path.join(repoRoot, "src", "lib", "server", "auth-repository.ts");
const secretProviderPath = path.join(repoRoot, "src", "lib", "server", "secret-provider.ts");
const localSecretPath = path.join(repoRoot, ".data", "auth", "local-secret");
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_SECRET_PREFLIGHT_STRICT === "1";
const provider = detectProvider();
const runtimeAdapter = detectRuntimeAdapter(provider);
const vaultConfig = inspectVaultConfig();

const commonRequiredEnv = [
  "OWNMINUTES_SECRET_ROTATION_POLICY",
  "OWNMINUTES_SECRET_AUDIT_LOG",
  "OWNMINUTES_TENANT_SCOPED_KEYS",
  "OWNMINUTES_SECRET_DELETION_PROOF",
  "OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY",
  "OWNMINUTES_SECRET_LOCAL_SECRET_DECISION",
  "OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT",
  "OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY",
];

const requiredEnvByProvider = {
  kms: ["implemented KMS runtime adapter", ...commonRequiredEnv],
  "managed-secret-store": [
    "OWNMINUTES_SECRET_STORE=vault-transit",
    "OWNMINUTES_VAULT_ADDR",
    "OWNMINUTES_VAULT_TRANSIT_KEY",
    "OWNMINUTES_VAULT_TOKEN_FILE (0600 regular file)",
    ...commonRequiredEnv,
  ],
  "local-app-secret": ["OWNMINUTES_SECRET_STORE=vault-transit", ...commonRequiredEnv],
};

function main() {
  const auditSource = readFile(auditPath);
  const authStoreSource = readFile(authStorePath);
  const authRepositorySource = readFile(authRepositoryPath);
  const secretProviderSource = readFile(secretProviderPath);
  const localSecretExists = fs.existsSync(localSecretPath);
  const managedRuntimeReady = runtimeAdapter === "vault-transit" && vaultConfig.complete;
  const checks = [
    check(
      "managed-provider",
      provider !== "local-app-secret",
      `密钥 provider=${provider} 已选择。`,
      "缺少托管 secret store；当前仍会使用本地 app secret。",
    ),
    check(
      "runtime-adapter",
      managedRuntimeReady,
      "Vault Transit 运行适配器和基础配置已就绪。",
      provider === "kms"
        ? "KMS 只有配置声明，没有已实现的运行适配器。"
        : runtimeAdapter === "vault-transit"
          ? "Vault Transit 运行适配器已选择，但地址、key 或私有 token 文件配置不完整。"
          : "当前托管 secret store 没有已实现的运行适配器；请使用 OWNMINUTES_SECRET_STORE=vault-transit。",
    ),
    check(
      "vault-runtime-config",
      runtimeAdapter === "vault-transit" && vaultConfig.complete,
      "Vault HTTPS 地址、Transit key 和 0600 token 文件已通过静态检查。",
      runtimeAdapter === "vault-transit"
        ? `Vault 配置未通过：${vaultConfig.reason}`
        : "Vault Transit 未选中。",
    ),
    check(
      "rotation-policy",
      Boolean(process.env.OWNMINUTES_SECRET_ROTATION_POLICY),
      "OWNMINUTES_SECRET_ROTATION_POLICY 已声明。",
      "缺少 OWNMINUTES_SECRET_ROTATION_POLICY。",
    ),
    check(
      "audit-log",
      Boolean(process.env.OWNMINUTES_SECRET_AUDIT_LOG),
      "OWNMINUTES_SECRET_AUDIT_LOG 已声明。",
      "缺少 OWNMINUTES_SECRET_AUDIT_LOG。",
    ),
    check(
      "tenant-scoped-keys",
      Boolean(process.env.OWNMINUTES_TENANT_SCOPED_KEYS),
      "OWNMINUTES_TENANT_SCOPED_KEYS 已声明。",
      "缺少 OWNMINUTES_TENANT_SCOPED_KEYS。",
    ),
    check(
      "deletion-proof",
      Boolean(process.env.OWNMINUTES_SECRET_DELETION_PROOF),
      "OWNMINUTES_SECRET_DELETION_PROOF 已声明。",
      "缺少 OWNMINUTES_SECRET_DELETION_PROOF；需要记录账号删除后 Provider 密钥和托管引用已删除的证据。",
    ),
    check(
      "admin-access-policy",
      Boolean(process.env.OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY),
      "OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY 已声明。",
      "缺少 OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY；需要记录客服/管理员不能查看用户明文密钥的策略。",
    ),
    check(
      "local-secret-decision",
      Boolean(process.env.OWNMINUTES_SECRET_LOCAL_SECRET_DECISION),
      "OWNMINUTES_SECRET_LOCAL_SECRET_DECISION 已声明。",
      "缺少 OWNMINUTES_SECRET_LOCAL_SECRET_DECISION；需要确认本地 .data/auth/local-secret 是轮换、隔离还是销毁。",
    ),
    check(
      "decrypt-failure-audit",
      Boolean(process.env.OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT),
      "OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT 已声明。",
      "缺少 OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT；需要记录 Provider 密钥解密失败的审计和告警策略。",
    ),
    check(
      "backup-recovery-policy",
      Boolean(process.env.OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY),
      "OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY 已声明。",
      "缺少 OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY；需要记录 Vault Transit 的备份恢复和灾备策略。",
    ),
    check(
      "local-secret-file",
      !localSecretExists || Boolean(process.env.OWNMINUTES_SECRET_LOCAL_SECRET_DECISION),
      localSecretExists ? "本地 local-secret 存在，但已声明迁移/隔离/销毁决策。" : "未检测到本地 local-secret 文件。",
      "检测到本地 .data/auth/local-secret，且没有声明迁移/隔离/销毁决策。",
    ),
    check("runbook", fs.existsSync(runbookPath), "密钥管理 runbook 存在。", "缺少 docs/secret-management-runbook.md。"),
    check(
      "audit-runtime",
      auditSource.includes("provider_secret_save") &&
        auditSource.includes("provider_secret_rotate") &&
        auditSource.includes("provider_secret_delete") &&
        auditSource.includes("providerRef") &&
        auditSource.includes("secretRefs") &&
        authStoreSource.includes("enqueueLocalSecretAuditEvents") &&
        authRepositorySource.includes("enqueuePostgresSecretAuditEvents"),
      "Provider 密钥保存、轮换、删除和不可逆引用 durable outbox runtime 已实现。",
      "Provider 密钥审计 runtime 缺失保存、轮换、删除、不可逆引用或 durable outbox 能力。",
    ),
    check(
      "secret-provider-contract",
      secretProviderSource.includes("secret-provider-contract:v3") &&
        secretProviderSource.includes("durable-transactional-outbox") &&
        secretProviderSource.includes("enqueueSecretAuditEvent") &&
        secretProviderSource.includes("vaultEncrypt") &&
        secretProviderSource.includes("vaultDecrypt") &&
        secretProviderSource.includes("deleteProviderSecretReference") &&
        authStoreSource.includes("await encryptSecret") &&
        authRepositorySource.includes("await encryptSecret"),
      "Secret Provider v3 durable outbox 合约、Vault Transit 和异步仓库入口已实现。",
      "缺少 Secret Provider v3 durable outbox 合约、Vault Transit，或本地/PostgreSQL 仓库未等待托管加密结果。",
    ),
    check(
      "encrypted-secret-runtime",
      secretProviderSource.includes("v2.${iv.toString") &&
        secretProviderSource.includes("v3.vault.") &&
        secretProviderSource.includes("provider-secret:v3:${scope.userId}:${scope.providerId}:${secretName}") &&
        authStoreSource.includes("secretPreviews") &&
        authRepositorySource.includes("encrypted_secrets") &&
        authRepositorySource.includes("secret_previews"),
      "本地 v2、Vault v3 租户上下文密文和不可回显摘要 runtime 已实现。",
      "Provider 密钥加密存储、Vault 租户上下文或不可回显摘要 runtime 缺失。",
    ),
  ];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const summary = {
    ok: missing.length === 0,
    strict,
    provider,
    runtimeAdapter,
    productionCandidate: missing.length === 0,
    requiredEnv: requiredEnvByProvider[provider],
    configured: {
      kmsKey: Boolean(getEnv("OWNMINUTES_KMS_KEY_ID", "KMS_KEY_ID")),
      managedSecretStore: Boolean(getEnv("OWNMINUTES_SECRET_STORE", "SECRET_STORE_URL")),
      vaultAddress: vaultConfig.address,
      vaultTransitKey: vaultConfig.key,
      vaultTokenFile: vaultConfig.tokenFile,
      rotationPolicy: Boolean(process.env.OWNMINUTES_SECRET_ROTATION_POLICY),
      auditLog: Boolean(process.env.OWNMINUTES_SECRET_AUDIT_LOG),
      tenantScopedKeys: Boolean(process.env.OWNMINUTES_TENANT_SCOPED_KEYS),
      deletionProof: Boolean(process.env.OWNMINUTES_SECRET_DELETION_PROOF),
      adminAccessPolicy: Boolean(process.env.OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY),
      localSecretDecision: Boolean(process.env.OWNMINUTES_SECRET_LOCAL_SECRET_DECISION),
      decryptFailureAudit: Boolean(process.env.OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT),
      backupRecoveryPolicy: Boolean(process.env.OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY),
      localSecretExists,
    },
    missing,
    checks,
    nextAction:
      missing.length === 0
        ? "Run a real Vault encrypt/decrypt isolation test, key rotation, provider credential deletion, account deletion, failure audit, backup recovery, and audit log sampling in this deployment."
        : "Configure the implemented Vault Transit runtime and missing production evidence, then rerun npm run secret:preflight.",
    leaksSecrets: leaksSecrets(JSON.stringify({ checks, missing, requiredEnv: requiredEnvByProvider[provider] })),
  };

  console.log(JSON.stringify(summary, null, 2));
  if (summary.leaksSecrets || (strict && !summary.ok)) process.exitCode = 1;
}

function inspectVaultConfig() {
  const addressText = getEnv("OWNMINUTES_VAULT_ADDR");
  const keyName = getEnv("OWNMINUTES_VAULT_TRANSIT_KEY");
  const tokenFile = getEnv("OWNMINUTES_VAULT_TOKEN_FILE");
  const result = { address: false, key: false, tokenFile: false, complete: false, reason: "missing required values" };
  try {
    const address = new URL(addressText);
    result.address =
      address.protocol === "https:" &&
      !address.username &&
      !address.password &&
      address.pathname === "/" &&
      !address.search &&
      !address.hash;
  } catch {
    result.address = false;
  }
  result.key = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(keyName);
  if (tokenFile) {
    try {
      const stat = fs.statSync(path.resolve(tokenFile));
      const token = fs.readFileSync(path.resolve(tokenFile), "utf8").trim();
      result.tokenFile = stat.isFile() && (stat.mode & 0o077) === 0 && token.length >= 8 && !/[\r\n\0]/.test(token);
    } catch {
      result.tokenFile = false;
    }
  }
  result.complete = result.address && result.key && result.tokenFile;
  result.reason = result.complete
    ? "complete"
    : [!result.address ? "invalid HTTPS address" : "", !result.key ? "invalid transit key" : "", !result.tokenFile ? "missing or non-0600 token file" : ""]
        .filter(Boolean)
        .join(", ");
  return result;
}

function check(id, passed, passDetail, failDetail) {
  return { id, status: passed ? "pass" : "fail", detail: passed ? passDetail : failDetail };
}

function readFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function detectProvider() {
  if (getEnv("OWNMINUTES_KMS_KEY_ID", "KMS_KEY_ID")) return "kms";
  if (getEnv("OWNMINUTES_SECRET_STORE", "SECRET_STORE_URL")) return "managed-secret-store";
  return "local-app-secret";
}

function detectRuntimeAdapter(selectedProvider) {
  if (selectedProvider === "local-app-secret") return "local-aes-gcm";
  if (selectedProvider === "managed-secret-store" && getEnv("OWNMINUTES_SECRET_STORE") === "vault-transit") return "vault-transit";
  return "unsupported";
}

function getEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return "";
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE") ||
    text.includes("kms-key-material") ||
    text.includes("managed-secret-token") ||
    text.includes("vault-smoke-token") ||
    text.includes("OWNMINUTES_APP_SECRET=") ||
    text.includes("AUTH_SECRET=")
  );
}

main();
