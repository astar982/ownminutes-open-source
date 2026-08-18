import fs from "node:fs";
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";

const lockDescriptorEnvironmentNames = [
  "OWNMINUTES_SECRET_AUDIT_LOCK_FD",
  "OWNMINUTES_STACK_OPERATION_LOCK_FD",
  "OWNMINUTES_BACKUP_OPERATION_LOCK_FD",
];

export function spawnWithInheritedFileLocks(executable, args, options = {}) {
  return nodeSpawn(executable, args, {
    ...options,
    stdio: stdioWithInheritedFileLocks(options.stdio),
  });
}

export function spawnSyncWithInheritedFileLocks(executable, args, options = {}) {
  return nodeSpawnSync(executable, args, {
    ...options,
    stdio: stdioWithInheritedFileLocks(options.stdio),
  });
}

export function stdioWithInheritedFileLocks(stdio) {
  const descriptors = inheritedLockDescriptors();
  if (descriptors.length === 0) return stdio;

  const normalized = normalizeStdio(stdio);
  for (const descriptor of descriptors) {
    while (normalized.length <= descriptor) normalized.push("ignore");
    normalized[descriptor] = descriptor;
  }
  return normalized;
}

function inheritedLockDescriptors() {
  const declared = lockDescriptorEnvironmentNames
    .map((name) => process.env[name])
    .filter(Boolean);

  // Compatibility for a process launched by an older wrapper during a rolling
  // source update. New wrappers also expose the lock-specific descriptor.
  if (declared.length === 0 && process.env.OWNMINUTES_FILE_LOCK_FD) {
    declared.push(process.env.OWNMINUTES_FILE_LOCK_FD);
  }

  return [...new Set(declared.map(parseOpenLockDescriptor))].sort((a, b) => a - b);
}

function parseOpenLockDescriptor(raw) {
  const descriptor = Number(raw);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1024) {
    throw new Error("Inherited file lock descriptor is invalid.");
  }

  let stats;
  try {
    stats = fs.fstatSync(descriptor);
  } catch {
    throw new Error("Inherited file lock descriptor is not open.");
  }
  if (!stats.isFile()) {
    throw new Error("Inherited file lock descriptor is not a regular file.");
  }
  return descriptor;
}

function normalizeStdio(stdio) {
  if (Array.isArray(stdio)) return [...stdio];
  if (stdio === "inherit") return ["inherit", "inherit", "inherit"];
  if (stdio === "ignore") return ["ignore", "ignore", "ignore"];
  if (stdio === "overlapped") return ["overlapped", "overlapped", "overlapped"];
  return ["pipe", "pipe", "pipe"];
}
