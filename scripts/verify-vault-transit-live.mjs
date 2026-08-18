#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const evidencePath = path.resolve(
  process.env.OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH || ".data/acceptance/vault-transit-live-latest.json",
);
const repoRoot = process.cwd();

async function main() {
  if (process.env.OWNMINUTES_VAULT_LIVE_VERIFY !== "1") {
    throw new Error("Live Vault verification requires OWNMINUTES_VAULT_LIVE_VERIFY=1 explicit authorization.");
  }
  if (process.env.OWNMINUTES_SECRET_STORE !== "vault-transit") {
    throw new Error("Live Vault verification requires OWNMINUTES_SECRET_STORE=vault-transit.");
  }
  const commit = gitCommit();
  if (commit === "unknown") throw new Error("Live Vault verification requires a Git checkout with a readable commit.");
  const allowDirtyTest = process.env.NODE_ENV !== "production" && process.env.OWNMINUTES_VAULT_LIVE_ALLOW_DIRTY_TEST === "1";
  if (gitDirty() && !allowDirtyTest) throw new Error("Live Vault verification requires a clean Git worktree.");
  const releaseId = process.env.OWNMINUTES_RELEASE_ID?.trim() || "";
  if (releaseId && releaseId !== commit) throw new Error("OWNMINUTES_RELEASE_ID does not match the checked-out commit.");
  ensurePrivateEvidenceDestination(evidencePath);

  const address = validateAddress(process.env.OWNMINUTES_VAULT_ADDR || "");
  const mount = validateMount(process.env.OWNMINUTES_VAULT_TRANSIT_MOUNT || "transit");
  const keyName = validateKeyName(process.env.OWNMINUTES_VAULT_TRANSIT_KEY || "");
  const namespace = validateNamespace(process.env.OWNMINUTES_VAULT_NAMESPACE || "");
  const tokenFile = path.resolve(process.env.OWNMINUTES_VAULT_TOKEN_FILE || "");
  const token = readPrivateToken(tokenFile);
  const { decryptProviderSecret, encryptProviderSecret, getSecretProviderContract } = await import("../src/lib/server/secret-provider.ts");

  const contract = getSecretProviderContract();
  if (
    contract.contractVersion !== "secret-provider-contract:v3" ||
    contract.auditDelivery !== "durable-transactional-outbox" ||
    contract.runtimeAdapter !== "vault-transit" ||
    !contract.runtimeReady
  ) {
    throw new Error("Vault Transit runtime contract is not ready.");
  }

  const suffix = crypto.randomBytes(12).toString("hex");
  const syntheticSecret = crypto.randomBytes(32).toString("base64url");
  const scope = {
    localSecretPath: path.join(path.dirname(evidencePath), "unused-local-secret"),
    userId: `vault-live-user-${suffix}`,
    providerId: `vault-live-provider-${suffix}`,
    secretName: `VAULT_LIVE_SECRET_${suffix}`,
  };
  const encrypted = await encryptProviderSecret(syntheticSecret, scope);
  const decrypted = await decryptProviderSecret(encrypted, scope);
  if (decrypted !== syntheticSecret) throw new Error("Vault Transit round trip did not recover the synthetic value.");

  const isolation = {
    user: await isContextRejected(() => decryptProviderSecret(encrypted, { ...scope, userId: `${scope.userId}-other` })),
    provider: await isContextRejected(() => decryptProviderSecret(encrypted, { ...scope, providerId: `${scope.providerId}-other` })),
    secretName: await isContextRejected(() => decryptProviderSecret(encrypted, { ...scope, secretName: `${scope.secretName}_OTHER` })),
  };
  if (!Object.values(isolation).every(Boolean)) throw new Error("Vault Transit context isolation did not reject every mismatched scope.");

  const keyMetadataStatus = await vaultReadStatus(address, mount, `keys/${encodeURIComponent(keyName)}`, token, namespace);
  const sysMountsStatus = await vaultReadStatus(address, "sys", "mounts", token, namespace);
  if (keyMetadataStatus !== 403 || sysMountsStatus !== 403) {
    throw new Error("Vault token is over-privileged; key metadata and sys/mounts reads must both return HTTP 403.");
  }

  const ciphertextVersion = readCiphertextVersion(encrypted);
  const secureTransport = new URL(address).protocol === "https:";
  const evidence = {
    schemaVersion: "ownminutes-vault-live-evidence:v1",
    generatedAt: new Date().toISOString(),
    commit,
    status: secureTransport ? "pass" : "test-pass",
    provider: "managed-secret-store",
    runtimeAdapter: "vault-transit",
    endpointHost: new URL(address).hostname,
    keyReferenceHash: crypto.createHash("sha256").update(`${mount}/${keyName}`).digest("hex").slice(0, 16),
    namespaceConfigured: Boolean(namespace),
    ciphertextVersion,
    checks: {
      contractReady: true,
      secureTransport,
      syntheticRoundTrip: true,
      userContextIsolation: isolation.user,
      providerContextIsolation: isolation.provider,
      secretNameContextIsolation: isolation.secretName,
      keyMetadataReadDenied: keyMetadataStatus === 403,
      sysMountsReadDenied: sysMountsStatus === 403,
      tokenFilePrivate: true,
      evidenceContainsNoPlaintext: true,
    },
    leaksSecrets: false,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  for (const forbidden of [syntheticSecret, token, encrypted, tokenFile, address, keyName]) {
    if (forbidden && serialized.includes(forbidden)) throw new Error("Vault live evidence would contain sensitive runtime material.");
  }
  writePrivateJson(evidencePath, serialized);

  console.log(
    JSON.stringify(
      {
        ok: true,
        status: evidence.status,
        provider: evidence.provider,
        runtimeAdapter: evidence.runtimeAdapter,
        ciphertextVersion,
        checks: evidence.checks,
        evidenceWritten: true,
        leaksSecrets: false,
      },
      null,
      2,
    ),
  );
}

function validateAddress(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Vault live address must be an absolute URL.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Vault live address must not contain credentials, path, query, or hash.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  const insecureTest =
    process.env.NODE_ENV !== "production" &&
    process.env.OWNMINUTES_VAULT_LIVE_ALLOW_INSECURE_TEST === "1" &&
    process.env.OWNMINUTES_VAULT_ALLOW_INSECURE_LOOPBACK_TEST === "1" &&
    loopback;
  if (url.protocol !== "https:" && !insecureTest) throw new Error("Vault live verification requires HTTPS.");
  return url.origin;
}

function validateMount(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error("Vault Transit mount is invalid.");
  return value;
}

function validateKeyName(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error("Vault Transit key name is invalid.");
  return value;
}

function validateNamespace(value) {
  if (value && (/[^a-zA-Z0-9_./-]/.test(value) || value.includes(".."))) throw new Error("Vault namespace is invalid.");
  return value;
}

function readPrivateToken(file) {
  if (!file || !fs.existsSync(file)) throw new Error("Vault token file is missing.");
  const stats = fs.statSync(file);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw new Error("Live Vault token source must be a 0600 regular file.");
  const token = fs.readFileSync(file, "utf8").trim();
  if (token.length < 8 || /[\r\n\0]/.test(token)) throw new Error("Vault token file is invalid.");
  return token;
}

async function vaultReadStatus(address, mount, resource, token, namespace) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  timeout.unref?.();
  try {
    const response = await fetch(`${address}/v1/${mount}/${resource}`, {
      method: "GET",
      headers: { "X-Vault-Token": token, ...(namespace ? { "X-Vault-Namespace": namespace } : {}) },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    await discardLimited(response, 65_536);
    return response.status;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Vault privilege probe timed out.");
    throw new Error("Vault privilege probe failed.");
  } finally {
    clearTimeout(timeout);
  }
}

async function discardLimited(response, limit) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Vault privilege response is too large.");
    }
  }
}

async function isContextRejected(operation) {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

function readCiphertextVersion(encrypted) {
  if (!encrypted.startsWith("v3.vault.")) throw new Error("Vault ciphertext envelope version is invalid.");
  const raw = Buffer.from(encrypted.slice("v3.vault.".length), "base64url").toString("utf8");
  const match = raw.match(/^vault:(v\d+):/);
  if (!match) throw new Error("Vault ciphertext version is missing.");
  return match[1];
}

function writePrivateJson(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function gitDirty() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Unable to inspect Git worktree state.");
  return result.stdout.trim().length > 0;
}

function ensurePrivateEvidenceDestination(file) {
  const relative = path.relative(repoRoot, file);
  const insideRepo = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (insideRepo && relative !== ".data" && !relative.startsWith(`.data${path.sep}`)) {
    throw new Error("Vault live evidence inside the repository must stay under .data/.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Vault live verification failed.");
  process.exit(1);
});
