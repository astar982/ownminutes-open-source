#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-vault-repository-"));
const authDataDir = path.join(tempDir, "auth");
const tokenFile = path.join(tempDir, "vault-token");
const token = "vault-repository-smoke-token";
const firstApiKey = "repository-first-api-key-never-log";
const firstToken = "repository-first-token-never-log";
const rotatedApiKey = "repository-rotated-api-key-never-log";
const port = 37_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const vaultRecords = new Map();
const vaultRequests = [];
let failEncrypt = false;
let appServer;

fs.writeFileSync(tokenFile, token, { mode: 0o600 });

const vaultServer = http.createServer(async (request, response) => {
  try {
    const bodyText = await readBody(request);
    const body = JSON.parse(bodyText || "{}");
    vaultRequests.push({ path: request.url, body: bodyText, authenticated: request.headers["x-vault-token"] === token });
    if (request.headers["x-vault-token"] !== token) return writeJson(response, 403, { errors: ["denied"] });
    if (request.url === "/v1/transit/encrypt/ownminutes-provider-secrets") {
      if (failEncrypt) return writeJson(response, 503, { errors: [`do not leak ${token} ${rotatedApiKey}`] });
      const ciphertext = `vault:v1:${randomUUID()}`;
      vaultRecords.set(ciphertext, { plaintext: body.plaintext, context: body.context });
      return writeJson(response, 200, { data: { ciphertext } });
    }
    if (request.url === "/v1/transit/decrypt/ownminutes-provider-secrets") {
      const stored = vaultRecords.get(body.ciphertext);
      if (!stored || stored.context !== body.context) return writeJson(response, 400, { errors: ["context mismatch"] });
      return writeJson(response, 200, { data: { plaintext: stored.plaintext } });
    }
    return writeJson(response, 404, { errors: ["not found"] });
  } catch {
    return writeJson(response, 400, { errors: ["invalid request"] });
  }
});

await new Promise((resolve, reject) => {
  vaultServer.once("error", reject);
  vaultServer.listen(0, "127.0.0.1", resolve);
});
const vaultAddress = vaultServer.address();
if (!vaultAddress || typeof vaultAddress === "string") throw new Error("Fake Vault did not expose a TCP address.");
const auditHeartbeatPath = path.join(tempDir, ".rotation-heartbeat.json");
fs.writeFileSync(
  auditHeartbeatPath,
  `${JSON.stringify({ ok: true, checkedAt: new Date().toISOString() })}\n`,
  { mode: 0o600 },
);

