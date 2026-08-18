#!/usr/bin/env node

import { chmodSync, chownSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";

const separator = process.argv.indexOf("--");
const command = separator >= 0 ? process.argv[separator + 1] : "";
const args = separator >= 0 ? process.argv.slice(separator + 2) : [];

if (!command) {
  throw new Error("Usage: node scripts/run-with-secrets.mjs -- <command> [args...]");
}

const environment = { ...process.env };
const runtimeUid = Number.parseInt(environment.OWNMINUTES_RUNTIME_UID || "1000", 10);
const runtimeGid = Number.parseInt(environment.OWNMINUTES_RUNTIME_GID || "1000", 10);
const secretFileVariables = [
  { fileVariable: "OWNMINUTES_APP_SECRET_FILE" },
  { fileVariable: "POSTGRES_PASSWORD_FILE" },
  { fileVariable: "POSTGRES_OWNER_PASSWORD_FILE" },
  { fileVariable: "POSTGRES_MIGRATOR_PASSWORD_FILE" },
  { fileVariable: "POSTGRES_APP_PASSWORD_FILE" },
  { fileVariable: "S3_ACCESS_KEY_ID_FILE" },
  { fileVariable: "S3_SECRET_ACCESS_KEY_FILE" },
  { fileVariable: "OWNMINUTES_ADMIN_PASSWORD_FILE" },
  { allowEmpty: true, fileVariable: "VOLCANO_ASR_API_KEY_FILE" },
  { allowEmpty: true, fileVariable: "VOLCANO_ASR_TOKEN_FILE" },
  { allowEmpty: true, fileVariable: "ARK_API_KEY_FILE" },
  { allowEmpty: true, fileVariable: "RESEND_API_KEY_FILE" },
  { allowNewlines: true, fileVariable: "APPLE_PRIVATE_KEY_FILE" },
];

for (const { allowEmpty = false, allowNewlines = false, fileVariable } of secretFileVariables) {
  const filePath = environment[fileVariable];
  if (!filePath) continue;
  const targetName = fileVariable.slice(0, -5);
  const value = readFileSync(filePath, "utf8").trim();
  if (!value && allowEmpty) continue;
  if (!value || value.includes("\0") || (!allowNewlines && /[\r\n]/.test(value))) {
    throw new Error(`Secret file for ${targetName} is empty or invalid.`);
  }
  environment[targetName] = value;
}

if (!environment.APPLE_ROOT_CERTIFICATES && environment.APPLE_ROOT_CERTIFICATE_PATHS) {
  const certificatePaths = environment.APPLE_ROOT_CERTIFICATE_PATHS.split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (certificatePaths.length === 0) {
    throw new Error("APPLE_ROOT_CERTIFICATE_PATHS does not contain any certificate files.");
  }
  const certificates = certificatePaths.map((filePath) => {
    const value = readFileSync(filePath);
    if (value.length === 0) {
      throw new Error("An Apple root certificate file is empty.");
    }
    return value.toString("base64");
  });
  environment.APPLE_ROOT_CERTIFICATES = JSON.stringify(certificates);
}

if (!environment.DATABASE_URL) {
  const host = environment.OWNMINUTES_DATABASE_HOST;
  const port = environment.OWNMINUTES_DATABASE_PORT || "5432";
  const database = environment.OWNMINUTES_DATABASE_NAME;
  const user = environment.OWNMINUTES_DATABASE_USER;
  const password = environment.POSTGRES_PASSWORD;
  if (host && database && user && password) {
    environment.DATABASE_URL = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
  }
}

if (process.geteuid?.() === 0) {
  if (!Number.isSafeInteger(runtimeUid) || runtimeUid <= 0) {
    throw new Error("OWNMINUTES_RUNTIME_UID must be a positive integer.");
  }
  if (!Number.isSafeInteger(runtimeGid) || runtimeGid <= 0) {
    throw new Error("OWNMINUTES_RUNTIME_GID must be a positive integer.");
  }

  const writableRoot = resolve("/app/.data");
  const writableDirectories = String(environment.OWNMINUTES_RUNTIME_WRITABLE_DIRS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const directory of writableDirectories) {
    const normalized = resolve(directory);
    if (normalized !== writableRoot && !normalized.startsWith(`${writableRoot}${sep}`)) {
      throw new Error("OWNMINUTES_RUNTIME_WRITABLE_DIRS may only contain paths below /app/.data.");
    }
    mkdirSync(normalized, { recursive: true, mode: 0o700 });
    chownSync(normalized, runtimeUid, runtimeGid);
    chmodSync(normalized, 0o700);
  }

  process.setgroups([runtimeGid]);
  process.setgid(runtimeGid);
  process.setuid(runtimeUid);
}

const child = spawn(command, args, {
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
