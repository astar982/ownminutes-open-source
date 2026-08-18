#!/usr/bin/env node

import http from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const objects = new Map([
  ["hung-prefix/manifest.json", Buffer.from("{}")],
  ["body-stall/chunks/chunk-000001.wav", Buffer.from("audio")],
]);
let mode = "hang-list-headers";
let activeRequests = 0;
let closedRequests = 0;
let duplicatePrefixListRequests = 0;

const server = http.createServer((request, response) => {
  activeRequests += 1;
  let closed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    activeRequests -= 1;
    closedRequests += 1;
  };
  response.on("close", markClosed);
  request.on("aborted", markClosed);

  const url = new URL(request.url || "/", "http://127.0.0.1");
  const key = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent).join("/");
  if (mode === "hang-list-headers" && request.method === "GET" && url.searchParams.get("list-type") === "2") {
    return;
  }
  if (mode === "stall-body" && request.method === "GET" && key.includes("body-stall/")) {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.from([0]));
    return;
  }
  if (
    mode === "duplicate-prefix-token" &&
    request.method === "GET" &&
    url.searchParams.get("list-type") === "2" &&
    url.searchParams.get("delimiter") === "/"
  ) {
    duplicatePrefixListRequests += 1;
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(
      duplicatePrefixListRequests < 3
        ? "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>repeat</NextContinuationToken></ListBucketResult>"
        : "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
    );
    return;
  }
  if (
    mode === "invalid-prefix-xml" &&
    request.method === "GET" &&
    url.searchParams.get("list-type") === "2" &&
    url.searchParams.get("delimiter") === "/"
  ) {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>not a bucket listing</html>");
    return;
  }
  if (
    mode === "truncated-prefix-without-token" &&
    request.method === "GET" &&
    url.searchParams.get("list-type") === "2" &&
    url.searchParams.get("delimiter") === "/"
  ) {
    response.writeHead(200, { "content-type": "application/xml" });
    response.end("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>");
    return;
  }
  if (
    mode === "truncated-object-without-token" &&
    request.method === "GET" &&
    url.searchParams.get("list-type") === "2"
  ) {
    response.writeHead(200, { "content-type": "application/xml" });
    response.end("<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>");
    return;
  }
  if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    const keys = [...objects.keys()].filter((candidate) => candidate.startsWith(prefix));
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(`<ListBucketResult>${keys.map((item) => `<Contents><Key>${item}</Key></Contents>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    return;
  }
  if (request.method === "GET" && url.searchParams.has("versions")) {
    response.writeHead(200, { "content-type": "application/xml" });
    response.end("<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
    return;
  }
  if (request.method === "DELETE") {
    objects.delete(key);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "GET") {
    const value = objects.get(key);
    if (!value) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(value);
    return;
  }
  response.writeHead(200);
  response.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
Object.assign(process.env, {
  OWNMINUTES_MEETING_WRITE_LOCK: "process",
  OWNMINUTES_OBJECT_STORE_HEADER_TIMEOUT_MS: "300",
  OWNMINUTES_OBJECT_STORE_IDLE_TIMEOUT_MS: "300",
  OWNMINUTES_OBJECT_STORE_SMALL_TRANSFER_TIMEOUT_MS: "1200",
  OWNMINUTES_OBJECT_STORE_LARGE_TRANSFER_TIMEOUT_MS: "2000",
  S3_ACCESS_KEY_ID: "timeout-smoke-access",
  S3_BUCKET: "timeout-smoke",
  S3_ENDPOINT: `http://127.0.0.1:${port}`,
  S3_REGION: "us-east-1",
  S3_SECRET_ACCESS_KEY: "timeout-smoke-secret",
});

const require = createRequire(import.meta.url);
const jiti = require("jiti")(join(process.cwd(), "scripts", "object-store-timeout-loader.cjs"), {
  interopDefault: true,
  alias: { "@": join(process.cwd(), "src") },
});
const { getMeetingObjectStore } = jiti("../src/lib/server/meeting-object-store.ts");
const { withMeetingWriteLock } = jiti("../src/lib/server/meeting-write-lock.ts");
const store = getMeetingObjectStore();
const directory = await mkdtemp(join(tmpdir(), "ownminutes-object-timeout-smoke-"));
const partialPath = join(directory, "stalled.wav");

try {
  const headerStartedAt = Date.now();
  const headerTimedOut = await withMeetingWriteLock("hung-prefix", () => store.deletePrefix("hung-prefix")).then(
    () => false,
    (error) => /headers timed out|aborted|cancel/i.test(String(error?.message || error)),
  );
  const headerElapsedMs = Date.now() - headerStartedAt;
  await waitFor(() => activeRequests === 0, 2_000);

  const lockRecovered = await Promise.race([
    withMeetingWriteLock("hung-prefix", async () => true),
    delay(1_000).then(() => false),
  ]);

  mode = "normal";
  await store.deletePrefix("hung-prefix");
  const cleanupRetried = ![...objects.keys()].some((key) => key.startsWith("hung-prefix/"));

  mode = "duplicate-prefix-token";
  const duplicatePrefixTokenRejected = await store.listTopLevelPrefixes().then(
    () => false,
    (error) => /pagination did not make progress/i.test(String(error?.message || error)),
  );
  mode = "invalid-prefix-xml";
  const invalidPrefixXmlRejected = await store.listTopLevelPrefixes().then(
    () => false,
    (error) => /invalid prefix listing/i.test(String(error?.message || error)),
  );
  mode = "truncated-prefix-without-token";
  const truncatedPrefixWithoutTokenRejected = await store.listTopLevelPrefixes().then(
    () => false,
    (error) => /prefix listing omitted its continuation token/i.test(String(error?.message || error)),
  );
  mode = "truncated-object-without-token";
  const truncatedObjectWithoutTokenRejected = await store.deletePrefix("truncated-object").then(
    () => false,
    (error) => /listing omitted its continuation token/i.test(String(error?.message || error)),
  );

  mode = "stall-body";
  const bodyStartedAt = Date.now();
  const bodyTimedOut = await store.getFile("body-stall/chunks/chunk-000001.wav", partialPath).then(
    () => false,
    (error) => /stalled|duration|aborted/i.test(String(error?.message || error)),
  );
  const bodyElapsedMs = Date.now() - bodyStartedAt;
  await waitFor(() => activeRequests === 0, 2_000);
  const partialRemoved = await stat(partialPath).then(() => false, () => true);

  const summary = {
    bodyElapsedMs,
    bodyTimedOut,
    cleanupRetried,
    closedRequests,
    duplicatePrefixTokenRejected,
    headerElapsedMs,
    headerTimedOut,
    invalidPrefixXmlRejected,
    lockRecovered,
    partialRemoved,
    requestsExited: activeRequests === 0,
    truncatedObjectWithoutTokenRejected,
    truncatedPrefixWithoutTokenRejected,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (
    !headerTimedOut || headerElapsedMs > 2_000 || !lockRecovered || !cleanupRetried ||
    !duplicatePrefixTokenRejected || !invalidPrefixXmlRejected ||
    !truncatedObjectWithoutTokenRejected || !truncatedPrefixWithoutTokenRejected ||
    !bodyTimedOut || bodyElapsedMs > 2_000 || !partialRemoved || !summary.requestsExited || closedRequests < 2
  ) process.exitCode = 1;
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for hung object-store request to exit.");
    await delay(20);
  }
}
