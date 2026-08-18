#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { waitForHostPostgres } from "./lib/wait-for-postgres.mjs";

const repoRoot = process.cwd();
const suffix = crypto.randomBytes(6).toString("hex");
const scratch = fs.mkdtempSync(
  path.join(os.tmpdir(), "ownminutes-login-rate-limit-"),
);
const container = `ownminutes-login-rate-limit-${suffix}`;
const password = crypto.randomBytes(24).toString("base64url");
let admin;
let runtimePool;

process.env.NODE_ENV = "test";
process.env.OWNMINUTES_AUTH_REPOSITORY = "local";
process.env.OWNMINUTES_AUTH_DATA_DIR = path.join(scratch, "auth");
process.env.OWNMINUTES_APP_SECRET =
  "ownminutes-login-rate-limit-smoke-secret-000000000000000000";

class CredentialFailure extends Error {}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const sourcePath = path.join(repoRoot, "src", specifier.slice(2));
    for (const candidate of [
      `${sourcePath}.ts`,
      `${sourcePath}.tsx`,
      path.join(sourcePath, "index.ts"),
    ]) {
      if (fs.existsSync(candidate)) {
        return { shortCircuit: true, url: pathToFileURL(candidate).href };
      }
    }
    return nextResolve(specifier, context);
  },
});

try {
  const authRateLimit = await import(
    "../src/lib/server/auth-rate-limit.ts"
  );
  const local = await runScenario(authRateLimit, `local-${suffix}`);

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
    `POSTGRES_PASSWORD=${password}`,
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
  )
    .trim()
    .split(":")
    .at(-1);
  const databaseUrl =
    `postgresql://ownminutes:${encodeURIComponent(password)}` +
    `@127.0.0.1:${port}/ownminutes`;
  await waitForHostPostgres(databaseUrl);
  run(
    process.execPath,
    ["scripts/run-postgres-migrations.mjs"],
    { DATABASE_URL: databaseUrl },
    true,
  );
  process.env.DATABASE_URL = databaseUrl;
  process.env.OWNMINUTES_AUTH_REPOSITORY = "postgres";

  const { Client } = await import("pg");
  admin = new Client({
    application_name: "ownminutes-login-rate-limit-smoke-admin",
    connectionString: databaseUrl,
  });
  await admin.connect();
  runtimePool = (
    await import("../src/lib/server/postgres-runtime.ts")
  ).getPostgresRuntimePool();
  const postgres = await runScenario(
    authRateLimit,
    `postgres-${suffix}`,
    admin,
  );
  const crossProcess = await runCrossProcessScenario({
    databaseClient: admin,
    databaseUrl,
    label: `cross-process-${suffix}`,
  });
  const schema = await admin.query(
    `select
       to_regclass('public.auth_login_rate_limit_reservations') as reservation_table,
       exists (
         select 1
         from pg_indexes
         where schemaname = 'public'
           and indexname = 'auth_login_rate_limit_reservations_scope_expiry_idx'
       ) as scope_index`,
  );

  const summary = {
    localProcessAtomic: local.ok,
    postgresCrossInstanceAtomic: postgres.ok && crossProcess.ok,
    postgresReservationSchema:
      schema.rows[0]?.reservation_table ===
        "auth_login_rate_limit_reservations" &&
      schema.rows[0]?.scope_index === true,
    verifierCapacity: 5,
    waves: {
      local,
      postgres,
      crossProcess,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(summary.localProcessAtomic, true);
  assert.equal(summary.postgresCrossInstanceAtomic, true);
  assert.equal(summary.postgresReservationSchema, true);
} catch (error) {
  console.error(
    redact(error instanceof Error ? error.stack || error.message : String(error)),
  );
  process.exitCode = 1;
} finally {
  try {
    await admin?.end();
  } catch {}
  try {
    await runtimePool?.end();
  } catch {}
  spawnSync("docker", ["rm", "--force", container], {
    encoding: "utf8",
    stdio: "ignore",
  });
  fs.rmSync(scratch, { force: true, recursive: true });
}

async function runCrossProcessScenario({
  databaseClient,
  databaseUrl,
  label,
}) {
  const barrierDir = path.join(scratch, "cross-process-barrier");
  fs.mkdirSync(barrierDir, { mode: 0o700 });
  const workers = [0, 1].map((workerId) =>
    spawnWorker({
      databaseUrl,
      email: `${label}@example.test`,
      ip: "203.0.113.200",
      workerId,
      barrierDir,
    }),
  );
  await waitUntil(() => {
    const markers = fs.readdirSync(barrierDir);
    return (
      markers.filter((name) => name.startsWith("entered-")).length === 5 &&
      markers.filter((name) => name.startsWith("blocked-")).length === 15
    );
  });
  const activeReservations = Number(
    (
      await databaseClient.query(
        `select count(*)::int as count
         from auth_login_rate_limit_reservations
         where expires_at > now()`,
      )
    ).rows[0]?.count,
  );
  assert.equal(activeReservations, 15);
  fs.writeFileSync(path.join(barrierDir, "release"), "", { flag: "wx" });
  const results = await Promise.all(workers);
  const remainingReservations = Number(
    (
      await databaseClient.query(
        "select count(*)::int as count from auth_login_rate_limit_reservations",
      )
    ).rows[0]?.count,
  );
  const admitted = results.reduce(
    (total, result) => total + Number(result.admitted),
    0,
  );
  const blocked = results.reduce(
    (total, result) => total + Number(result.blocked),
    0,
  );
  return {
    activeReservationsAtBarrier: activeReservations,
    admitted,
    blocked,
    independentProcesses: results.length,
    ok:
      results.length === 2 &&
      admitted === 5 &&
      blocked === 15 &&
      remainingReservations === 0,
    remainingReservations,
  };
}

function spawnWorker({
  barrierDir,
  databaseUrl,
  email,
  ip,
  workerId,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        "scripts/lib/login-rate-limit-concurrency-worker.mjs",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          LOGIN_RATE_LIMIT_BARRIER_DIR: barrierDir,
          LOGIN_RATE_LIMIT_EMAIL: email,
          LOGIN_RATE_LIMIT_IP: ip,
          LOGIN_RATE_LIMIT_REQUEST_COUNT: "10",
          LOGIN_RATE_LIMIT_WORKER_ID: String(workerId),
          NODE_ENV: "test",
          OWNMINUTES_AUTH_REPOSITORY: "postgres",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Login rate limit worker ${workerId} failed: ${redact(stderr)}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `Login rate limit worker ${workerId} returned invalid JSON: ${
              error instanceof Error ? error.message : error
            }`,
          ),
        );
      }
    });
  });
}

