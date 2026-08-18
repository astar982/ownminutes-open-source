#!/usr/bin/env node

import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";

const suffix = crypto.randomBytes(5).toString("hex");
const container = `ownminutes-iap-${suffix}`;
const databasePassword = crypto.randomBytes(24).toString("base64url");
const appSecret = crypto.randomBytes(32).toString("base64url");
const port = await getAvailablePort();
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let serverOutput = "";
let combinedOutput = "";

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
  waitForContainerPostgres();
  const databasePort = run("docker", ["port", container, "5432/tcp"], {}, true).trim().split(":").at(-1);
  if (!/^\d+$/.test(databasePort || "")) throw new Error("Unable to resolve isolated PostgreSQL port.");
  const databaseUrl = `postgresql://ownminutes:${encodeURIComponent(databasePassword)}@127.0.0.1:${databasePort}/ownminutes`;
  await waitForHostPostgres(databaseUrl);

  run(process.execPath, ["scripts/run-postgres-migrations.mjs"], { DATABASE_URL: databaseUrl }, true);
  seedMeetingStorageIntegrityFixture();
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      OWNMINUTES_APP_SECRET: appSecret,
      OWNMINUTES_AUTH_REPOSITORY: "postgres",
      OWNMINUTES_ENABLE_IAP_MOCK: "1",
      OWNMINUTES_REQUIRE_EMAIL_VERIFICATION: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-12000);
  });
  server.stderr.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-12000);
  });
  await waitForServer();

  const endpointOutput = run(process.execPath, ["scripts/smoke-apple-iap-endpoints.mjs"], { SMOKE_BASE_URL: baseUrl }, true);
  const endpointSummary = JSON.parse(endpointOutput);
  const endpointBooleansPass = Object.entries(endpointSummary)
    .filter(([, value]) => typeof value === "boolean")
    .every(([key, value]) => (key === "leaksSecrets" ? value === false : value === true));
  const summary = {
    allMigrationsApplied: Number(query("select count(*) from ownminutes_schema_migrations")) >= 14,
    storageIntegrityFixtureValid:
      query(
        `select count(*) from meeting_storage_integrity_state
         where integrity_key = 'meeting-storage-integrity'
           and audit_version = 1
           and writer_invariant_version = 1
           and unattributed_prefix_count = 0
           and completed_at <= now()
           and completed_at >= now() - interval '10 minutes'`,
      ) === "1",
    endpointLifecyclePassed: endpointBooleansPass,
    deletionRequestsQueued:
      endpointSummary.accountDeletionObserved?.secondHttpStatus === 202 &&
      endpointSummary.accountDeletionObserved?.secondStatus === "pending_cleanup" &&
      endpointSummary.accountDeletionObserved?.firstHttpStatus === 202 &&
      endpointSummary.accountDeletionObserved?.firstStatus === "pending_cleanup",
    deletedAccountsHaveCleanupJobs:
      query(
        `select count(*) from users
         join account_deletion_cleanup_jobs on account_deletion_cleanup_jobs.user_id = users.id
         where users.deleted_at is not null`,
      ) === "2",
    activeAccountsHaveNoCleanupJobs:
      query(
        `select count(*) from users
         join account_deletion_cleanup_jobs on account_deletion_cleanup_jobs.user_id = users.id
         where users.deleted_at is null`,
      ) === "0",
    durableOrdersRecorded: Number(query("select count(*) from billing_orders where provider = 'apple_iap'")) >= 2,
    lifetimeFreeTrialLedgerSurvivesPaidRollback:
      Number(
        query(
          "select count(*) from users where free_trial_minutes_total = 60 and free_trial_minutes_used = 0 and free_trial_minutes_total - free_trial_minutes_used = 60",
        ),
      ) >= 1,
    proPurchasePersistsLaunchEntitlementAndPrice:
      Number(
        query(
          `select count(*)
           from billing_orders
           join users on users.id = billing_orders.user_id
           where billing_orders.provider = 'apple_iap'
             and billing_orders.status = 'paid'
             and billing_orders.plan = 'pro'
             and billing_orders.product_id = 'ownminutes.pro.monthly'
             and billing_orders.price_milliunits = 19990
             and billing_orders.currency = 'USD'
             and users.plan = 'pro'
             and users.official_minutes_total = 1800`,
        ),
      ) >= 1,
    durableSubscriptionRecorded: Number(query("select count(*) from apple_subscriptions")) >= 1,
    notificationInboxProcessed:
      Number(query("select count(*) from apple_notification_events where processing_status = 'processed'")) >= 4 &&
      query("select count(*) from apple_notification_events where processing_status = 'failed'") === "0",
    deletedAccountsRetainBillingLedger:
      Number(
        query(
          "select count(*) from billing_orders join users on users.id = billing_orders.user_id where billing_orders.provider = 'apple_iap' and users.deleted_at is not null",
        ),
      ) >= 2,
    deletedAccountsRetainAccountBinding:
      Number(
        query(
          "select count(*) from apple_iap_account_bindings join users on users.id = apple_iap_account_bindings.user_id where users.deleted_at is not null",
        ),
      ) >= 1,
    rawSignedPayloadNotStored:
      query(
        "select count(*) from information_schema.columns where table_schema = 'public' and column_name in ('signed_payload', 'signed_transaction_info', 'signed_renewal_info')",
      ) === "0",
    leaksSecrets: combinedOutput.includes(databasePassword) || combinedOutput.includes(appSecret),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.entries(summary).some(([key, value]) => (key === "leaksSecrets" ? value : !value))) process.exitCode = 1;
} catch (error) {
  const message = String(error instanceof Error ? error.message : error)
    .replaceAll(databasePassword, "[redacted-database-password]")
    .replaceAll(appSecret, "[redacted-app-secret]");
  const logs = serverOutput
    .replaceAll(databasePassword, "[redacted-database-password]")
    .replaceAll(appSecret, "[redacted-app-secret]");
  console.error(`${message}\n${logs}`.trim());
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
  spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
}

function waitForContainerPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "ownminutes", "-d", "ownminutes"], { encoding: "utf8" });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("Isolated PostgreSQL did not become ready.");
}

async function waitForHostPostgres(databaseUrl) {
  const { Client } = await import("pg");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      try {
        await client.end();
      } catch {}
      if (attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function seedMeetingStorageIntegrityFixture() {
  // TEST FIXTURE ONLY: the dedicated account-deletion runtime smoke exercises
  // the real object-store scan. This billing smoke has no Worker, so it seeds
  // the prerequisite epoch without scanning a developer's shared .data tree.
  query(
    `insert into meeting_storage_integrity_state (
       integrity_key, audit_version, writer_invariant_version,
       unattributed_prefix_count, completed_at
     ) values ('meeting-storage-integrity', 1, 1, 0, now())
     on conflict (integrity_key) do update
       set audit_version = excluded.audit_version,
           writer_invariant_version = excluded.writer_invariant_version,
           unattributed_prefix_count = excluded.unattributed_prefix_count,
           completed_at = excluded.completed_at`,
  );
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error("IAP development server exited before becoming ready.");
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.status > 0) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for IAP development server.");
}

function query(sql) {
  return run("docker", ["exec", container, "psql", "-U", "ownminutes", "-d", "ownminutes", "-Atc", sql], {}, true).trim();
}

function run(executable, args, extraEnv = {}, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: capture ? "pipe" : "ignore",
  });
  combinedOutput += `${result.stdout || ""}\n${result.stderr || ""}\n`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(detail || `${executable} exited ${result.status}`);
  }
  return result.stdout || "";
}

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const selectedPort = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(selectedPort)));
    });
  });
}
