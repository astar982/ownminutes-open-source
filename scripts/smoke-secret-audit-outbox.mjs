#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "ownminutes-secret-audit-outbox-"),
);
const authDataDir = path.join(scratch, "auth");
const auditPath = path.join(scratch, "secret-audit.jsonl");
const heartbeatPath = path.join(scratch, "rotation-heartbeat.json");
const rawSecret = "outbox-smoke-raw-secret-never-persist";
const rawProviderId = "audit-owner@example.test";
const rawSecretName = "RawSecretValue123456789";

fs.mkdirSync(authDataDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  heartbeatPath,
  `${JSON.stringify({ ok: true, checkedAt: new Date().toISOString() })}\n`,
  { mode: 0o600 },
);

process.env.NODE_ENV = "test";
process.env.OWNMINUTES_AUTH_DATA_DIR = authDataDir;
process.env.OWNMINUTES_APP_SECRET =
  "ownminutes-secret-audit-outbox-smoke-key-000000000000000";
process.env.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION = "0";
process.env.OWNMINUTES_SECRET_AUDIT_LOG = auditPath;
process.env.OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION = "1";
process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE = heartbeatPath;
process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS = "300";
delete process.env.OWNMINUTES_KMS_KEY_ID;
delete process.env.KMS_KEY_ID;
delete process.env.OWNMINUTES_SECRET_STORE;
delete process.env.SECRET_STORE_URL;

const jiti = require("jiti")(
  path.join(repoRoot, "scripts", "secret-audit-outbox-loader.cjs"),
  {
    interopDefault: true,
    alias: { "@": path.join(repoRoot, "src") },
  },
);
const authStore = jiti(
  path.join(repoRoot, "src", "lib", "server", "auth-store.ts"),
);
const runtimeReadiness = jiti(
  path.join(repoRoot, "src", "lib", "server", "runtime-readiness.ts"),
);
const secretDiagnostics = jiti(
  path.join(repoRoot, "src", "lib", "secret-diagnostics.ts"),
);

