#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { claimLegacyStackOwner } from "./lib/production-like-stack-owner.mjs";

const root = process.cwd();
const stateDir = path.join(root, ".data", "production-like");
const lockPath = path.join(stateDir, "operation.lock");
const lockWrapper = path.join(root, "scripts", "with-file-lock.pl");
const stackScript = path.join(root, "scripts", "production-like-stack.mjs");
const inheritedLockHelperUrl = pathToFileURL(
  path.join(root, "scripts", "lib", "inherited-file-lock.mjs"),
).href;
const killScratch = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-operation-lock-kill-"));

try {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const holder = spawn(
    "perl",
    [
      lockWrapper,
      lockPath,
      "5",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      "-e",
      "process.stdout.write('lock-held\\n'); setTimeout(() => {}, 2500);",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );

  await waitForMarker(holder, "lock-held");

  const rejected = spawnSync(process.execPath, [stackScript, "status"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(rejected.status, 75);
  assert.match(rejected.stderr, /file_lock_timeout/);

  const holderResult = await waitForExit(holder);
  assert.equal(holderResult.code, 0);

  const reacquired = spawnSync(
    "perl",
    [
      lockWrapper,
      lockPath,
      "1",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      "-e",
      "process.exit(process.env.OWNMINUTES_STACK_OPERATION_LOCK_HELD === '1' ? 0 : 1)",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(reacquired.status, 0, reacquired.stderr);

  const killLockPath = path.join(killScratch, "operation.lock");
  const startedMarker = path.join(killScratch, "started");
  const finishedMarker = path.join(killScratch, "finished");
  const killedHolder = spawn(
    "perl",
    [
      lockWrapper,
      killLockPath,
      "5",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      "-e",
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(startedMarker)}, 'started');`,
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(finishedMarker)}, 'finished'), 1800);`,
      ].join(" "),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitForFile(startedMarker, 5_000);
  killedHolder.kill("SIGKILL");
  const killedResult = await waitForExit(killedHolder);
  assert.equal(killedResult.signal, "SIGKILL");

  const acquiredAfterKill = spawnSync(
    "perl",
    [
      lockWrapper,
      killLockPath,
      "2",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(acquiredAfterKill.status, 0, acquiredAfterKill.stderr);
  await delay(2_100);
  assert.equal(
    fs.existsSync(finishedMarker),
    false,
    "The protected command continued after its lock-owning PID was killed.",
  );

  const descendantLockPath = path.join(killScratch, "descendant-operation.lock");
  const descendantStartedMarker = path.join(killScratch, "descendant-started");
  const descendantFinishedMarker = path.join(killScratch, "descendant-finished");
  const descendantHolder = spawn(
    "perl",
    [
      lockWrapper,
      descendantLockPath,
      "5",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      "--input-type=module",
      "-e",
      [
        `const { spawnWithInheritedFileLocks } = await import(${JSON.stringify(inheritedLockHelperUrl)});`,
        "spawnWithInheritedFileLocks(",
        "  process.execPath,",
        `  ['-e', ${JSON.stringify([
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(descendantStartedMarker)}, 'started');`,
          `setTimeout(() => fs.writeFileSync(${JSON.stringify(descendantFinishedMarker)}, 'finished'), 1800);`,
        ].join(" "))}],`,
        "  { stdio: 'ignore' },",
        ");",
        "setInterval(() => {}, 10_000);",
      ].join("\n"),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitForFile(descendantStartedMarker, 5_000);
  descendantHolder.kill("SIGKILL");
  const descendantHolderResult = await waitForExit(descendantHolder);
  assert.equal(descendantHolderResult.signal, "SIGKILL");

  const rejectedWhileDescendantRuns = spawnSync(
    "perl",
    [
      lockWrapper,
      descendantLockPath,
      "1",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(rejectedWhileDescendantRuns.status, 75);
  assert.match(rejectedWhileDescendantRuns.stderr, /file_lock_timeout/);
  await waitForFile(descendantFinishedMarker, 5_000);

  const acquiredAfterDescendant = spawnSync(
    "perl",
    [
      lockWrapper,
      descendantLockPath,
      "2",
      "--held-env=OWNMINUTES_STACK_OPERATION_LOCK_HELD",
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(acquiredAfterDescendant.status, 0, acquiredAfterDescendant.stderr);

  const ownerFile = path.join(killScratch, "legacy-owner.json");
  const firstOwner = claimLegacyStackOwner({
    ownerFile,
    dockerEngineId: "test-engine-0123456789",
    stageIdentity: "111111111111",
  });
  assert.equal(firstOwner.stageIdentity, "111111111111");
  assert.throws(
    () => claimLegacyStackOwner({
      ownerFile,
      dockerEngineId: "test-engine-0123456789",
      stageIdentity: "222222222222",
    }),
    /different worktree/,
  );
  const sameOwner = claimLegacyStackOwner({
    ownerFile,
    dockerEngineId: "test-engine-0123456789",
    stageIdentity: "111111111111",
  });
  assert.equal(sameOwner.stageIdentity, "111111111111");

  console.log(JSON.stringify({
    concurrentOperationRejected: true,
    kernelLockReleasedAfterHolderExit: true,
    killedLockOwnerCannotContinueWithoutLock: true,
    descendantRetainsLockUntilMutationCompletes: true,
    legacyResourcesHaveOnePersistentWorktreeOwner: true,
    lockFileModePrivate: (fs.statSync(lockPath).mode & 0o777) === 0o600,
  }, null, 2));
} finally {
  fs.rmSync(killScratch, { recursive: true, force: true });
}

function waitForMarker(child, marker) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(`Lock holder exited before acquiring the lock (${code}): ${stderr}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
