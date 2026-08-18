import fs from "fs";
import path from "path";
import {
  getSecretAuditInfo,
  type SecretAuditOutboxInfo,
} from "@/lib/server/secret-audit";
import { getSecretAuditOutboxInfo } from "@/lib/server/auth-repository";
import { getSecretProviderContract } from "@/lib/server/secret-provider";

export type SecretProvider = "local-app-secret" | "kms" | "managed-secret-store";
export type SecretCheckStatus = "pass" | "fail" | "manual";

export type SecretDiagnosticCheck = {
  id: string;
  title: string;
  status: SecretCheckStatus;
  detail: string;
};

export type SecretDiagnostics = {
  generatedAt: string;
  provider: SecretProvider;
  productionReady: boolean;
  localSecretPath: string;
  audit: {
    managedPathConfigured: boolean;
    sinkReady: boolean;
    sinkStatus: string;
    sinkWritable: boolean;
    legacyMigrationReady: boolean;
    legacyMigrationStatus: string;
    legacyMigrationCheckedAt: string | null;
    externalRotationRequired: boolean;
    externalRotationConfigured: boolean;
    maxBytes: number;
    localRetentionEnforced: boolean;
    lastWriteOk: boolean | null;
    lastWriteAt: string | null;
    lastWriteErrorCode: string | null;
    outboxReady: boolean;
    outboxStatus: "pending" | "ready" | "unavailable";
    pendingCount: number | null;
    expiredLeaseCount: number | null;
    overduePendingCount: number | null;
    oldestPendingAgeMs: number | null;
  };
  configured: {
    appSecret: boolean;
    kmsKey: boolean;
    managedSecretStore: boolean;
    rotationPolicy: boolean;
    auditLog: boolean;
    tenantScopedKeys: boolean;
    deletionProof: boolean;
    adminAccessPolicy: boolean;
    localSecretDecision: boolean;
    decryptFailureAudit: boolean;
    backupRecoveryPolicy: boolean;
    providerContract: boolean;
    providerRuntime: boolean;
    providerTransportSecure: boolean;
    runbook: boolean;
  };
  capabilities: {
    encryptsProviderSecrets: boolean;
    tenantScopedLocalEncryption: boolean;
    supportsRotation: boolean;
    supportsTenantIsolation: boolean;
    supportsAuditLog: boolean;
    supportsDeletionProof: boolean;
    blocksAdminPlaintextAccess: boolean;
    supportsBackupRecoveryPolicy: boolean;
    supportsProviderContract: boolean;
    usesManagedRuntime: boolean;
    usesSecureManagedTransport: boolean;
    usesLocalFilesystem: boolean;
  };
  missing: string[];
  checks: SecretDiagnosticCheck[];
  notes: string[];
};

const localSecretPath = path.join(process.cwd(), ".data", "auth", "local-secret");
const secretRunbookPath = path.join(process.cwd(), "docs", "secret-management-runbook.md");

export async function getRuntimeSecretDiagnostics(): Promise<SecretDiagnostics> {
  let auditOutboxInfo: SecretAuditOutboxInfo | null = null;
  try {
    auditOutboxInfo = await getSecretAuditOutboxInfo();
  } catch {
    // Missing or unreachable durable state must remain fail-closed.
  }
  return getSecretDiagnostics({ auditOutboxInfo });
}

