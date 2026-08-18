#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-vault-runtime-"));
const tokenFile = path.join(tempDir, "vault-token");
const localSecretPath = path.join(tempDir, "local-secret");
const vaultToken = "vault-smoke-token-private";
const rawSecret = "provider-secret-value-never-log";
const vaultCiphertexts = new Map();
const requests = [];
let failureMode = "none";

fs.writeFileSync(tokenFile, vaultToken, { mode: 0o600 });

const server = http.createServer(async (request, response) => {
  try {
    const bodyText = await readBody(request);
    requests.push({
      method: request.method,
      path: request.url,
      tokenAccepted: request.headers["x-vault-token"] === vaultToken,
      namespaceAccepted: request.headers["x-vault-namespace"] === "team-ownminutes",
      body: bodyText,
    });
    if (request.headers["x-vault-token"] !== vaultToken || request.headers["x-vault-namespace"] !== "team-ownminutes") {
      return writeJson(response, 403, { errors: ["denied"] });
    }
    if (failureMode === "http") {
      return writeJson(response, 500, { errors: [`upstream failure ${vaultToken} ${rawSecret}`] });
    }
    if (failureMode === "redirect") {
      response.writeHead(302, { Location: `http://${request.headers.host}/redirect-target` });
      response.end();
      return;
    }
    if (failureMode === "oversized") {
      return writeJson(response, 200, { data: { ciphertext: `vault:v1:${"x".repeat(70_000)}` } });
    }

    const body = JSON.parse(bodyText || "{}");
    const encryptPath = "/v1/transit/encrypt/ownminutes-provider-secrets";
    const decryptPath = "/v1/transit/decrypt/ownminutes-provider-secrets";
    if (request.method === "POST" && request.url === encryptPath) {
      if (!isCanonicalBase64(body.plaintext) || !isCanonicalBase64(body.context)) return writeJson(response, 400, { errors: ["invalid payload"] });
      const ciphertext = `vault:v1:${randomUUID()}`;
      vaultCiphertexts.set(ciphertext, { plaintext: body.plaintext, context: body.context });
      return writeJson(response, 200, { data: { ciphertext } });
    }
    if (request.method === "POST" && request.url === decryptPath) {
      const stored = vaultCiphertexts.get(body.ciphertext);
      if (!stored || stored.context !== body.context) return writeJson(response, 400, { errors: ["ciphertext context mismatch"] });
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
if (!address || typeof address === "string") throw new Error("Fake Vault did not expose a TCP address.");

const managedEnv = {
  OWNMINUTES_SECRET_STORE: "vault-transit",
  OWNMINUTES_VAULT_ADDR: `http://127.0.0.1:${address.port}`,
  OWNMINUTES_VAULT_TRANSIT_KEY: "ownminutes-provider-secrets",
  OWNMINUTES_VAULT_TRANSIT_MOUNT: "transit",
  OWNMINUTES_VAULT_NAMESPACE: "team-ownminutes",
  OWNMINUTES_VAULT_TOKEN_FILE: tokenFile,
  OWNMINUTES_VAULT_ALLOW_INSECURE_LOOPBACK_TEST: "1",
};
Object.assign(process.env, managedEnv);
delete process.env.OWNMINUTES_KMS_KEY_ID;
delete process.env.KMS_KEY_ID;

try {
  const { decryptProviderSecret, encryptProviderSecret, getSecretProviderContract } = await import("../src/lib/server/secret-provider.ts");
  const scope = {
    localSecretPath,
    userId: "user-alpha",
    providerId: "volcano",
    secretName: "VOLCANO_ASR_API_KEY",
  };
  const contract = getSecretProviderContract();
  assert(contract.contractVersion === "secret-provider-contract:v3", "contract version is v3");
  assert(contract.auditDelivery === "durable-transactional-outbox", "audit delivery uses durable outbox");
  assert(contract.runtimeAdapter === "vault-transit" && contract.runtimeReady, "Vault runtime reports ready");

  const encrypted = await encryptProviderSecret(rawSecret, scope);
  assert(encrypted.startsWith("v3.vault."), "Vault ciphertext uses v3 envelope");
  assert(!encrypted.includes(rawSecret), "ciphertext does not contain plaintext");
  assert((await decryptProviderSecret(encrypted, scope)) === rawSecret, "Vault round trip succeeds");

  for (const changedScope of [
    { ...scope, userId: "user-beta" },
    { ...scope, providerId: "ark" },
    { ...scope, secretName: "VOLCANO_ASR_TOKEN" },
  ]) {
    await expectRejected(() => decryptProviderSecret(encrypted, changedScope), "HTTP 400");
  }
  await expectRejected(() => decryptProviderSecret("v3.vault.invalid", scope), "ciphertext is invalid");

  failureMode = "http";
  const upstreamError = await captureError(() => encryptProviderSecret(rawSecret, scope));
  failureMode = "none";
  assert(upstreamError.includes("HTTP 500"), "upstream HTTP status is retained");
  assert(!upstreamError.includes(vaultToken) && !upstreamError.includes(rawSecret), "upstream error is sanitized");

  failureMode = "redirect";
  const redirectError = await captureError(() => encryptProviderSecret(rawSecret, scope));
  failureMode = "none";
  assert(redirectError.includes("request failed"), "redirect is rejected with a sanitized error");
  assert(!requests.some((item) => item.path === "/redirect-target"), "Vault token is never forwarded through redirects");

  failureMode = "oversized";
  const oversizedError = await captureError(() => encryptProviderSecret(rawSecret, scope));
  failureMode = "none";
  assert(oversizedError.includes("response is too large"), "oversized Vault response is rejected");

  fs.chmodSync(tokenFile, 0o644);
  const permissionError = await captureError(() => encryptProviderSecret(rawSecret, scope));
  assert(permissionError.includes("owner-only or a read-only /run/secrets file"), "unsafe token permissions are rejected");
  assert(!permissionError.includes(vaultToken), "token content is never returned in permission errors");
  fs.chmodSync(tokenFile, 0o600);

  const tokenLink = path.join(tempDir, "vault-token-link");
  fs.symlinkSync(tokenFile, tokenLink);
  process.env.OWNMINUTES_VAULT_TOKEN_FILE = tokenLink;
  const tokenSymlinkError = await captureError(() => encryptProviderSecret(rawSecret, scope));
  assert(tokenSymlinkError.includes("owner-only or a read-only /run/secrets file"), "Vault token symlinks are rejected");
  process.env.OWNMINUTES_VAULT_TOKEN_FILE = tokenFile;

  process.env.NODE_ENV = "production";
  const productionHttpContract = getSecretProviderContract();
  const productionHttpError = await captureError(() => encryptProviderSecret(rawSecret, scope));
  assert(!productionHttpContract.runtimeReady, "production contract rejects insecure loopback Vault");
  assert(productionHttpError.includes("must use HTTPS"), "production runtime rejects the HTTP test exemption");
  delete process.env.NODE_ENV;

  delete process.env.OWNMINUTES_SECRET_STORE;
  delete process.env.OWNMINUTES_VAULT_ADDR;
  delete process.env.OWNMINUTES_APP_SECRET;
  delete process.env.AUTH_SECRET;
  const localSecretTarget = path.join(tempDir, "local-secret-target");
  fs.writeFileSync(localSecretTarget, "local-secret-through-symlink-must-not-load", { mode: 0o600 });
  fs.symlinkSync(localSecretTarget, localSecretPath);
  const localSecretSymlinkError = await captureError(() => encryptProviderSecret("legacy-compatible-value", scope));
  assert(localSecretSymlinkError.length > 0, "local secret symlinks are rejected");
  fs.unlinkSync(localSecretPath);
  process.env.OWNMINUTES_APP_SECRET = "local-compatibility-secret-0123456789abcdef";
  const localCiphertext = await encryptProviderSecret("legacy-compatible-value", scope);
  assert(localCiphertext.startsWith("v2."), "local compatibility ciphertext remains v2");
  Object.assign(process.env, managedEnv);
  assert((await decryptProviderSecret(localCiphertext, scope)) === "legacy-compatible-value", "Vault cutover can still read local v2 ciphertext");

  process.env.OWNMINUTES_KMS_KEY_ID = "declared-without-runtime";
  delete process.env.OWNMINUTES_SECRET_STORE;
  const unsupportedContract = getSecretProviderContract();
  const unsupportedError = await captureError(() => encryptProviderSecret(rawSecret, scope));
  assert(unsupportedContract.runtimeAdapter === "unsupported" && !unsupportedContract.runtimeReady, "unimplemented KMS reports unavailable");
  assert(unsupportedError.includes("runtime adapter is unavailable"), "unimplemented KMS fails closed");

  const summary = {
    contractV3DurableOutbox: true,
    vaultRuntimeReady: true,
    encryptedWithoutPlaintext: true,
    roundTrip: true,
    userIsolation: true,
    providerIsolation: true,
    secretNameIsolation: true,
    malformedCiphertextRejected: true,
    upstreamFailureSanitized: true,
    redirectsRejected: true,
    oversizedResponsesRejected: true,
    unsafeTokenPermissionsRejected: true,
    tokenSymlinksRejected: true,
    localSecretSymlinksRejected: true,
    productionHttpVaultRejected: true,
    legacyV2ReadableAfterCutover: true,
    unsupportedKmsFailsClosed: true,
    requestCount: requests.length,
    allRequestsAuthenticated: requests.every((item) => item.tokenAccepted && item.namespaceAccepted),
    rawPlaintextAbsentFromWireJson: requests.every((item) => !item.body.includes(rawSecret)),
    tokenAbsentFromWireJson: requests.every((item) => !item.body.includes(vaultToken)),
  };
  console.log(JSON.stringify(summary, null, 2));
  assert(Object.entries(summary).every(([key, value]) => key === "requestCount" || value === true), "all Vault runtime checks pass");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const key of [...Object.keys(managedEnv), "OWNMINUTES_KMS_KEY_ID", "KMS_KEY_ID", "OWNMINUTES_APP_SECRET", "AUTH_SECRET"]) delete process.env[key];
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new Error("request too large"));
        request.destroy();
        return;
      }
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

function isCanonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

async function captureError(operation) {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected operation to fail.");
}

async function expectRejected(operation, expectedMessage) {
  const message = await captureError(operation);
  assert(message.includes(expectedMessage), `rejection contains ${expectedMessage}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Vault Transit smoke failed: ${message}`);
}
