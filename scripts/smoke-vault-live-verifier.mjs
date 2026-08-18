#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-vault-live-verifier-"));
const tokenFile = path.join(tempDir, "least-privilege-token");
const rootTokenFile = path.join(tempDir, "root-token");
const evidencePath = path.join(tempDir, "vault-live-evidence.json");
const overprivilegedEvidencePath = path.join(tempDir, "vault-live-overprivileged.json");
const leastToken = "vault-live-least-token";
const rootToken = "vault-live-root-token";
const keyName = "ownminutes-provider-secrets";
const records = new Map();
const requests = [];

fs.writeFileSync(tokenFile, `${leastToken}\n`, { mode: 0o600 });
fs.writeFileSync(rootTokenFile, `${rootToken}\n`, { mode: 0o600 });

const server = http.createServer(async (request, response) => {
  try {
    const body = await readBody(request);
    const token = String(request.headers["x-vault-token"] || "");
    requests.push({ method: request.method, path: request.url, body, tokenAccepted: token === leastToken || token === rootToken });
    if (token !== leastToken && token !== rootToken) return writeJson(response, 403, { errors: ["denied"] });
    if (request.method === "GET" && (request.url === `/v1/transit/keys/${keyName}` || request.url === "/v1/sys/mounts")) {
      return writeJson(response, token === rootToken ? 200 : 403, token === rootToken ? { data: { privileged: true } } : { errors: ["denied"] });
    }
    const payload = JSON.parse(body || "{}");
    if (request.method === "POST" && request.url === `/v1/transit/encrypt/${keyName}`) {
      const ciphertext = `vault:v7:${crypto.randomUUID()}`;
      records.set(ciphertext, { plaintext: payload.plaintext, context: payload.context });
      return writeJson(response, 200, { data: { ciphertext } });
    }
    if (request.method === "POST" && request.url === `/v1/transit/decrypt/${keyName}`) {
      const stored = records.get(payload.ciphertext);
      if (!stored || stored.context !== payload.context) return writeJson(response, 400, { errors: ["context mismatch"] });
      return writeJson(response, 200, { data: { plaintext: stored.plaintext } });
    }
    return writeJson(response, 404, { errors: ["not found"] });
  } catch {
    return writeJson(response, 400, { errors: ["invalid request"] });
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Vault live verifier smoke server did not start.");

try {
  const commonEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    OWNMINUTES_SECRET_STORE: "vault-transit",
    OWNMINUTES_VAULT_ADDR: `http://127.0.0.1:${address.port}`,
    OWNMINUTES_VAULT_TRANSIT_KEY: keyName,
    OWNMINUTES_VAULT_TRANSIT_MOUNT: "transit",
    OWNMINUTES_VAULT_ALLOW_INSECURE_LOOPBACK_TEST: "1",
    OWNMINUTES_VAULT_LIVE_ALLOW_INSECURE_TEST: "1",
    OWNMINUTES_VAULT_LIVE_ALLOW_DIRTY_TEST: "1",
  };
  const unauthorized = await runVerifier({ ...commonEnv, OWNMINUTES_VAULT_TOKEN_FILE: tokenFile, OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH: evidencePath });
  const releaseMismatch = await runVerifier({
    ...commonEnv,
    OWNMINUTES_VAULT_LIVE_VERIFY: "1",
    OWNMINUTES_RELEASE_ID: "0000000000000000000000000000000000000000",
    OWNMINUTES_VAULT_TOKEN_FILE: tokenFile,
    OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH: path.join(tempDir, "release-mismatch.json"),
  });
  const trackedEvidencePath = path.join(process.cwd(), "docs", "vault-live-do-not-write.json");
  const trackedDestination = await runVerifier({
    ...commonEnv,
    OWNMINUTES_VAULT_LIVE_VERIFY: "1",
    OWNMINUTES_VAULT_TOKEN_FILE: tokenFile,
    OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH: trackedEvidencePath,
  });
  const leastPrivilege = await runVerifier({
    ...commonEnv,
    OWNMINUTES_VAULT_LIVE_VERIFY: "1",
    OWNMINUTES_VAULT_TOKEN_FILE: tokenFile,
    OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH: evidencePath,
  });
  if (leastPrivilege.status !== 0 || !fs.existsSync(evidencePath)) {
    throw new Error(`Least-privilege live verifier failed: ${leastPrivilege.stderr.slice(0, 500)}`);
  }
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const mode = fs.statSync(evidencePath).mode & 0o777;
  const overprivileged = await runVerifier({
    ...commonEnv,
    OWNMINUTES_VAULT_LIVE_VERIFY: "1",
    OWNMINUTES_VAULT_TOKEN_FILE: rootTokenFile,
    OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH: overprivilegedEvidencePath,
  });
  fs.chmodSync(tokenFile, 0o644);
  const unsafeToken = await runVerifier({
    ...commonEnv,
    OWNMINUTES_VAULT_LIVE_VERIFY: "1",
    OWNMINUTES_VAULT_TOKEN_FILE: tokenFile,
    OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH: path.join(tempDir, "unsafe-token.json"),
  });

  const combined = [unauthorized, releaseMismatch, trackedDestination, leastPrivilege, overprivileged, unsafeToken]
    .map((item) => `${item.stdout}\n${item.stderr}`)
    .join("\n");
  const summary = {
    explicitAuthorizationRequired: unauthorized.status !== 0 && unauthorized.stderr.includes("explicit authorization"),
    releaseMismatchRejected: releaseMismatch.status !== 0 && releaseMismatch.stderr.includes("does not match"),
    trackedEvidenceDestinationRejected:
      trackedDestination.status !== 0 && trackedDestination.stderr.includes("must stay under .data") && !fs.existsSync(trackedEvidencePath),
    leastPrivilegeAccepted: leastPrivilege.status === 0,
    evidenceSchemaValid: evidence.schemaVersion === "ownminutes-vault-live-evidence:v1" && evidence.status === "test-pass",
    evidencePrivate: mode === 0o600,
    roundTripAndIsolationRecorded:
      evidence.checks?.syntheticRoundTrip === true &&
      evidence.checks?.userContextIsolation === true &&
      evidence.checks?.providerContextIsolation === true &&
      evidence.checks?.secretNameContextIsolation === true,
    leastPrivilegeDenialsRecorded: evidence.checks?.keyMetadataReadDenied === true && evidence.checks?.sysMountsReadDenied === true,
    overprivilegedTokenRejected:
      overprivileged.status !== 0 && overprivileged.stderr.includes("over-privileged") && !fs.existsSync(overprivilegedEvidencePath),
    unsafeTokenPermissionsRejected: unsafeToken.status !== 0 && unsafeToken.stderr.includes("0600 regular file"),
    ciphertextVersionRecordedWithoutCiphertext: evidence.ciphertextVersion === "v7" && !JSON.stringify(evidence).includes("vault:v7:"),
    allRequestsAuthenticated: requests.every((item) => item.tokenAccepted),
    noSensitiveOutput:
      ![leastToken, rootToken, keyName, "vault:v7:"].some((value) => combined.includes(value)) &&
      !JSON.stringify(evidence).includes(tokenFile),
    noSensitiveEvidence: evidence.leaksSecrets === false,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function runVerifier(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/verify-vault-transit-live.mjs"],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65_536) return reject(new Error("request too large"));
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}
