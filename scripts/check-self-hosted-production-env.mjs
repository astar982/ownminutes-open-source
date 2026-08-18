#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const strict = process.argv.includes("--strict");
const domain = value("OWNMINUTES_DOMAIN");
const email = value("OWNMINUTES_TLS_EMAIL");
const releaseId = value("OWNMINUTES_RELEASE_ID");
const image = value("OWNMINUTES_IMAGE");
const adminEmail = value("OWNMINUTES_ADMIN_EMAIL");
const adminName = value("OWNMINUTES_ADMIN_NAME");
const legalOperatorName = value("OWNMINUTES_LEGAL_OPERATOR_NAME");
const legalOperatorAddress = value("OWNMINUTES_LEGAL_OPERATOR_ADDRESS");
const legalOperatorJurisdiction = value("OWNMINUTES_LEGAL_OPERATOR_JURISDICTION");
const noncurrentRetentionDays = Number(value("OWNMINUTES_NONCURRENT_RETENTION_DAYS"));
const transientRetentionDays = Number(value("OWNMINUTES_TRANSIENT_RETENTION_DAYS"));
const uploadRetentionDays = Number(value("OWNMINUTES_UPLOAD_RETENTION_DAYS"));
const transientCleanupIntervalSeconds = Number(value("OWNMINUTES_TRANSIENT_CLEANUP_INTERVAL_SECONDS"));
const secretAuditLog = value("OWNMINUTES_SECRET_AUDIT_LOG");
const secretAuditExternalRotation = value("OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION");
const secretAuditMaxBytes = Number(value("OWNMINUTES_SECRET_AUDIT_MAX_BYTES"));
const secretAuditRotationIntervalSeconds = Number(value("OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS"));
const secretAuditRotateBytes = Number(value("OWNMINUTES_SECRET_AUDIT_ROTATE_BYTES"));
const secretAuditRetentionDays = Number(value("OWNMINUTES_SECRET_AUDIT_RETENTION_DAYS"));
const currentCommit = process.env.OWNMINUTES_CURRENT_COMMIT?.trim() || "";
const worktreeClean = process.env.OWNMINUTES_WORKTREE_CLEAN === "1";
const allowDirtySmoke = process.env.OWNMINUTES_PRODUCTION_ALLOW_DIRTY_SMOKE === "1";

const secretSpecs = [
  ["OWNMINUTES_APP_SECRET_FILE", 43],
  ["OWNMINUTES_POSTGRES_PASSWORD_FILE", 32],
  ["OWNMINUTES_POSTGRES_MIGRATOR_PASSWORD_FILE", 32],
  ["OWNMINUTES_POSTGRES_APP_PASSWORD_FILE", 32],
  ["OWNMINUTES_MINIO_ROOT_USER_FILE", 16],
  ["OWNMINUTES_MINIO_ROOT_PASSWORD_FILE", 32],
  ["OWNMINUTES_S3_ACCESS_KEY_ID_FILE", 16],
  ["OWNMINUTES_S3_SECRET_ACCESS_KEY_FILE", 32],
  ["OWNMINUTES_S3_CLEANUP_ACCESS_KEY_ID_FILE", 16],
  ["OWNMINUTES_S3_CLEANUP_SECRET_ACCESS_KEY_FILE", 32],
  ["OWNMINUTES_ADMIN_PASSWORD_FILE", 16],
  ["OWNMINUTES_BACKUP_ENCRYPTION_KEY_FILE", 43],
];