async function runScenario(authRateLimit, label, databaseClient) {
  const rotatingEmail = `${label}-rotating@example.test`;
  const rotatingScopes = Array.from({ length: 20 }, (_, index) =>
    authRateLimit.buildLoginRateLimitScopes({
      email: rotatingEmail,
      ip: `198.51.100.${index + 1}`,
    }),
  );
  const emailWave = await runBarrierWave({
    authRateLimit,
    expectedVerifierEntries: 10,
    outcomes: ["success"],
    scopes: rotatingScopes,
  });

  const pairScopes = authRateLimit.buildLoginRateLimitScopes({
    email: `${label}-pair@example.test`,
    ip: "203.0.113.10",
  });
  const firstPairWave = await runBarrierWave({
    authRateLimit,
    databaseClient,
    expectedActiveReservations: 15,
    expectedVerifierEntries: 5,
    outcomes: ["success", "success", "failure", "failure", "failure"],
    scopes: Array.from({ length: 20 }, () => pairScopes),
  });
  const firstStates = await Promise.all(
    pairScopes.map((scope) =>
      authRateLimit.getLoginRateLimitState(
        scope.identifier,
        scope.maxAttempts,
      ),
    ),
  );
  const secondPairWave = await runBarrierWave({
    authRateLimit,
    databaseClient,
    expectedActiveReservations: 6,
    expectedVerifierEntries: 2,
    outcomes: ["success", "failure"],
    scopes: Array.from({ length: 20 }, () => pairScopes),
  });
  const finalStates = await Promise.all(
    pairScopes.map((scope) =>
      authRateLimit.getLoginRateLimitState(
        scope.identifier,
        scope.maxAttempts,
      ),
    ),
  );
  const durableCounts = databaseClient
    ? (
        await databaseClient.query(
          `select attempt_count
           from auth_rate_limit_entries
           where bucket = 'login'
           order by identifier_hash`,
        )
      ).rows.map((row) => Number(row.attempt_count))
    : [];
  const remainingReservations = databaseClient
    ? Number(
        (
          await databaseClient.query(
            "select count(*)::int as count from auth_login_rate_limit_reservations",
          )
        ).rows[0]?.count,
      )
    : 0;

  const expectedFirstRemaining = [2, 7, 47];
  const expectedFinalRemaining = [1, 6, 46];
  const ok =
    emailWave.entered === 10 &&
    emailWave.blocked === 10 &&
    emailWave.succeeded === 10 &&
    firstPairWave.entered === 5 &&
    firstPairWave.blocked === 15 &&
    firstPairWave.succeeded === 2 &&
    firstPairWave.failed === 3 &&
    firstStates.every(
      (state, index) =>
        state.remainingAttempts === expectedFirstRemaining[index],
    ) &&
    secondPairWave.entered === 2 &&
    secondPairWave.blocked === 18 &&
    secondPairWave.succeeded === 1 &&
    secondPairWave.failed === 1 &&
    finalStates.every(
      (state, index) =>
        state.remainingAttempts === expectedFinalRemaining[index],
    ) &&
    (!databaseClient ||
      (durableCounts.length === 3 &&
        durableCounts.every((count) => count === 4) &&
        remainingReservations === 0));

  return {
    blockedFirstPairWave: firstPairWave.blocked,
    blockedSecondPairWave: secondPairWave.blocked,
    durableCounts,
    emailScopeVerifierEntries: emailWave.entered,
    failureCountsPreserved: finalStates.map(
      (state, index) =>
        pairScopes[index].maxAttempts - state.remainingAttempts,
    ),
    ok,
    pairScopeVerifierEntries: firstPairWave.entered,
    remainingReservations,
  };
}