export function getSecretDiagnostics(
  input: { auditOutboxInfo?: SecretAuditOutboxInfo | null } = {},
): SecretDiagnostics {
  const kmsKey = getEnv("OWNMINUTES_KMS_KEY_ID", "KMS_KEY_ID");
  const managedSecretStore = getEnv("OWNMINUTES_SECRET_STORE", "SECRET_STORE_URL");
  const appSecret = getEnv("OWNMINUTES_APP_SECRET", "AUTH_SECRET");
  const provider = detectProvider({ kmsKey, managedSecretStore });
  const rotationPolicy = hasEnv("OWNMINUTES_SECRET_ROTATION_POLICY");
  const auditInfo = getSecretAuditInfo();
  const auditOutboxInfo = input.auditOutboxInfo ?? null;
  const auditOutboxReady =
    auditOutboxInfo !== null &&
    auditOutboxInfo.pendingCount === 0 &&
    auditOutboxInfo.expiredLeaseCount === 0 &&
    auditOutboxInfo.overduePendingCount === 0;
  const auditOutboxStatus = auditOutboxInfo === null
    ? "unavailable" as const
    : auditOutboxReady
      ? "ready" as const
      : "pending" as const;
  const auditLog =
    auditInfo.managedPathConfigured &&
    auditInfo.sinkReady &&
    auditOutboxReady &&
    auditInfo.lastWriteOk !== false;
  const tenantScopedKeys = hasEnv("OWNMINUTES_TENANT_SCOPED_KEYS");
  const deletionProof = hasEnv("OWNMINUTES_SECRET_DELETION_PROOF");
  const adminAccessPolicy = hasEnv("OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY");
  const localSecretDecision = hasEnv("OWNMINUTES_SECRET_LOCAL_SECRET_DECISION");
  const decryptFailureAudit = hasEnv("OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT");
  const backupRecoveryPolicy = hasEnv("OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY");
  const localSecretExists = fs.existsSync(localSecretPath);
  const runbook = fs.existsSync(secretRunbookPath);
  const providerContract = getSecretProviderContract();
  const providerContractReady =
    providerContract.contractVersion === "secret-provider-contract:v3" &&
    providerContract.auditDelivery === "durable-transactional-outbox" &&
    providerContract.requiredRuntimeMethods.includes("encryptProviderSecret") &&
    providerContract.requiredRuntimeMethods.includes("decryptProviderSecret") &&
    providerContract.requiredRuntimeMethods.includes("deleteProviderSecretReference") &&
    providerContract.requiredRuntimeMethods.includes("enqueueSecretAuditEvent");
  const managedRuntimeReady =
    provider !== "local-app-secret" && providerContract.runtimeReady && providerContract.runtimeAdapter === "vault-transit";
  const providerTransportSecure = provider === "managed-secret-store" && isSecureVaultAddress(getEnv("OWNMINUTES_VAULT_ADDR"));
  const productionReady =
    managedRuntimeReady &&
    providerTransportSecure &&
    providerContractReady &&
    rotationPolicy &&
    auditLog &&
    tenantScopedKeys &&
    deletionProof &&
    adminAccessPolicy &&
    localSecretDecision &&
    decryptFailureAudit &&
    backupRecoveryPolicy &&
    runbook &&
    (!localSecretExists || localSecretDecision);
  const missing = getMissingConfig({
    provider,
    rotationPolicy,
    auditLog,
    tenantScopedKeys,
    deletionProof,
    adminAccessPolicy,
    localSecretDecision,
    decryptFailureAudit,
    backupRecoveryPolicy,
    runbook,
    localSecretExists,
    managedRuntimeReady,
    providerTransportSecure,
    runtimeAdapter: providerContract.runtimeAdapter,
    auditOutboxReady,
  });

  return {
    generatedAt: new Date().toISOString(),
    provider,
    productionReady,
    localSecretPath: ".data/auth/local-secret",
    audit: {
      managedPathConfigured: auditInfo.managedPathConfigured,
      sinkReady: auditInfo.sinkReady,
      sinkStatus: auditInfo.sinkStatus,
      sinkWritable: auditInfo.sinkWritable,
      legacyMigrationReady: auditInfo.legacyMigrationReady,
      legacyMigrationStatus: auditInfo.legacyMigrationStatus,
      legacyMigrationCheckedAt: auditInfo.legacyMigrationCheckedAt,
      externalRotationRequired: auditInfo.externalRotationRequired,
      externalRotationConfigured: auditInfo.externalRotationConfigured,
      maxBytes: auditInfo.maxBytes,
      localRetentionEnforced: auditInfo.localRetentionEnforced,
      lastWriteOk: auditInfo.lastWriteOk,
      lastWriteAt: auditInfo.lastWriteAt,
      lastWriteErrorCode: auditInfo.lastWriteErrorCode,
      outboxReady: auditOutboxReady,
      outboxStatus: auditOutboxStatus,
      pendingCount: auditOutboxInfo?.pendingCount ?? null,
      expiredLeaseCount: auditOutboxInfo?.expiredLeaseCount ?? null,
      overduePendingCount: auditOutboxInfo?.overduePendingCount ?? null,
      oldestPendingAgeMs: auditOutboxInfo?.oldestPendingAgeMs ?? null,
    },
    configured: {
      appSecret: Boolean(appSecret),
      kmsKey: Boolean(kmsKey),
      managedSecretStore: Boolean(managedSecretStore),
      rotationPolicy,
      auditLog,
      tenantScopedKeys,
      deletionProof,
      adminAccessPolicy,
      localSecretDecision,
      decryptFailureAudit,
      backupRecoveryPolicy,
      providerContract: providerContractReady,
      providerRuntime: managedRuntimeReady,
      providerTransportSecure,
      runbook,
    },
    capabilities: {
      encryptsProviderSecrets: provider === "local-app-secret" || managedRuntimeReady,
      tenantScopedLocalEncryption: true,
      supportsRotation: provider !== "local-app-secret" && rotationPolicy,
      supportsTenantIsolation: tenantScopedKeys,
      supportsAuditLog: auditLog,
      supportsDeletionProof: deletionProof,
      blocksAdminPlaintextAccess: adminAccessPolicy,
      supportsBackupRecoveryPolicy: backupRecoveryPolicy,
      supportsProviderContract: providerContractReady,
      usesManagedRuntime: managedRuntimeReady,
      usesSecureManagedTransport: managedRuntimeReady && providerTransportSecure,
      usesLocalFilesystem: provider === "local-app-secret",
    },
    missing,
    checks: [
      {
        id: "secret-provider",
        title: "托管密钥 Provider",
        status: managedRuntimeReady ? "pass" : "fail",
        detail: managedRuntimeReady
          ? "Vault Transit 运行适配器已选中且基础配置完整。"
          : provider === "local-app-secret"
            ? "当前使用本地 app secret 派生 Provider 密钥加密 Key。"
            : `检测到 ${provider} 声明，但没有可用的托管加密运行适配器。`,
      },
      {
        id: "secret-provider-transport",
        title: "Vault 生产传输",
        status: providerTransportSecure ? "pass" : "fail",
        detail: providerTransportSecure ? "Vault 使用无凭据、无路径的 HTTPS origin。" : "生产 Vault 必须使用无凭据、无路径的 HTTPS origin；本机 HTTP 只允许测试且不计入生产就绪。",
      },
      {
        id: "local-secret-visible",
        title: "本地 app secret",
        status: localSecretExists ? "manual" : "pass",
        detail: localSecretExists ? "本地 local-secret 已存在，生产迁移前需要轮换或隔离。" : "未检测到本地 local-secret 文件。",
      },
      {
        id: "tenant-scoped-local-encryption",
        title: "租户级本地加密",
        status: "pass",
        detail: "本地密文按 userId + providerId 派生 AES-GCM Key；Vault 密文额外绑定 secretName，上述两种模式均保留旧密文兼容读取。",
      },
      {
        id: "secret-provider-contract",
        title: "Secret Provider 合约",
        status: providerContractReady ? "pass" : "fail",
        detail: providerContractReady
          ? `已检测到 ${providerContract.contractVersion}，本地 JSON store 和 PostgreSQL repository 复用统一 Provider 密钥加密/解密入口。`
          : "缺少统一 Secret Provider 合约；Provider 密钥加密逻辑可能继续分叉。",
      },
      {
        id: "secret-provider-runtime",
        title: "Secret Provider 运行适配器",
        status: provider === "local-app-secret" ? "fail" : managedRuntimeReady ? "pass" : "fail",
        detail:
          provider === "local-app-secret"
            ? "本地开发适配器可用，但不满足公开商用的托管密钥要求。"
            : managedRuntimeReady
              ? `运行适配器 ${providerContract.runtimeAdapter} 已就绪。`
              : `运行适配器 ${providerContract.runtimeAdapter} 不可用于生产；仅填写 KMS 或 secret store 标识不会通过。`,
      },
      {
        id: "rotation-policy",
        title: "密钥轮换",
        status: rotationPolicy ? "manual" : "fail",
        detail: rotationPolicy ? "已声明轮换策略，仍需实际轮换演练。" : "缺少密钥轮换周期和旧密钥解密兼容策略。",
      },
      {
        id: "tenant-isolation",
        title: "租户隔离",
        status: tenantScopedKeys ? "manual" : "fail",
        detail: tenantScopedKeys ? "已声明租户级密钥隔离策略。" : "缺少租户级密钥隔离或 envelope encryption 设计声明。",
      },
      {
        id: "audit-log",
        title: "审计日志",
        status: auditLog ? "pass" : "fail",
        detail: auditLog
          ? `持久审计路径、旧日志规范化、外部轮转和 durable outbox 均已就绪；outbox 待投递 0，容量上限 ${auditInfo.maxBytes} bytes。`
          : `持久审计未就绪（sink=${auditInfo.sinkStatus}，legacyMigration=${auditInfo.legacyMigrationStatus}，outbox=${auditOutboxStatus}，pending=${auditOutboxInfo?.pendingCount ?? "unknown"}）；本地开发 fallback 为 ${auditInfo.localAuditPath}。`,
      },
      {
        id: "deletion-proof",
        title: "删除证明",
        status: deletionProof ? "manual" : "fail",
        detail: deletionProof ? "已声明账号删除后 Provider 密钥和托管引用删除证据位置。" : "缺少账号删除后 Provider 密钥和托管引用删除证明。",
      },
      {
        id: "admin-access-policy",
        title: "管理员不可见策略",
        status: adminAccessPolicy ? "manual" : "fail",
        detail: adminAccessPolicy ? "已声明客服/管理员不能查看用户明文 Provider 密钥的策略。" : "缺少客服/管理员不能查看用户明文密钥的策略证明。",
      },
      {
        id: "local-secret-decision",
        title: "本地 secret 处置",
        status: localSecretDecision ? "manual" : localSecretExists ? "fail" : "manual",
        detail: localSecretDecision
          ? "已声明本地 .data/auth/local-secret 的轮换、隔离或销毁决策。"
          : "未声明本地 local-secret 生产切换前处置策略。",
      },
      {
        id: "decrypt-failure-audit",
        title: "解密失败审计",
        status: decryptFailureAudit ? "manual" : "fail",
        detail: decryptFailureAudit ? "已声明 Provider 密钥解密失败进入审计和告警。" : "缺少 Provider 密钥解密失败审计和告警策略。",
      },
      {
        id: "backup-recovery-policy",
        title: "备份恢复策略",
        status: backupRecoveryPolicy ? "manual" : "fail",
        detail: backupRecoveryPolicy ? "已声明 KMS/托管密钥备份恢复和灾备策略。" : "缺少 KMS/托管 secret store 的备份恢复策略。",
      },
      {
        id: "secret-runbook",
        title: "密钥管理 Runbook",
        status: runbook ? "pass" : "fail",
        detail: runbook ? "已检测到密钥管理迁移和轮换 runbook。" : "缺少密钥管理迁移和轮换 runbook。",
      },
      {
        id: "no-secret-return",
        title: "不可回显",
        status: "pass",
        detail: "现有账号 API 只返回 configuredSecrets 和 secretPreviews，不返回密钥原文。",
      },
    ],
    notes: [
      "诊断只输出配置存在性，不输出 KMS key、app secret、Provider secret 或密文。",
      "本地 v2 密文已经按用户和 Provider 作用域派生 Key；Vault v3 密文绑定 userId、providerId 和 secretName。",
      "Vault Transit 是当前唯一实现的托管运行适配器；KMS 标识和其他 secret store 声明会失败关闭，不会冒充生产就绪。",
      "进程重启后，productionReady 仍会重新读取 durable outbox；只要存在待投递、过期 lease、超时积压或 outbox 不可用，就会失败关闭。",
      "productionReady=true 需要 Vault Transit 运行适配器、runbook、轮换、审计、租户隔离、删除证明、管理员不可见、解密失败审计、备份恢复和本地 secret 处置声明；仍需要真实轮换、删除和审计演练。",
    ],
  };
}