let appOutput = "";
try {
  appServer = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      TRANSCRIPTION_PROVIDER: "mock",
      OWNMINUTES_AUTH_REPOSITORY: "local-file",
      OWNMINUTES_AUTH_DATA_DIR: authDataDir,
      OWNMINUTES_APP_SECRET: "vault-repository-session-secret-0123456789",
      OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE: "1",
      OWNMINUTES_ALLOW_FIRST_USER_ADMIN: "1",
      OWNMINUTES_REQUIRE_EMAIL_VERIFICATION: "0",
      OWNMINUTES_KMS_KEY_ID: "",
      KMS_KEY_ID: "",
      OWNMINUTES_SECRET_STORE: "vault-transit",
      OWNMINUTES_VAULT_ADDR: `http://127.0.0.1:${vaultAddress.port}`,
      OWNMINUTES_VAULT_TRANSIT_KEY: "ownminutes-provider-secrets",
      OWNMINUTES_VAULT_TRANSIT_MOUNT: "transit",
      OWNMINUTES_VAULT_TOKEN_FILE: tokenFile,
      OWNMINUTES_VAULT_ALLOW_INSECURE_LOOPBACK_TEST: "1",
      OWNMINUTES_SECRET_ROTATION_POLICY: "90 day rotation",
      OWNMINUTES_SECRET_AUDIT_LOG: path.join(tempDir, "secret-audit.jsonl"),
      OWNMINUTES_SECRET_AUDIT_EXTERNAL_ROTATION: "1",
      OWNMINUTES_SECRET_AUDIT_ROTATION_HEARTBEAT_FILE: auditHeartbeatPath,
      OWNMINUTES_SECRET_AUDIT_ROTATION_INTERVAL_SECONDS: "300",
      OWNMINUTES_TENANT_SCOPED_KEYS: "user provider secret-name context",
      OWNMINUTES_SECRET_DELETION_PROOF: "account deletion evidence",
      OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY: "admin plaintext denied",
      OWNMINUTES_SECRET_LOCAL_SECRET_DECISION: "legacy local key isolated",
      OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT: "security alert route",
      OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY: "Vault recovery drill",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  appServer.stdout.on("data", (chunk) => (appOutput += String(chunk)));
  appServer.stderr.on("data", (chunk) => (appOutput += String(chunk)));
  await waitForServer();

  const email = `vault-repository-${Date.now()}@ownminutes.local`;
  const password = `OwnMinutesVault-${Date.now()}`;
  const register = await requestJson("/api/auth/register", { method: "POST", body: { name: "Vault Repository Smoke", email, password } });
  const cookie = register.response.headers.get("set-cookie")?.split(";")[0] || "";
  assert(register.response.ok && cookie, "register creates an authenticated session");

  const saved = await requestJson("/api/account/provider-credentials", {
    method: "POST",
    cookie,
    body: {
      providerId: "volcano-asr",
      label: "Vault ASR",
      fields: { VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo" },
      secrets: { VOLCANO_ASR_API_KEY: firstApiKey, VOLCANO_ASR_TOKEN: firstToken },
    },
  });
  assert(saved.response.ok, "provider credential save succeeds through Vault");
  const storePath = path.join(authDataDir, "store.json");
  const storeAfterSave = readStore(storePath);
  const credentialAfterSave = storeAfterSave.providerCredentials[0];
  const storedTextAfterSave = JSON.stringify(storeAfterSave);
  assert(Object.values(credentialAfterSave.encryptedSecrets).every((value) => value.startsWith("v3.vault.")), "repository stores only v3 Vault envelopes");
  assert(![firstApiKey, firstToken, token].some((value) => storedTextAfterSave.includes(value)), "repository file contains no plaintext or Vault token");

  const listed = await requestJson("/api/account/provider-credentials", { cookie });
  const listedText = JSON.stringify(listed.payload);
  assert(listed.response.ok && listed.payload.providerCredentials?.length === 1, "credential list returns saved provider");
  assert(!listedText.includes(firstApiKey) && !listedText.includes(firstToken), "credential list never returns plaintext");

  const health = await requestJson("/api/account/provider-health?providerId=volcano-asr", { cookie });
  assert(health.response.ok, "provider health reads and decrypts Vault-backed configuration");
  assert(vaultRequests.some((item) => item.path?.includes("/decrypt/")), "repository read reached Vault decrypt");

  const readyDiagnostics = await requestJson("/api/secrets/diagnostics", { cookie });
  assert(readyDiagnostics.payload.diagnostics?.configured?.providerRuntime === true, "diagnostics reports valid Vault runtime configuration");
  assert(readyDiagnostics.payload.diagnostics?.configured?.providerTransportSecure === false, "diagnostics identifies loopback HTTP as test-only transport");
  assert(readyDiagnostics.payload.diagnostics?.productionReady === false, "test-only HTTP Vault never becomes production-ready");
  fs.chmodSync(tokenFile, 0o644);
  const unsafeDiagnostics = await requestJson("/api/secrets/diagnostics", { cookie });
  assert(unsafeDiagnostics.payload.diagnostics?.configured?.providerRuntime === false, "diagnostics rejects unsafe token permissions at runtime");
  assert(unsafeDiagnostics.payload.diagnostics?.productionReady === false, "unsafe token permissions clear production readiness");
  fs.chmodSync(tokenFile, 0o600);

  const ciphertextBeforeFailure = credentialAfterSave.encryptedSecrets.VOLCANO_ASR_API_KEY;
  failEncrypt = true;
  const failedRotation = await requestJson("/api/account/provider-credentials", {
    method: "POST",
    cookie,
    allowError: true,
    body: { providerId: "volcano-asr", secrets: { VOLCANO_ASR_API_KEY: rotatedApiKey } },
  });
  failEncrypt = false;
  const storeAfterFailure = readStore(storePath);
  assert(failedRotation.response.status === 500, "Vault outage returns a controlled save failure");
  assert(storeAfterFailure.providerCredentials[0].encryptedSecrets.VOLCANO_ASR_API_KEY === ciphertextBeforeFailure, "failed rotation does not alter persisted ciphertext");
  assert(!JSON.stringify(failedRotation.payload).includes(rotatedApiKey) && !JSON.stringify(failedRotation.payload).includes(token), "save failure response is sanitized");

  const rotated = await requestJson("/api/account/provider-credentials", {
    method: "POST",
    cookie,
    body: { providerId: "volcano-asr", secrets: { VOLCANO_ASR_API_KEY: rotatedApiKey }, removeSecrets: ["VOLCANO_ASR_TOKEN"] },
  });
  const storeAfterRotation = readStore(storePath);
  const rotatedCredential = storeAfterRotation.providerCredentials[0];
  assert(rotated.response.ok, "provider secret rotation succeeds");
  assert(rotatedCredential.encryptedSecrets.VOLCANO_ASR_API_KEY !== ciphertextBeforeFailure, "rotation replaces ciphertext");
  assert(!("VOLCANO_ASR_TOKEN" in rotatedCredential.encryptedSecrets), "explicit secret removal is persisted");

  const deleteAccount = await requestJson("/api/auth/delete", { method: "DELETE", cookie, body: { confirmation: "DELETE" } });
  const storeAfterDelete = readStore(storePath);
  assert(deleteAccount.response.ok, "account deletion succeeds");
  assert(storeAfterDelete.providerCredentials.length === 0, "account deletion removes Vault-backed provider ciphertexts");

  const combinedOutput = `${appOutput}\n${JSON.stringify({ saved: saved.payload, listed: listed.payload, health: health.payload, failed: failedRotation.payload })}`;
  const summary = {
    registerAndSession: true,
    repositorySaveUsesVaultV3: true,
    repositoryReadUsesVaultDecrypt: true,
    diagnosticsValidateRuntimeTokenFile: true,
    listDoesNotRevealSecrets: true,
    failedRotationIsAtomic: true,
    failedRotationIsSanitized: true,
    rotationAndRemovalPersist: true,
    accountDeletionRemovesCiphertexts: true,
    vaultRequestsAuthenticated: vaultRequests.every((item) => item.authenticated),
    rawSecretsAbsentFromAppOutput: ![firstApiKey, firstToken, rotatedApiKey, token].some((value) => combinedOutput.includes(value)),
    rawSecretsAbsentFromVaultJson: vaultRequests.every((item) => ![firstApiKey, firstToken, rotatedApiKey, token].some((value) => item.body.includes(value))),
    vaultEncryptRequests: vaultRequests.filter((item) => item.path?.includes("/encrypt/")).length,
    vaultDecryptRequests: vaultRequests.filter((item) => item.path?.includes("/decrypt/")).length,
  };
  console.log(JSON.stringify(summary, null, 2));
  assert(Object.entries(summary).every(([key, value]) => key.endsWith("Requests") || value === true), "all repository integration checks pass");
} finally {
  if (appServer && appServer.exitCode === null) appServer.kill("SIGTERM");
  await new Promise((resolve) => vaultServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function requestJson(apiPath, options = {}) {
  const method = options.method || "GET";
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      ...(method !== "GET" && method !== "HEAD" ? { "Sec-Fetch-Site": "same-origin" } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const text = await response.text();
  const payload = JSON.parse(text);
  if (!response.ok && !options.allowError) throw new Error(`HTTP ${response.status} from ${apiPath}: ${JSON.stringify(payload)}`);
  return { response, payload };
}

function readStore(storePath) {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (appServer.exitCode !== null) throw new Error(`Vault repository app exited early: ${appOutput.slice(-1_000)}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Vault repository app: ${appOutput.slice(-1_000)}`);
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

function assert(condition, message) {
  if (!condition) throw new Error(`Vault repository smoke failed: ${message}`);
}
