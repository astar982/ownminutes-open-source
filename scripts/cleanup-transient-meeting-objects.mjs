#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";

const loop = process.argv.includes("--loop");
const once = process.argv.includes("--once") || !loop;
const healthcheck = process.argv.includes("--healthcheck");
const HEARTBEAT_PATH = "/tmp/ownminutes-transient-cleanup-heartbeat.json";

if (healthcheck) {
  assertHealthyHeartbeat();
} else {
  const config = readConfig();
  if (once) {
    const result = await sweep(config, effectiveNow());
    writeHeartbeat(result);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    while (true) {
      let succeeded = false;
      try {
        const result = await sweep(config, Date.now());
        writeHeartbeat(result);
        succeeded = true;
        console.log(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        console.error(JSON.stringify({
          ok: false,
          errorType: error instanceof Error ? error.name : "UnknownCleanupError",
        }));
      }
      const delaySeconds = succeeded ? config.intervalSeconds : Math.min(config.intervalSeconds, 60);
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
    }
  }
}

function writeHeartbeat(result) {
  const temporaryPath = `${HEARTBEAT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      completedAt: new Date().toISOString(),
      deleted: result.deleted,
      scanned: result.scanned,
    })}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporaryPath, HEARTBEAT_PATH);
  fs.chmodSync(HEARTBEAT_PATH, 0o600);
}

function assertHealthyHeartbeat() {
  const intervalSeconds = boundedInteger(
    "OWNMINUTES_TRANSIENT_CLEANUP_INTERVAL_SECONDS",
    21_600,
    300,
    86_400,
  );
  let stats;
  try {
    stats = fs.statSync(HEARTBEAT_PATH);
  } catch {
    process.exitCode = 1;
    return;
  }
  const maximumAgeMs = (intervalSeconds + 300) * 1_000;
  if (!stats.isFile() || Date.now() - stats.mtimeMs > maximumAgeMs) {
    process.exitCode = 1;
  }
}

async function sweep(input, nowMs) {
  const versions = await listObjectVersions(input);
  const candidates = versions.filter((version) => {
    const retentionDays = retentionForKey(input, version.key);
    if (!retentionDays) return false;
    const modifiedAt = Date.parse(version.lastModified);
    return Number.isFinite(modifiedAt) && modifiedAt < nowMs - retentionDays * 86_400_000;
  });

  for (const version of candidates) {
    await signedRequest(input, {
      key: version.key,
      method: "DELETE",
      query: new URLSearchParams({ versionId: version.versionId }),
    });
  }

  return {
    deleted: candidates.length,
    scanned: versions.length,
  };
}

async function listObjectVersions(input) {
  const versions = [];
  let keyMarker = "";
  let versionIdMarker = "";
  const seenMarkers = new Set();
  let pages = 0;

  do {
    pages += 1;
    if (pages > 10_000) throw new CleanupConfigurationError("Object version listing exceeded the pagination limit.");
    const query = new URLSearchParams({
      prefix: `${input.keyPrefix}/`,
      versions: "",
    });
    if (keyMarker) query.set("key-marker", keyMarker);
    if (versionIdMarker) query.set("version-id-marker", versionIdMarker);
    const response = await signedRequest(input, {
      key: "",
      method: "GET",
      query,
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > 4 * 1024 * 1024) {
      throw new CleanupConfigurationError("Object listing page exceeded the response limit.");
    }
    const xml = body.toString("utf8");
    if (!/<ListVersionsResult(?:\s|>)/.test(xml)) {
      throw new CleanupConfigurationError("Object store returned an invalid version listing response.");
    }
    const contentsPattern = /<(?:Version|DeleteMarker)>([\s\S]*?)<\/(?:Version|DeleteMarker)>/g;
    let match;
    while ((match = contentsPattern.exec(xml))) {
      const key = extractXmlValue(match[1], "Key");
      const versionId = extractXmlValue(match[1], "VersionId");
      const lastModified = extractXmlValue(match[1], "LastModified");
      if (!key || !versionId || !lastModified) {
        throw new CleanupConfigurationError("Object version listing contained an incomplete entry.");
      }
      versions.push({ key, lastModified, versionId });
    }
    const truncated = extractXmlValue(xml, "IsTruncated").trim().toLowerCase() === "true";
    if (!truncated) break;
    keyMarker = extractXmlValue(xml, "NextKeyMarker");
    versionIdMarker = extractXmlValue(xml, "NextVersionIdMarker");
    if (!keyMarker) throw new CleanupConfigurationError("Object version listing omitted its next key marker.");
    const marker = `${keyMarker}\u0000${versionIdMarker}`;
    if (seenMarkers.has(marker)) {
      throw new CleanupConfigurationError("Object version listing pagination did not make progress.");
    }
    seenMarkers.add(marker);
  } while (true);

  return versions;
}

function retentionForKey(input, key) {
  if (!key.startsWith(`${input.keyPrefix}/`)) return 0;
  const relative = key.slice(input.keyPrefix.length + 1);
  const segments = relative.split("/");
  if (segments.length < 3 || !segments[0]) return 0;
  if (segments[1] === "transient") return input.transientRetentionDays;
  if (segments[1] === "uploads") return input.uploadRetentionDays;
  return 0;
}

async function signedRequest(input, request) {
  const url = new URL(`${input.endpoint}/${encodeURIComponent(input.bucket)}${request.key ? `/${encodeObjectKey(request.key)}` : ""}`);
  for (const [name, value] of request.query?.entries() || []) url.searchParams.set(name, value);
  const headers = signAwsV4({
    accessKeyId: input.accessKeyId,
    method: request.method,
    region: input.region,
    secretAccessKey: input.secretAccessKey,
    url,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Cleanup object request timed out.")), 15_000);
  timer.unref?.();
  let response;
  try {
    response = await fetch(url, {
      headers,
      method: request.method,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new CleanupObjectStoreError(request.method, response.status);
  }
  return response;
}

function readConfig() {
  const endpoint = parseEndpoint(required("S3_ENDPOINT"));
  const bucket = required("S3_BUCKET");
  const accessKeyId = required("S3_ACCESS_KEY_ID");
  const secretAccessKey = required("S3_SECRET_ACCESS_KEY");
  const keyPrefix = normalizePrefix(process.env.OWNMINUTES_STORAGE_PREFIX || "ownminutes/meetings");
  const transientRetentionDays = boundedInteger("OWNMINUTES_TRANSIENT_RETENTION_DAYS", 7, 1, 30);
  const uploadRetentionDays = boundedInteger("OWNMINUTES_UPLOAD_RETENTION_DAYS", 2, 1, 14);
  const intervalSeconds = boundedInteger("OWNMINUTES_TRANSIENT_CLEANUP_INTERVAL_SECONDS", 21_600, 300, 86_400);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(bucket)) {
    throw new CleanupConfigurationError("Invalid S3 bucket.");
  }
  return {
    accessKeyId,
    bucket,
    endpoint,
    intervalSeconds,
    keyPrefix,
    region: process.env.S3_REGION?.trim() || "us-east-1",
    secretAccessKey,
    transientRetentionDays,
    uploadRetentionDays,
  };
}

function effectiveNow() {
  const testNow = process.env.OWNMINUTES_CLEANUP_TEST_NOW;
  if (
    process.env.NODE_ENV === "test" &&
    process.env.OWNMINUTES_CLEANUP_TEST_MODE === "1" &&
    testNow
  ) {
    const parsed = Date.parse(testNow);
    if (!Number.isFinite(parsed)) throw new CleanupConfigurationError("Invalid cleanup test time.");
    return parsed;
  }
  return Date.now();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new CleanupConfigurationError(`Missing ${name}.`);
  return value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CleanupConfigurationError(`${name} is outside its allowed range.`);
  }
  return value;
}

function parseEndpoint(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new CleanupConfigurationError("Invalid S3 endpoint.");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizePrefix(value) {
  const prefix = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
  if (!prefix || prefix.includes("..")) throw new CleanupConfigurationError("Invalid object prefix.");
  return prefix;
}

function signAwsV4(input) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(Buffer.alloc(0));
  const headers = new Headers({
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
  const signedHeaderNames = [...headers.keys()].map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers.get(name)?.trim() ?? ""}\n`).join("");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    canonicalizeSearchParams(input.url.searchParams),
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", signingKey(input.secretAccessKey, dateStamp, input.region))
    .update(stringToSign)
    .digest("hex");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
  );
  return headers;
}

function signingKey(secretAccessKey, dateStamp, region) {
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function canonicalizeSearchParams(params) {
  return [...params.entries()]
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const byName = leftName.localeCompare(rightName);
      return byName || leftValue.localeCompare(rightValue);
    })
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

function encodeObjectKey(key) {
  return key.split("/").map(encodeRfc3986).join("/");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function extractXmlValue(xml, tagName) {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`).exec(xml);
  return decodeXml(match?.[1] || "");
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    // Decode ampersands last so an encoded entity such as &amp;quot; remains
    // the literal text "&quot;" instead of being decoded twice.
    .replace(/&amp;/g, "&");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class CleanupConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CleanupConfigurationError";
  }
}

class CleanupObjectStoreError extends Error {
  constructor(method, status) {
    super(`Cleanup object store ${method} failed with status ${status}.`);
    this.name = "CleanupObjectStoreError";
    this.status = status;
  }
}
