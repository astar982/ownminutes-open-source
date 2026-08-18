#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const barrierDir = required("LOGIN_RATE_LIMIT_BARRIER_DIR");
const email = required("LOGIN_RATE_LIMIT_EMAIL");
const ip = required("LOGIN_RATE_LIMIT_IP");
const workerId = required("LOGIN_RATE_LIMIT_WORKER_ID");
const requestCount = Number(
  process.env.LOGIN_RATE_LIMIT_REQUEST_COUNT || "10",
);

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
    "../../src/lib/server/auth-rate-limit.ts"
  );
  const scopes = authRateLimit.buildLoginRateLimitScopes({ email, ip });
  const results = await Promise.all(
    Array.from({ length: requestCount }, (_, index) =>
      authRateLimit
        .runLoginRateLimitedVerifier(
          scopes,
          async () => {
            fs.writeFileSync(
              path.join(barrierDir, `entered-${workerId}-${index}`),
              "",
              { flag: "wx" },
            );
            await waitForRelease();
            return index;
          },
          () => false,
        )
        .then((result) => {
          if (!result.admitted) {
            fs.writeFileSync(
              path.join(barrierDir, `blocked-${workerId}-${index}`),
              "",
              { flag: "wx" },
            );
          }
          return result;
        }),
    ),
  );
  const runtimePool = (
    await import("../../src/lib/server/postgres-runtime.ts")
  ).getPostgresRuntimePool();
  await runtimePool.end?.();
  process.stdout.write(
    `${JSON.stringify({
      admitted: results.filter((result) => result.admitted).length,
      blocked: results.filter((result) => !result.admitted).length,
      workerId,
    })}\n`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
}

async function waitForRelease() {
  const releasePath = path.join(barrierDir, "release");
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the cross-process barrier.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
