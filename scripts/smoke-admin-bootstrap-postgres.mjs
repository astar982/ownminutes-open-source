#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { waitForHostPostgres } from "./lib/wait-for-postgres.mjs";

const root = process.cwd();
const suffix = crypto.randomBytes(5).toString("hex");
const container = `ownminutes-admin-bootstrap-${suffix}`;
const databasePassword = crypto.randomBytes(24).toString("base64url");
const adminPassword = `Admin-${crypto.randomBytes(24).toString("base64url")}`;
const scratch = path.join(root, ".data", `smoke-admin-bootstrap-postgres-${suffix}`);
const adminPasswordFile = path.join(scratch, "admin-password");
let combinedOutput = "";

fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
fs.writeFileSync(adminPasswordFile, `${adminPassword}\n`, { mode: 0o600 });

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
  const portOutput = run("docker", ["port", container, "5432/tcp"], {}, true).trim();
  const port = portOutput.split(":").at(-1);
  if (!/^\d+$/.test(port || "")) throw new Error("Unable to resolve isolated PostgreSQL port.");
  const databaseUrl = `postgresql://ownminutes:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/ownminutes`;
  await waitForHostPostgres(databaseUrl);
  run(process.execPath, ["scripts/run-postgres-migrations.mjs"], { DATABASE_URL: databaseUrl }, true);
  const first = run(
    process.execPath,
    ["scripts/bootstrap-admin.mjs", "--repository", "postgres", "--email", "owner@ownminutes.test", "--name", "Owner", "--password-file", adminPasswordFile],
    { DATABASE_URL: databaseUrl },
    true,
  );
  const firstPayload = JSON.parse(first);
  const beforeHash = query("select password_hash from users where role='admin' and deleted_at is null limit 1");
  const repeated = run(
    process.execPath,
    ["scripts/bootstrap-admin.mjs", "--repository", "postgres", "--email", "changed@ownminutes.test", "--name", "Changed", "--password-file", adminPasswordFile],
    { DATABASE_URL: databaseUrl },
    true,
  );
  const repeatedPayload = JSON.parse(repeated);
  const afterHash = query("select password_hash from users where role='admin' and deleted_at is null limit 1");
  const counts = query("select count(*) || ':' || count(*) filter (where role='admin') from users where deleted_at is null");
  const verifiedAdmins = query("select count(*) from users where role='admin' and deleted_at is null and email_verified_at is not null");
  const summary = {
    migrationsApplied: Number(query("select count(*) from ownminutes_schema_migrations")) >= 11,
    createsAdminInEmptyPostgres: firstPayload.action === "created" && counts === "1:1",
    bootstrapAdminIsEmailVerified: verifiedAdmins === "1",
    idempotentWithDifferentConfiguredEmail: repeatedPayload.action === "already-configured" && counts === "1:1",
    preservesChangedPassword: Boolean(beforeHash) && beforeHash === afterHash,
    leaksSecrets: combinedOutput.includes(databasePassword) || combinedOutput.includes(adminPassword),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.entries(summary).some(([key, value]) => (key === "leaksSecrets" ? value !== false : value !== true))) process.exitCode = 1;
} finally {
  spawnSync("docker", ["rm", "--force", container], { cwd: root, encoding: "utf8" });
  fs.rmSync(scratch, { force: true, recursive: true });
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "ownminutes", "-d", "ownminutes"], { cwd: root, encoding: "utf8" });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error("Isolated PostgreSQL did not become ready.");
}

function query(sql) {
  return run("docker", ["exec", container, "psql", "-U", "ownminutes", "-d", "ownminutes", "-Atc", sql], {}, true).trim();
}

function run(executable, args, extraEnv = {}, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: capture ? "pipe" : "ignore",
  });
  combinedOutput += `${result.stdout || ""}\n${result.stderr || ""}\n`;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${executable} exited ${result.status}`);
  return result.stdout || "";
}
