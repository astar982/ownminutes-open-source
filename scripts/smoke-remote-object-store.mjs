#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const accessKeyId = "remote-smoke-access-key";
const secretAccessKey = "remote-smoke-secret-key";
const r2AccessKeyId = "remote-smoke-r2-access-key";
const r2SecretAccessKey = "remote-smoke-r2-secret-key";
const bucket = "ownminutes-remote-smoke";
const meetingId = `remote-store-smoke-${timestamp}`;
const invalidAudioMeetingId = `remote-store-invalid-audio-${timestamp}`;
const accountDeleteMeetingId = `remote-store-account-delete-${timestamp}`;
const accountDeleteSecondMeetingId = `remote-store-account-delete-second-${timestamp}`;
const email = `remote-store-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const serverWorkdir = process.env.SMOKE_SERVER_WORKDIR || process.cwd();
const sameOriginMutationHeaders = { "Sec-Fetch-Site": "same-origin" };

const objects = new Map();
const retainedVersions = new Map();
let nextVersion = 0;
const requests = [];
const asrRequests = [];

async function main() {
  const asrDirectoriesBefore = new Set(await listAsrTempDirectories());
  const authDataDir = await mkdtemp(`${tmpdir()}/ownminutes-remote-store-auth-`);
  const s3Server = createFakeS3Server();
  await listen(s3Server, 0);
  const s3Port = s3Server.address().port;
  const asrServer = createFakeAsrServer();
  await listen(asrServer, 0);
  const asrPort = asrServer.address().port;
  const appPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const app = startNextPreview(appPort, s3Port, asrPort, authDataDir);

  try {
    await waitForApp(baseUrl, app);
    const register = await postJson(`${baseUrl}/api/auth/register`, {
      name: "Remote Store Smoke",
      email,
      password,
    });
    const cookie = extractCookie(register.response);
    const storageDiagnostics = await getJson(`${baseUrl}/api/storage/diagnostics`, cookie);

    const upload = await uploadChunk(baseUrl, cookie, meetingId);
    const final = await postJson(
      `${baseUrl}/api/meetings/${meetingId}/finalize`,
      {
        title: "OwnMinutes remote object store smoke",
        expectedLastSequence: upload.totalChunks,
        totalBytes: upload.totalBytes,
      },
      cookie,
    );
    const detail = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
    const meetings = await getJson(`${baseUrl}/api/meetings`, cookie);
    const listed = meetings.meetings?.some((meeting) => meeting.meetingId === meetingId);
    const deleteMeeting = await fetch(`${baseUrl}/api/meetings/${meetingId}`, {
      method: "DELETE",
      headers: { ...sameOriginMutationHeaders, Cookie: cookie },
    });
    const deletePayload = await readJsonResponse(deleteMeeting, `${baseUrl}/api/meetings/${meetingId}`);
    const meetingsAfterDelete = await getJson(`${baseUrl}/api/meetings`, cookie);
    const invalidAudioUpload = await uploadInvalidAudioChunk(baseUrl, cookie, invalidAudioMeetingId);
    const invalidAudioFinalizeResponse = await fetch(`${baseUrl}/api/meetings/${invalidAudioMeetingId}/finalize`, {
      method: "POST",
      headers: { ...sameOriginMutationHeaders, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "OwnMinutes invalid audio privacy smoke",
        expectedLastSequence: invalidAudioUpload.totalChunks,
        totalBytes: invalidAudioUpload.totalBytes,
      }),
    });
    const invalidAudioFinalize = await readJsonResponse(
      invalidAudioFinalizeResponse,
      `${baseUrl}/api/meetings/${invalidAudioMeetingId}/finalize`,
      { allowError: true },
    );
    const accountDeleteUpload = await uploadChunk(baseUrl, cookie, accountDeleteMeetingId);
    const accountDeleteSecondUpload = await uploadChunk(baseUrl, cookie, accountDeleteSecondMeetingId);
    const accountDeleteFinal = await postJson(
      `${baseUrl}/api/meetings/${accountDeleteMeetingId}/finalize`,
      {
        title: "OwnMinutes remote object store account delete smoke",
        expectedLastSequence: accountDeleteUpload.totalChunks,
        totalBytes: accountDeleteUpload.totalBytes,
      },
      cookie,
    );
    const accountDeleteSecondFinal = await postJson(
      `${baseUrl}/api/meetings/${accountDeleteSecondMeetingId}/finalize`,
      {
        title: "OwnMinutes remote object store account delete smoke 2",
        expectedLastSequence: accountDeleteSecondUpload.totalChunks,
        totalBytes: accountDeleteSecondUpload.totalBytes,
      },
      cookie,
    );
    const accountDeleteReview = await postJson(
      `${baseUrl}/api/meetings/${accountDeleteMeetingId}/review`,
      { confirmed: true },
      cookie,
    );
    const accountDeletePublish = await postJson(
      `${baseUrl}/api/meetings/${accountDeleteMeetingId}/share`,
      {
        visibility: "public",
        includeTranscript: false,
        confirmUnverified: true,
      },
      cookie,
    );
    const accountDeleteShareBefore = await fetch(`${baseUrl}/share/${accountDeleteMeetingId}`);
    const accountDeleteShareBeforeText = await accountDeleteShareBefore.text();
    const accountDeleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
      method: "DELETE",
      headers: { ...sameOriginMutationHeaders, Cookie: cookie },
    });
    const accountDeletePayload = await readJsonResponse(accountDeleteResult, `${baseUrl}/api/auth/delete`);
    const accountDeleteShareAfter = await fetch(`${baseUrl}/share/${accountDeleteMeetingId}`);
    const accountDeleteShareAfterText = await accountDeleteShareAfter.text();
    const accountMeetingsAfterDelete = await fetch(`${baseUrl}/api/meetings`, {
      headers: { Cookie: cookie },
    });
    const r2Compatibility = await verifyR2DeleteCompatibility(s3Port);

    const remainingMeetingObjects = [...objects.keys()].filter((key) => key.startsWith(`${meetingId}/`));
    const remainingMeetingVersions = [...retainedVersions.values()].filter((version) => version.key.startsWith(`${meetingId}/`));
    const remainingAccountDeleteObjects = [...objects.keys()].filter(
      (key) =>
        key.startsWith(`${invalidAudioMeetingId}/`) ||
        key.startsWith(`${accountDeleteMeetingId}/`) ||
        key.startsWith(`${accountDeleteSecondMeetingId}/`),
    );
    const remainingAccountDeleteVersions = [...retainedVersions.values()].filter(
      (version) =>
        version.key.startsWith(`${invalidAudioMeetingId}/`) ||
        version.key.startsWith(`${accountDeleteMeetingId}/`) ||
        version.key.startsWith(`${accountDeleteSecondMeetingId}/`),
    );
    const leakedAsrDirectories = (await listAsrTempDirectories()).filter((name) => !asrDirectoriesBefore.has(name));
    const summary = {
      provider: storageDiagnostics.diagnostics?.provider,
      productionReady: storageDiagnostics.diagnostics?.productionReady,
      crossInstanceWriteLock: storageDiagnostics.diagnostics?.capabilities?.supportsCrossInstanceWrites,
      durableDeletionFence: storageDiagnostics.diagnostics?.capabilities?.preventsDeletedMeetingRecreation,
      hasObjectStoreAdapter: storageDiagnostics.diagnostics?.capabilities?.hasObjectStoreAdapter,
      uploadStoredChunk: objects.has(`${meetingId}/chunks/chunk-000001.wav`) || requests.some((request) => request.method === "PUT" && request.key === `${meetingId}/chunks/chunk-000001.wav`),
      finalizeOk: final.ok === true,
      finalUsedVolcanoFileAsr: detail.meeting?.result?.adapter === "volcano-file-asr",
      asrUsedSafeBufferFallback: asrRequests.length >= 3 && asrRequests.every((request) => !request.hasUrl && request.hasData),
      asrReceivedAudio: asrRequests.length >= 3 && asrRequests.every((request) => request.fetchedBytes > 44),
      asrUsedBenchmarkedOggOpus:
        asrRequests.length >= 3 &&
        asrRequests.every(
          (request) => request.audioFormat === "ogg" && request.hasOggContainer && request.hasOpusCodec,
        ),
      transientAsrObjectsCleaned: ![...objects.keys()].some((key) => key.includes("/transient/asr/")),
      asrTempDirectoriesCleaned: leakedAsrDirectories.length === 0,
      detailApiOk: detail.ok === true && detail.meeting?.meetingId === meetingId,
      listedInRemoteStore: Boolean(listed),
      deleteOk: deletePayload.ok === true,
      deletedFromHistory: !meetingsAfterDelete.meetings?.some((meeting) => meeting.meetingId === meetingId),
      remainingMeetingObjectCount: remainingMeetingObjects.length,
      remainingMeetingVersionCount: remainingMeetingVersions.length,
      invalidAudioStatus: invalidAudioFinalizeResponse.status,
      invalidAudioCode: invalidAudioFinalize.code,
      invalidAudioResponseSafe:
        invalidAudioFinalize.error === "录音文件无法解码或格式不受支持。原始音频仍已保留，可检查录音后重试。" &&
        invalidAudioFinalize.processing?.error?.message === invalidAudioFinalize.error &&
        !JSON.stringify(invalidAudioFinalize).match(
          /(?:\/var\/|\/tmp\/|\/Users\/|ownminutes-asr-audio-|EBML|ffmpeg|https?:\/\/|X-Amz-(?:Credential|Signature))/i,
        ),
      accountDeleteFinalOk: accountDeleteFinal.ok === true,
      accountDeleteSecondFinalOk: accountDeleteSecondFinal.ok === true,
      accountDeleteReviewConfirmed:
        accountDeleteReview.ok === true && accountDeleteReview.humanReview?.status === "confirmed",
      accountDeletePublishOk: accountDeletePublish.ok === true,
      accountDeleteShareBeforeVisible: accountDeleteShareBeforeText.includes("公开分享的会议纪要"),
      accountDeleteStatus: accountDeleteResult.status,
      accountDeleteDeletedMeetings: accountDeletePayload.deletedMeetings,
      accountDeleteShareHidden: accountDeleteShareAfterText.includes("尚未公开"),
      accountMeetingsAfterDeleteStatus: accountMeetingsAfterDelete.status,
      remainingAccountDeleteObjectCount: remainingAccountDeleteObjects.length,
      remainingAccountDeleteVersionCount: remainingAccountDeleteVersions.length,
      r2CurrentObjectDeleted: r2Compatibility.currentObjectDeleted,
      r2SkippedUnsupportedVersionApi: r2Compatibility.skippedUnsupportedVersionApi,
      requestCount: requests.length,
      sawPut: requests.some((request) => request.method === "PUT"),
      sawGet: requests.some((request) => request.method === "GET" && request.key),
      sawList: requests.some((request) => request.method === "GET" && request.listType === "2"),
      sawDelete: requests.some((request) => request.method === "DELETE"),
      sawVersionList: requests.some((request) => request.method === "GET" && request.versionListing),
      sawVersionDelete: requests.some((request) => request.method === "DELETE" && request.versionId),
      authHeaderPresent: requests.filter((request) => !request.presigned).every((request) =>
        request.authorization?.includes(`Credential=${request.r2 ? r2AccessKeyId : accessKeyId}/`),
      ),
      internalPresignedUrlNotFetched: !requests.some((request) => request.method === "GET" && request.presigned),
      contentHashValid: requests.filter((request) => request.method === "PUT").every((request) => request.contentHashValid),
    };

    console.log(JSON.stringify(summary, null, 2));

    if (
      summary.provider !== "s3" ||
      summary.productionReady !== false ||
      summary.crossInstanceWriteLock !== false ||
      summary.durableDeletionFence !== false ||
      !summary.hasObjectStoreAdapter ||
      !summary.uploadStoredChunk ||
      !summary.finalizeOk ||
      !summary.finalUsedVolcanoFileAsr ||
      !summary.asrUsedSafeBufferFallback ||
      !summary.asrReceivedAudio ||
      !summary.asrUsedBenchmarkedOggOpus ||
      !summary.transientAsrObjectsCleaned ||
      !summary.asrTempDirectoriesCleaned ||
      !summary.detailApiOk ||
      !summary.listedInRemoteStore ||
      !summary.deleteOk ||
      !summary.deletedFromHistory ||
      summary.remainingMeetingObjectCount !== 0 ||
      summary.remainingMeetingVersionCount !== 0 ||
      summary.invalidAudioStatus !== 422 ||
      summary.invalidAudioCode !== "audio_processing_failed" ||
      !summary.invalidAudioResponseSafe ||
      !summary.accountDeleteFinalOk ||
      !summary.accountDeleteSecondFinalOk ||
      !summary.accountDeleteReviewConfirmed ||
      !summary.accountDeletePublishOk ||
      !summary.accountDeleteShareBeforeVisible ||
      summary.accountDeleteStatus !== 200 ||
      summary.accountDeleteDeletedMeetings < 3 ||
      !summary.accountDeleteShareHidden ||
      summary.accountMeetingsAfterDeleteStatus !== 401 ||
      summary.remainingAccountDeleteObjectCount !== 0 ||
      summary.remainingAccountDeleteVersionCount !== 0 ||
      !summary.r2CurrentObjectDeleted ||
      !summary.r2SkippedUnsupportedVersionApi ||
      !summary.sawPut ||
      !summary.sawGet ||
      !summary.sawList ||
      !summary.sawDelete ||
      !summary.sawVersionList ||
      !summary.sawVersionDelete ||
      !summary.authHeaderPresent ||
      !summary.internalPresignedUrlNotFetched ||
      !summary.contentHashValid
    ) {
      process.exitCode = 1;
    }
  } finally {
    app.kill("SIGTERM");
    s3Server.close();
    asrServer.close();
    await rm(authDataDir, { recursive: true, force: true });
  }
}

async function listAsrTempDirectories() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("ownminutes-asr-audio-"));
}

function createFakeS3Server() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const pathParts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const requestBucket = pathParts.shift();
      const key = pathParts.join("/");
      const body = await readRequestBody(request);
      const presigned = request.method === "GET" && url.searchParams.has("X-Amz-Signature");
      const presignedShapeValid = presigned && hasValidPresignedShape(url);
      const requestInfo = {
        method: request.method,
        key,
        listType: url.searchParams.get("list-type"),
        versionListing: url.searchParams.has("versions"),
        versionId: url.searchParams.get("versionId"),
        authorization: request.headers.authorization || "",
        presigned,
        presignedShapeValid,
        contentHashValid: validateContentHash(request, body),
        r2: (request.headers.authorization || "").includes(`Credential=${r2AccessKeyId}/`),
      };
      requests.push(requestInfo);

      if (requestBucket !== bucket) {
        sendXml(response, 404, `<Error><Code>NoSuchBucket</Code><BucketName>${escapeXml(requestBucket || "")}</BucketName></Error>`);
        return;
      }
      if (!request.headers.authorization && !presignedShapeValid) {
        sendXml(response, 403, "<Error><Code>AccessDenied</Code></Error>");
        return;
      }

      if (request.method === "PUT") {
        objects.set(key, body);
        if (!requestInfo.r2) retainVersion(key, "Version");
        response.writeHead(200);
        response.end();
        return;
      }

      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        sendXml(response, 200, listObjectsXml(url.searchParams));
        return;
      }

      if (request.method === "GET" && url.searchParams.has("versions")) {
        sendXml(response, 200, listObjectVersionsXml(url.searchParams));
        return;
      }

      if (request.method === "GET") {
        if (!objects.has(key)) {
          sendXml(response, 404, `<Error><Code>NoSuchKey</Code><Key>${escapeXml(key)}</Key></Error>`);
          return;
        }
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(objects.get(key));
        return;
      }

      if (request.method === "DELETE") {
        const versionId = url.searchParams.get("versionId");
        if (versionId) retainedVersions.delete(versionId);
        else {
          objects.delete(key);
          if (!requestInfo.r2) retainVersion(key, "DeleteMarker");
        }
        response.writeHead(204);
        response.end();
        return;
      }

      sendXml(response, 405, "<Error><Code>MethodNotAllowed</Code></Error>");
    } catch (error) {
      sendXml(response, 500, `<Error><Code>InternalError</Code><Message>${escapeXml(error.message)}</Message></Error>`);
    }
  });
}

function createFakeAsrServer() {
  return http.createServer(async (request, response) => {
    try {
      const payload = JSON.parse((await readRequestBody(request)).toString("utf8"));
      const audioUrl = typeof payload?.audio?.url === "string" ? payload.audio.url : "";
      const hasData = typeof payload?.audio?.data === "string";
      let fetchedBytes = 0;
      let fetchedAudio = Buffer.alloc(0);
      if (audioUrl) {
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) throw new Error(`Private audio fetch failed with ${audioResponse.status}.`);
        fetchedAudio = Buffer.from(await audioResponse.arrayBuffer());
        fetchedBytes = fetchedAudio.byteLength;
      } else if (hasData) {
        fetchedAudio = Buffer.from(payload.audio.data, "base64");
        fetchedBytes = fetchedAudio.byteLength;
      }
      asrRequests.push({
        audioFormat: payload?.audio?.format,
        fetchedBytes,
        hasData,
        hasOggContainer: fetchedAudio.subarray(0, 4).toString("ascii") === "OggS",
        hasOpusCodec: fetchedAudio.includes(Buffer.from("OpusHead", "ascii")),
        hasUrl: Boolean(audioUrl),
        urlEndsWithOgg: Boolean(audioUrl) && new URL(audioUrl).pathname.endsWith(".ogg"),
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "x-api-status-code": "20000000",
        "x-api-message": "OK",
      });
      response.end(JSON.stringify({
        result: {
          utterances: [
            { start_time: 0, end_time: 900, speaker_id: 1, text: "私有音频链接识别成功。" },
          ],
        },
      }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json", "x-api-status-code": "55000000" });
      response.end(JSON.stringify({ message: error instanceof Error ? error.message : "fixture failure" }));
    }
  });
}

function hasValidPresignedShape(url) {
  const credential = url.searchParams.get("X-Amz-Credential") || "";
  return (
    url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
    credential.startsWith(`${accessKeyId}/`) &&
    url.searchParams.get("X-Amz-SignedHeaders") === "host" &&
    /^\d{8}T\d{6}Z$/.test(url.searchParams.get("X-Amz-Date") || "") &&
    Number(url.searchParams.get("X-Amz-Expires")) >= 300 &&
    /^[a-f0-9]{64}$/.test(url.searchParams.get("X-Amz-Signature") || "")
  );
}

function listObjectsXml(searchParams) {
  const prefix = searchParams.get("prefix") || "";
  const delimiter = searchParams.get("delimiter") || "";
  const matchingKeys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();

  if (delimiter === "/") {
    const prefixes = new Set();
    const contents = [];
    for (const key of matchingKeys) {
      const rest = key.slice(prefix.length);
      const delimiterIndex = rest.indexOf(delimiter);
      if (delimiterIndex >= 0) {
        prefixes.add(`${prefix}${rest.slice(0, delimiterIndex + 1)}`);
      } else {
        contents.push(key);
      }
    }
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<ListBucketResult>",
      `<Prefix>${escapeXml(prefix)}</Prefix>`,
      ...contents.map(objectXml),
      ...[...prefixes].sort().map((value) => `<CommonPrefixes><Prefix>${escapeXml(value)}</Prefix></CommonPrefixes>`),
      "</ListBucketResult>",
    ].join("");
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ListBucketResult>",
    `<Prefix>${escapeXml(prefix)}</Prefix>`,
    ...matchingKeys.map(objectXml),
    "</ListBucketResult>",
  ].join("");
}

function listObjectVersionsXml(searchParams) {
  const prefix = searchParams.get("prefix") || "";
  const entries = [...retainedVersions.entries()]
    .filter(([, version]) => version.key.startsWith(prefix))
    .sort(([, left], [, right]) => left.key.localeCompare(right.key));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ListVersionsResult>",
    `<Prefix>${escapeXml(prefix)}</Prefix>`,
    ...entries.map(([versionId, version]) =>
      `<${version.kind}><Key>${escapeXml(version.key)}</Key><VersionId>${escapeXml(versionId)}</VersionId><IsLatest>false</IsLatest><LastModified>${version.lastModified}</LastModified></${version.kind}>`,
    ),
    "<IsTruncated>false</IsTruncated>",
    "</ListVersionsResult>",
  ].join("");
}

function retainVersion(key, kind) {
  nextVersion += 1;
  retainedVersions.set(`version-${nextVersion}`, {
    key,
    kind,
    lastModified: new Date().toISOString(),
  });
}

async function verifyR2DeleteCompatibility(s3Port) {
  const targetPrefix = `r2-delete-compat-${timestamp}`;
  const environmentNames = [
    "OWNMINUTES_STORAGE_PREFIX",
    "R2_ACCESS_KEY_ID",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "R2_SECRET_ACCESS_KEY",
  ];
  const previous = new Map(environmentNames.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      OWNMINUTES_STORAGE_PREFIX: "",
      R2_ACCESS_KEY_ID: r2AccessKeyId,
      R2_BUCKET: bucket,
      R2_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      R2_SECRET_ACCESS_KEY: r2SecretAccessKey,
    });
    const require = createRequire(import.meta.url);
    const jiti = require("jiti")(path.join(process.cwd(), "scripts", "remote-object-store-r2-loader.cjs"), {
      interopDefault: true,
      alias: { "@": path.join(process.cwd(), "src") },
    });
    const { getMeetingObjectStore } = jiti("../src/lib/server/meeting-object-store.ts");
    const store = getMeetingObjectStore();
    if (store.provider !== "r2") throw new Error(`Expected R2 adapter, received ${store.provider}.`);
    await store.putText(`${targetPrefix}/manifest.json`, "r2-unversioned-delete-smoke");
    await store.deletePrefix(targetPrefix);
    return {
      currentObjectDeleted: !objects.has(`${targetPrefix}/manifest.json`),
      skippedUnsupportedVersionApi: !requests.some((request) => request.r2 && request.versionListing),
    };
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function objectXml(key) {
  return `<Contents><Key>${escapeXml(key)}</Key><Size>${objects.get(key)?.byteLength ?? 0}</Size></Contents>`;
}

function startNextPreview(appPort, s3Port, asrPort, authDataDir) {
  const child = spawn("./node_modules/.bin/next", ["dev", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: serverWorkdir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      S3_BUCKET: bucket,
      S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_REGION: "us-east-1",
      OWNMINUTES_AUTH_DATA_DIR: authDataDir,
      OWNMINUTES_AUTH_REPOSITORY: "local-file",
      OWNMINUTES_ALLOW_FIRST_USER_ADMIN: "1",
      OWNMINUTES_STORAGE_LIFECYCLE_POLICY: "remote smoke temporary objects",
      OWNMINUTES_STORAGE_DELETE_PROOF: "remote smoke verifies meeting and account delete prefix cleanup",
      OWNMINUTES_STORAGE_COST_BUDGET: "remote smoke temporary bucket cost budget",
      OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION: "remote smoke starts from isolated temp bucket",
      OWNMINUTES_STORAGE_PRIVATE_ACCESS: "1",
      OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE: "remote smoke access key limited to fake bucket",
      OWNMINUTES_STORAGE_RESTORE_READ_PROOF: "remote smoke reads stored objects back after write",
      OWNMINUTES_MEETING_WRITE_LOCK: "process",
      OWNMINUTES_ASR_AUDIO_URL_TTL_SECONDS: "300",
      OWNMINUTES_ALLOW_LOCAL_PROVIDER_ENDPOINTS: "1",
      OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "1",
      OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "30",
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_API_KEY: "fixture-asr-key",
      VOLCANO_ASR_MODE: "flash",
      VOLCANO_ASR_RECOGNIZE_URL: `http://127.0.0.1:${asrPort}/recognize`,
      VOLCANO_ASR_RESOURCE_ID: "fixture-file-asr",
      ARK_API_KEY: "",
      ARK_CHAT_MODEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(data);
  });
  child.stderr.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stderr.write(data);
  });

  return child;
}

