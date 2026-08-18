#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { waitForHostPostgres } from "./lib/wait-for-postgres.mjs";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const suffix = crypto.randomBytes(5).toString("hex");
const container = `ownminutes-secret-audit-outbox-${suffix}`;
const databasePassword = crypto.randomBytes(24).toString("base64url");
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "ownminutes-secret-audit-outbox-pg-"),
);
const auditPath = path.join(scratch, "secret-audit.jsonl");
const heartbeatPath = path.join(scratch, "rotation-heartbeat.json");
let databaseUrl = "";

try {
  run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--env",
    "POSTGRES_DB=ownminutes",
    "--env",
    "POSTGRES_USER=ownminutes",
    "--env",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "--publish",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  waitForPostgres();
  const port = run(
    "docker",
    ["port", container, "5432/tcp"],
    {},
    true,
  ).trim().split(":").at(-1);
  if (!/^\d+$/.test(port || "")) {
    throw new Error("Unable to resolve isolated PostgreSQL port.");
  }
  databaseUrl = `postgresql://ownminutes:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/ownminutes`;
  await waitForHostPostgres(databaseUrl);
  run(
    process.execPath,
    ["scripts/run-postgres-migrations.mjs"],
    { DATABASE_URL: databaseUrl },
    true,
  );

  fs.writeFileSync(
    heartbeatPath,
    `${JSON.stringify({ ok: true, checkedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = databaseUrl;
  process.env.OWNMINUTES_AUTH_REPOSITORY = "postgres";
  process.env.OWNMINUTES_APP_SECRET =
    "ownminutes-secret-audit-outbox-postgres-key-000000000000";
  process.env.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION = "0";
  process.env.OWNMINUTES_POSTGRES_IDLE_TIMEOUT_MS = "1000";
  process.env.OWNMINUTES_SECRET_AUDIT_LOG = auditPath;
  process.env.OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION = "1";
  process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE = heartbeatPath;
  process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS = "300";
  delete process.env.OWNMINUTES_KMS_KEY_ID;
  delete process.env.KMS_KEY_ID;
  delete process.env.OWNMINUTES_SECRET_STORE;
  delete process.env.SECRET_STORE_URL;

  const jiti = require("jiti")(
    path.join(repoRoot, "scripts", "secret-audit-outbox-postgres-loader.cjs"),
    {
      interopDefault: true,
      alias: { "@": path.join(repoRoot, "src") },
    },
  );
  const repository = jiti(
    path.join(repoRoot, "src", "lib", "server", "auth-repository.ts"),
  );
  const secretDiagnostics = jiti(
    path.join(repoRoot, "src", "lib", "secret-diagnostics.ts"),
  );
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const user = await repository.registerUser({
      email: `secret-audit-outbox-pg-${Date.now()}@ownminutes.local`,
      name: "Secret Audit PG",
      password: "OwnMinutes-Outbox-Postgres",
    });
    const rawSecret = "postgres-outbox-raw-secret-never-persist";
    const rawProviderId = "audit-owner@example.test";
    const rawSecretName = "RawSecretValue123456789";

    process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY = "1";
    const saved = await repository.saveProviderCredential(user.id, {
      providerId: rawProviderId,
      secrets: { [rawSecretName]: rawSecret },
    });
    assert.equal(saved.configuredSecrets.includes(rawSecretName), true);

    const committedCredential = await client.query(
      "select count(*)::int as count from provider_credentials where user_id = $1 and provider_id = $2",
      [user.id, rawProviderId],
    );
    const pending = await client.query(
      `select event_id, payload, attempt_count, delivered_at
       from secret_audit_outbox
       where delivered_at is null
       order by created_at asc`,
    );
    assert.equal(committedCredential.rows[0].count, 1);
    assert.equal(pending.rowCount, 1);
    const eventId = pending.rows[0].event_id;
    const pendingText = JSON.stringify(pending.rows[0].payload);
    assert.equal(pending.rows[0].payload.id, eventId);
    assert.equal("userId" in pending.rows[0].payload, false);
    assert.equal("providerId" in pending.rows[0].payload, false);
    assert.equal("secretNames" in pending.rows[0].payload, false);
    assert.match(
      pending.rows[0].payload.providerRef,
      /^provider_[a-f0-9]{24}$/,
    );
    assert.ok(
      pending.rows[0].payload.secretRefs.every((reference) =>
        /^secret_[a-f0-9]{24}$/.test(reference)
      ),
    );
    assert.deepEqual(Object.keys(pending.rows[0].payload.metadata), ["reason"]);
    assert.equal(pendingText.includes(user.id), false);
    assert.equal(pendingText.includes(rawSecret), false);
    assert.equal(pendingText.includes(rawProviderId), false);
    assert.equal(pendingText.includes(rawSecretName), false);

    delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY;
    await waitForPostgresRetry(client, eventId);
    const [firstWorker, secondWorker] = await Promise.all([
      repository.flushSecretAuditOutboxOnce("pg-outbox-worker-one"),
      repository.flushSecretAuditOutboxOnce("pg-outbox-worker-two"),
    ]);
    const deliveryResults = [firstWorker, secondWorker];
    assert.equal(
      deliveryResults.filter((result) => result.delivered).length,
      1,
    );
    assert.equal(
      deliveryResults.find((result) => result.delivered)?.eventId,
      eventId,
    );
    const delivered = await client.query(
      "select delivered_at from secret_audit_outbox where event_id = $1",
      [eventId],
    );
    assert.ok(delivered.rows[0]?.delivered_at);
    const auditEvents = readAuditEvents();
    assert.equal(auditEvents.filter((event) => event.id === eventId).length, 1);

    await client.query(
      "update secret_audit_outbox set delivered_at = now() - interval '8 days' where event_id = $1",
      [eventId],
    );
    const idleMaintenanceDeleted =
      await repository.maintainSecretAuditOutboxOnce();
    assert.equal(idleMaintenanceDeleted, 1);
    const retainedOldDelivery = await client.query(
      "select count(*)::int as count from secret_audit_outbox where event_id = $1",
      [eventId],
    );
    assert.equal(retainedOldDelivery.rows[0].count, 0);

    process.env.OWNMINUTES_SECRET_AUDIT_TEST_ROLLBACK_AFTER_ENQUEUE = "1";
    const outboxCountBeforeRollback = await client.query(
      "select count(*)::int as count from secret_audit_outbox",
    );
    await assert.rejects(
      () =>
        repository.saveProviderCredential(user.id, {
          providerId: "rollback-provider",
          secrets: {
            ROLLBACK_SECRET: "rollback-secret-never-persist",
          },
        }),
      /secret_audit_test_rollback_after_enqueue/,
    );
    delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_ROLLBACK_AFTER_ENQUEUE;
    const rollbackCredential = await client.query(
      "select count(*)::int as count from provider_credentials where user_id = $1 and provider_id = $2",
      [user.id, "rollback-provider"],
    );
    const rollbackOutbox = await client.query(
      "select count(*)::int as count from secret_audit_outbox",
    );
    assert.equal(rollbackCredential.rows[0].count, 0);
    assert.equal(
      rollbackOutbox.rows[0].count,
      outboxCountBeforeRollback.rows[0].count,
    );

    const invalidPayloadId = "secret_audit_dbconstraint00001";
    await assert.rejects(
      () =>
        client.query(
          `insert into secret_audit_outbox
            (event_id, payload, created_at, available_at)
           values ($1, $2::jsonb, now(), now())`,
          [
            invalidPayloadId,
            JSON.stringify({
              id: invalidPayloadId,
              eventType: "provider_secret_delete",
              userRef: "user_0123456789abcdef01234567",
              providerRef: "provider_0123456789abcdef01234567",
              secretRefs: [],
              metadata: { reason: "provider_delete" },
              createdAt: new Date().toISOString(),
              providerId: rawProviderId,
            }),
          ],
        ),
      (error) => error?.code === "23514",
    );

    const constrainedPayload = {
      id: "secret_audit_dbconstraint00002",
      eventType: "provider_secret_delete",
      userRef: "user_0123456789abcdef01234567",
      providerRef: "provider_0123456789abcdef01234567",
      secretRefs: [],
      metadata: { reason: "provider_delete" },
      createdAt: "2026-07-31T00:00:00.000Z",
    };
    await assert.rejects(
      () =>
        client.query(
          `insert into secret_audit_outbox
            (event_id, payload, created_at, available_at)
           values ($1, $2::jsonb, now(), now())`,
          [
            constrainedPayload.id,
            JSON.stringify({
              ...constrainedPayload,
              createdAt: "RAW_MESSAGE_SHOULD_NOT_PERSIST",
            }),
          ],
        ),
      (error) => ["22007", "23514"].includes(error?.code),
    );
    await assert.rejects(
      () =>
        client.query(
          `insert into secret_audit_outbox
            (event_id, payload, created_at, available_at)
           values ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)`,
          [
            constrainedPayload.id,
            JSON.stringify(constrainedPayload),
            "2026-07-31T00:00:01.000Z",
          ],
        ),
      (error) => error?.code === "23514",
    );
    await assert.rejects(
      () =>
        client.query(
          `insert into secret_audit_outbox
            (event_id, payload, created_at, available_at)
           values ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)`,
          [
            constrainedPayload.id,
            JSON.stringify({
              ...constrainedPayload,
              secretRefs: [
                "secret_0123456789abcdef01234567",
                "secret_0123456789abcdef01234567",
              ],
            }),
            constrainedPayload.createdAt,
          ],
        ),
      (error) => error?.code === "23514",
    );
    const injectedSentinel = await client.query(
      "select count(*)::int as count from secret_audit_outbox where payload::text like '%RAW_MESSAGE_SHOULD_NOT_PERSIST%'",
    );
    assert.equal(injectedSentinel.rows[0].count, 0);

    await client.query(
      `update provider_credentials
       set encrypted_secrets = $3::jsonb
       where user_id = $1 and provider_id = $2`,
      [
        user.id,
        rawProviderId,
        JSON.stringify({
          [rawSecretName]: "corrupt-encrypted-provider-secret",
        }),
      ],
    );
    process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY = "1";
    await assert.rejects(
      () => repository.getProviderRuntimeConfig(user.id, rawProviderId),
    );
    const decryptFailurePending = await client.query(
      `select event_id, payload
       from secret_audit_outbox
       where delivered_at is null
         and payload ->> 'eventType' = 'provider_secret_decrypt_failed'`,
    );
    assert.equal(decryptFailurePending.rowCount, 1);
    const decryptFailureEventId =
      decryptFailurePending.rows[0].event_id;
    const decryptFailureText = JSON.stringify(
      decryptFailurePending.rows[0].payload,
    );
    assert.equal(
      decryptFailurePending.rows[0].payload.metadata.reason,
      "provider_runtime_decrypt",
    );
    assert.deepEqual(
      Object.keys(decryptFailurePending.rows[0].payload.metadata),
      ["reason"],
    );
    assert.equal(decryptFailureText.includes(rawProviderId), false);
    assert.equal(decryptFailureText.includes(rawSecretName), false);
    assert.equal(decryptFailureText.includes("corrupt-encrypted"), false);
    const pendingOutboxInfo = await repository.getSecretAuditOutboxInfo();
    assert.equal(pendingOutboxInfo.pendingCount, 1);
    delete globalThis[Symbol.for("ownminutes.secret-audit-write-status")];
    const restartedDiagnostics = secretDiagnostics.getSecretDiagnostics({
      auditOutboxInfo: pendingOutboxInfo,
    });
    assert.equal(restartedDiagnostics.audit.lastWriteOk, null);
    assert.equal(restartedDiagnostics.audit.outboxReady, false);
    assert.equal(restartedDiagnostics.audit.outboxStatus, "pending");
    assert.equal(restartedDiagnostics.configured.auditLog, false);
    assert.equal(restartedDiagnostics.productionReady, false);
    delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY;
    await waitForPostgresRetry(client, decryptFailureEventId);
    const recoveredDecryptFailure =
      await repository.flushSecretAuditOutboxOnce(
        "pg-outbox-decrypt-recovery",
      );
    assert.equal(recoveredDecryptFailure.delivered, true);
    assert.equal(
      recoveredDecryptFailure.eventId,
      decryptFailureEventId,
    );

    console.log(
      JSON.stringify(
        {
          commitSurvivedSinkFailure: true,
          pendingOutboxPreserved: true,
          decryptFailureDurablyQueuedBeforeBestEffortDelivery: true,
          decryptFailurePendingObservable: true,
          recoveredWithSameEventId: true,
          crossInstanceClaimDeliveredOnce: true,
          idleMaintenanceUsesBoundedSevenDayCleanup: true,
          databaseRejectsRawAuditPayloadFields: true,
          databaseRejectsFreeformCreatedAtAndTimestampMismatch: true,
          databaseRejectsDuplicateSecretRefs: true,
          databaseContainsNoInjectedCreatedAtSentinel: true,
          restartWithPendingOutboxFailsDiagnosticsClosed: true,
          transactionRollbackLeftNoCredentialOrOutbox: true,
          outboxContainsNoRawUserIdOrSecret: true,
          outboxUsesStableProviderAndSecretRefs: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
} finally {
  delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY;
  delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_ROLLBACK_AFTER_ENQUEUE;
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  spawnSync("docker", ["rm", "--force", container], {
    encoding: "utf8",
  });
  fs.rmSync(scratch, { recursive: true, force: true });
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logs = spawnSync("docker", ["logs", container], {
      encoding: "utf8",
    });
    const result = spawnSync(
      "docker",
      ["exec", container, "pg_isready", "-U", "ownminutes", "-d", "ownminutes"],
      { encoding: "utf8" },
    );
    const initComplete = `${logs.stdout || ""}\n${logs.stderr || ""}`.includes(
      "PostgreSQL init process complete; ready for start up.",
    );
    if (initComplete && result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("Isolated PostgreSQL did not become ready.");
}

async function waitForPostgresRetry(client, eventId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query(
      "select available_at <= now() as ready from secret_audit_outbox where event_id = $1",
      [eventId],
    );
    if (result.rows[0]?.ready === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("PostgreSQL Secret audit outbox retry window did not open.");
}

function readAuditEvents() {
  if (!fs.existsSync(auditPath)) return [];
  const text = fs.readFileSync(auditPath, "utf8").trim();
  return text
    ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

function run(executable, args, extraEnv = {}, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: capture ? "pipe" : "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(detail || `${executable} exited ${result.status}`);
  }
  return result.stdout || "";
}
