import fs from "fs";
import path from "path";
import { getMeetingObjectStoreContract, getMeetingObjectStoreInfo, meetingObjectStoreContractVersion } from "@/lib/server/meeting-object-store";
import { getMeetingWriteCoordinatorInfo } from "@/lib/server/meeting-write-lock";
import { recordingUploadPartBytes } from "@/lib/server/recording-upload-protocol";
import { getRecordingUploadResourcePolicy } from "@/lib/server/recording-upload-resource-policy";

export type StorageProvider = "local" | "s3" | "r2" | "volcano-tos";
export type StorageCheckStatus = "pass" | "fail" | "manual";

export type StorageDiagnosticCheck = {
  id: string;
  title: string;
  status: StorageCheckStatus;
  detail: string;
};

export type StorageDiagnostics = {
  generatedAt: string;
  provider: StorageProvider;
  productionReady: boolean;
  localDataDir: string;
  localInventory: {
    meetingCount: number;
    manifestCount: number;
    totalBytes: number;
    hasLocalData: boolean;
  };
  recordingUploads: {
    assemblyMethod: "bounded-temp-file";
    maxActiveUploadsPerUser: number;
    maxStagedBytesPerUser: number;
    partBytes: number;
    staleAfterHours: number;
  };
  configured: {
    bucket: boolean;
    contract: boolean;
    endpoint: boolean;
    keyPrefix: boolean;
    accessKey: boolean;
    secretKey: boolean;
    lifecyclePolicy: boolean;
    deleteProof: boolean;
    costBudget: boolean;
    localInventoryDecision: boolean;
    privateAccess: boolean;
    minimumPrivilege: boolean;
    restoreReadProof: boolean;
    crossInstanceWriteLock: boolean;
    durableDeletionFence: boolean;
    runbook: boolean;
  };
  capabilities: {
    hasObjectStoreContract: boolean;
    hasObjectStoreAdapter: boolean;
    supportsBoundedFilePut: boolean;
    supportsPrivateAsrUrl: boolean;
    storesAudioObjects: boolean;
    supportsAccountDeletion: boolean;
    supportsLifecyclePolicy: boolean;
    enforcesPrivateAccess: boolean;
    supportsRestoreReadEvidence: boolean;
    usesLocalFilesystem: boolean;
    supportsCrossInstanceWrites: boolean;
    preventsDeletedMeetingRecreation: boolean;
  };
  missing: string[];
  checks: StorageDiagnosticCheck[];
  notes: string[];
};

const localMeetingsDir = path.join(process.cwd(), ".data", "meetings");
const storageRunbookPath = path.join(process.cwd(), "docs", "object-storage-runbook.md");

