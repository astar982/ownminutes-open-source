import crypto from "crypto";
import path from "path";
import { readOrCreatePrivateSecret, readPrivateTextFile } from "./private-file.ts";

export type SecretProviderRuntime = "kms" | "local-app-secret" | "managed-secret-store";

export type ProviderSecretScope = {
  localSecretPath: string;
  providerId: string;
  secretName?: string;
  userId: string;
};

export type SecretProviderContract = {
  auditDelivery: "durable-transactional-outbox";
  contractVersion: "secret-provider-contract:v3";
  provider: SecretProviderRuntime;
  requiredRuntimeMethods: Array<"decryptProviderSecret" | "deleteProviderSecretReference" | "encryptProviderSecret" | "enqueueSecretAuditEvent">;
  runtimeAdapter: "local-aes-gcm" | "unsupported" | "vault-transit";
  runtimeReady: boolean;
  tenantScopedContext: string;
};

type VaultTransitConfig = {
  address: string;
  keyName: string;
  mount: string;
  namespace: string;
  tokenFile: string;
};

export function getSecretProviderContract(): SecretProviderContract {
  const provider = detectSecretProviderRuntime();
  const runtimeAdapter = detectRuntimeAdapter(provider);
  return {
    auditDelivery: "durable-transactional-outbox",
    contractVersion: "secret-provider-contract:v3",
    provider,
    requiredRuntimeMethods: ["encryptProviderSecret", "decryptProviderSecret", "deleteProviderSecretReference", "enqueueSecretAuditEvent"],
    runtimeAdapter,
    runtimeReady: runtimeAdapter !== "unsupported" && (runtimeAdapter !== "vault-transit" || vaultConfigReady()),
    tenantScopedContext: "provider-secret:v3:${userId}:${providerId}:${secretName}",
  };
}

export function detectSecretProviderRuntime(): SecretProviderRuntime {
  if (getEnv("OWNMINUTES_KMS_KEY_ID", "KMS_KEY_ID")) return "kms";
  if (getEnv("OWNMINUTES_SECRET_STORE", "SECRET_STORE_URL")) return "managed-secret-store";
  return "local-app-secret";
}

export async function encryptProviderSecret(secret: string, scope: ProviderSecretScope) {
  const contract = getSecretProviderContract();
  if (contract.runtimeAdapter === "vault-transit") return vaultEncrypt(secret, scope);
  if (contract.runtimeAdapter === "unsupported") throw new Error("Configured Secret Provider runtime adapter is unavailable.");

  const key = deriveProviderSecretKey(scope);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export async function decryptProviderSecret(encrypted: string, scope: ProviderSecretScope) {
  if (encrypted.startsWith("v3.vault.")) return vaultDecrypt(encrypted, scope);

  const parts = encrypted.split(".");
  const version = parts[0];
  const [ivText, tagText, ciphertextText] = version === "v2" ? parts.slice(1) : parts;
  if (!ivText || !tagText || !ciphertextText) throw new Error("Provider secret ciphertext is invalid.");

  const key = version === "v2" ? deriveProviderSecretKey(scope) : deriveLegacySecretKey(scope.localSecretPath);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

export async function deleteProviderSecretReference(scope: ProviderSecretScope) {
  return { deleted: true, providerId: scope.providerId, userId: scope.userId };
}

async function vaultEncrypt(secret: string, scope: ProviderSecretScope) {
  const config = getVaultConfig();
  const payload = await vaultRequest(config, "encrypt", {
    plaintext: Buffer.from(secret, "utf8").toString("base64"),
    context: vaultContext(scope),
  });
  const ciphertext = payload.data?.ciphertext;
  if (typeof ciphertext !== "string" || !ciphertext.startsWith("vault:")) throw new Error("Vault Transit encrypt response is invalid.");
  return `v3.vault.${Buffer.from(ciphertext, "utf8").toString("base64url")}`;
}

async function vaultDecrypt(encrypted: string, scope: ProviderSecretScope) {
  const config = getVaultConfig();
  const encodedCiphertext = encrypted.slice("v3.vault.".length);
  let ciphertext = "";
  try {
    ciphertext = decodeCanonicalBase64(encodedCiphertext, "base64url").toString("utf8");
  } catch {
    throw new Error("Vault Transit ciphertext is invalid.");
  }
  if (!ciphertext.startsWith("vault:")) throw new Error("Vault Transit ciphertext is invalid.");
  const payload = await vaultRequest(config, "decrypt", { ciphertext, context: vaultContext(scope) });
  const plaintext = payload.data?.plaintext;
  if (typeof plaintext !== "string") throw new Error("Vault Transit decrypt response is invalid.");
  try {
    return decodeCanonicalBase64(plaintext, "base64").toString("utf8");
  } catch {
    throw new Error("Vault Transit plaintext is invalid.");
  }
}

async function vaultRequest(config: VaultTransitConfig, operation: "decrypt" | "encrypt", body: Record<string, string>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  timeout.unref?.();
  try {
    const token = readPrivateToken(config.tokenFile);
    const response = await fetch(`${config.address}/v1/${config.mount}/${operation}/${encodeURIComponent(config.keyName)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Token": token,
        ...(config.namespace ? { "X-Vault-Namespace": config.namespace } : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readLimitedResponse(response, 65_536);
    if (!response.ok) throw new Error(`Vault Transit ${operation} failed with HTTP ${response.status}.`);
    try {
      return JSON.parse(text) as { data?: Record<string, unknown> };
    } catch {
      throw new Error(`Vault Transit ${operation} response is not JSON.`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Vault Transit ${operation} timed out.`);
    if (error instanceof Error && error.message.startsWith("Vault Transit ")) throw error;
    throw new Error(`Vault Transit ${operation} request failed.`);
  } finally {
    clearTimeout(timeout);
  }
}

function getVaultConfig(): VaultTransitConfig {
  if (detectRuntimeAdapter(detectSecretProviderRuntime()) !== "vault-transit") {
    throw new Error("Vault Transit Secret Provider is not selected.");
  }
  const address = normalizeVaultAddress(getEnv("OWNMINUTES_VAULT_ADDR"));
  const keyName = getEnv("OWNMINUTES_VAULT_TRANSIT_KEY");
  const mount = getEnv("OWNMINUTES_VAULT_TRANSIT_MOUNT") || "transit";
  const tokenFile = path.resolve(getEnv("OWNMINUTES_VAULT_TOKEN_FILE") || "");
  const namespace = getEnv("OWNMINUTES_VAULT_NAMESPACE");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(keyName)) throw new Error("Vault Transit key name is invalid.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(mount)) throw new Error("Vault Transit mount is invalid.");
  if (namespace && (/[^a-zA-Z0-9_./-]/.test(namespace) || namespace.includes(".."))) throw new Error("Vault namespace is invalid.");
  readPrivateToken(tokenFile);
  return { address, keyName, mount, namespace, tokenFile };
}

function normalizeVaultAddress(raw: string) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Vault address must be an absolute URL.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Vault address must not include credentials, path, query, or hash.");
  }
  const insecureLoopback =
    process.env.NODE_ENV !== "production" &&
    process.env.OWNMINUTES_VAULT_ALLOW_INSECURE_LOOPBACK_TEST === "1" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "https:" && !insecureLoopback) throw new Error("Vault address must use HTTPS.");
  return url.origin;
}

