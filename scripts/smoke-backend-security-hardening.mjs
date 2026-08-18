#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-backend-security-"));
const auditPath = path.join(scratch, "secret-audit.jsonl");
const auditHeartbeatPath = path.join(scratch, ".rotation-heartbeat.json");
const cleanupServers = [];
fs.writeFileSync(
  auditHeartbeatPath,
  `${JSON.stringify({ ok: true, checkedAt: new Date().toISOString() })}\n`,
  { mode: 0o600 },
);
process.env.NODE_ENV = "test";
process.env.OWNMINUTES_AUTH_REPOSITORY = "local";
process.env.OWNMINUTES_AUTH_DATA_DIR = path.join(scratch, "auth");
process.env.OWNMINUTES_APP_SECRET = "ownminutes-backend-security-smoke-secret-000000000000000000";
process.env.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION = "0";
process.env.OWNMINUTES_SECRET_AUDIT_LOG = auditPath;
process.env.OWNMINUTES_TRUST_PROXY_HEADERS = "1";
process.env.OWNMINUTES_TRUSTED_PROXY_SOURCES = "caddy-primary";
process.env.OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION = "1";
process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE = auditHeartbeatPath;
process.env.OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS = "300";
delete process.env.OWNMINUTES_ALLOW_UNSAFE_ARK_LOOPBACK_TEST;

const jiti = require("jiti")(path.join(repoRoot, "scripts", "backend-security-loader.cjs"), {
  interopDefault: true,
  alias: { "@": path.join(repoRoot, "src") },
});

const bounded = jiti(path.join(repoRoot, "src", "lib", "server", "bounded-request.ts"));
const ark = jiti(path.join(repoRoot, "src", "lib", "server", "ark-endpoint-security.ts"));
const sensitive = jiti(path.join(repoRoot, "src", "lib", "server", "sensitive-action-guard.ts"));
const clientIdentity = jiti(path.join(repoRoot, "src", "lib", "server", "auth-client-identity.ts"));
const requestOrigin = jiti(path.join(repoRoot, "src", "lib", "server", "request-origin.ts"));
const authRateLimit = jiti(path.join(repoRoot, "src", "lib", "server", "auth-rate-limit.ts"));
const authRepository = jiti(path.join(repoRoot, "src", "lib", "server", "auth-repository.ts"));
const audit = jiti(path.join(repoRoot, "src", "lib", "server", "secret-audit.ts"));
const loginRoute = jiti(path.join(repoRoot, "src", "app", "api", "auth", "login", "route.ts"));
const registerRoute = jiti(path.join(repoRoot, "src", "app", "api", "auth", "register", "route.ts"));
const healthRoute = jiti(path.join(repoRoot, "src", "app", "api", "health", "route.ts"));
const readyzRoute = jiti(path.join(repoRoot, "src", "app", "api", "readyz", "route.ts"));
const runtimeReadiness = jiti(path.join(repoRoot, "src", "lib", "server", "runtime-readiness.ts"));
const accountDeletionCleanupWorker = jiti(path.join(repoRoot, "src", "lib", "server", "account-deletion-cleanup-worker.ts"));
const postgresRuntime = jiti(path.join(repoRoot, "src", "lib", "server", "postgres-runtime.ts"));
const { NextRequest } = require("next/server");