async function uploadChunk(baseUrl, cookie, targetMeetingId) {
  const audio = new Blob([buildSilentWav(16_000, 1)], {
    type: "audio/wav",
  });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", audio, "chunk-000001.wav");

  const response = await fetch(`${baseUrl}/api/meetings/${targetMeetingId}/chunks`, {
    method: "POST",
    headers: { ...sameOriginMutationHeaders, Cookie: cookie },
    body: form,
  });
  return readJsonResponse(response, `${baseUrl}/api/meetings/${targetMeetingId}/chunks`);
}

async function uploadInvalidAudioChunk(baseUrl, cookie, targetMeetingId) {
  const audio = new Blob([Buffer.from("INVALID_WEBM_FOR_ERROR_PRIVACY_SMOKE")], {
    type: "audio/webm;codecs=opus",
  });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/webm;codecs=opus");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", audio, "chunk-000001.webm");

  const response = await fetch(`${baseUrl}/api/meetings/${targetMeetingId}/chunks`, {
    method: "POST",
    headers: { ...sameOriginMutationHeaders, Cookie: cookie },
    body: form,
  });
  return readJsonResponse(response, `${baseUrl}/api/meetings/${targetMeetingId}/chunks`);
}

async function waitForApp(baseUrl, app) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (app.exitCode !== null) {
      throw new Error(`Next preview exited early with code ${app.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Timed out waiting for Next preview.");
}

async function postJson(url, body, cookie, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...sameOriginMutationHeaders,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse(response, url);
  return { response, ...payload };
}

async function getJson(url, cookie) {
  const response = await fetch(url, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  return readJsonResponse(response, url);
}

async function readJsonResponse(response, url, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Register response did not set a session cookie.");
  return setCookie.split(";")[0];
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function validateContentHash(request, body) {
  const expected = request.headers["x-amz-content-sha256"];
  if (!expected) return false;
  return expected === crypto.createHash("sha256").update(body).digest("hex");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sendXml(response, status, body) {
  response.writeHead(status, { "content-type": "application/xml; charset=utf-8" });
  response.end(body);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