export function getStorageDiagnostics(): StorageDiagnostics {
  const provider = detectProvider();
  const config = getProviderConfig(provider);
  const objectStore = getMeetingObjectStoreInfo();
  const objectStoreContract = getMeetingObjectStoreContract();
  const writeCoordinator = getMeetingWriteCoordinatorInfo();
  const contractConfigured =
    objectStore.contractVersion === meetingObjectStoreContractVersion &&
    objectStoreContract.objectModel.manifest === "{{meetingId}}/manifest.json" &&
    objectStoreContract.objectModel.chunk === "{{meetingId}}/chunks/{{fileName}}" &&
    objectStoreContract.objectModel.asrInput === "{{meetingId}}/transient/asr/{{fileName}}" &&
    objectStoreContract.objectModel.result === "{{meetingId}}/result.json" &&
    objectStoreContract.objectModel.obsidianMarkdown === "{{meetingId}}/obsidian.md" &&
    objectStoreContract.objectModel.processing === "{{meetingId}}/processing.json" &&
    objectStoreContract.operations.includes("putFile") &&
    objectStoreContract.operations.includes("getFile") &&
    objectStoreContract.operations.includes("createPresignedGetUrl") &&
    objectStoreContract.operations.includes("deletePrefix") &&
    objectStoreContract.providers.includes("volcano-tos");
  const objectStorageConfigured = Boolean(config.bucket && config.endpoint && config.accessKey && config.secretKey && config.keyPrefix);
  const lifecyclePolicy = hasEnv("OWNMINUTES_STORAGE_LIFECYCLE_POLICY");
  const deleteProof = hasEnv("OWNMINUTES_STORAGE_DELETE_PROOF");
  const costBudget = hasEnv("OWNMINUTES_STORAGE_COST_BUDGET");
  const localInventoryDecision = hasEnv("OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION");
  const privateAccess = process.env.OWNMINUTES_STORAGE_PRIVATE_ACCESS === "1";
  const minimumPrivilege = hasEnv("OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE");
  const restoreReadProof = hasEnv("OWNMINUTES_STORAGE_RESTORE_READ_PROOF");
  const productionReady =
    provider !== "local" &&
    objectStorageConfigured &&
    lifecyclePolicy &&
    deleteProof &&
    costBudget &&
    localInventoryDecision &&
    privateAccess &&
    minimumPrivilege &&
    restoreReadProof &&
    writeCoordinator.crossInstance &&
    writeCoordinator.durableDeletionFence;
  const missing = getMissingConfig(provider, config);
  if (!writeCoordinator.crossInstance) missing.push("PostgreSQL cross-instance meeting write lock");
  if (!writeCoordinator.durableDeletionFence) missing.push("durable meeting deletion fence");
  const localInventory = getLocalMeetingInventory();
  const recordingUploadPolicy = getRecordingUploadResourcePolicy();

  return {
    generatedAt: new Date().toISOString(),
    provider,
    productionReady,
    localDataDir: ".data/meetings",
    localInventory,
    recordingUploads: {
      assemblyMethod: "bounded-temp-file",
      maxActiveUploadsPerUser: recordingUploadPolicy.maxActiveUploadsPerUser,
      maxStagedBytesPerUser: recordingUploadPolicy.maxStagedBytesPerUser,
      partBytes: recordingUploadPartBytes,
      staleAfterHours: recordingUploadPolicy.staleAfterMs / 60 / 60 / 1000,
    },
    configured: {
      bucket: Boolean(config.bucket),
      contract: contractConfigured,
      endpoint: Boolean(config.endpoint),
      keyPrefix: Boolean(config.keyPrefix),
      accessKey: Boolean(config.accessKey),
      secretKey: Boolean(config.secretKey),
      lifecyclePolicy,
      deleteProof,
      costBudget,
      localInventoryDecision,
      privateAccess,
      minimumPrivilege,
      restoreReadProof,
      crossInstanceWriteLock: writeCoordinator.crossInstance,
      durableDeletionFence: writeCoordinator.durableDeletionFence,
      runbook: fs.existsSync(storageRunbookPath),
    },
    capabilities: {
      hasObjectStoreContract: contractConfigured,
      hasObjectStoreAdapter: objectStore.supportsDeletePrefix && objectStore.supportsTopLevelPrefixListing,
      supportsBoundedFilePut: objectStore.supportsFilePut,
      supportsPrivateAsrUrl: objectStore.supportsPresignedGet,
      storesAudioObjects: productionReady,
      supportsAccountDeletion: productionReady,
      supportsLifecyclePolicy: productionReady && lifecyclePolicy,
      enforcesPrivateAccess: productionReady && privateAccess,
      supportsRestoreReadEvidence: productionReady && restoreReadProof,
      usesLocalFilesystem: provider === "local",
      supportsCrossInstanceWrites: writeCoordinator.crossInstance,
      preventsDeletedMeetingRecreation: writeCoordinator.durableDeletionFence,
    },
    missing,
    checks: [
      {
        id: "storage-key-prefix",
        title: "对象命名空间",
        status: config.keyPrefix ? "pass" : "fail",
        detail: config.keyPrefix ? "远程对象使用独立 namespace 前缀，验收和正式环境可隔离。" : "缺少 OWNMINUTES_STORAGE_PREFIX；远程对象会直接写入 bucket 根命名空间。",
      },
      {
        id: "object-store-contract",
        title: "对象存储合约",
        status: contractConfigured ? "pass" : "fail",
        detail: contractConfigured
          ? `${objectStoreContract.version} 已声明，并固定对象 key、文件流读写与私有 ASR URL 能力。`
          : "缺少对象存储合约版本、对象模型或必要操作声明。",
      },
      {
        id: "object-store-adapter",
        title: "对象存储适配层",
        status: objectStore.supportsDeletePrefix && objectStore.supportsTopLevelPrefixListing ? "pass" : "fail",
        detail: `会议读写已通过 ${objectStore.provider} object store adapter；文件流 PUT=${objectStore.supportsFilePut}，私有 ASR URL=${objectStore.supportsPresignedGet}，当前 root=${objectStore.localRoot}。`,
      },
      {
        id: "recording-upload-staging",
        title: "完整录音暂存保护",
        status: "pass",
        detail: `完整录音按 ${recordingUploadPartBytes} bytes 分片并通过 bounded-temp-file 顺序组装；每账号最多 ${recordingUploadPolicy.maxActiveUploadsPerUser} 个活动上传、${recordingUploadPolicy.maxStagedBytesPerUser} bytes 暂存，${recordingUploadPolicy.staleAfterMs / 60 / 60 / 1000} 小时无进展后由状态/上传请求机会性回收，生产 bucket 仍需 lifecycle 兜底。`,
      },
      {
        id: "cross-instance-write-lock",
        title: "跨实例会议写入锁",
        status: writeCoordinator.crossInstance ? "pass" : "fail",
        detail: writeCoordinator.crossInstance
          ? `会议 manifest 与结果写入使用 ${writeCoordinator.mode}，锁等待上限 ${writeCoordinator.lockTimeoutMs}ms。`
          : "当前仅有单进程写入队列；多 App 实例并发上传可能覆盖 manifest。",
      },
      {
        id: "durable-deletion-fence",
        title: "会议删除防复活",
        status: writeCoordinator.durableDeletionFence ? "pass" : "fail",
        detail: writeCoordinator.durableDeletionFence
          ? "删除会议会写入 PostgreSQL tombstone，延迟到达的分片和会后结果不能重新创建对象。"
          : "当前删除标记不跨进程持久化；生产环境需要 PostgreSQL deletion tombstone。",
      },
      {
        id: "provider-configured",
        title: "对象存储 Provider",
        status: provider === "local" ? "fail" : "pass",
        detail: provider === "local" ? "当前仍使用本地 .data/meetings 保存会议音频。" : `已检测到 ${provider} 配置入口。`,
      },
      {
        id: "credentials-present",
        title: "访问凭证",
        status: objectStorageConfigured ? "pass" : "fail",
        detail: objectStorageConfigured ? "已检测到对象存储 bucket、endpoint、access key 和 secret key。" : `缺少：${missing.join(", ") || "对象存储配置"}`,
      },
      {
        id: "local-fallback-visible",
        title: "本地落盘状态",
        status: provider === "local" ? "manual" : "pass",
        detail: localInventory.hasLocalData
          ? `本地检测到 ${localInventory.meetingCount} 场会议、${localInventory.manifestCount} 个 manifest、${localInventory.totalBytes} bytes，生产迁移前必须迁移或清理。`
          : "当前没有检测到本地会议目录。",
      },
      {
        id: "local-migration-inventory",
        title: "本地迁移库存",
        status: localInventory.hasLocalData ? "manual" : "pass",
        detail: localInventory.hasLocalData
          ? "切换远程对象存储前，先导出或确认这些本地会议对象不需要迁移。"
          : "没有待迁移的本地会议对象。",
      },
      {
        id: "storage-runbook",
        title: "对象存储 Runbook",
        status: fs.existsSync(storageRunbookPath) ? "pass" : "fail",
        detail: fs.existsSync(storageRunbookPath) ? "已检测到对象存储迁移和验收 runbook。" : "缺少对象存储迁移和验收 runbook。",
      },
      {
        id: "delete-contract",
        title: "删除一致性",
        status: deleteProof ? "manual" : "fail",
        detail: deleteProof ? "已声明会议删除和账号删除对象清理证据位置，仍需真实对象验证。" : "缺少会议删除和账号删除同步清理对象的证据。",
      },
      {
        id: "lifecycle-policy",
        title: "生命周期策略",
        status: lifecyclePolicy ? "manual" : "fail",
        detail: lifecyclePolicy ? "已声明生命周期策略，仍需云端策略截图或 API 验证。" : "缺少音频保留周期、冷存储和自动清理策略声明。",
      },
      {
        id: "private-access",
        title: "私有访问策略",
        status: privateAccess ? "manual" : "fail",
        detail: privateAccess ? "已声明 bucket 禁止公共访问，仍需云端策略截图或 API 验证。" : "缺少 bucket 私有访问和禁止公开 listing 的证明。",
      },
      {
        id: "minimum-privilege",
        title: "最小权限账号",
        status: minimumPrivilege ? "manual" : "fail",
        detail: minimumPrivilege ? "已声明最小权限 app key，仍需验证只允许目标 bucket/prefix 的读写删。" : "缺少对象存储最小权限账号声明。",
      },
      {
        id: "restore-read-proof",
        title: "恢复读取证明",
        status: restoreReadProof ? "manual" : "fail",
        detail: restoreReadProof ? "已声明从已存对象恢复读取的证据位置，仍需真实 provider 验证。" : "缺少从远程对象恢复读取录音/纪要的证明。",
      },
      {
        id: "cost-budget",
        title: "成本预算",
        status: costBudget ? "manual" : "fail",
        detail: costBudget ? "已声明典型月度音频容量和请求成本预算。" : "缺少典型会议时长下的容量、请求量和成本预算。",
      },
    ],
    notes: [
      "诊断只输出配置存在性，不输出任何密钥原文。",
      "会议音频、manifest、纪要 JSON 和 Obsidian Markdown 已通过对象存储适配层读写；当前 provider 仍是本地文件。",
      "productionReady=true 还要求 PostgreSQL 跨实例会议写锁和持久删除 tombstone，避免并发分片覆盖或删除后对象复活。",
      "远程 provider、生命周期、删除证明、私有访问、最小权限、恢复读取、本地库存处置和成本预算仍需要真实云端证据。",
    ],
  };
}