const checks = [
  check("domain", isPublicHostname(domain), "Public hostname is configured.", "OWNMINUTES_DOMAIN must be a public hostname without scheme, port, path, wildcard, or placeholder."),
  check("tls-email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith("@example.com"), "TLS contact email is configured.", "OWNMINUTES_TLS_EMAIL must be a real operations email."),
  check("release-id", /^[a-f0-9]{40}$/.test(releaseId) && !/^0+$/.test(releaseId), "Immutable Git release id is configured.", "OWNMINUTES_RELEASE_ID must be the 40-character deployed Git commit."),
  check("release-match", !currentCommit || releaseId === currentCommit, "Release id matches the checked-out commit.", "OWNMINUTES_RELEASE_ID does not match the checked-out commit."),
  check(
    "worktree-clean",
    !currentCommit || worktreeClean || allowDirtySmoke,
    worktreeClean || !currentCommit ? "Deployment source worktree is clean." : "Dirty worktree is allowed only for this isolated smoke test.",
    "Commit or remove local changes before building a production release.",
  ),
  check("image", image.includes(releaseId.slice(0, 12)) && !image.endsWith(":latest"), "Image tag identifies the release commit.", "OWNMINUTES_IMAGE must contain the release short SHA and must not use latest."),
  check("admin-email", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail) && !adminEmail.endsWith("@example.com"), "Bootstrap administrator email is configured.", "OWNMINUTES_ADMIN_EMAIL must be a real administrator email."),
  check("admin-name", adminName.length >= 2 && adminName.length <= 80, "Bootstrap administrator name is configured.", "OWNMINUTES_ADMIN_NAME must contain 2-80 characters."),
  check("legal-operator-name", legalOperatorName.length >= 2 && legalOperatorName.length <= 160, "Legal operator name is configured.", "OWNMINUTES_LEGAL_OPERATOR_NAME must identify the real legal operator."),
  check("legal-operator-address", legalOperatorAddress.length >= 8 && legalOperatorAddress.length <= 300, "Legal operator address is configured.", "OWNMINUTES_LEGAL_OPERATOR_ADDRESS must contain the real service address."),
  check("legal-operator-jurisdiction", legalOperatorJurisdiction.length >= 2 && legalOperatorJurisdiction.length <= 120, "Legal jurisdiction is configured.", "OWNMINUTES_LEGAL_OPERATOR_JURISDICTION must identify the governing jurisdiction."),
  check(
    "noncurrent-retention",
    Number.isInteger(noncurrentRetentionDays) && noncurrentRetentionDays >= 1 && noncurrentRetentionDays <= 30,
    "Deleted and superseded object versions have a bounded recovery window.",
    "OWNMINUTES_NONCURRENT_RETENTION_DAYS must be between 1 and 30.",
  ),
  check("transient-retention", Number.isInteger(transientRetentionDays) && transientRetentionDays >= 1 && transientRetentionDays <= 30, "Transient ASR object retention is bounded.", "OWNMINUTES_TRANSIENT_RETENTION_DAYS must be an integer between 1 and 30."),
  check("upload-retention", Number.isInteger(uploadRetentionDays) && uploadRetentionDays >= 1 && uploadRetentionDays <= 14, "Incomplete upload retention is bounded.", "OWNMINUTES_UPLOAD_RETENTION_DAYS must be an integer between 1 and 14."),
  check("transient-cleanup-interval", Number.isInteger(transientCleanupIntervalSeconds) && transientCleanupIntervalSeconds >= 300 && transientCleanupIntervalSeconds <= 86400, "Transient object cleanup cadence is bounded.", "OWNMINUTES_TRANSIENT_CLEANUP_INTERVAL_SECONDS must be an integer between 300 and 86400."),
  check("secret-audit-path", secretAuditLog === "/app/.data/auth/secret-audit.jsonl", "Secret audit events use the mounted active-log path.", "OWNMINUTES_SECRET_AUDIT_LOG must be /app/.data/auth/secret-audit.jsonl."),
  check("secret-audit-external-rotation", secretAuditExternalRotation === "1", "The dedicated audit rotator is enabled.", "OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION must be 1 when the dedicated rotator service is enabled."),
  check("secret-audit-max-bytes", Number.isSafeInteger(secretAuditMaxBytes) && secretAuditMaxBytes >= 1024 * 1024 && secretAuditMaxBytes <= 2 * 1024 * 1024 * 1024, "Secret audit capacity guard is bounded.", "OWNMINUTES_SECRET_AUDIT_MAX_BYTES must be an integer between 1 MiB and 2 GiB."),
  check("secret-audit-rotation-interval", Number.isInteger(secretAuditRotationIntervalSeconds) && secretAuditRotationIntervalSeconds >= 60 && secretAuditRotationIntervalSeconds <= 86400, "Secret audit rotation cadence is bounded.", "OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS must be an integer between 60 and 86400."),
  check("secret-audit-rotate-bytes", Number.isSafeInteger(secretAuditRotateBytes) && secretAuditRotateBytes >= 1024 * 1024 && secretAuditRotateBytes < secretAuditMaxBytes, "Secret audit rotates before the active-log capacity guard.", "OWNMINUTES_SECRET_AUDIT_ROTATE_BYTES must be at least 1 MiB and lower than OWNMINUTES_SECRET_AUDIT_MAX_BYTES."),
  check("secret-audit-retention", Number.isInteger(secretAuditRetentionDays) && secretAuditRetentionDays >= 30 && secretAuditRetentionDays <= 2555, "Rotated secret audit archives have bounded retention.", "OWNMINUTES_SECRET_AUDIT_RETENTION_DAYS must be between 30 and 2555."),
  check("simulated-billing", value("OWNMINUTES_ENABLE_SIMULATED_BILLING") !== "1", "Simulated billing is disabled.", "OWNMINUTES_ENABLE_SIMULATED_BILLING must not be enabled in production."),
];