function readPrivateToken(file: string) {
  if (!file) throw new Error("Vault token file is missing.");
  let token = "";
  try {
    token = readPrivateTextFile(file, { allowReadOnlyContainerSecret: true }).trim();
  } catch {
    throw new Error("Vault token file must be owner-only or a read-only /run/secrets file.");
  }
  if (token.length < 8 || /[\r\n\0]/.test(token)) throw new Error("Vault token file is invalid.");
  return token;
}

function vaultContext(scope: ProviderSecretScope) {
  const secretName = scope.secretName?.trim();
  if (!secretName) throw new Error("Provider secret name is required for Vault Transit context.");
  return Buffer.from(`provider-secret:v3:${scope.userId}:${scope.providerId}:${secretName}`, "utf8").toString("base64");
}

function detectRuntimeAdapter(provider: SecretProviderRuntime): SecretProviderContract["runtimeAdapter"] {
  if (provider === "local-app-secret") return "local-aes-gcm";
  if (provider === "managed-secret-store" && getEnv("OWNMINUTES_SECRET_STORE") === "vault-transit") return "vault-transit";
  return "unsupported";
}

function vaultConfigReady() {
  try {
    getVaultConfig();
    return true;
  } catch {
    return false;
  }
}

async function readLimitedResponse(response: Response, limit: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Vault Transit response is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeCanonicalBase64(value: string, encoding: "base64" | "base64url") {
  const pattern = encoding === "base64" ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9_-]+$/;
  if (!value || !pattern.test(value)) throw new Error("Invalid base64 encoding.");
  const decoded = Buffer.from(value, encoding);
  const canonical = decoded.toString(encoding).replace(/=+$/u, "");
  if (canonical !== value.replace(/=+$/u, "")) throw new Error("Invalid base64 encoding.");
  return decoded;
}

function deriveProviderSecretKey(scope: ProviderSecretScope) {
  return crypto.createHmac("sha256", getLocalSecret(scope.localSecretPath)).update(`provider-secret:v2:${scope.userId}:${scope.providerId}`).digest();
}

function deriveLegacySecretKey(localSecretPath: string) {
  return crypto.createHash("sha256").update(getLocalSecret(localSecretPath)).digest();
}

function getLocalSecret(localSecretPath: string) {
  const envSecret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (envSecret && envSecret.length >= 32) return envSecret;
  return readOrCreatePrivateSecret(localSecretPath);
}

function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  return "";
}
