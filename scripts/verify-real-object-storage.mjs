#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const evidencePath = process.env.OWNMINUTES_REAL_STORAGE_EVIDENCE_PATH || ".data/acceptance/object-storage-live-latest.json";
const allowLocalEndpoint = process.env.OWNMINUTES_REAL_OBJECT_STORAGE_ALLOW_LOCAL === "1";

if (process.env.OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE !== "1") {
  throw new Error("Refusing to touch remote storage without OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE=1.");
}

const provider = detectProvider();
const config = providerConfig(provider);
validateConfig(provider, config);

const { getMeetingObjectStore } = await import("../src/lib/server/meeting-object-store.ts");
const store = getMeetingObjectStore();
if (store.provider === "local") throw new Error("The meeting object store resolved to local storage.");

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const meetingId = `storage-live-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
const keys = {
  manifest: `${meetingId}/manifest.json`,
  audio: `${meetingId}/chunks/chunk-000001.webm`,
  result: `${meetingId}/result.json`,
  markdown: `${meetingId}/obsidian.md`,
  processing: `${meetingId}/processing.json`,
};
const payloads = {
  manifest: JSON.stringify({ meetingId, totalChunks: 1, totalBytes: 24 }),
  audio: crypto.randomBytes(24),
  result: JSON.stringify({ meetingId, status: "verified" }),
  markdown: `# ${meetingId}\n\nStorage acceptance.\n`,
  processing: JSON.stringify({ meetingId, status: "completed" }),
};

let summary;
const uploadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-storage-file-put-"));
const uploadFilePath = path.join(uploadDirectory, "audio.bin");
const downloadFilePath = path.join(uploadDirectory, "downloaded-audio.bin");
fs.writeFileSync(uploadFilePath, payloads.audio, { mode: 0o600 });
try {
  await store.putText(keys.manifest, payloads.manifest);
  await store.putFile(keys.audio, uploadFilePath);
  await store.putText(keys.result, payloads.result);
  await store.putText(keys.markdown, payloads.markdown);
  await store.putText(keys.processing, payloads.processing);

  const manifest = await store.getText(keys.manifest);
  const audio = await store.getBuffer(keys.audio);
  const downloadedBytes = await store.getFile(keys.audio, downloadFilePath);
  const downloadedAudio = fs.readFileSync(downloadFilePath);
  const privateAudioUrl = await store.createPresignedGetUrl(keys.audio, 300);
  if (!privateAudioUrl) throw new Error("Remote object storage did not create a private read URL.");
  const privateAudioResponse = await fetch(privateAudioUrl);
  const privateAudio = Buffer.from(await privateAudioResponse.arrayBuffer());
  const result = await store.getText(keys.result);
  const markdown = await store.getText(keys.markdown);
  const processing = await store.getText(keys.processing);
  const listed = await store.listTopLevelPrefixes();
  const publicResponse = await fetch(publicObjectUrl(config, `${config.keyPrefix}/${keys.audio}`));

  await store.deletePrefix(meetingId);
  const afterDelete = await store.listTopLevelPrefixes();
  let deletedReadRejected = false;
  try {
    await store.getBuffer(keys.audio);
  } catch {
    deletedReadRejected = true;
  }

  summary = {
    checkedAt: new Date().toISOString(),
    provider,
    endpointHost: new URL(config.endpoint).hostname,
    bucketHash: crypto.createHash("sha256").update(config.bucket).digest("hex").slice(0, 12),
    keyPrefixConfigured: Boolean(config.keyPrefix),
    put: true,
    filePut: true,
    fileGet: downloadedBytes === payloads.audio.byteLength && downloadedAudio.equals(payloads.audio),
    presignedGet: privateAudioResponse.ok && privateAudio.equals(payloads.audio),
    get: manifest === payloads.manifest && audio.equals(payloads.audio),
    list: listed.includes(meetingId),
    manifestWriteRead: manifest === payloads.manifest,
    audioWriteRead: audio.equals(payloads.audio),
    resultWriteRead: result === payloads.result,
    markdownWriteRead: markdown === payloads.markdown,
    processingWriteRead: processing === payloads.processing,
    privateAccess: !publicResponse.ok,
    publicAccessStatus: publicResponse.status,
    deletePrefix: true,
    topLevelPrefixVisibleAfterDelete: afterDelete.includes(meetingId),
    deletedReadRejected,
    cleanupComplete: deletedReadRejected,
    secretsLeaked: false,
  };
} finally {
  await store.deletePrefix(meetingId).catch(() => undefined);
  fs.rmSync(uploadDirectory, { force: true, recursive: true });
}