const secretValues = [];
for (const [name, minimumLength] of secretSpecs) {
  const path = value(name);
  let secret = "";
  let privateMode = false;
  let readable = false;
  try {
    const stats = statSync(path);
    readable = stats.isFile();
    privateMode = (stats.mode & 0o077) === 0;
    secret = readable ? readFileSync(path, "utf8").trim() : "";
  } catch {
    readable = false;
  }

  checks.push(check(`${name}:absolute`, isAbsolute(path), `${name} uses an absolute path.`, `${name} must use an absolute path.`));
  checks.push(check(`${name}:readable`, !strict || readable, `${name} is readable.`, `${name} does not point to a readable secret file.`));
  checks.push(check(`${name}:mode`, !strict || privateMode, `${name} is owner-only.`, `${name} must not be readable by group or other users.`));
  checks.push(check(`${name}:length`, !strict || secret.length >= minimumLength, `${name} has sufficient entropy length.`, `${name} is shorter than the required minimum.`));
  if (secret) secretValues.push(secret);
}

checks.push(
  check(
    "secret-uniqueness",
    !strict || new Set(secretValues).size === secretSpecs.length,
    "Every runtime credential uses a distinct value.",
    "Production credentials must not reuse the same value.",
  ),
);

const failures = checks.filter((item) => !item.ok);
const summary = {
  ok: failures.length === 0,
  strict,
  checks,
  failureIds: failures.map((item) => item.id),
  configured: {
    domain: domain || null,
    image: image || null,
    releaseId: releaseId ? releaseId.slice(0, 12) : null,
    noncurrentRetentionDays: Number.isFinite(noncurrentRetentionDays) ? noncurrentRetentionDays : null,
    transientRetentionDays: Number.isFinite(transientRetentionDays) ? transientRetentionDays : null,
    uploadRetentionDays: Number.isFinite(uploadRetentionDays) ? uploadRetentionDays : null,
    secretFileCount: secretSpecs.filter(([name]) => Boolean(value(name))).length,
    adminEmailConfigured: Boolean(adminEmail),
    legalOperatorConfigured: Boolean(legalOperatorName && legalOperatorAddress && legalOperatorJurisdiction),
  },
  leaksSecrets: false,
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;

function value(name) {
  return process.env[name]?.trim() || "";
}

function check(id, ok, passDetail, failDetail) {
  return { id, ok: Boolean(ok), detail: ok ? passDetail : failDetail };
}

function isPublicHostname(host) {
  if (!host || host.includes("://") || host.includes("/") || host.includes(":") || host.includes("*")) return false;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".example.com")) return false;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}