async function runBarrierWave({
  authRateLimit,
  databaseClient,
  expectedActiveReservations,
  expectedVerifierEntries,
  outcomes,
  scopes,
}) {
  const gate = deferred();
  let completed = 0;
  let entered = 0;
  const requests = scopes.map((requestScopes) =>
    authRateLimit
      .runLoginRateLimitedVerifier(
        requestScopes,
        async () => {
          const ordinal = entered;
          entered += 1;
          await gate.promise;
          if (outcomes[ordinal % outcomes.length] === "failure") {
            throw new CredentialFailure();
          }
          return ordinal;
        },
        (error) => error instanceof CredentialFailure,
      )
      .finally(() => {
        completed += 1;
      }),
  );
  await waitUntil(
    () =>
      entered === expectedVerifierEntries &&
      completed === scopes.length - expectedVerifierEntries,
  );
  if (databaseClient) {
    const activeReservations = Number(
      (
        await databaseClient.query(
          `select count(*)::int as count
           from auth_login_rate_limit_reservations
           where expires_at > now()`,
        )
      ).rows[0]?.count,
    );
    assert.equal(activeReservations, expectedActiveReservations);
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(entered, expectedVerifierEntries);
  gate.resolve();
  const results = await Promise.all(requests);
  return {
    blocked: results.filter((result) => !result.admitted).length,
    entered,
    failed: results.filter(
      (result) => result.admitted && !result.verified,
    ).length,
    succeeded: results.filter(
      (result) => result.admitted && result.verified,
    ).length,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the login verifier barrier.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      spawnSync(
        "docker",
        [
          "exec",
          container,
          "pg_isready",
          "-U",
          "ownminutes",
          "-d",
          "ownminutes",
        ],
        { stdio: "ignore" },
      ).status === 0
    ) {
      return;
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      250,
    );
  }
  throw new Error("Isolated PostgreSQL did not become ready.");
}

function run(executable, args, extraEnv = {}, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    stdio: capture ? "pipe" : "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${result.stdout || ""}\n${result.stderr || ""}`.trim() ||
        `${executable} failed`,
    );
  }
  return result.stdout || "";
}

function redact(value) {
  return value.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[REDACTED_DATABASE_URL]",
  );
}
