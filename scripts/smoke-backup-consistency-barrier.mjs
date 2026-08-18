#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const container = `ownminutes-backup-barrier-${crypto.randomBytes(6).toString("hex")}`;
const password = crypto.randomBytes(32).toString("base64url");

try {
  run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--env",
    "POSTGRES_DB=ownminutes",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--publish",
    "127.0.0.1::5432",
    "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777",
  ]);
  waitForPostgres();
  const portOutput = run("docker", ["port", container, "5432/tcp"], true).stdout.trim();
  const port = Number(portOutput.match(/:(\d+)$/)?.[1]);
  if (!Number.isInteger(port)) throw new Error("Unable to discover disposable PostgreSQL port.");

  process.env.DATABASE_URL = `postgresql://postgres:${password}@127.0.0.1:${port}/ownminutes`;
  process.env.OWNMINUTES_AUTH_REPOSITORY = "postgres";
  process.env.OWNMINUTES_MEETING_WRITE_LOCK = "postgres-advisory";
  process.env.OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS = "500";
  process.env.OWNMINUTES_POSTGRES_IDLE_TIMEOUT_MS = "1000";
  process.env.OWNMINUTES_INSTANCE_ID = "backup-consistency-barrier-smoke";

  const jiti = createJiti(import.meta.url, {
    alias: { "@": path.join(root, "src") },
    interopDefault: true,
  });
  const {
    MEETING_BACKUP_BARRIER_LOCK_KEY,
    withMeetingWriteLock,
  } = jiti("../src/lib/server/meeting-write-lock.ts");
  const backupPool = new Pool({
    application_name: "ownminutes-backup-barrier-smoke",
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  const backupClient = await connectWithRetry(backupPool);

  try {
    let signalMutationStarted;
    let releaseMutation;
    const mutationStarted = new Promise((resolve) => {
      signalMutationStarted = resolve;
    });
    const mutationRelease = new Promise((resolve) => {
      releaseMutation = resolve;
    });
    const inFlightMutation = withMeetingWriteLock("backup-barrier-meeting", async () => {
      signalMutationStarted();
      await mutationRelease;
    });
    await mutationStarted;

    await backupClient.query("set lock_timeout = '150ms'");
    const exclusiveBlockedByMutation = await backupClient
      .query(
        "select pg_advisory_lock(hashtextextended($1, 0))",
        [MEETING_BACKUP_BARRIER_LOCK_KEY],
      )
      .then(
        () => false,
        (error) => error?.code === "55P03",
      );
    releaseMutation();
    await inFlightMutation;

    await backupClient.query("set lock_timeout = '2s'");
    await backupClient.query(
      "select pg_advisory_lock(hashtextextended($1, 0))",
      [MEETING_BACKUP_BARRIER_LOCK_KEY],
    );
    const mutationBlockedByBackup = await withMeetingWriteLock(
      "backup-barrier-meeting-two",
      async () => true,
    ).then(
      () => false,
      (error) => error?.code === "meeting_write_lock_timeout",
    );
    await backupClient.query(
      "select pg_advisory_unlock(hashtextextended($1, 0))",
      [MEETING_BACKUP_BARRIER_LOCK_KEY],
    );
    const mutationRunsAfterBackup = await withMeetingWriteLock(
      "backup-barrier-meeting-two",
      async () => true,
    );

    const summary = {
      meetingMutationHoldsSharedBackupBarrier: exclusiveBlockedByMutation,
      backupExclusiveBarrierBlocksNewMutation: mutationBlockedByBackup,
      mutationResumesAfterBackupBarrierRelease: mutationRunsAfterBackup === true,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!Object.values(summary).every(Boolean)) process.exitCode = 1;
  } finally {
    backupClient.release();
    await backupPool.end();
    await globalThis[Symbol.for("ownminutes.postgres-runtime-pool")]?.pool?.end?.();
  }
} finally {
  run("docker", ["rm", "--force", container], false, true);
}

function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = run(
      "docker",
      ["exec", container, "pg_isready", "-U", "postgres", "-d", "ownminutes"],
      false,
      true,
    );
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  throw new Error("Disposable PostgreSQL did not become ready.");
}

async function connectWithRetry(pool) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    let client;
    try {
      client = await pool.connect();
      await client.query("select 1");
      return client;
    } catch (error) {
      client?.release?.(true);
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError || new Error("Unable to connect to disposable PostgreSQL.");
}

function run(executable, args, capture = false, allowFailure = false) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${executable} ${args[0] || ""} failed with status ${result.status}.`);
  }
  return result;
}
