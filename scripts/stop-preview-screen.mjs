#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(import.meta.dirname, "..");
const port = process.env.OWNMINUTES_PREVIEW_PORT || "3003";
const sessionName = `ownminutes-preview-${port}`;

function run(command, args) {
  return spawnSync(command, args, { cwd: rootDir, encoding: "utf8" });
}

function listenerPids() {
  const result = run("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"]);
  return result.status === 0
    ? result.stdout
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];
}

function processBelongsToPreview(pid) {
  const command = run("ps", ["-p", String(pid), "-o", "command="]).stdout.trim();
  const cwd = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .stdout.split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  const isNextPreview = command.includes("next-server") || (command.includes("next") && command.includes(port));
  return cwd === rootDir && isNextPreview;
}

function waitForExit(pid, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (run("kill", ["-0", String(pid)]).status !== 0) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

run("screen", ["-S", sessionName, "-X", "quit"]);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);

for (const pid of listenerPids()) {
  if (!processBelongsToPreview(pid)) {
    console.error(`Port ${port} is owned by an unrelated process (${pid}); refusing to stop it.`);
    process.exitCode = 1;
    continue;
  }
  run("kill", ["-TERM", String(pid)]);
  if (!waitForExit(pid)) run("kill", ["-KILL", String(pid)]);
}

if (listenerPids().length > 0) {
  console.error(`Port ${port} is still in use.`);
  process.exitCode = 1;
} else {
  console.log(`OwnMinutes preview stopped; port ${port} is free.`);
}
