#!/usr/bin/env node

import crypto from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

loadDotEnvLocal();

const accessKeyId = process.env.VOLCANO_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.VOLCANO_SECRET_ACCESS_KEY?.trim();
const shouldCreate = process.argv.includes("--create-key");
const shouldCreateRealtimeKey = process.argv.includes("--create-realtime-key");
const shouldActivateFlash = process.argv.includes("--activate-flash");
const shouldActivateRealtime = process.argv.includes("--activate-realtime");
const projectName = process.env.VOLCANO_SPEECH_PROJECT_NAME?.trim() || "default";
const apiKeyName = process.env.VOLCANO_SPEECH_API_KEY_NAME?.trim() || "ownminutes";

if (!accessKeyId || !secretAccessKey) {
  fail("VOLCANO_ACCESS_KEY_ID or VOLCANO_SECRET_ACCESS_KEY is missing.");
}

const listResponse = await callSpeechOpenApi("ListAPIKeys", {
  ProjectName: projectName,
  OnlyAvailable: true,
});

if (!listResponse.ok) {
  fail(summarizeOpenApiError("ListAPIKeys", listResponse));
}

const availableKeys = findApiKeys(listResponse.body?.Result);
let apiKey = availableKeys[0]?.value ?? null;
let source = apiKey ? "existing" : "missing";

if (!apiKey && shouldCreate) {
  const createResponse = await callSpeechOpenApi("CreateAPIKey", {
    ProjectName: projectName,
    Name: apiKeyName,
  });
  if (!createResponse.ok) {
    fail(summarizeOpenApiError("CreateAPIKey", createResponse));
  }
  apiKey = findApiKeyValue(createResponse.body?.Result);
  source = "created";
  if (!apiKey) fail("CreateAPIKey succeeded but no API key value was returned.");
}

if (shouldCreateRealtimeKey) {
  const createResponse = await callSpeechOpenApi("CreateAPIKey", {
    ProjectName: projectName,
    Name: `${apiKeyName}-realtime-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`,
  });
  if (!createResponse.ok) {
    fail(summarizeOpenApiError("CreateAPIKey(realtime)", createResponse));
  }
  apiKey = findApiKeyValue(createResponse.body?.Result);
  source = "created-realtime";
  if (!apiKey) fail("CreateAPIKey(realtime) succeeded but no API key value was returned.");
}

let activation = null;
if (shouldActivateFlash) {
  const response = await callSpeechOpenApi("ActivateService", {
    ProjectName: projectName,
    ResourceID: "volc.bigasr.auc_turbo",
  });
  activation = {
    ok: response.ok,
    requestId: response.body?.ResponseMetadata?.RequestId || null,
    errorCode: response.body?.ResponseMetadata?.Error?.Code || null,
    errorMessage: response.body?.ResponseMetadata?.Error?.Message || null,
  };
  if (!response.ok) fail(summarizeOpenApiError("ActivateService", response));
}

let realtimeActivation = null;
if (shouldActivateRealtime) {
  const resourceId = process.env.VOLCANO_REALTIME_ASR_RESOURCE_ID?.trim() || "volc.seedasr.sauc.duration";
  const response = await callSpeechOpenApi("ActivateService", {
    ProjectName: projectName,
    ResourceID: resourceId,
  });
  realtimeActivation = {
    ok: response.ok,
    resourceId,
    requestId: response.body?.ResponseMetadata?.RequestId || null,
    errorCode: response.body?.ResponseMetadata?.Error?.Code || null,
    errorMessage: response.body?.ResponseMetadata?.Error?.Message || null,
    resultKeys: Object.keys(response.body?.Result || {}).sort(),
    status: response.body?.Result?.Status || null,
    instanceNumberPresent: Boolean(response.body?.Result?.InstanceNumber),
    clusterCount: Array.isArray(response.body?.Result?.Clusters) ? response.body.Result.Clusters.length : 0,
  };
  if (!response.ok) fail(summarizeOpenApiError("ActivateService(realtime)", response));
}

const grantedResourceId = apiKey ? await detectGrantedAsrResource(apiKey) : null;
if (apiKey) {
  upsertEnvLocal({
    VOLCANO_ASR_API_KEY: apiKey,
    VOLCANO_ASR_MODE: "flash",
    VOLCANO_ASR_RECOGNIZE_URL: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    VOLCANO_ASR_RESOURCE_ID: grantedResourceId || "volc.bigasr.auc_turbo",
    ...(shouldActivateRealtime
      ? {
          VOLCANO_ASR_WS_URL: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
          VOLCANO_REALTIME_ASR_RESOURCE_ID:
            process.env.VOLCANO_REALTIME_ASR_RESOURCE_ID?.trim() || "volc.seedasr.sauc.duration",
        }
      : {}),
  });
}

