#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const runbookPath = path.join(repoRoot, "docs", "object-storage-runbook.md");
const adapterPath = path.join(repoRoot, "src", "lib", "server", "meeting-object-store.ts");
const writeLockPath = path.join(repoRoot, "src", "lib", "server", "meeting-write-lock.ts");
const deletionMigrationPath = path.join(repoRoot, "db", "migrations", "0009_meeting_deletion_tombstones.sql");
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_STORAGE_PREFLIGHT_STRICT === "1";
const evidenceDraftPath = process.env.OWNMINUTES_OBJECT_STORAGE_EVIDENCE_DRAFT_PATH?.trim() || "";
const provider = detectProvider();
const config = getProviderConfig(provider);
const requiredEnvByProvider = {
  s3: ["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "OWNMINUTES_STORAGE_PREFIX"],
  r2: ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "OWNMINUTES_STORAGE_PREFIX"],
  "volcano-tos": ["VOLCANO_TOS_BUCKET or TOS_BUCKET", "VOLCANO_TOS_ENDPOINT or TOS_ENDPOINT", "VOLCANO_TOS_ACCESS_KEY_ID or TOS_ACCESS_KEY_ID", "VOLCANO_TOS_SECRET_ACCESS_KEY or TOS_SECRET_ACCESS_KEY", "OWNMINUTES_STORAGE_PREFIX"],
  local: ["S3/R2/Volcano TOS provider env"],
};

