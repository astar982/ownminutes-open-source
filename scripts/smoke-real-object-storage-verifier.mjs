#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const bucket = "ownminutes-real-verifier-smoke";
const accessKey = "real-verifier-access";
const secretKey = "real-verifier-secret";
const objects = new Map();
const server = http.createServer(handleRequest);
await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
const port = server.address().port;
const evidencePath = ".data/smoke/object-storage-live-verifier.json";

try {
  const missingGate = await runVerifier(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/verify-real-object-storage.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, OWNMINUTES_REAL_OBJECT_STORAGE_ALLOW_LOCAL: "1", S3_BUCKET: bucket, S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_ACCESS_KEY_ID: accessKey, S3_SECRET_ACCESS_KEY: secretKey },
  });
  const missingPrefix = await runVerifier(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/verify-real-object-storage.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE: "1", OWNMINUTES_REAL_OBJECT_STORAGE_ALLOW_LOCAL: "1", S3_BUCKET: bucket, S3_ENDPOINT: `http://127.0.0.1:${port}`, S3_ACCESS_KEY_ID: accessKey, S3_SECRET_ACCESS_KEY: secretKey },
  });
  const result = await runVerifier(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/verify-real-object-storage.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE: "1",
        OWNMINUTES_REAL_OBJECT_STORAGE_ALLOW_LOCAL: "1",
        OWNMINUTES_REAL_STORAGE_EVIDENCE_PATH: evidencePath,
        OWNMINUTES_STORAGE_PREFIX: "ownminutes-smoke",
        S3_BUCKET: bucket,
        S3_ENDPOINT: `http://127.0.0.1:${port}`,
        S3_ACCESS_KEY_ID: accessKey,
        S3_SECRET_ACCESS_KEY: secretKey,
        S3_REGION: "us-east-1",
      },
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    process.exitCode = 1;
  } else {
    const summary = JSON.parse(result.stdout);
    const storedEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    console.log(JSON.stringify({
      verifierPassed: summary.cleanupComplete === true,
      filePutVerified: summary.filePut === true,
      fileGetVerified: summary.fileGet === true,
      presignedGetVerified: summary.presignedGet === true,
      namespaceIsolated: summary.keyPrefixConfigured === true,
      privateAccessChecked: summary.privateAccess === true,
      evidenceStored: storedEvidence.bucketHash === summary.bucketHash,
      remainingObjects: objects.size,
      evidenceLeaksSecrets: JSON.stringify(storedEvidence).includes(secretKey) || JSON.stringify(storedEvidence).includes(accessKey),
      missingGateRejected: missingGate.status !== 0,
      missingPrefixRejected: missingPrefix.status !== 0,
    }, null, 2));
    if (!summary.cleanupComplete || !summary.filePut || !summary.fileGet || !summary.presignedGet || !summary.keyPrefixConfigured || !summary.privateAccess || objects.size !== 0 || JSON.stringify(storedEvidence).includes(secretKey) || JSON.stringify(storedEvidence).includes(accessKey) || missingGate.status === 0 || missingPrefix.status === 0) process.exitCode = 1;
  }
} finally {
  server.close();
}

function runVerifier(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const requestBucket = parts.shift();
  const key = parts.join("/");
  if (requestBucket !== bucket) return respond(response, 404, "<Error><Code>NoSuchBucket</Code></Error>");
  if (!request.headers.authorization && !hasValidPresignedShape(url)) return respond(response, 403, "<Error><Code>AccessDenied</Code></Error>");

  if (request.method === "PUT") {
    objects.set(key, await readBody(request));
    return respond(response, 200, "");
  }
  if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    const delimiter = url.searchParams.get("delimiter") || "";
    const keys = [...objects.keys()].filter((item) => item.startsWith(prefix)).sort();
    const prefixes = new Set();
    for (const item of keys) {
      const rest = item.slice(prefix.length);
      const index = delimiter ? rest.indexOf(delimiter) : -1;
      if (index >= 0) prefixes.add(`${prefix}${rest.slice(0, index + 1)}`);
    }
    return respond(response, 200, `<ListBucketResult>${keys.map((item) => `<Contents><Key>${escapeXml(item)}</Key></Contents>`).join("")}${[...prefixes].map((item) => `<CommonPrefixes><Prefix>${escapeXml(item)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`);
  }
  if (request.method === "GET" && url.searchParams.has("versions")) {
    return respond(response, 200, "<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
  }
  if (request.method === "GET") return objects.has(key) ? respond(response, 200, objects.get(key)) : respond(response, 404, "<Error><Code>NoSuchKey</Code></Error>");
  if (request.method === "DELETE") {
    objects.delete(key);
    return respond(response, 204, "");
  }
  respond(response, 405, "");
}

function hasValidPresignedShape(url) {
  const credential = url.searchParams.get("X-Amz-Credential") || "";
  const signature = url.searchParams.get("X-Amz-Signature") || "";
  return (
    url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
    credential.startsWith(`${accessKey}/`) &&
    url.searchParams.get("X-Amz-SignedHeaders") === "host" &&
    /^\d{8}T\d{6}Z$/.test(url.searchParams.get("X-Amz-Date") || "") &&
    Number(url.searchParams.get("X-Amz-Expires")) >= 60 &&
    /^[a-f0-9]{64}$/.test(signature)
  );
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function respond(response, status, body) {
  response.writeHead(status, { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/xml" });
  response.end(body);
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
