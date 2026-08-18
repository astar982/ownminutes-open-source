#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { waitForHostPostgres } from "./lib/wait-for-postgres.mjs";

const suffix = crypto.randomBytes(5).toString("hex");
const container = `ownminutes-email-verification-${suffix}`;
const databasePassword = crypto.randomBytes(24).toString("base64url");
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
  waitForPostgres();
  const port = run("docker", ["port", container, "5432/tcp"], {}, true).trim().split(":").at(-1);
  if (!/^\d+$/.test(port || "")) throw new Error("Unable to resolve isolated PostgreSQL port.");
  const databaseUrl = `postgresql://ownminutes:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/ownminutes`;
  await waitForHostPostgres(databaseUrl);
  run(process.execPath, ["scripts/run-postgres-migrations.mjs"], { DATABASE_URL: databaseUrl }, true);
  const flowOutput = run(
    process.execPath,
    ["scripts/smoke-email-verification.mjs"],
    { DATABASE_URL: databaseUrl, OWNMINUTES_AUTH_REPOSITORY: "postgres" },
    true,
  );
  const flow = JSON.parse(flowOutput);
  const summary = {
    allMigrationsApplied: Number(query("select count(*) from ownminutes_schema_migrations")) >= 18,
    postgresFlowPassed: Object.entries(flow).every(([key, value]) => (key === "leaksSecrets" ? value === false : value === true)),
    deletedUserRetainsVerifiedAuditTimestamp:
      query("select count(*) from users where deleted_at is not null and email_verified_at is not null") === "5",
    noActiveUsers: query("select count(*) from users where deleted_at is null") === "0",
    verificationTokensDeleted: query("select count(*) from email_verification_tokens") === "0",
    resetTokensDeleted: query("select count(*) from password_reset_tokens") === "0",
    leaksSecrets: combinedOutput.includes(databasePassword),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.entries(summary).some(([key, value]) => (key === "leaksSecrets" ? value : !value))) process.exitCode = 1;
} finally {
  spawnSync("docker", ["rm", "--force", container], { encoding: "utf8" });
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logs = spawnSync("docker", ["logs", container], { encoding: "utf8" });
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "ownminutes", "-d", "ownminutes"], { encoding: "utf8" });
    const initComplete = `${logs.stdout || ""}\n${logs.stderr || ""}`.includes(
      "PostgreSQL init process complete; ready for start up.",
    );
    if (initComplete && result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("Isolated PostgreSQL did not become ready.");
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