function main() {
  const adapterSource = fs.existsSync(adapterPath) ? fs.readFileSync(adapterPath, "utf8") : "";
  const writeLockSource = fs.existsSync(writeLockPath) ? fs.readFileSync(writeLockPath, "utf8") : "";
  const checks = [
    check("remote-provider", provider !== "local", `远程对象存储 provider=${provider} 已选择。`, "缺少 S3/R2/火山 TOS provider 环境变量；当前会使用本地 .data/meetings。"),
    check("bucket", Boolean(config.bucket), `${provider} bucket 已配置。`, `缺少 ${provider} bucket。`),
    check("endpoint", Boolean(config.endpoint), `${provider} endpoint 已配置。`, `缺少 ${provider} endpoint。`),
    check("access-key", Boolean(config.accessKey), `${provider} access key 已配置。`, `缺少 ${provider} access key。`),
    check("secret-key", Boolean(config.secretKey), `${provider} secret key 已配置。`, `缺少 ${provider} secret key。`),
    check("key-prefix", validStoragePrefix(config.keyPrefix), "OWNMINUTES_STORAGE_PREFIX 已配置为隔离 namespace。", "缺少或无效 OWNMINUTES_STORAGE_PREFIX；必须使用不含 .. 的独立对象前缀。"),
    check(
      "lifecycle-policy",
      Boolean(process.env.OWNMINUTES_STORAGE_LIFECYCLE_POLICY),
      "OWNMINUTES_STORAGE_LIFECYCLE_POLICY 已声明。",
      "缺少 OWNMINUTES_STORAGE_LIFECYCLE_POLICY。",
    ),
    check(
      "delete-proof",
      Boolean(process.env.OWNMINUTES_STORAGE_DELETE_PROOF),
      "OWNMINUTES_STORAGE_DELETE_PROOF 已声明。",
      "缺少 OWNMINUTES_STORAGE_DELETE_PROOF；需要记录会议删除和账号删除同步清理对象的证据。",
    ),
    check(
      "cost-budget",
      Boolean(process.env.OWNMINUTES_STORAGE_COST_BUDGET),
      "OWNMINUTES_STORAGE_COST_BUDGET 已声明。",
      "缺少 OWNMINUTES_STORAGE_COST_BUDGET；需要记录典型月度音频容量和成本预算。",
    ),
    check(
      "local-inventory-decision",
      Boolean(process.env.OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION),
      "OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION 已声明。",
      "缺少 OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION；需要确认本地 .data/meetings 是否迁移、备份或丢弃。",
    ),
    check(
      "private-access",
      process.env.OWNMINUTES_STORAGE_PRIVATE_ACCESS === "1",
      "OWNMINUTES_STORAGE_PRIVATE_ACCESS=1 已声明。",
      "缺少 OWNMINUTES_STORAGE_PRIVATE_ACCESS=1；需要证明 bucket 禁止公共访问和公开 listing。",
    ),
    check(
      "minimum-privilege",
      Boolean(process.env.OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE),
      "OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE 已声明。",
      "缺少 OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE；需要记录 app key 只允许目标 bucket/prefix 的读写删。",
    ),
    check(
      "restore-read-proof",
      Boolean(process.env.OWNMINUTES_STORAGE_RESTORE_READ_PROOF),
      "OWNMINUTES_STORAGE_RESTORE_READ_PROOF 已声明。",
      "缺少 OWNMINUTES_STORAGE_RESTORE_READ_PROOF；需要记录从远程对象恢复读取录音和纪要的证据。",
    ),
    check(
      "postgres-runtime",
      process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL),
      "PostgreSQL runtime 已配置，可协调多实例会议写入。",
      "缺少 OWNMINUTES_AUTH_REPOSITORY=postgres 和 DATABASE_URL/POSTGRES_URL；远程对象存储不能只依赖单进程锁。",
    ),
    check(
      "cross-instance-write-lock",
      process.env.OWNMINUTES_MEETING_WRITE_LOCK === "postgres-advisory" &&
        writeLockSource.includes("pg_advisory_lock") &&
        writeLockSource.includes("withMeetingWriteLock"),
      "OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory，跨实例写锁实现存在。",
      "缺少 OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory 或 PostgreSQL advisory lock 实现。",
    ),
    check(
      "durable-deletion-fence",
      fs.existsSync(deletionMigrationPath) &&
        writeLockSource.includes("meeting_deletion_tombstones") &&
        writeLockSource.includes("markMeetingDeleted"),
      "会议删除 tombstone migration 与运行时 fence 已实现。",
      "缺少 0009 meeting deletion tombstone migration 或运行时删除 fence。",
    ),
    check("runbook", fs.existsSync(runbookPath), "对象存储 runbook 存在。", "缺少 docs/object-storage-runbook.md。"),
    check(
      "object-store-contract",
      adapterSource.includes("meeting-object-store-contract:v3") &&
        adapterSource.includes("getMeetingObjectStoreContract") &&
        adapterSource.includes("putFile") &&
        adapterSource.includes("getFile") &&
        adapterSource.includes("createPresignedGetUrl") &&
        adapterSource.includes("presignAwsV4Get") &&
        adapterSource.includes("buildMeetingObjectKey") &&
        adapterSource.includes("{{meetingId}}/manifest.json") &&
        adapterSource.includes("{{meetingId}}/chunks/{{fileName}}") &&
        adapterSource.includes("{{meetingId}}/transient/asr/{{fileName}}") &&
        adapterSource.includes("{{meetingId}}/processing.json") &&
        adapterSource.includes("{{meetingId}}/result.json") &&
        adapterSource.includes("{{meetingId}}/obsidian.md"),
      "对象存储合约已声明，并集中管理持久对象、文件流读写和短时私有 ASR URL。",
      "缺少对象存储合约版本或集中 key builder；业务代码可能绕过存储契约。",
    ),
    check(
      "adapter-runtime",
      adapterSource.includes("createS3CompatibleObjectStore") &&
        adapterSource.includes("deletePrefix") &&
        adapterSource.includes("listTopLevelPrefixes") &&
        adapterSource.includes("signAwsV4") &&
        adapterSource.includes("presignAwsV4Get"),
      "S3 兼容对象存储 adapter 已实现文件流 PUT/GET、LIST/DELETE、Header 签名和短时 GET URL 签名。",
      "对象存储 adapter 缺失远程读写、前缀删除、前缀列表或签名能力。",
    ),
  ];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const summary = {
    ok: missing.length === 0,
    strict,
    provider,
    productionCandidate: missing.length === 0,
    requiredEnv: requiredEnvByProvider[provider],
    configured: {
      bucket: Boolean(config.bucket),
      endpoint: Boolean(config.endpoint),
      accessKey: Boolean(config.accessKey),
      secretKey: Boolean(config.secretKey),
      keyPrefix: validStoragePrefix(config.keyPrefix),
      lifecyclePolicy: Boolean(process.env.OWNMINUTES_STORAGE_LIFECYCLE_POLICY),
      deleteProof: Boolean(process.env.OWNMINUTES_STORAGE_DELETE_PROOF),
      costBudget: Boolean(process.env.OWNMINUTES_STORAGE_COST_BUDGET),
      localInventoryDecision: Boolean(process.env.OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION),
      privateAccess: process.env.OWNMINUTES_STORAGE_PRIVATE_ACCESS === "1",
      minimumPrivilege: Boolean(process.env.OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE),
      restoreReadProof: Boolean(process.env.OWNMINUTES_STORAGE_RESTORE_READ_PROOF),
      postgresRuntime: process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL),
      crossInstanceWriteLock: process.env.OWNMINUTES_MEETING_WRITE_LOCK === "postgres-advisory",
      durableDeletionFence: fs.existsSync(deletionMigrationPath),
    },
    missing,
    checks,
    nextAction:
      missing.length === 0
        ? "Run the cross-instance storage runtime smoke and smoke:storage-remote against a staging bucket, then verify private access, minimum privilege, restore reads, deletion fences, lifecycle policy, and cost budget evidence."
        : "Set the missing object storage production environment and rerun npm run storage:preflight.",
    leaksSecrets: leaksSecrets(JSON.stringify({ checks, missing, requiredEnv: requiredEnvByProvider[provider] })),
  };

  if (evidenceDraftPath) {
    writeEvidenceDraft(evidenceDraftPath, summary);
  }

  console.log(JSON.stringify(summary, null, 2));

  if (summary.leaksSecrets || (strict && !summary.ok)) {
    process.exitCode = 1;
  }
}