console.log(JSON.stringify({
  ok: Boolean(apiKey),
  action: shouldCreateRealtimeKey
    ? "create-realtime-speech-api-key"
    : shouldCreate
      ? "list-or-create-speech-api-key"
      : "list-speech-api-keys",
  availableKeyCount: availableKeys.length,
  keySource: source,
  keyValuePrinted: false,
  activation,
  realtimeActivation,
  grantedResourceId,
  wroteEnv: Boolean(apiKey),
  nextAction: apiKey
    ? "Run npm run provider:diagnostics, npm run volcano:asr-auth-probe, and npm run volcano:realtime-auth-probe."
    : "No available speech API key exists. Re-run with --create-key after confirming account permission.",
}, null, 2));

if (!apiKey) process.exitCode = 2;

async function detectGrantedAsrResource(apiKey) {
  const configured = process.env.VOLCANO_ASR_RESOURCE_ID?.trim();
  const candidates = [...new Set([
    configured,
    "volc.seedasr.auc",
    "volc.bigasr.auc",
    "volc.bigasr.auc_turbo",
  ].filter(Boolean))];
  const audio = createSilentWav().toString("base64");

  for (const resourceId of candidates) {
    const response = await fetch("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        "X-Api-Request-Id": crypto.randomUUID(),
        "X-Api-Resource-Id": resourceId,
        "X-Api-Sequence": "-1",
      },
      body: JSON.stringify({
        user: { uid: "ownminutes-bootstrap" },
        audio: { data: audio, format: "wav" },
        request: { model_name: "bigmodel", show_utterances: true },
      }),
    });
    const statusCode = response.headers.get("x-api-status-code");
    if (response.ok && (statusCode === "20000000" || statusCode === "20000003")) return resourceId;
  }
  return null;
}

function createSilentWav() {
  const sampleRate = 16000;
  const dataBytes = sampleRate;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataBytes, 40);
  return output;
}

async function callSpeechOpenApi(action, body) {
  const service = "speech_saas_prod";
  const region = "cn-beijing";
  const host = "open.volcengineapi.com";
  const version = "2025-05-20";
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = xDate.slice(0, 8);
  const query = new URLSearchParams({ Action: action, Version: version });
  const payload = JSON.stringify(body);
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-date:${xDate}\n`;
  const signedHeaders = "content-type;host;x-date";
  const payloadHash = sha256Hex(payload);
  const canonicalRequest = ["POST", "/", query.toString(), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = getSigningKey(secretAccessKey, shortDate, region, service);
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/?${query.toString()}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      Host: host,
      "X-Date": xDate,
    },
    body: payload,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text ? { text: text.slice(0, 300) } : null;
  }
  return {
    body: parsed,
    ok: response.ok && !parsed?.ResponseMetadata?.Error,
    status: response.status,
  };
}

function findApiKeys(result) {
  if (!result || typeof result !== "object") return [];
  const items = Array.isArray(result.APIKeys)
    ? result.APIKeys
    : Array.isArray(result.Items)
      ? result.Items
      : [];
  return items
    .map((item) => ({
      disabled: String(item?.Disable ?? item?.Disabled ?? "false") === "true",
      id: item?.ID ?? item?.Id ?? null,
      name: item?.Name ?? null,
      value: findApiKeyValue(item),
    }))
    .filter((item) => !item.disabled && item.value);
}

function findApiKeyValue(value) {
  if (!value || typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(api[-_]?key|apikey|key)$/i.test(key) && typeof nested === "string" && nested.length >= 20) {
      return nested;
    }
  }
  for (const nested of Object.values(value)) {
    const found = findApiKeyValue(nested);
    if (found) return found;
  }
  return null;
}

function summarizeOpenApiError(action, response) {
  const error = response.body?.ResponseMetadata?.Error;
  const code = typeof error?.Code === "string" ? error.Code : "unknown";
  const message = typeof error?.Message === "string" ? error.Message : `HTTP ${response.status}`;
  return `${action} failed: ${code}: ${redactSecrets(message)}`;
}

function upsertEnvLocal(updates) {
  const lines = existsSync(".env.local") ? readFileSync(".env.local", "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const index = line.indexOf("=");
    if (index < 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, index);
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  writeFileSync(".env.local", `${next.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  chmodSync(".env.local", 0o600);
}

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    process.env[trimmed.slice(0, index)] = stripQuotes(trimmed.slice(index + 1));
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function redactSecrets(value) {
  return [accessKeyId, secretAccessKey]
    .filter(Boolean)
    .reduce((output, secret) => output.split(secret).join("[redacted]"), String(value));
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function getSigningKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(Buffer.from(secret, "utf8"), date), region), service), "request");
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: redactSecrets(message), keyValuePrinted: false }, null, 2));
  process.exit(1);
}
