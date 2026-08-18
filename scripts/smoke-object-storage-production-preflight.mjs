#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const commonEvidenceEnv = {
  DATABASE_URL: "postgresql://storage-smoke.invalid/ownminutes",
  OWNMINUTES_AUTH_REPOSITORY: "postgres",
  OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
  OWNMINUTES_STORAGE_LIFECYCLE_POLICY: "90 day hot storage, archive after 90 days, delete after account deletion",
  OWNMINUTES_STORAGE_DELETE_PROOF: "delete meeting prefix and account prefixes verified by smoke:storage-remote",
  OWNMINUTES_STORAGE_COST_BUDGET: "1000 meeting hours per month budget estimate documented",
  OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION: "local .data/meetings inventory reviewed before cutover",
  OWNMINUTES_STORAGE_PRIVATE_ACCESS: "1",
  OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE: "app key limited to ownminutes-prod meeting object prefix read/write/delete/list",
  OWNMINUTES_STORAGE_RESTORE_READ_PROOF: "restored stored manifest/result/audio from staging bucket on 2026-07-04",
  OWNMINUTES_STORAGE_PREFIX: "ownminutes/meetings",
};

const cases = [
  {
    name: "complete-without-prefix",
    expectOk: false,
    env: {
      S3_BUCKET: "ownminutes-prod",
      S3_ENDPOINT: "https://s3.example.invalid",
      S3_ACCESS_KEY_ID: "s3-access",
      S3_SECRET_ACCESS_KEY: "redacted-s3-secret",
      ...commonEvidenceEnv,
      OWNMINUTES_STORAGE_PREFIX: "",
    },
    expectedProvider: "s3",
  },
  {
    name: "missing-env",
    expectOk: false,
    env: {},
    expectedProvider: "local",
  },
  {
    name: "bucket-only",
    expectOk: false,
    env: {
      S3_BUCKET: "ownminutes-prod",
    },
    expectedProvider: "s3",
  },
  {
    name: "complete-s3",
    expectOk: true,
    env: {
      S3_BUCKET: "ownminutes-prod",
      S3_ENDPOINT: "https://s3.example.invalid",
      S3_ACCESS_KEY_ID: "s3-access",
      S3_SECRET_ACCESS_KEY: "redacted-s3-secret",
      S3_REGION: "us-east-1",
      ...commonEvidenceEnv,
    },
    expectedProvider: "s3",
  },
  {
    name: "complete-r2",
    expectOk: true,
    env: {
      R2_BUCKET: "ownminutes-prod",
      R2_ENDPOINT: "https://r2.example.invalid",
      R2_ACCESS_KEY_ID: "r2-access",
      R2_SECRET_ACCESS_KEY: "redacted-r2-secret",
      R2_REGION: "auto",
      ...commonEvidenceEnv,
    },
    expectedProvider: "r2",
  },
  {
    name: "complete-volcano-tos",
    expectOk: true,
    env: {
      VOLCANO_TOS_BUCKET: "ownminutes-prod",
      VOLCANO_TOS_ENDPOINT: "https://tos-cn-beijing.volces.com",
      VOLCANO_TOS_ACCESS_KEY_ID: "volcano-access",
      VOLCANO_TOS_SECRET_ACCESS_KEY: "redacted-volcano-secret",
      VOLCANO_TOS_REGION: "cn-beijing",
      ...commonEvidenceEnv,
    },
    expectedProvider: "volcano-tos",
  },
];