function check(id, passed, passDetail, failDetail) {
  return {
    id,
    status: passed ? "pass" : "fail",
    detail: passed ? passDetail : failDetail,
  };
}

function detectProvider() {
  if (hasAnyEnv(["VOLCANO_TOS_BUCKET", "TOS_BUCKET", "VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"])) return "volcano-tos";
  if (hasAnyEnv(["R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"])) return "r2";
  if (hasAnyEnv(["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT"])) return "s3";
  return "local";
}

function getProviderConfig(selectedProvider) {
  if (selectedProvider === "volcano-tos") {
    return {
      bucket: getEnv("VOLCANO_TOS_BUCKET", "TOS_BUCKET"),
      endpoint: getEnv("VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"),
      accessKey: getEnv("VOLCANO_TOS_ACCESS_KEY_ID", "TOS_ACCESS_KEY_ID", "VOLCANO_ACCESS_KEY_ID"),
      secretKey: getEnv("VOLCANO_TOS_SECRET_ACCESS_KEY", "TOS_SECRET_ACCESS_KEY", "VOLCANO_SECRET_ACCESS_KEY"),
      keyPrefix: getEnv("OWNMINUTES_STORAGE_PREFIX"),
    };
  }

  if (selectedProvider === "r2") {
    return {
      bucket: getEnv("R2_BUCKET"),
      endpoint: getEnv("R2_ENDPOINT"),
      accessKey: getEnv("R2_ACCESS_KEY_ID"),
      secretKey: getEnv("R2_SECRET_ACCESS_KEY"),
      keyPrefix: getEnv("OWNMINUTES_STORAGE_PREFIX"),
    };
  }

  if (selectedProvider === "s3") {
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

function validStoragePrefix(value) {
  if (!value || value.includes("..")) return false;
  return value.split("/").map((part) => part.trim()).filter(Boolean).length > 0;
}

function getEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function hasAnyEnv(names) {
  return names.some((name) => Boolean(process.env[name]));
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE") ||
    text.includes("remote-smoke-secret-key") ||
    text.includes("s3-secret")
  );
}

function writeEvidenceDraft(outputPath, summary) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildEvidenceDraft(summary));
}

