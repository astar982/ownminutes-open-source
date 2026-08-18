#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const gatePath = path.join(repoRoot, "scripts", "check-account-deletion-cleanup-gate.mjs");
const gateSource = fs.readFileSync(gatePath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

assert.equal(
  packageJson.scripts?.["account-cleanup:gate"],
  "node scripts/check-account-deletion-cleanup-gate.mjs --strict",
);
assert.equal(
  packageJson.scripts?.["smoke:account-deletion-cleanup-gate"],
  "node scripts/smoke-account-deletion-cleanup-gate.mjs",
);
assert.match(gateSource, /begin transaction isolation level repeatable read read only/);
assert.match(gateSource, /0033_account_deletion_cleanup_observability/);
assert.match(gateSource, /account_deletion_cleanup_jobs_health_idx/);
assert.match(gateSource, /account_deletion_cleanup_jobs_dead_letter_idx/);
assert.match(gateSource, /\('account_deletion_cleanup_jobs', 'manual_replay_count'\)/);
assert.match(gateSource, /\('account_deletion_cleanup_jobs', 'last_replayed_at'\)/);
assert.match(gateSource, /\('account_deletion_cleanup_jobs', 'last_replayed_by_ref'\)/);
assert.match(gateSource, /join users on users\.id = job\.user_id\s+where users\.deleted_at is not null/);
assert.match(gateSource, /job\.dead_lettered_at is not null/);
assert.match(gateSource, /job\.status = 'processing'/);
assert.match(gateSource, /job\.claimed_at < now\(\) - \(\$1::bigint \* interval '1 millisecond'\)/);
assert.match(gateSource, /job\.status = 'pending'/);
assert.match(gateSource, /job\.available_at < now\(\) - \(\$1::bigint \* interval '1 millisecond'\)/);
assert.match(gateSource, /const staleJobAgeMs = 5 \* 60 \* 1_000/);
assert.match(gateSource, /const integrityMaxAgeMs = 10 \* 60 \* 1_000/);
assert.match(gateSource, /integrity_key = 'meeting-storage-integrity'/);
assert.match(gateSource, /audit_version = \$2::int/);
assert.match(gateSource, /writer_invariant_version = \$3::int/);
assert.match(gateSource, /unattributed_prefix_count/);
assert.doesNotMatch(gateSource, /console\.error|error\.message|error\.stack/);
assert.doesNotMatch(
  gateSource,
  /client\.query\(\s*[`'"]\s*(?:insert|update|delete|alter|create|drop|truncate)\b/i,
);

const missingStrict = runGate({ strict: true });
const missingNonStrict = runGate({ strict: false });
const unreachableStrict = runGate({
  strict: true,
  databaseUrl: "postgresql://private-user:private-password@127.0.0.1:1/ownminutes?connect_timeout=1",
});
const malformedStrict = runGate({
  strict: true,
  databaseUrl: "postgresql://private-user:private-password@[invalid",
});
const missingPayload = parsePayload(missingStrict.stdout);
const nonStrictPayload = parsePayload(missingNonStrict.stdout);
const unreachablePayload = parsePayload(unreachableStrict.stdout);
const malformedPayload = parsePayload(malformedStrict.stdout);

assert.equal(missingStrict.status, 1);
assert.equal(missingPayload.ok, false);
assert.equal(missingPayload.databaseConfigured, false);
assert.equal(missingPayload.releaseBlocked, true);
assert.equal(missingNonStrict.status, 0);
assert.equal(nonStrictPayload.ok, false);
assert.equal(unreachableStrict.status, 1);
assert.equal(unreachablePayload.ok, false);
assert.equal(unreachablePayload.databaseConfigured, true);
assert.equal(unreachablePayload.databaseConnected, false);
assert.equal(unreachablePayload.releaseBlocked, true);
assert.equal(malformedStrict.status, 1);
assert.equal(malformedPayload.ok, false);
assert.equal(malformedPayload.databaseConfigured, true);
assert.equal(malformedPayload.databaseConnected, false);
assert.equal(malformedPayload.releaseBlocked, true);

for (const output of [missingStrict, missingNonStrict, unreachableStrict, malformedStrict]) {
  assert.equal(output.stderr, "");
  assert.ok(!output.combined.includes("private-user"));
  assert.ok(!output.combined.includes("private-password"));
  assert.ok(!output.combined.includes("postgresql://"));
}
for (const payload of [missingPayload, nonStrictPayload, unreachablePayload, malformedPayload]) {
  assertOnlyAggregateValues(payload);
}

console.log(JSON.stringify({
  readOnlyTransaction: true,
  deletedUserScopePinned: true,
  strictFailureSemantics: true,
  outputIsAggregateOnly: true,
  connectionErrorsAreRedacted: true,
}, null, 2));

function runGate({ strict, databaseUrl } = {}) {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-account-deletion-cleanup-gate.mjs", ...(strict ? ["--strict"] : [])],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}

function parsePayload(stdout) {
  return JSON.parse(stdout);
}

function assertOnlyAggregateValues(payload) {
  const timestampKeys = new Set(["checkedAt", "integrityCompletedAt"]);
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || typeof value === "boolean" || Number.isSafeInteger(value)) continue;
    assert.ok(timestampKeys.has(key));
    assert.equal(new Date(value).toISOString(), value);
  }
}