try {
  await assert.rejects(
    () => bounded.readBoundedJson(
      new Request("https://talk.example.test/api/test", {
        method: "POST",
        headers: { "content-length": "4097", "content-type": "application/json" },
        body: "{}",
      }),
      4096,
    ),
    (error) => error instanceof bounded.BoundedRequestError && error.status === 413,
  );
  await assert.rejects(
    () => bounded.readBoundedJson(
      new Request("https://talk.example.test/api/test", {
        method: "POST",
        headers: { "content-length": "3", "content-type": "application/json" },
        body: "{}",
      }),
      4_096,
    ),
    (error) => error instanceof bounded.BoundedRequestError && error.status === 400,
  );
  assert.deepEqual(
    await bounded.readBoundedOptionalJson(
      new Request("https://talk.example.test/api/test", { method: "POST" }),
      4_096,
    ),
    {},
  );
  const oversizedForm = new FormData();
  oversizedForm.append(
    "chunk",
    new Blob([new Uint8Array(4_096)], { type: "audio/pcm" }),
    "oversized.pcm",
  );
  await assert.rejects(
    () => bounded.readBoundedFormData(
      new Request("https://talk.example.test/api/test", {
        method: "POST",
        body: oversizedForm,
      }),
      1_024,
    ),
    (error) => error instanceof bounded.BoundedRequestError && error.status === 413,
  );

  const chunkedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(3_000));
      controller.enqueue(new Uint8Array(3_000));
      controller.close();
    },
  });
  await assert.rejects(
    () => bounded.readBoundedJson(
      new Request("https://talk.example.test/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunkedBody,
        duplex: "half",
      }),
      4_096,
    ),
    (error) => error instanceof bounded.BoundedRequestError && error.status === 413,
  );

  const oversizedLogin = await loginRoute.POST(new NextRequest("https://talk.example.test/api/auth/login", {
    method: "POST",
    headers: { "content-length": "40000", "content-type": "application/json" },
    body: "{}",
  }));
  const oversizedRegister = await registerRoute.POST(new NextRequest("https://talk.example.test/api/auth/register", {
    method: "POST",
    headers: { "content-length": "40000", "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(oversizedLogin.status, 413);
  assert.equal(oversizedRegister.status, 413);

  assert.equal(ark.validateArkBaseUrlStructure().ok, true);
  for (const rejected of [
    "http://ark.cn-beijing.volces.com/api/v3",
    "https://user:pass@ark.cn-beijing.volces.com/api/v3",
    "https://ark.cn-beijing.volces.com:443/api/v3",
    "https://ark.cn-beijing.volces.com/api/v3#fragment",
    "https://example.com/api/v3",
    "https://ark.cn-beijing.volces.com/api/v3/other",
  ]) {
    assert.equal(ark.validateArkBaseUrlStructure(rejected).ok, false, rejected);
  }
  for (const blocked of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1", "::1", "fc00::1", "2001:db8::1"]) {
    assert.equal(ark.isPublicArkAddress(blocked), false, blocked);
  }
  assert.equal(ark.isPublicArkAddress("8.8.8.8"), true);
  assert.equal(ark.isPublicArkAddress("2606:4700:4700::1111"), true);
  let redirectTargetHits = 0;
  const redirectTarget = createServer((_request, response) => {
    redirectTargetHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  cleanupServers.push(redirectTarget);
  await listenLoopback(redirectTarget);
  const targetAddress = redirectTarget.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  const redirectSource = createServer((_request, response) => {
    response.writeHead(307, {
      location: `http://127.0.0.1:${targetAddress.port}/redirect-target`,
    });
    response.end();
  });
  cleanupServers.push(redirectSource);
  await listenLoopback(redirectSource);
  const sourceAddress = redirectSource.address();
  assert.ok(sourceAddress && typeof sourceAddress !== "string");
  process.env.OWNMINUTES_ALLOW_UNSAFE_ARK_LOOPBACK_TEST = "1";
  await assert.rejects(
    () => ark.postArkJson({
      apiKey: "security-smoke-key",
      baseUrl: `http://127.0.0.1:${sourceAddress.port}/api/v3`,
      body: { model: "security-smoke" },
    }),
    (error) => error instanceof ark.ArkEndpointSecurityError &&
      error.code === "ark_endpoint_redirect_forbidden",
  );
  assert.equal(redirectTargetHits, 0);
  await closeServer(redirectSource);
  await closeServer(redirectTarget);
  cleanupServers.length = 0;
  delete process.env.OWNMINUTES_ALLOW_UNSAFE_ARK_LOOPBACK_TEST;

  assert.throws(
    () => sensitive.assertSensitiveActionOrigin(
      new Request("https://talk.example.test/api/account/provider-health", {
        method: "POST",
        headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      }),
    ),
    sensitive.SensitiveActionOriginError,
  );
  assert.equal(
    sensitive.authenticatedMutationOriginResponse(
      new Request("https://talk.example.test/api/meetings/meeting-1", {
        method: "PATCH",
        headers: {
          authorization: "Bearer ownminutes-native-session-token-1234567890",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    ),
    null,
  );
  const cookieWithoutOrigin = sensitive.authenticatedMutationOriginResponse(
    new Request("https://talk.example.test/api/meetings/meeting-1", {
      method: "POST",
      headers: {
        cookie: "ownminutes_session=cookie-only-session",
        "content-type": "text/plain",
      },
      body: "{}",
    }),
  );
  assert.equal(cookieWithoutOrigin?.status, 403);
  assert.equal(
    sensitive.publicMutationOriginResponse(
      new Request("https://talk.example.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ),
    null,
  );
  const sameSiteDifferentOrigin = sensitive.authenticatedMutationOriginResponse(
    new Request("https://talk.example.test/api/meetings/meeting-1/share", {
      method: "POST",
      headers: {
        cookie: "ownminutes_session=browser-session",
        "content-type": "text/plain",
        origin: "https://sibling.example.test",
        "sec-fetch-site": "same-site",
      },
      body: "visibility=public",
    }),
  );
  assert.equal(sameSiteDifferentOrigin?.status, 403);
  assert.equal((await sameSiteDifferentOrigin?.json()).code, "request_origin_forbidden");
  const loginCsrf = await loginRoute.POST(new NextRequest(
    "https://talk.example.test/api/auth/login",
    {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://sibling.example.test",
        "sec-fetch-site": "same-site",
      },
      body: "email=victim%40example.test&password=attacker",
    },
  ));
  assert.equal(loginCsrf.status, 403);
  assert.equal((await loginCsrf.json()).code, "request_origin_forbidden");
  const forgedRedirect = requestOrigin.buildSafeSameOriginUrl(
    new Request("https://talk.example.test/api/auth/login", {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    }),
    "/app",
  );
  assert.equal(forgedRedirect.toString(), "https://talk.example.test/app");
  assert.equal(
    requestOrigin.isSafeExternalHttps(
      new Request("http://talk.example.test/api/auth/login", {
        headers: { "x-forwarded-proto": "https" },
      }),
    ),
    false,
  );
  const boundedJsonMutationRoutes = [
    "src/app/api/account/plan/route.ts",
    "src/app/api/admin/entitlement-grants/[id]/status/route.ts",
    "src/app/api/admin/users/[id]/plan/route.ts",
    "src/app/api/meetings/[id]/finalize/route.ts",
    "src/app/api/meetings/[id]/review/route.ts",
    "src/app/api/meetings/[id]/route.ts",
    "src/app/api/meetings/[id]/share/route.ts",
  ];
  assert.ok(boundedJsonMutationRoutes.every((file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    return source.includes("readBounded") && !source.includes("request.json()");
  }));
  for (const file of [
    "src/app/api/meetings/[id]/chunks/route.ts",
    "src/lib/server/realtime-chunk-request.ts",
    "src/lib/server/recording-upload-protocol.ts",
  ]) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.ok(source.includes("readBounded"), file);
    assert.equal(/request\.(formData|arrayBuffer)\(\)/.test(source), false, file);
  }
  sensitive.assertSensitiveActionOrigin(
    new Request("https://talk.example.test/api/account/provider-health", {
      method: "POST",
      headers: { origin: "https://talk.example.test", "sec-fetch-site": "same-origin" },
    }),
  );
  const trustedRedirect = requestOrigin.buildSafeSameOriginUrl(
    new Request("http://app:3000/api/auth/login", {
      headers: {
        "x-forwarded-host": "talk.example.test",
        "x-forwarded-proto": "https",
        "x-ownminutes-proxy-source": "caddy-primary",
      },
    }),
    "/app",
  );
  assert.equal(trustedRedirect.toString(), "https://talk.example.test/app");
  assert.equal(
    requestOrigin.isSafeExternalHttps(
      new Request("http://app:3000/api/auth/login", {
        headers: {
          "x-forwarded-host": "talk.example.test",
          "x-forwarded-proto": "https",
          "x-ownminutes-proxy-source": "caddy-primary",
        },
      }),
    ),
    true,
  );
  assert.throws(
    () => sensitive.assertSensitiveActionOrigin(
      new Request("https://talk.example.test/api/account/provider-health", {
        method: "POST",
        headers: {
          origin: "https://forged.example",
          "sec-fetch-site": "same-origin",
          "x-forwarded-host": "forged.example",
          "x-forwarded-proto": "https",
        },
      }),
    ),
    sensitive.SensitiveActionOriginError,
  );
  assert.equal(sensitive.consumeSensitiveActionCooldown("security-smoke-user", "probe", 60_000, 1_000).allowed, true);
  assert.equal(sensitive.consumeSensitiveActionCooldown("security-smoke-user", "probe", 60_000, 1_001).allowed, false);

  process.env.OWNMINUTES_TRUST_PROXY_HEADERS = "1";
  process.env.OWNMINUTES_TRUSTED_PROXY_SOURCES = "caddy-primary,10.42.0.0/16";
  sensitive.assertSensitiveActionOrigin(
    new Request("http://app:3000/api/account/provider-health", {
      method: "POST",
      headers: {
        origin: "https://talk.example.test",
        "x-forwarded-host": "talk.example.test",
        "x-forwarded-proto": "https",
        "x-ownminutes-proxy-source": "caddy-primary",
      },
    }),
  );
  assert.equal(
    clientIdentity.getAuthRateLimitClientIp(
      new Request("https://talk.example.test/api/auth/login", {
        headers: {
          "x-ownminutes-client-ip": "198.51.100.8",
          "x-ownminutes-proxy-source": "caddy-primary",
        },
      }),
    ),
    "198.51.100.8",
  );
  assert.equal(
    clientIdentity.getAuthRateLimitClientIp(
      new Request("https://talk.example.test/api/auth/login", {
        headers: {
          "x-ownminutes-client-ip": "198.51.100.8",
          "x-ownminutes-proxy-source": "attacker",
        },
      }),
    ),
    "untrusted-proxy",
  );

  const beforeInfo = audit.getSecretAuditInfo();
  assert.equal(beforeInfo.managedPathConfigured, true);
  assert.equal(beforeInfo.sinkReady, true);
  assert.equal(beforeInfo.externalRotationRequired, true);
  assert.equal(beforeInfo.externalRotationConfigured, true);
  assert.equal(beforeInfo.retentionDays, null);
  assert.equal(beforeInfo.localRetentionEnforced, false);
  assert.equal(
    audit.deliverSecretAuditEvent(
      audit.createSecretAuditEvent({
        eventType: "provider_secret_save",
        userId: "raw-user-id-must-not-appear",
        providerId: "audit-owner@example.test",
        secretNames: ["RawSecretValue123456789"],
        reason: "provider_save",
      }),
    ).ok,
    true,
  );
  const auditRaw = fs.readFileSync(auditPath, "utf8");
  assert.equal(auditRaw.includes("raw-user-id-must-not-appear"), false);
  assert.equal(auditRaw.includes("audit-owner@example.test"), false);
  assert.equal(auditRaw.includes("RawSecretValue123456789"), false);
  assert.equal(fs.statSync(auditPath).mode & 0o777, 0o600);
  assert.equal(audit.getSecretAuditInfo().lastWriteOk, true);
  const originalConsoleError = console.error;
  const observedAuditErrors = [];
  console.error = (...args) => observedAuditErrors.push(args);
  try {
    process.env.OWNMINUTES_SECRET_AUDIT_LOG = "relative-audit-path.jsonl";
    assert.equal(
      audit.deliverSecretAuditEvent(
        audit.createSecretAuditEvent({
          eventType: "provider_secret_delete",
          userId: "failure-observability-user",
          providerId: "failed-provider",
          secretNames: [],
          reason: "provider_delete",
        }),
      ).ok,
      false,
    );
    const failedAuditInfo = audit.getSecretAuditInfo();
    assert.equal(failedAuditInfo.pathValid, false);
    assert.equal(failedAuditInfo.sinkReady, false);
    assert.equal(failedAuditInfo.lastWriteOk, false);
    assert.ok(failedAuditInfo.lastWriteErrorCode);
    assert.equal(observedAuditErrors.length, 1);
  } finally {
    console.error = originalConsoleError;
    process.env.OWNMINUTES_SECRET_AUDIT_LOG = auditPath;
  }
  process.env.OWNMINUTES_SECRET_AUDIT_MAX_BYTES = String(1024 * 1024);
  fs.truncateSync(auditPath, 1024 * 1024);
  const capacityAuditInfo = audit.getSecretAuditInfo();
  assert.equal(capacityAuditInfo.sinkReady, false);
  assert.equal(capacityAuditInfo.sinkStatus, "capacity_exceeded");
  fs.truncateSync(auditPath, 0);
  delete process.env.OWNMINUTES_SECRET_AUDIT_MAX_BYTES;

  const healthResponse = await healthRoute.GET();
  const health = await healthResponse.json();
  assert.deepEqual(health, {
    ok: true,
    service: "ownminutes",
    status: "live",
    runtime: "nodejs",
    checks: {},
  });
  const readinessFlights = await Promise.all([
    runtimeReadiness.getRuntimeReadinessReport(),
    runtimeReadiness.getRuntimeReadinessReport(),
    runtimeReadiness.getRuntimeReadinessReport(),
  ]);
  assert.equal(readinessFlights[0], readinessFlights[1]);
  assert.equal(readinessFlights[1], readinessFlights[2]);
  assert.equal(
    await runtimeReadiness.getRuntimeReadinessReport(),
    readinessFlights[0],
  );
  const readinessSource = fs.readFileSync(
    path.join(repoRoot, "src", "lib", "server", "runtime-readiness.ts"),
    "utf8",
  );
  assert.ok(readinessSource.includes("const READINESS_CACHE_TTL_MS = 5_000"));
  assert.ok(readinessSource.includes("if (readinessInFlight) return readinessInFlight"));
  assert.ok(readinessSource.includes("expiresAt: Date.now() + READINESS_CACHE_TTL_MS"));
  assert.ok(readinessSource.includes("application_name like 'ownminutes-finalization-worker:%'"));
  assert.ok(readinessSource.includes("status in ('queued', 'retry_wait')"));
  assert.ok(readinessSource.includes("from account_deletion_cleanup_jobs"));
  assert.ok(readinessSource.includes("dead_lettered_at is not null"));
  const appWithTwoWorkers = runtimeReadiness.evaluateQueueWorkerReadiness({
    currentRuntimeRole: "app",
    currentRuntimeWorkerEnabled: false,
    expectedWorkers: 2,
    expiredLeases: 0,
    freshnessMs: 15_000,
    mode: "postgres-queue",
    stalledRunnable: 0,
    workerCount: 2,
  });
  assert.equal(appWithTwoWorkers.ok, true);
  const appMissingOneWorker = runtimeReadiness.evaluateQueueWorkerReadiness({
    currentRuntimeRole: "app",
    currentRuntimeWorkerEnabled: false,
    expectedWorkers: 2,
    expiredLeases: 0,
    freshnessMs: 15_000,
    mode: "postgres-queue",
    stalledRunnable: 0,
    workerCount: 1,
  });
  assert.equal(appMissingOneWorker.ok, false);
  const misconfiguredWorkerSelfCheck = runtimeReadiness.evaluateQueueWorkerReadiness({
    currentRuntimeRole: "worker",
    currentRuntimeWorkerEnabled: false,
    expectedWorkers: 2,
    expiredLeases: 0,
    freshnessMs: 15_000,
    mode: "postgres-queue",
    stalledRunnable: 0,
    workerCount: 2,
  });
  assert.equal(misconfiguredWorkerSelfCheck.ok, false);
  const healthyDeletionCleanup = runtimeReadiness.evaluateDeletionCleanupReadiness({
    deadLettered: 0,
    expiredClaims: 0,
    integrityFresh: true,
    oldestPendingAgeMs: 30_000,
    overdueRunnable: 0,
    pending: 1,
    unattributedPrefixCount: 0,
    writerInvariantCurrent: true,
  });
  assert.equal(healthyDeletionCleanup.ok, true);
  for (const unhealthyDeletionCleanup of [
    { deadLettered: 1, expiredClaims: 0, integrityFresh: true, oldestPendingAgeMs: 30_000, overdueRunnable: 0, pending: 1, unattributedPrefixCount: 0, writerInvariantCurrent: true },
    { deadLettered: 0, expiredClaims: 1, integrityFresh: true, oldestPendingAgeMs: 30_000, overdueRunnable: 0, pending: 1, unattributedPrefixCount: 0, writerInvariantCurrent: true },
    { deadLettered: 0, expiredClaims: 0, integrityFresh: true, oldestPendingAgeMs: 30_000, overdueRunnable: 1, pending: 1, unattributedPrefixCount: 0, writerInvariantCurrent: true },
    { deadLettered: 0, expiredClaims: 0, integrityFresh: false, oldestPendingAgeMs: 30_000, overdueRunnable: 0, pending: 1, unattributedPrefixCount: 0, writerInvariantCurrent: true },
    { deadLettered: 0, expiredClaims: 0, integrityFresh: true, oldestPendingAgeMs: 30_000, overdueRunnable: 0, pending: 1, unattributedPrefixCount: 1, writerInvariantCurrent: true },
  ]) {
    assert.equal(runtimeReadiness.evaluateDeletionCleanupReadiness(unhealthyDeletionCleanup).ok, false);
  }
  assert.deepEqual(
    runtimeReadiness.evaluateRuntimeReadinessChecks([
      { id: "database", ok: true, detail: "ok" },
      { id: "deletion-cleanup", blocksTraffic: false, ok: false, detail: "blocked" },
    ]),
    { ok: true, releaseReady: false },
  );
  assert.deepEqual(
    runtimeReadiness.evaluateRuntimeReadinessChecks([
      { id: "database", ok: false, detail: "blocked" },
      { id: "deletion-cleanup", blocksTraffic: false, ok: false, detail: "blocked" },
    ]),
    { ok: false, releaseReady: false },
  );
  assert.deepEqual(
    [1, 2, 3, 12].map(accountDeletionCleanupWorker.accountDeletionCleanupRetryDelayMs),
    [15_000, 30_000, 60_000, 60 * 60 * 1_000],
  );
  const accountCleanupWorkerSource = fs.readFileSync(
    path.join(repoRoot, "src", "lib", "server", "account-deletion-cleanup-worker.ts"),
    "utf8",
  );
  assert.ok(accountCleanupWorkerSource.includes("const accountDeletionCleanupMaxAttempts = 12"));
  assert.ok(accountCleanupWorkerSource.includes("dead_lettered_at = now()"));
  assert.ok(accountCleanupWorkerSource.includes("and job.dead_lettered_at is null"));
  assert.ok(accountCleanupWorkerSource.includes("manual_replay_count = manual_replay_count + 1"));
  const originalInstanceId = process.env.OWNMINUTES_INSTANCE_ID;
  const originalWorkerEnabled = process.env.OWNMINUTES_FINALIZATION_WORKER;
  process.env.OWNMINUTES_FINALIZATION_WORKER = "1";
  process.env.OWNMINUTES_INSTANCE_ID = "ownminutes-production-like-worker-1";
  const workerOneApplicationName = postgresRuntime.getPostgresApplicationName();
  process.env.OWNMINUTES_INSTANCE_ID = "ownminutes-production-like-worker-2";
  const workerTwoApplicationName = postgresRuntime.getPostgresApplicationName();
  assert.notEqual(workerOneApplicationName, workerTwoApplicationName);
  assert.ok(Buffer.byteLength(workerOneApplicationName, "utf8") <= 63);
  assert.ok(Buffer.byteLength(workerTwoApplicationName, "utf8") <= 63);
  process.env.OWNMINUTES_INSTANCE_ID = `${"same-prefix-".repeat(8)}worker-1`;
  const longWorkerOne = postgresRuntime.getPostgresApplicationName();
  process.env.OWNMINUTES_INSTANCE_ID = `${"same-prefix-".repeat(8)}worker-2`;
  const longWorkerTwo = postgresRuntime.getPostgresApplicationName();
  assert.notEqual(longWorkerOne, longWorkerTwo);
  assert.ok(Buffer.byteLength(longWorkerOne, "utf8") <= 63);
  assert.ok(Buffer.byteLength(longWorkerTwo, "utf8") <= 63);
  if (originalInstanceId === undefined) delete process.env.OWNMINUTES_INSTANCE_ID;
  else process.env.OWNMINUTES_INSTANCE_ID = originalInstanceId;
  if (originalWorkerEnabled === undefined) delete process.env.OWNMINUTES_FINALIZATION_WORKER;
  else process.env.OWNMINUTES_FINALIZATION_WORKER = originalWorkerEnabled;
  const readyzResponse = await readyzRoute.GET();
  const readyz = await readyzResponse.json();
  assert.deepEqual(Object.keys(readyz).sort(), ["ok", "releaseReady", "service", "status"]);

  const adminOnlyRoutes = [
    "src/app/api/database/diagnostics/route.ts",
    "src/app/api/deployment/diagnostics/route.ts",
    "src/app/api/email/diagnostics/route.ts",
    "src/app/api/payments/diagnostics/route.ts",
    "src/app/api/providers/diagnostics/route.ts",
    "src/app/api/release/readiness/route.ts",
    "src/app/api/secrets/diagnostics/route.ts",
    "src/app/api/settings/providers/route.ts",
    "src/app/api/storage/diagnostics/route.ts",
  ];
  assert.ok(adminOnlyRoutes.every((file) => fs.readFileSync(path.join(repoRoot, file), "utf8").includes("authorizeAdminApi")));
  const mutationOriginGuardRoutes = [
    "src/app/api/account/plan/route.ts",
    "src/app/api/account/processing-mode/route.ts",
    "src/app/api/account/provider-credentials/route.ts",
    "src/app/api/account/provider-health/asr-test/route.ts",
    "src/app/api/account/provider-health/realtime-test/route.ts",
    "src/app/api/admin/entitlement-grants/[id]/status/route.ts",
    "src/app/api/admin/users/[id]/plan/route.ts",
    "src/app/api/auth/delete/route.ts",
    "src/app/api/auth/email-verification/code/confirm/route.ts",
    "src/app/api/auth/email-verification/code/request/route.ts",
    "src/app/api/auth/email-verification/confirm/route.ts",
    "src/app/api/auth/email-verification/request/route.ts",
    "src/app/api/auth/login/route.ts",
    "src/app/api/auth/logout/route.ts",
    "src/app/api/auth/password-reset/confirm/route.ts",
    "src/app/api/auth/password-reset/request/route.ts",
    "src/app/api/auth/password/route.ts",
    "src/app/api/auth/register/route.ts",
    "src/app/api/checkup/acceptance/obsidian/route.ts",
    "src/app/api/meetings/[id]/chunks/route.ts",
    "src/app/api/meetings/[id]/finalize/route.ts",
    "src/app/api/meetings/[id]/obsidian/route.ts",
    "src/app/api/meetings/[id]/realtime-chunks/route.ts",
    "src/app/api/meetings/[id]/recording-upload/route.ts",
    "src/app/api/meetings/[id]/review/route.ts",
    "src/app/api/meetings/[id]/route.ts",
    "src/app/api/meetings/[id]/share/route.ts",
    "src/app/api/payments/apple/transactions/route.ts",
  ];
  assert.ok(mutationOriginGuardRoutes.every((file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    return source.includes("authenticatedMutationOriginResponse") ||
      source.includes("publicMutationOriginResponse") ||
      source.includes("assertSensitiveActionOrigin");
  }));
  assert.equal(
    fs.readFileSync(
      path.join(repoRoot, "src/app/api/payments/apple/notifications/route.ts"),
      "utf8",
    ).includes("MutationOrigin"),
    false,
  );
  const migration = fs.readFileSync(path.join(repoRoot, "db", "migrations", "0025_auth_rate_limits.sql"), "utf8");
  assert.ok(migration.includes("create table if not exists auth_rate_limit_entries"));
  assert.ok(migration.includes("primary key (bucket, identifier_hash)"));
  for (const bucket of ["email_verification", "login", "password_reset", "register"]) {
    assert.ok(migration.includes(`'${bucket}'`));
  }
  const reservationMigration = fs.readFileSync(
    path.join(repoRoot, "db", "migrations", "0029_auth_rate_limit_reservations.sql"),
    "utf8",
  );
  assert.ok(reservationMigration.includes("create table if not exists auth_login_rate_limit_reservations"));
  assert.ok(reservationMigration.includes("primary key (reservation_token_hash, identifier_hash)"));
  const authRateLimitSource = fs.readFileSync(path.join(repoRoot, "src", "lib", "server", "auth-rate-limit.ts"), "utf8");
  assert.ok(authRateLimitSource.includes("on conflict (bucket, identifier_hash) do update"));
  assert.ok(authRateLimitSource.includes("AuthRateLimitBackendError"));
  assert.ok(authRateLimitSource.includes("from unnest($2::text[]) as scope(identifier_hash)"));
  assert.ok(authRateLimitSource.includes("pg_advisory_xact_lock"));
  assert.ok(authRateLimitSource.includes("runLoginRateLimitedVerifier"));
  assert.ok(authRateLimitSource.includes("for update skip locked"));
  assert.ok(authRateLimitSource.includes("PERSISTENT_CLEANUP_BATCH_SIZE = 1_000"));
  assert.ok(authRateLimitSource.includes("if (state.inFlight) return state.inFlight"));
  const loginRouteSource = fs.readFileSync(
    path.join(repoRoot, "src", "app", "api", "auth", "login", "route.ts"),
    "utf8",
  );
  assert.ok(loginRouteSource.includes("runLoginRateLimitedVerifier"));
  assert.equal(loginRouteSource.includes("clearLoginFailuresForScopes"), false);

  const poolKey = Symbol.for("ownminutes.postgres-runtime-pool");
  const cleanupStateKey = Symbol.for("ownminutes.auth-rate-limit-cleanup");
  const originalPool = globalThis[poolKey];
  const originalCleanupState = globalThis[cleanupStateKey];
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRepository = process.env.OWNMINUTES_AUTH_REPOSITORY;
  const fakeDatabaseUrl = "postgresql://security-smoke.invalid/ownminutes";
  let cleanupQueries = 0;
  let cleanupSql = "";
  try {
    process.env.DATABASE_URL = fakeDatabaseUrl;
    process.env.OWNMINUTES_AUTH_REPOSITORY = "postgres";
    delete globalThis[cleanupStateKey];
    globalThis[poolKey] = {
      connectionString: fakeDatabaseUrl,
      pool: {
        async query(text, values) {
          if (text.includes("with expired as")) {
            cleanupQueries += 1;
            cleanupSql = text;
            assert.deepEqual(values, [1_000]);
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
      },
    };
    await Promise.all([
      authRateLimit.getRegisterRateLimitState("cleanup-single-flight-a"),
      authRateLimit.getRegisterRateLimitState("cleanup-single-flight-b"),
      authRateLimit.getRegisterRateLimitState("cleanup-single-flight-c"),
    ]);
    assert.equal(cleanupQueries, 1);
    assert.ok(cleanupSql.includes("for update skip locked"));
    assert.ok(cleanupSql.includes("limit $1"));
    await authRateLimit.getRegisterRateLimitState("cleanup-interval-gated");
    assert.equal(cleanupQueries, 1);
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalRepository === undefined) delete process.env.OWNMINUTES_AUTH_REPOSITORY;
    else process.env.OWNMINUTES_AUTH_REPOSITORY = originalRepository;
    if (originalPool === undefined) delete globalThis[poolKey];
    else globalThis[poolKey] = originalPool;
    if (originalCleanupState === undefined) delete globalThis[cleanupStateKey];
    else globalThis[cleanupStateKey] = originalCleanupState;
  }

  const rotatingIpEmail = "rotating-ip-login@example.test";
  for (let index = 0; index < 10; index += 1) {
    await authRateLimit.recordLoginFailureForScopes(
      authRateLimit.buildLoginRateLimitScopes({
        email: rotatingIpEmail,
        ip: `198.51.100.${index + 1}`,
      }),
    );
  }
  const rotatedIpScopes = authRateLimit.buildLoginRateLimitScopes({
    email: rotatingIpEmail,
    ip: "198.51.100.200",
  });
  const rotatedIpEmailScope = rotatedIpScopes.find((scope) => scope.scope === "email");
  assert.ok(rotatedIpEmailScope);
  assert.equal(
    (await authRateLimit.getLoginRateLimitState(
      rotatedIpEmailScope.identifier,
      rotatedIpEmailScope.maxAttempts,
    )).blocked,
    true,
  );
  assert.equal(
    (await authRateLimit.getLoginRateLimitStateForScopes(rotatedIpScopes)).blocked,
    true,
  );

  const rotatingEmailIp = "203.0.113.90";
  for (let index = 0; index < 50; index += 1) {
    await authRateLimit.recordLoginFailureForScopes(
      authRateLimit.buildLoginRateLimitScopes({
        email: `rotating-email-${index}@example.test`,
        ip: rotatingEmailIp,
      }),
    );
  }
  const rotatedEmailScopes = authRateLimit.buildLoginRateLimitScopes({
    email: "rotated-email-final@example.test",
    ip: rotatingEmailIp,
  });
  const rotatedEmailIpScope = rotatedEmailScopes.find((scope) => scope.scope === "ip");
  assert.ok(rotatedEmailIpScope);
  assert.equal(
    (await authRateLimit.getLoginRateLimitState(
      rotatedEmailIpScope.identifier,
      rotatedEmailIpScope.maxAttempts,
    )).blocked,
    true,
  );
  assert.equal(
    (await authRateLimit.getLoginRateLimitStateForScopes(rotatedEmailScopes)).blocked,
    true,
  );

  const successfulLoginEmail = "successful-login@example.test";
  const successfulLoginPassword = "OwnMinutes-security-smoke-password-123!";
  const successfulLoginIp = "192.0.2.77";
  const successfulRegistration = await registerRoute.POST(new NextRequest(
    "https://talk.example.test/api/auth/register",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ownminutes-client-ip": "192.0.2.76",
        "x-ownminutes-proxy-source": "caddy-primary",
      },
      body: JSON.stringify({
        email: successfulLoginEmail,
        name: "Security Smoke",
        password: successfulLoginPassword,
      }),
    },
  ));
  assert.equal(successfulRegistration.status, 200);
  const successfulRegistrationPayload = await successfulRegistration.json();
  assert.ok(successfulRegistrationPayload.user?.id);
  const successfulLoginScopes = authRateLimit.buildLoginRateLimitScopes({
    email: successfulLoginEmail,
    ip: successfulLoginIp,
  });
  await authRateLimit.recordLoginFailureForScopes(successfulLoginScopes);
  const successfulLoginIpScope = successfulLoginScopes.find((scope) => scope.scope === "ip");
  assert.ok(successfulLoginIpScope);
  const statesBeforeSuccess = await Promise.all(
    successfulLoginScopes.map((scope) =>
      authRateLimit.getLoginRateLimitState(
        scope.identifier,
        scope.maxAttempts,
      ),
    ),
  );
  const successfulLogin = await loginRoute.POST(new NextRequest(
    "https://talk.example.test/api/auth/login",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ownminutes-client-ip": successfulLoginIp,
        "x-ownminutes-proxy-source": "caddy-primary",
      },
      body: JSON.stringify({
        email: successfulLoginEmail,
        password: successfulLoginPassword,
      }),
    },
  ));
  assert.equal(successfulLogin.status, 200);
  const statesAfterSuccess = await Promise.all(
    successfulLoginScopes.map((scope) =>
      authRateLimit.getLoginRateLimitState(
        scope.identifier,
        scope.maxAttempts,
      ),
    ),
  );
  for (let index = 0; index < successfulLoginScopes.length; index += 1) {
    assert.equal(
      statesAfterSuccess[index].remainingAttempts,
      statesBeforeSuccess[index].remainingAttempts,
    );
  }

  const credentialUserId = successfulRegistrationPayload.user.id;
  await authRepository.saveProviderCredential(credentialUserId, {
    providerId: "volcano-ark",
    fields: { ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3" },
    secrets: { ARK_API_KEY: "baseline-secret-value-for-audit-failure-smoke" },
  });
  const credentialsBeforeAuditFailure = await authRepository.listProviderCredentials(credentialUserId);
  const consoleErrorBeforeAuditPreflight = console.error;
  const observedAuditPreflightErrors = [];
  console.error = (...args) => observedAuditPreflightErrors.push(args);
  try {
    process.env.OWNMINUTES_SECRET_AUDIT_LOG = "relative-audit-path.jsonl";
    await assert.rejects(
      () => authRepository.saveProviderCredential(credentialUserId, {
        providerId: "volcano-ark",
        secrets: { ARK_API_KEY: "rotated-secret-must-not-be-persisted" },
      }),
      (error) => error instanceof audit.SecretAuditUnavailableError,
    );
    assert.deepEqual(
      await authRepository.listProviderCredentials(credentialUserId),
      credentialsBeforeAuditFailure,
    );
    await assert.rejects(
      () => authRepository.deleteProviderCredential(credentialUserId, "volcano-ark"),
      (error) => error instanceof audit.SecretAuditUnavailableError,
    );
    assert.deepEqual(
      await authRepository.listProviderCredentials(credentialUserId),
      credentialsBeforeAuditFailure,
    );
    assert.equal(observedAuditPreflightErrors.length, 2);
  } finally {
    console.error = consoleErrorBeforeAuditPreflight;
    process.env.OWNMINUTES_SECRET_AUDIT_LOG = auditPath;
  }

  process.env.NODE_ENV = "production";
  process.env.OWNMINUTES_AUTH_REPOSITORY = "local";
  for (const probe of [
    () => authRateLimit.getLoginRateLimitStateForScopes(
      authRateLimit.buildLoginRateLimitScopes({
        email: "security-smoke@example.test",
        ip: "192.0.2.10",
      }),
    ),
    () => authRateLimit.getRegisterRateLimitState("security-smoke"),
    () => authRateLimit.getEmailVerificationRateLimitState("security-smoke"),
    () => authRateLimit.getPasswordResetRateLimitState("security-smoke"),
  ]) {
    await assert.rejects(
      probe,
      (error) => error instanceof authRateLimit.AuthRateLimitBackendError,
    );
  }
  process.env.NODE_ENV = "test";
  process.env.OWNMINUTES_AUTH_REPOSITORY = "local";

  console.log(JSON.stringify({
    arkOfficialAllowlist: true,
    arkRedirectsNotFollowed: true,
    authOversizeReturns413: true,
    boundedAllMutationBodies: true,
    boundedChunkedBody: true,
    boundedMultipartAndBinaryAudio: true,
    detailedDiagnosticsAdminOnly: true,
    healthMinimal: true,
    loginRateLimitPairEmailAndIpScopes: true,
    loginRateLimitPruningBoundedSingleFlight: true,
    loginSuccessPreservesFailureBuckets: true,
    loginVerifierUsesAtomicReservations: true,
    persistentAuthRateLimitSchema: true,
    providerProbeOriginAndCooldown: true,
    publicAuthLoginCsrfBlocked: true,
    readyzAppAcceptsExternalWorkers: true,
    readyzDetectsMissingWorker: true,
    readyzDetectsDeletionCleanupFailures: true,
    accountDeletionCleanupDeadLetterAndReplayGuarded: true,
    readyzSingleFlightAndShortCache: true,
    readyzPublicContractMinimal: true,
    secretAuditPersistentAndObservable: true,
    secretAuditSinkFailurePreservesCredentials: true,
    sessionMutationOriginGuard: true,
    trustedProxySourceRequired: true,
  }, null, 2));
} finally {
  await Promise.all(cleanupServers.map((server) => closeServer(server)));
  fs.rmSync(scratch, { recursive: true, force: true });
}

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}