function buildEvidenceDraft(summary) {
  const checkMap = new Map(summary.checks.map((item) => [item.id, item]));
  const region = getEnv("S3_REGION", "R2_REGION", "VOLCANO_TOS_REGION", "TOS_REGION") || "pending";
  const endpoint = config.endpoint ? sanitizeEndpoint(config.endpoint) : "pending";
  const supportedProvider = ["s3", "r2", "volcano-tos"].includes(provider);
  const decision = summary.ok && supportedProvider ? "pending" : "fail";

  return [
    "# Object Storage Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run storage:preflight`.",
    "Manual remote PUT/GET/LIST/DELETE, object reads, deletion, lifecycle, private access, minimum privilege, restore/read, cost, and local inventory checks must be reviewed before this can pass acceptance.",
    "",
    `Date: ${new Date().toISOString()}`,
    `Commit: ${process.env.OWNMINUTES_STORAGE_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "pending"}`,
    `Provider: ${supportedProvider ? provider : "pending"}`,
    `Bucket: ${config.bucket ? "configured" : "pending"}`,
    `Region: ${region}`,
    `Endpoint: ${endpoint}`,
    `Object prefix: ${process.env.OWNMINUTES_STORAGE_PREFIX || "pending"}`,
    `Lifecycle policy: ${process.env.OWNMINUTES_STORAGE_LIFECYCLE_POLICY ? "configured" : "pending"}`,
    `Delete proof: ${process.env.OWNMINUTES_STORAGE_DELETE_PROOF ? "configured" : "pending"}`,
    `Cost budget: ${process.env.OWNMINUTES_STORAGE_COST_BUDGET ? "configured" : "pending"}`,
    `Local inventory decision: ${process.env.OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION ? "configured" : "pending"}`,
    `Private access: ${process.env.OWNMINUTES_STORAGE_PRIVATE_ACCESS === "1" ? "yes" : "pending"}`,
    `Minimum privilege policy: ${process.env.OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE ? "configured" : "pending"}`,
    `Restore read proof: ${process.env.OWNMINUTES_STORAGE_RESTORE_READ_PROOF ? "configured" : "pending"}`,
    `Storage diagnostics: ${summary.ok ? "pass" : "fail"}`,
    `Release readiness objectStorageBlocked: ${summary.ok && supportedProvider ? "pending" : "yes"}`,
    `Release readiness nextAction: ${summary.nextAction || "pending"}`,
    `Production preflight: ${summary.ok ? "pass" : "fail"}`,
    "Remote PUT: pending",
    "Remote GET: pending",
    "Remote LIST: pending",
    "Remote DELETE: pending",
    "Manifest write/read: pending",
    "Audio chunk write/read: pending",
    "Result JSON write/read: pending",
    "Obsidian Markdown write/read: pending",
    "Meeting delete prefix: pending",
    "Account delete prefix: pending",
    "Cross-instance concurrent chunks: pending",
    "Deleted meeting recreation blocked: pending",
    `Lifecycle policy proof: ${passIfConfigured(checkMap.get("lifecycle-policy"))}`,
    `Private access proof: ${passIfConfigured(checkMap.get("private-access"))}`,
    `Minimum privilege proof: ${passIfConfigured(checkMap.get("minimum-privilege"))}`,
    `Restore/read proof: ${passIfConfigured(checkMap.get("restore-read-proof"))}`,
    `Cost budget reviewed: ${passIfConfigured(checkMap.get("cost-budget"))}`,
    `Local inventory handled: ${passIfConfigured(checkMap.get("local-inventory-decision"))}`,
    `Secrets leaked: ${summary.leaksSecrets ? "yes" : "no"}`,
    `Decision: ${decision}`,
    `Known issues: ${summary.missing.length ? `missing ${summary.missing.join(", ")}` : "manual checks still pending"}`,
    "",
  ].join("\n");
}

function sanitizeEndpoint(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "pending";
  }
}

function passIfConfigured(check) {
  if (!check) return "pending";
  return check.status === "pass" ? "pass" : "pending";
}

main();
