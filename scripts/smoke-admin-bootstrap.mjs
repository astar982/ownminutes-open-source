#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const scratch = path.join(root, ".data", "smoke-admin-bootstrap");
const storePath = path.join(scratch, "store.json");
const passwordPath = path.join(scratch, "admin-password");
const weakModePath = path.join(scratch, "weak-mode-password");
const password = `Admin-Smoke-${crypto.randomBytes(18).toString("base64url")}`;

fs.rmSync(scratch, { force: true, recursive: true });
fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
fs.writeFileSync(storePath, `${JSON.stringify(emptyStore(), null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });
fs.writeFileSync(weakModePath, `${password}\n`, { mode: 0o644 });

try {
  const productionRole = roleProbe("production", "1", 0);
  const defaultDevelopmentRole = roleProbe("development", "", 0);
  const explicitDevelopmentRole = roleProbe("development", "1", 0);
  const created = runBootstrap(passwordPath);
  const createdStore = readStore();
  const admin = createdStore.users[0];
  const originalHash = admin?.passwordHash;
  const repeated = runBootstrap(passwordPath);
  const repeatedStore = readStore();
  const weakMode = spawnBootstrap(weakModePath);

  fs.writeFileSync(storePath, `${JSON.stringify({ ...emptyStore(), users: [{ id: "user_existing", role: "user" }] }, null, 2)}\n`, { mode: 0o600 });
  const occupiedStore = spawnBootstrap(passwordPath);

  const combined = [created.stdout, repeated.stdout, weakMode.stdout, weakMode.stderr, occupiedStore.stdout, occupiedStore.stderr].join("\n");
  const summary = {
    productionRegistrationAlwaysUser: productionRole === "user",
    developmentDefaultIsUser: defaultDevelopmentRole === "user",
    developmentBootstrapRequiresExplicitFlag: explicitDevelopmentRole === "admin",
    createsSingleAdmin:
      created.status === 0 &&
      created.payload?.action === "created" &&
      createdStore.users.length === 1 &&
      admin?.role === "admin" &&
      Boolean(admin?.emailVerifiedAt) &&
      verifyPassword(password, admin?.passwordSalt, admin?.passwordHash),
    recordsBootstrapEvents: createdStore.usageEvents.length === 1 && createdStore.growthEvents.length === 1,
    idempotentWithoutPasswordReset:
      repeated.status === 0 &&
      repeated.payload?.action === "already-configured" &&
      repeatedStore.users.length === 1 &&
      repeatedStore.users[0]?.passwordHash === originalHash,
    rejectsPermissivePasswordFile: weakMode.status !== 0 && weakMode.stderr.includes("0600"),
    refusesOccupiedStoreWithoutAdmin: occupiedStore.status !== 0 && occupiedStore.stderr.includes("already contains users"),
    leaksSecrets: combined.includes(password),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.entries(summary).some(([key, value]) => (key === "leaksSecrets" ? value !== false : value !== true))) process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { force: true, recursive: true });
}

function runBootstrap(filePath) {
  const result = spawnBootstrap(filePath);
  return { ...result, payload: result.status === 0 ? JSON.parse(result.stdout) : undefined };
}

function spawnBootstrap(filePath) {
  return spawnSync(
    process.execPath,
    ["scripts/bootstrap-admin.mjs", "--repository", "local-file", "--store-path", storePath, "--email", "owner@ownminutes.test", "--name", "Owner", "--password-file", filePath],
    { cwd: root, encoding: "utf8" },
  );
}

function roleProbe(nodeEnv, flag, count) {
  const source = `import { roleForPublicRegistration } from './src/lib/server/registration-policy.ts'; process.stdout.write(roleForPublicRegistration(${count}));`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: nodeEnv, OWNMINUTES_ALLOW_FIRST_USER_ADMIN: flag },
  });
  if (result.status !== 0) throw new Error(result.stderr || "Unable to probe registration role policy.");
  return result.stdout.trim();
}

function verifyPassword(value, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = crypto.scryptSync(value, salt, 64);
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function emptyStore() {
  return {
    users: [],
    sessions: [],
    passwordResetTokens: [],
    providerCredentials: [],
    usageEvents: [],
    growthEvents: [],
    entitlementGrants: [],
    billingOrders: [],
  };
}

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}