function getLocalMeetingInventory() {
  if (!fs.existsSync(localMeetingsDir)) {
    return {
      meetingCount: 0,
      manifestCount: 0,
      totalBytes: 0,
      hasLocalData: false,
    };
  }

  const meetingDirs = fs
    .readdirSync(localMeetingsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  let manifestCount = 0;
  let totalBytes = 0;

  for (const meetingDir of meetingDirs) {
    const manifestPath = path.join(localMeetingsDir, meetingDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    manifestCount += 1;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { totalBytes?: number };
      totalBytes += Number(manifest.totalBytes || 0);
    } catch {
      // Keep diagnostics best-effort; malformed manifests are surfaced by manifestCount without crashing readiness.
    }
  }

  return {
    meetingCount: meetingDirs.length,
    manifestCount,
    totalBytes,
    hasLocalData: meetingDirs.length > 0 || manifestCount > 0 || totalBytes > 0,
  };
}

function detectProvider(): StorageProvider {
  if (hasAnyEnv(["VOLCANO_TOS_BUCKET", "TOS_BUCKET", "VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"])) return "volcano-tos";
  if (hasAnyEnv(["R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])) return "r2";
  if (hasAnyEnv(["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])) return "s3";
  return "local";
}

function getProviderConfig(provider: StorageProvider) {
  if (provider === "volcano-tos") {
    return {
      bucket: getEnv("VOLCANO_TOS_BUCKET", "TOS_BUCKET"),
      endpoint: getEnv("VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"),
      accessKey: getEnv("VOLCANO_TOS_ACCESS_KEY_ID", "TOS_ACCESS_KEY_ID", "VOLCANO_ACCESS_KEY_ID"),
      secretKey: getEnv("VOLCANO_TOS_SECRET_ACCESS_KEY", "TOS_SECRET_ACCESS_KEY", "VOLCANO_SECRET_ACCESS_KEY"),
      keyPrefix: getEnv("OWNMINUTES_STORAGE_PREFIX"),
    };
  }

  if (provider === "r2") {
    return {
      bucket: getEnv("R2_BUCKET"),
      endpoint: getEnv("R2_ENDPOINT"),
      accessKey: getEnv("R2_ACCESS_KEY_ID"),
      secretKey: getEnv("R2_SECRET_ACCESS_KEY"),
      keyPrefix: getEnv("OWNMINUTES_STORAGE_PREFIX"),
    };
  }

  if (provider === "s3") {
    return {
      bucket: getEnv("S3_BUCKET"),
      endpoint: getEnv("S3_ENDPOINT"),
      accessKey: getEnv("S3_ACCESS_KEY_ID"),
      secretKey: getEnv("S3_SECRET_ACCESS_KEY"),
      keyPrefix: getEnv("OWNMINUTES_STORAGE_PREFIX"),
    };
  }

  return {
    bucket: "",
    endpoint: "",
    accessKey: "",
    secretKey: "",
    keyPrefix: "",
  };
}

function getMissingConfig(provider: StorageProvider, config: ReturnType<typeof getProviderConfig>) {
  if (provider === "local") {
    return [
      "S3/R2/火山 TOS bucket",
      "对象存储 endpoint",
      "对象存储 access key",
      "对象存储 secret key",
      "OWNMINUTES_STORAGE_PREFIX",
      "OWNMINUTES_STORAGE_LIFECYCLE_POLICY",
      "OWNMINUTES_STORAGE_DELETE_PROOF",
      "OWNMINUTES_STORAGE_COST_BUDGET",
      "OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION",
      "OWNMINUTES_STORAGE_PRIVATE_ACCESS=1",
      "OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE",
      "OWNMINUTES_STORAGE_RESTORE_READ_PROOF",
    ];
  }

  const missing: string[] = [];
  if (!config.bucket) missing.push(`${provider} bucket`);
  if (!config.endpoint) missing.push(`${provider} endpoint`);
  if (!config.accessKey) missing.push(`${provider} access key`);
  if (!config.secretKey) missing.push(`${provider} secret key`);
  if (!config.keyPrefix) missing.push("OWNMINUTES_STORAGE_PREFIX");
  if (!hasEnv("OWNMINUTES_STORAGE_LIFECYCLE_POLICY")) missing.push("OWNMINUTES_STORAGE_LIFECYCLE_POLICY");
  if (!hasEnv("OWNMINUTES_STORAGE_DELETE_PROOF")) missing.push("OWNMINUTES_STORAGE_DELETE_PROOF");
  if (!hasEnv("OWNMINUTES_STORAGE_COST_BUDGET")) missing.push("OWNMINUTES_STORAGE_COST_BUDGET");
  if (!hasEnv("OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION")) missing.push("OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION");
  if (process.env.OWNMINUTES_STORAGE_PRIVATE_ACCESS !== "1") missing.push("OWNMINUTES_STORAGE_PRIVATE_ACCESS=1");
  if (!hasEnv("OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE")) missing.push("OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE");
  if (!hasEnv("OWNMINUTES_STORAGE_RESTORE_READ_PROOF")) missing.push("OWNMINUTES_STORAGE_RESTORE_READ_PROOF");
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

function hasAnyEnv(names: string[]) {
  return names.some((name) => hasEnv(name));
}