function detectProvider(input: { kmsKey: string; managedSecretStore: string }): SecretProvider {
  if (input.kmsKey) return "kms";
  if (input.managedSecretStore) return "managed-secret-store";
  return "local-app-secret";
}

function getMissingConfig(input: {
  provider: SecretProvider;
  rotationPolicy: boolean;
  auditLog: boolean;
  tenantScopedKeys: boolean;
  deletionProof: boolean;
  adminAccessPolicy: boolean;
  localSecretDecision: boolean;
  decryptFailureAudit: boolean;
  backupRecoveryPolicy: boolean;
  runbook: boolean;
  localSecretExists: boolean;
  managedRuntimeReady: boolean;
  providerTransportSecure: boolean;
  runtimeAdapter: "local-aes-gcm" | "unsupported" | "vault-transit";
  auditOutboxReady: boolean;
}) {
  const missing: string[] = [];
  if (input.provider === "local-app-secret") missing.push("OWNMINUTES_KMS_KEY_ID or OWNMINUTES_SECRET_STORE");
  if (input.provider !== "local-app-secret" && !input.managedRuntimeReady) {
    missing.push(
      input.runtimeAdapter === "vault-transit"
        ? "OWNMINUTES_VAULT_ADDR, OWNMINUTES_VAULT_TRANSIT_KEY and OWNMINUTES_VAULT_TOKEN_FILE"
        : "implemented Secret Provider runtime adapter (OWNMINUTES_SECRET_STORE=vault-transit)",
    );
  }
  if (input.provider === "managed-secret-store" && !input.providerTransportSecure) {
    missing.push("OWNMINUTES_VAULT_ADDR with a credential-free HTTPS origin");
  }
  if (!input.rotationPolicy) missing.push("OWNMINUTES_SECRET_ROTATION_POLICY");
  if (!input.auditLog) missing.push("OWNMINUTES_SECRET_AUDIT_LOG");
  if (!input.auditOutboxReady) {
    missing.push("healthy durable secret audit outbox with no pending delivery");
  }
  if (!input.tenantScopedKeys) missing.push("OWNMINUTES_TENANT_SCOPED_KEYS");
  if (!input.deletionProof) missing.push("OWNMINUTES_SECRET_DELETION_PROOF");
  if (!input.adminAccessPolicy) missing.push("OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY");
  if (!input.localSecretDecision) missing.push("OWNMINUTES_SECRET_LOCAL_SECRET_DECISION");
  if (!input.decryptFailureAudit) missing.push("OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT");
  if (!input.backupRecoveryPolicy) missing.push("OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY");
  if (!input.runbook) missing.push("docs/secret-management-runbook.md");
  if (input.localSecretExists && !input.localSecretDecision) missing.push("rotate or isolate .data/auth/local-secret before production");
  return missing;
}

function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  return "";
}

function hasEnv(name: string) {
  return Boolean(process.env[name]);
}

function isSecureVaultAddress(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}