try {
  const user = authStore.registerUser({
    email: `secret-audit-outbox-${Date.now()}@ownminutes.local`,
    name: "Secret Audit Outbox",
    password: "OwnMinutes-Outbox-Smoke",
  });

  process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY = "1";
  const saved = await authStore.saveProviderCredential(user.id, {
    providerId: rawProviderId,
    fields: { VOLCANO_ASR_APP_ID: "outbox-smoke-app" },
    secrets: { [rawSecretName]: rawSecret },
  });

  const storeAfterFailure = readStore();
  const pending = storeAfterFailure.secretAuditOutbox;
  assert.equal(saved.configuredSecrets.includes(rawSecretName), true);
  assert.equal(storeAfterFailure.providerCredentials.length, 1);
  assert.equal(pending.length, 1);
  const eventId = pending[0].eventId;
  const pendingText = JSON.stringify(pending);
  assert.match(eventId, /^secret_audit_/);
  assert.equal(pending[0].payload.id, eventId);
  assert.equal("userId" in pending[0].payload, false);
  assert.equal("providerId" in pending[0].payload, false);
  assert.equal("secretNames" in pending[0].payload, false);
  assert.match(pending[0].payload.providerRef, /^provider_[a-f0-9]{24}$/);
  assert.ok(pending[0].payload.secretRefs.every((reference) => /^secret_[a-f0-9]{24}$/.test(reference)));
  assert.deepEqual(Object.keys(pending[0].payload.metadata), ["reason"]);
  assert.equal(pendingText.includes(user.id), false);
  assert.equal(pendingText.includes(rawSecret), false);
  assert.equal(pendingText.includes(rawProviderId), false);
  assert.equal(pendingText.includes(rawSecretName), false);
  assert.equal(readAuditEvents().length, 0);

  const failureInfo = authStore.getLocalSecretAuditOutboxInfo();
  assert.equal(failureInfo.pendingCount, 1);
  assert.equal(failureInfo.provider, "local-file");
  assert.equal(
    runtimeReadiness.evaluateSecretAuditOutboxReadiness(failureInfo).ok,
    false,
  );
  assert.equal(
    runtimeReadiness.evaluateSecretAuditOutboxReadiness({
      ...failureInfo,
      expiredLeaseCount: 1,
      pendingCount: 0,
    }).ok,
    false,
  );
  delete globalThis[Symbol.for("ownminutes.secret-audit-write-status")];
  const restartedDiagnostics = secretDiagnostics.getSecretDiagnostics({
    auditOutboxInfo: failureInfo,
  });
  assert.equal(restartedDiagnostics.audit.lastWriteOk, null);
  assert.equal(restartedDiagnostics.audit.outboxReady, false);
  assert.equal(restartedDiagnostics.audit.outboxStatus, "pending");
  assert.equal(restartedDiagnostics.configured.auditLog, false);
  assert.equal(restartedDiagnostics.productionReady, false);

  delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY;
  await waitForRetryWindow();
  const recovered = authStore.flushLocalSecretAuditOutboxOnce(
    "secret-audit-outbox-smoke-recovery",
  );
  const storeAfterRecovery = readStore();
  const deliveredEvents = readAuditEvents();
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.delivered, true);
  assert.equal(recovered.eventId, eventId);
  assert.equal(storeAfterRecovery.secretAuditOutbox.length, 0);
  assert.equal(deliveredEvents.length, 1);
  assert.equal(deliveredEvents[0].id, eventId);
  assert.equal("userId" in deliveredEvents[0], false);
  assert.equal("providerId" in deliveredEvents[0], false);
  assert.equal("secretNames" in deliveredEvents[0], false);
  assert.equal(JSON.stringify(deliveredEvents).includes(rawSecret), false);
  assert.equal(JSON.stringify(deliveredEvents).includes(rawProviderId), false);
  assert.equal(JSON.stringify(deliveredEvents).includes(rawSecretName), false);
  assert.equal(
    runtimeReadiness.evaluateSecretAuditOutboxReadiness(
      authStore.getLocalSecretAuditOutboxInfo(),
    ).ok,
    true,
  );

  const corruptedStore = readStore();
  corruptedStore.providerCredentials[0].encryptedSecrets[rawSecretName] =
    "corrupt-encrypted-provider-secret";
  writeStore(corruptedStore);
  process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY = "1";
  await assert.rejects(
    () => authStore.getProviderRuntimeConfig(user.id, rawProviderId),
  );
  const storeAfterDecryptFailure = readStore();
  assert.equal(storeAfterDecryptFailure.secretAuditOutbox.length, 1);
  const decryptFailureEvent =
    storeAfterDecryptFailure.secretAuditOutbox[0].payload;
  const decryptFailureEventId = decryptFailureEvent.id;
  const decryptFailureText = JSON.stringify(decryptFailureEvent);
  assert.equal(
    decryptFailureEvent.eventType,
    "provider_secret_decrypt_failed",
  );
  assert.equal(
    decryptFailureEvent.metadata.reason,
    "provider_runtime_decrypt",
  );
  assert.deepEqual(Object.keys(decryptFailureEvent.metadata), ["reason"]);
  assert.equal(decryptFailureText.includes(rawProviderId), false);
  assert.equal(decryptFailureText.includes(rawSecretName), false);
  assert.equal(decryptFailureText.includes("corrupt-encrypted"), false);
  assert.equal(
    runtimeReadiness.evaluateSecretAuditOutboxReadiness(
      authStore.getLocalSecretAuditOutboxInfo(),
    ).ok,
    false,
  );

  delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY;
  await waitForRetryWindow();
  const recoveredDecryptFailure =
    authStore.flushLocalSecretAuditOutboxOnce(
      "secret-audit-outbox-decrypt-recovery",
    );
  assert.equal(recoveredDecryptFailure.delivered, true);
  assert.equal(recoveredDecryptFailure.eventId, decryptFailureEventId);
  assert.equal(readStore().secretAuditOutbox.length, 0);

  console.log(
    JSON.stringify(
      {
        credentialCommitSurvivedSinkFailure: true,
        durablePendingSurvivedSinkFailure: true,
        decryptFailureDurablyQueuedBeforeBestEffortDelivery: true,
        decryptFailurePendingKeepsReadinessRed: true,
        outboxContainsNoRawUserIdOrSecret: true,
        outboxUsesStableProviderAndSecretRefs: true,
        readinessFailsForExpiredLease: true,
        readinessFailsWhilePending: true,
        restartWithPendingOutboxFailsDiagnosticsClosed: true,
        recoveryDeliveredSameEventId: true,
        recoveredPendingCount: storeAfterRecovery.secretAuditOutbox.length,
      },
      null,
      2,
    ),
  );
} finally {
  delete process.env.OWNMINUTES_SECRET_AUDIT_TEST_FAIL_DELIVERY;
  fs.rmSync(scratch, { recursive: true, force: true });
}

function readStore() {
  return JSON.parse(
    fs.readFileSync(path.join(authDataDir, "store.json"), "utf8"),
  );
}

function writeStore(store) {
  fs.writeFileSync(
    path.join(authDataDir, "store.json"),
    `${JSON.stringify(store, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function readAuditEvents() {
  if (!fs.existsSync(auditPath)) return [];
  const text = fs.readFileSync(auditPath, "utf8").trim();
  return text
    ? text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

async function waitForRetryWindow() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const store = readStore();
    if (Date.parse(store.secretAuditOutbox[0]?.availableAt || "") <= Date.now()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Secret audit outbox retry window did not open.");
}
