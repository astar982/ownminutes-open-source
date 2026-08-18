import { existsSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const envPath = ".env.local";
const existing = parseEnv(existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
const rl = readline.createInterface({ input, output });

const next = {
  ...existing,
  TRANSCRIPTION_PROVIDER: "volcano",
  VOLCANO_ASR_MODE: existing.VOLCANO_ASR_MODE || "flash",
  VOLCANO_ASR_RECOGNIZE_URL:
    existing.VOLCANO_ASR_RECOGNIZE_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  VOLCANO_ASR_RESOURCE_ID: existing.VOLCANO_ASR_RESOURCE_ID || "volc.bigasr.auc_turbo",
  VOLCANO_ASR_SUBMIT_URL:
    existing.VOLCANO_ASR_SUBMIT_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
  VOLCANO_ASR_QUERY_URL:
    existing.VOLCANO_ASR_QUERY_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
  VOLCANO_ASR_WS_URL: existing.VOLCANO_ASR_WS_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  VOLCANO_REALTIME_ASR_RESOURCE_ID:
    existing.VOLCANO_REALTIME_ASR_RESOURCE_ID || "volc.seedasr.sauc.duration",
  OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED: "1",
  OWNMINUTES_REALTIME_ASR_RUNTIME: existing.OWNMINUTES_REALTIME_ASR_RUNTIME || "stateful_node",
  OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY:
    existing.OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY || "ping-15s-stale-45s",
  OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY:
    existing.OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY || "fresh-session-bounded-no-audio-replay",
  OWNMINUTES_FINALIZATION_LEASE_MS: existing.OWNMINUTES_FINALIZATION_LEASE_MS || "900000",
  OWNMINUTES_FINALIZATION_MODE: existing.OWNMINUTES_FINALIZATION_MODE || "inline",
  OWNMINUTES_FINALIZATION_WORKER: existing.OWNMINUTES_FINALIZATION_WORKER || "0",
  OWNMINUTES_FINALIZATION_POLL_MS: existing.OWNMINUTES_FINALIZATION_POLL_MS || "2000",
  OWNMINUTES_FINALIZATION_JOB_LEASE_MS: existing.OWNMINUTES_FINALIZATION_JOB_LEASE_MS || "300000",
  OWNMINUTES_FINALIZATION_MAX_ATTEMPTS: existing.OWNMINUTES_FINALIZATION_MAX_ATTEMPTS || "5",
  OWNMINUTES_FINALIZATION_RETRY_BASE_MS: existing.OWNMINUTES_FINALIZATION_RETRY_BASE_MS || "15000",
  OWNMINUTES_MEETING_WRITE_LOCK: existing.OWNMINUTES_MEETING_WRITE_LOCK || "auto",
  OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS: existing.OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS || "15000",
  OWNMINUTES_POSTGRES_POOL_MAX: existing.OWNMINUTES_POSTGRES_POOL_MAX || "10",
  OWNMINUTES_POSTGRES_CONNECT_TIMEOUT_MS: existing.OWNMINUTES_POSTGRES_CONNECT_TIMEOUT_MS || "10000",
  OWNMINUTES_POSTGRES_IDLE_TIMEOUT_MS: existing.OWNMINUTES_POSTGRES_IDLE_TIMEOUT_MS || "30000",
  ARK_BASE_URL: existing.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
  EXPO_PUBLIC_API_BASE_URL: existing.EXPO_PUBLIC_API_BASE_URL || "http://localhost:3003",
};

console.log("This writes .env.local only. Values are not printed after entry.");

await promptSecret("VOLCANO_ACCESS_KEY_ID", "Volcano account AccessKey ID");
await promptSecret("VOLCANO_SECRET_ACCESS_KEY", "Volcano account SecretAccessKey");
await promptSecret("VOLCANO_ASR_API_KEY", "Volcano speech ASR API Key, if available");
await promptSecret("VOLCANO_ASR_APP_ID", "Volcano speech AppID/AppKey, if using AppID+Token");
await promptSecret("VOLCANO_ASR_TOKEN", "Volcano speech Token/AccessKey, if using AppID+Token");
await promptSecret("ARK_API_KEY", "Volcano Ark API Key");
await promptPlain("ARK_CHAT_MODEL", "Volcano Ark chat model ID");
await promptPlain("EXPO_PUBLIC_API_BASE_URL", "Mobile API base URL");

rl.close();
writeFileSync(envPath, formatEnv(next), { mode: 0o600 });

console.log("Wrote .env.local.");
console.log(
  JSON.stringify(
    {
      TRANSCRIPTION_PROVIDER: next.TRANSCRIPTION_PROVIDER,
      hasAccountAkSk: Boolean(next.VOLCANO_ACCESS_KEY_ID && next.VOLCANO_SECRET_ACCESS_KEY),
      hasFileAsrApiKey: Boolean(next.VOLCANO_ASR_API_KEY),
      hasFileAsrAppToken: Boolean(next.VOLCANO_ASR_APP_ID && next.VOLCANO_ASR_TOKEN),
      hasArkSummary: Boolean(next.ARK_API_KEY && next.ARK_CHAT_MODEL),
      mobileApiBaseUrl: next.EXPO_PUBLIC_API_BASE_URL,
    },
    null,
    2,
  ),
);

async function promptSecret(key, label) {
  const current = existing[key] ? "already set" : "empty";
  const answer = await rl.question(`${label} (${key}, ${current}; leave blank to keep): `);

  if (answer.trim()) {
    next[key] = answer.trim();
  }
}

async function promptPlain(key, label) {
  const current = existing[key] || next[key] || "empty";
  const answer = await rl.question(`${label} (${key}, current: ${current}; leave blank to keep): `);

  if (answer.trim()) {
    next[key] = answer.trim();
  }
}

function parseEnv(contents) {
  const env = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    env[key] = value;
  }

  return env;
}

function formatEnv(values) {
  const orderedKeys = [
    "TRANSCRIPTION_PROVIDER",
    "VOLCANO_ACCESS_KEY_ID",
    "VOLCANO_SECRET_ACCESS_KEY",
    "VOLCANO_ASR_API_KEY",
    "VOLCANO_ASR_APP_ID",
    "VOLCANO_ASR_TOKEN",
    "VOLCANO_ASR_CLUSTER",
    "VOLCANO_ASR_MODE",
    "VOLCANO_ASR_RECOGNIZE_URL",
    "VOLCANO_ASR_RESOURCE_ID",
    "VOLCANO_ASR_SUBMIT_URL",
    "VOLCANO_ASR_QUERY_URL",
    "VOLCANO_ASR_WS_URL",
    "VOLCANO_REALTIME_ASR_RESOURCE_ID",
    "OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED",
    "OWNMINUTES_REALTIME_ASR_RUNTIME",
    "OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY",
    "OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY",
    "OWNMINUTES_FINALIZATION_LEASE_MS",
    "OWNMINUTES_FINALIZATION_MODE",
    "OWNMINUTES_FINALIZATION_WORKER",
    "OWNMINUTES_FINALIZATION_POLL_MS",
    "OWNMINUTES_FINALIZATION_JOB_LEASE_MS",
    "OWNMINUTES_FINALIZATION_MAX_ATTEMPTS",
    "OWNMINUTES_FINALIZATION_RETRY_BASE_MS",
    "OWNMINUTES_MEETING_WRITE_LOCK",
    "OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS",
    "OWNMINUTES_POSTGRES_POOL_MAX",
    "OWNMINUTES_POSTGRES_CONNECT_TIMEOUT_MS",
    "OWNMINUTES_POSTGRES_IDLE_TIMEOUT_MS",
    "ARK_API_KEY",
    "ARK_BASE_URL",
    "ARK_CHAT_MODEL",
    "EXPO_PUBLIC_API_BASE_URL",
  ];

  const orderedSet = new Set(orderedKeys);
  const remainingKeys = Object.keys(values)
    .filter((key) => !orderedSet.has(key))
    .sort();
  return `${[...orderedKeys, ...remainingKeys].map((key) => `${key}=${values[key] || ""}`).join("\n")}\n`;
}
