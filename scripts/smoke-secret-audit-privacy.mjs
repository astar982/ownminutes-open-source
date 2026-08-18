#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-secret-audit-privacy-"));
const auditDir = path.join(scratch, ".data", "auth");
const auditPath = path.join(auditDir, "secret-audit.jsonl");
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
fs.symlinkSync(path.join(repoRoot, "scripts"), path.join(scratch, "scripts"), "dir");
fs.writeFileSync(
  auditPath,
  [
    JSON.stringify({
      id: "secret_audit_legacyexpired001",
      eventType: "provider_secret_save",
      userId: "expired-raw-user-id",
      secretNames: [],
      metadata: {},
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    JSON.stringify({
      id: "secret_audit_legacyrecent0001",
      eventType: "provider_secret_rotate",
      userId: "recent-raw-user-id",
      secretNames: [],
      metadata: {
        reason: "migration",
        message: "legacy-raw-message-that-must-not-survive",
      },
      createdAt: new Date().toUTCString(),
    }),
  ].join("\n") + "\n",
  { mode: 0o600 },
);

process.chdir(scratch);
process.env.NODE_ENV = "test";
process.env.OWNMINUTES_APP_SECRET = "ownminutes-secret-audit-privacy-smoke-key-000000000000000";
const jiti = require("jiti")(path.join(repoRoot, "scripts", "secret-audit-privacy-loader.cjs"), {
  interopDefault: true,
  alias: { "@": path.join(repoRoot, "src") },
});
const audit = jiti(path.join(repoRoot, "src", "lib", "server", "secret-audit.ts"));
const secretDiagnostics = jiti(
  path.join(repoRoot, "src", "lib", "secret-diagnostics.ts"),
);

try {
  const proactiveInfo = audit.getSecretAuditInfo();
  const proactivelyMigratedRaw = fs.readFileSync(auditPath, "utf8");
  const proactivelyMigratedEvents = proactivelyMigratedRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(proactiveInfo.legacyMigrationReady, true);
  assert.equal(proactivelyMigratedEvents.length, 2);
  assert.ok(
    proactivelyMigratedEvents.every((event) =>
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(
        event.createdAt,
      )
    ),
  );
  assert.ok(!proactivelyMigratedRaw.includes("expired-raw-user-id"));
  assert.ok(!proactivelyMigratedRaw.includes("recent-raw-user-id"));
  assert.ok(
    !proactivelyMigratedRaw.includes(
      "legacy-raw-message-that-must-not-survive",
    ),
  );
  assert.equal(
    proactivelyMigratedEvents.some(
      (event) => event.id === "secret_audit_legacyexpired001",
    ),
    true,
  );

  const rawProviderId = "audit-owner@example.test";
  const rawSecretName = "RawSecretValue123456789";
  const rawMetadataValue = "credential_internal_id_or_decrypt_message";
  const event = audit.createSecretAuditEvent({
    eventType: "provider_secret_delete",
    userId: "account-delete-raw-user-id",
    providerId: rawProviderId,
    secretNames: [rawSecretName],
    reason: "account_delete",
    metadata: {
      message: rawMetadataValue,
      providerCredentialId: rawMetadataValue,
    },
  });
  const repeatedEvent = audit.createSecretAuditEvent({
    eventType: "provider_secret_delete",
    userId: "account-delete-raw-user-id",
    providerId: rawProviderId,
    secretNames: [rawSecretName],
    reason: "account_delete",
  });
  assert.equal(event.providerRef, repeatedEvent.providerRef);
  assert.deepEqual(event.secretRefs, repeatedEvent.secretRefs);
  assert.equal(audit.deliverSecretAuditEvent(event).ok, true);
  const raw = fs.readFileSync(auditPath, "utf8");
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => /^user_[a-f0-9]{24}$/.test(event.userRef)));
  assert.ok(events.every((event) => /^provider_[a-f0-9]{24}$/.test(event.providerRef)));
  assert.ok(events.every((event) => event.secretRefs.every((reference) => /^secret_[a-f0-9]{24}$/.test(reference))));
  assert.ok(events.every((event) => !("userId" in event)));
  assert.ok(events.every((event) => !("providerId" in event)));
  assert.ok(events.every((event) => !("secretNames" in event)));
  assert.ok(events.every((event) => Object.keys(event.metadata).join(",") === "reason"));
  assert.ok(!raw.includes("expired-raw-user-id"));
  assert.ok(!raw.includes("recent-raw-user-id"));
  assert.ok(!raw.includes("account-delete-raw-user-id"));
  assert.ok(!raw.includes(rawProviderId));
  assert.ok(!raw.includes(rawSecretName));
  assert.ok(!raw.includes(rawMetadataValue));
  assert.equal(events.some((event) => event.id === "secret_audit_legacyexpired001"), false);
  assert.equal(events.some((event) => event.id === "secret_audit_legacyrecent0001"), true);
  const info = audit.getSecretAuditInfo();
  assert.equal(info.retentionDays, 180);
  assert.equal(info.maxEvents, 50_000);
  assert.equal(info.userIdentifiersPseudonymized, true);
  fs.appendFileSync(
    auditPath,
    `${JSON.stringify({
      id: "secret_audit_legacyfailure0001",
      eventType: "provider_secret_save",
      userId: "raw-user-needs-pseudonymization-key",
      secretNames: [],
      metadata: { reason: "provider_save" },
      createdAt: new Date().toUTCString(),
    })}\n`,
  );
  process.env.NODE_ENV = "production";
  delete process.env.OWNMINUTES_APP_SECRET;
  delete process.env.AUTH_SECRET;
  const failedMigrationInfo = audit.getSecretAuditInfo();
  assert.equal(failedMigrationInfo.legacyMigrationReady, false);
  assert.equal(failedMigrationInfo.sinkReady, false);
  const failedMigrationDiagnostics = secretDiagnostics.getSecretDiagnostics({
    auditOutboxInfo: {
      claimableCount: 0,
      expiredLeaseCount: 0,
      oldestPendingAgeMs: 0,
      oldestPendingAt: null,
      overduePendingCount: 0,
      pendingCount: 0,
      provider: "local-file",
    },
  });
  assert.equal(failedMigrationDiagnostics.audit.legacyMigrationReady, false);
  assert.equal(failedMigrationDiagnostics.configured.auditLog, false);
  assert.equal(failedMigrationDiagnostics.productionReady, false);
  console.log(JSON.stringify({
    accountDeletionUserIdPseudonymized: true,
    providerAndSecretInputsUseStableIrreversibleRefs: true,
    metadataAllowsOnlyControlledReason: true,
    legacyRawFieldsMigratedByDiagnosticsBeforeAppend: true,
    proactiveMigrationPreservedRecordCount: true,
    proactiveMigrationCanonicalizedCreatedAt: true,
    failedLegacyMigrationFailsSinkReadinessClosed: true,
    failedLegacyMigrationFailsProductionDiagnosticsClosed: true,
    legacyRawUserIdMigrated: true,
    expiredAuditPruned: true,
    retentionDays: info.retentionDays,
  }, null, 2));
} finally {
  process.chdir(repoRoot);
  fs.rmSync(scratch, { recursive: true, force: true });
}