fs.mkdirSync(path.dirname(path.resolve(rootDir, evidencePath)), { recursive: true });
fs.writeFileSync(path.resolve(rootDir, evidencePath), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));

if (!Object.entries(summary).filter(([key]) => ["put", "filePut", "fileGet", "presignedGet", "get", "list", "manifestWriteRead", "audioWriteRead", "resultWriteRead", "markdownWriteRead", "processingWriteRead", "privateAccess", "deletePrefix", "deletedReadRejected", "cleanupComplete"].includes(key)).every(([, value]) => value === true)) {
  process.exitCode = 1;
}

function detectProvider() {
  if (hasAny(["VOLCANO_TOS_BUCKET", "TOS_BUCKET", "VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"])) return "volcano-tos";
  if (hasAny(["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"])) return "r2";
  if (hasAny(["S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"])) return "s3";
  return "local";
}

function providerConfig(providerName) {
  if (providerName === "volcano-tos") return { bucket: env("VOLCANO_TOS_BUCKET", "TOS_BUCKET"), endpoint: env("VOLCANO_TOS_ENDPOINT", "TOS_ENDPOINT"), keyPrefix: env("OWNMINUTES_STORAGE_PREFIX"), accessKey: env("VOLCANO_TOS_ACCESS_KEY_ID", "TOS_ACCESS_KEY_ID", "VOLCANO_ACCESS_KEY_ID"), secretKey: env("VOLCANO_TOS_SECRET_ACCESS_KEY", "TOS_SECRET_ACCESS_KEY", "VOLCANO_SECRET_ACCESS_KEY") };
  if (providerName === "r2") return { bucket: env("R2_BUCKET"), endpoint: env("R2_ENDPOINT"), keyPrefix: env("OWNMINUTES_STORAGE_PREFIX"), accessKey: env("R2_ACCESS_KEY_ID"), secretKey: env("R2_SECRET_ACCESS_KEY") };
  if (providerName === "s3") return { bucket: env("S3_BUCKET"), endpoint: env("S3_ENDPOINT"), keyPrefix: env("OWNMINUTES_STORAGE_PREFIX"), accessKey: env("S3_ACCESS_KEY_ID"), secretKey: env("S3_SECRET_ACCESS_KEY") };
  return { bucket: "", endpoint: "", keyPrefix: "", accessKey: "", secretKey: "" };
}

function validateConfig(providerName, provider) {
  if (providerName === "local") throw new Error("No remote object storage provider is configured.");
  if (!provider.bucket || !provider.endpoint) throw new Error("Remote bucket and endpoint are required.");
  if (!provider.accessKey || !provider.secretKey) throw new Error("Remote object storage credentials are required.");
  if (!provider.keyPrefix) throw new Error("OWNMINUTES_STORAGE_PREFIX is required to isolate acceptance objects.");
  const url = new URL(provider.endpoint);
  if (url.protocol !== "https:" && !allowLocalEndpoint) throw new Error("The real storage endpoint must use HTTPS.");
  if (isLocalHost(url.hostname) && !allowLocalEndpoint) throw new Error("The real storage endpoint cannot be localhost or LAN.");
}

function publicObjectUrl(provider, key) {
  const endpoint = provider.endpoint.replace(/\/$/, "");
  return `${endpoint}/${encodeURIComponent(provider.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function env(...names) {
  for (const name of names) if (process.env[name]) return process.env[name];
  return "";
}

function hasAny(names) {
  return names.some((name) => Boolean(process.env[name]));
}

function isLocalHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