const results = cases.map((testCase) => {
  const output = runCase(testCase.env);
  const payload = parseJson(output.stdout);
  return {
    name: testCase.name,
    expected: testCase.expectOk,
    status: output.status,
    ok: payload?.ok,
    productionCandidate: payload?.productionCandidate,
    provider: payload?.provider,
    providerMatches: payload?.provider === testCase.expectedProvider,
    missing: payload?.missing ?? [],
    hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 10,
    hasRequiredEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.length > 0,
    hasObjectStoreContractGate: payload?.checks?.some((check) => check.id === "object-store-contract"),
    hasKeyPrefixGate: payload?.checks?.some((check) => check.id === "key-prefix"),
    hasLifecycleGate: payload?.checks?.some((check) => check.id === "lifecycle-policy"),
    hasDeleteProofGate: payload?.checks?.some((check) => check.id === "delete-proof"),
    hasCostGate: payload?.checks?.some((check) => check.id === "cost-budget"),
    hasLocalInventoryGate: payload?.checks?.some((check) => check.id === "local-inventory-decision"),
    hasPrivateAccessGate: payload?.checks?.some((check) => check.id === "private-access"),
    hasMinimumPrivilegeGate: payload?.checks?.some((check) => check.id === "minimum-privilege"),
    hasRestoreReadGate: payload?.checks?.some((check) => check.id === "restore-read-proof"),
    hasPostgresRuntimeGate: payload?.checks?.some((check) => check.id === "postgres-runtime"),
    hasCrossInstanceWriteLockGate: payload?.checks?.some((check) => check.id === "cross-instance-write-lock"),
    hasDurableDeletionFenceGate: payload?.checks?.some((check) => check.id === "durable-deletion-fence"),
    noSecretLeaks: !output.combined.includes("redacted-s3-secret") &&
      !output.combined.includes("redacted-r2-secret") &&
      !output.combined.includes("redacted-volcano-secret") &&
      !output.combined.includes("AKL") &&
      !output.combined.includes("sk-proj") &&
      !output.combined.includes("Secret Access Key"),
  };
});

const summary = {
  allExpected: results.every((result) => result.ok === result.expected),
  strictFailsWhenMissing: results.find((result) => result.name === "missing-env")?.status === 1,
  strictFailsWithBucketOnly: results.find((result) => result.name === "bucket-only")?.status === 1,
  strictFailsWithoutPrefix: results.find((result) => result.name === "complete-without-prefix")?.status === 1,
  strictPassesWithCompleteProviders: results
    .filter((result) => result.expected)
    .every((result) => result.status === 0),
  allProvidersDetected: results.every((result) => result.providerMatches),
  allHaveChecks: results.every((result) => result.hasChecks),
  allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
  allHaveObjectStoreContractGate: results.every((result) => result.hasObjectStoreContractGate),
  allHaveKeyPrefixGate: results.every((result) => result.hasKeyPrefixGate),
  allHaveProductionGates: results.every(
    (result) =>
      result.hasLifecycleGate &&
      result.hasDeleteProofGate &&
      result.hasCostGate &&
      result.hasLocalInventoryGate &&
      result.hasPrivateAccessGate &&
      result.hasMinimumPrivilegeGate &&
      result.hasRestoreReadGate &&
      result.hasPostgresRuntimeGate &&
      result.hasCrossInstanceWriteLockGate &&
      result.hasDurableDeletionFenceGate,
  ),
  noSecretLeaks: results.every((result) => result.noSecretLeaks),
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.allExpected ||
  !summary.strictFailsWhenMissing ||
  !summary.strictFailsWithBucketOnly ||
  !summary.strictFailsWithoutPrefix ||
  !summary.strictPassesWithCompleteProviders ||
  !summary.allProvidersDetected ||
  !summary.allHaveChecks ||
  !summary.allHaveRequiredEnv ||
  !summary.allHaveObjectStoreContractGate ||
  !summary.allHaveKeyPrefixGate ||
  !summary.allHaveProductionGates ||
  !summary.noSecretLeaks
) {
  process.exitCode = 1;
}

function runCase(env) {
  const result = spawnSync(process.execPath, ["scripts/check-object-storage-production-env.mjs", "--strict"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      ...env,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid storage preflight JSON: ${error.message}\n${stdout}`);
  }
}
