#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const partBytes = 4 * 1024 * 1024;
const stamp = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
const meetingId = `smoke-resumable-${stamp}`;
const uploadId = `recording-${crypto.randomUUID()}`;
const audio = buildSilentWav(16_000, 300);
const totalParts = Math.ceil(audio.byteLength / partBytes);
const recordedAt = Date.now();
const claimedDurationMs = 1_000;
const mimeType = "audio/wav";
const registered = [];
const recordingUploadStoreSource = await readFile(path.join(process.cwd(), "src/lib/server/recording-upload-store.ts"), "utf8");
const meetingAudioStoreSource = await readFile(path.join(process.cwd(), "src/lib/server/meeting-audio-store.ts"), "utf8");
const meetingObjectStoreSource = await readFile(path.join(process.cwd(), "src/lib/server/meeting-object-store.ts"), "utf8");

assert.equal(totalParts, 3, "fixture must exercise at least three upload parts");
assert.ok(recordingUploadStoreSource.includes("ownminutes-recording-assembly-"));
assert.ok(recordingUploadStoreSource.includes("await writeAll(fileHandle, buffer)"));
assert.ok(!recordingUploadStoreSource.includes("Buffer.concat(buffers)"));
assert.ok(meetingAudioStoreSource.includes("probeAudioFileDurationMs(assembled.filePath)"));
assert.ok(meetingAudioStoreSource.includes("objectStore.putFile(finalObjectKey, assembled.filePath)"));
assert.ok(meetingObjectStoreSource.includes("createReadStream(bodyFile.filePath)"));

try {
  const owner = await registerUser("owner", `198.51.100.${20 + Math.floor(Math.random() * 80)}`);
  registered.push(owner.cookie);
  const outsider = await registerUser("outsider", `203.0.113.${20 + Math.floor(Math.random() * 80)}`);
  registered.push(outsider.cookie);
  const budgetOwner = await registerUser("budget", `192.0.2.${20 + Math.floor(Math.random() * 80)}`);
  registered.push(budgetOwner.cookie);

  const first = await putPart(0, audio.subarray(0, partBytes), owner.cookie);
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.receivedParts, [0]);

  const duplicate = await putPart(0, audio.subarray(0, partBytes), owner.cookie);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.receivedParts, [0]);

  const conflictingBytes = Buffer.from(audio.subarray(0, partBytes));
  conflictingBytes[conflictingBytes.length - 1] ^= 1;
  const conflict = await putPart(0, conflictingBytes, owner.cookie, { allowError: true });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.code, "RECORDING_PART_CONFLICT");

  const finalPartStart = 2 * partBytes;
  await putPart(2, audio.subarray(finalPartStart), owner.cookie);

  const incomplete = await commit(owner.cookie, { allowError: true });
  assert.equal(incomplete.response.status, 409);
  assert.equal(incomplete.payload.code, "RECORDING_UPLOAD_INCOMPLETE");

  const resumableStatus = await status(owner.cookie);
  assert.equal(resumableStatus.exists, true);
  assert.equal(resumableStatus.committed, false);
  assert.deepEqual(resumableStatus.receivedParts, [0, 2]);
  assert.equal(resumableStatus.metadata.totalBytes, audio.byteLength);
  assert.equal(resumableStatus.metadata.totalParts, totalParts);
  assert.equal(resumableStatus.metadata.uploadId, uploadId);

  const forbidden = await status(outsider.cookie, { allowError: true });
  assert.equal(forbidden.response.status, 403);

  await putPart(1, audio.subarray(partBytes, 2 * partBytes), owner.cookie);
  const committed = await commit(owner.cookie);
  assert.equal(committed.ok, true);
  assert.equal(committed.adapter, "resumable-recording-upload");
  assert.equal(committed.assembly, "bounded-temp-file");
  assert.equal(committed.assemblyMaxBufferedBytes, partBytes);
  assert.equal(committed.totalBytes, audio.byteLength);
  assert.equal(committed.totalChunks, 1);
  assert.ok(committed.durationMs >= 299_900 && committed.durationMs <= 300_100);

  const committedStatus = await status(owner.cookie);
  assert.equal(committedStatus.committed, true);
  assert.equal(committedStatus.metadata.totalParts, totalParts);
  assert.equal(committedStatus.metadata.totalBytes, audio.byteLength);
  assert.equal("ownerUserId" in committedStatus.metadata, false);
  assert.equal("parts" in committedStatus.metadata, false);
  assert.equal(committedStatus.ack.durationMs, committed.durationMs);

  const repeatedCommit = await commit(owner.cookie);
  assert.equal(repeatedCommit.receivedAt, committed.receivedAt);
  assert.equal(repeatedCommit.durationMs, committed.durationMs);
  assert.equal(repeatedCommit.totalBytes, committed.totalBytes);

  const detail = await requestJson(`/api/meetings/${meetingId}`, { cookie: owner.cookie });
  assert.equal(detail.meeting.totalBytes, audio.byteLength);
  assert.equal(detail.meeting.totalChunks, 1);
  assert.equal(detail.meeting.durationMs, committed.durationMs);

  const deleted = await requestJson(`/api/meetings/${meetingId}`, { cookie: owner.cookie, method: "DELETE" });
  assert.equal(deleted.ok, true);
  const afterDelete = await status(owner.cookie, { allowError: true });
  assert.equal(afterDelete.response.status, 410);
  assert.equal(afterDelete.payload.code, "meeting_deleted");
  const writeAfterDelete = await putPart(0, audio.subarray(0, partBytes), owner.cookie, { allowError: true });
  assert.equal(writeAfterDelete.response.status, 410);

  const quotaFixtures = Array.from({ length: 5 }, (_, index) => buildQuotaFixture(index));
  const quotaAttempts = await Promise.all(
    quotaFixtures.map(async (fixture) => ({ fixture, result: await putFixturePart(fixture, owner.cookie, true) })),
  );
  const quotaAccepted = quotaAttempts.filter((attempt) => attempt.result.response.status === 200);
  const quotaRejected = quotaAttempts.filter((attempt) => attempt.result.response.status === 429);
  assert.equal(quotaAccepted.length, 4, "concurrent account budget must accept exactly four uploads");
  assert.equal(quotaRejected.length, 1, "concurrent account budget must reject exactly one upload");
  for (const attempt of quotaAccepted) {
    assert.equal(attempt.result.payload.duplicate, false);
    assert.deepEqual(attempt.result.payload.receivedParts, [0]);
  }
  const activeFixture = quotaAccepted[0].fixture;
  const blockedFixture = quotaRejected[0].fixture;
  const competingUpload = await putFixturePart({ ...activeFixture, uploadId: `recording-${crypto.randomUUID()}` }, owner.cookie, true);
  assert.equal(competingUpload.response.status, 409);
  assert.equal(competingUpload.payload.code, "RECORDING_UPLOAD_ALREADY_ACTIVE");

  const quotaBlocked = quotaRejected[0].result;
  assert.equal(quotaBlocked.response.status, 429);
  assert.equal(quotaBlocked.payload.code, "RECORDING_UPLOAD_ACTIVE_LIMIT");
  assert.equal(quotaBlocked.response.headers.get("retry-after"), "60");

  let corruptAssemblyRejected = false;
  let staleCleanupVerified = false;
  let tempAssemblyCleanupVerified = false;
  const localQuotaManifestPath = path.join(
    process.cwd(),
    ".data",
    "meetings",
    quotaAccepted[0].fixture.meetingId,
    "manifest.json",
  );
  const localStorage = await readFile(localQuotaManifestPath, "utf8").then(
    () => true,
    (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (localStorage) {
    const corruptFixture = buildQuotaFixture(98);
    await putFixturePart(corruptFixture, outsider.cookie);
    const corruptPartPath = path.join(
      process.cwd(),
      ".data",
      "meetings",
      corruptFixture.meetingId,
      "uploads",
      corruptFixture.uploadId,
      "parts",
      "part-0000.bin",
    );
    const corruptBytes = await readFile(corruptPartPath);
    corruptBytes[corruptBytes.byteLength - 1] ^= 1;
    await writeFile(corruptPartPath, corruptBytes);
    const assemblyDirectoriesBefore = new Set(await listAssemblyDirectories());
    const corruptCommit = await commitFixture(corruptFixture, outsider.cookie, true);
    assert.equal(corruptCommit.response.status, 422);
    assert.equal(corruptCommit.payload.code, "RECORDING_UPLOAD_CORRUPT");
    const leakedAssemblyDirectories = (await listAssemblyDirectories()).filter((name) => !assemblyDirectoriesBefore.has(name));
    assert.deepEqual(leakedAssemblyDirectories, []);
    corruptAssemblyRejected = true;
    tempAssemblyCleanupVerified = true;

    await expireLocalRecordingUploadLease(activeFixture);
    const sweepTrigger = buildQuotaFixture(99);
    const crossAccountUpload = await putFixturePart(sweepTrigger, outsider.cookie);
    assert.equal(crossAccountUpload.duplicate, false);
    const expiredStatus = await fixtureStatus(activeFixture, owner.cookie);
    assert.equal(expiredStatus.exists, false);
    assert.equal(expiredStatus.committed, false);
    assert.deepEqual(expiredStatus.receivedParts, []);
    const acceptedAfterCleanup = await putFixturePart(blockedFixture, owner.cookie);
    assert.equal(acceptedAfterCleanup.duplicate, false);
    staleCleanupVerified = true;
  }

  const ownerDeleted = await requestJson("/api/auth/delete", { cookie: owner.cookie, method: "DELETE" });
  assert.equal(ownerDeleted.ok, true);
  assert.equal(ownerDeleted.status, "deleted");
  const deletedSessionRejected = await fixtureStatusAllowError(quotaAccepted[1].fixture, owner.cookie);
  assert.equal(deletedSessionRejected.response.status, 401);

  const budgetFixtures = Array.from({ length: 3 }, (_, index) => buildReservationFixture(index));
  const firstReservation = await putFixturePart(budgetFixtures[0], budgetOwner.cookie);
  const secondReservation = await putFixturePart(budgetFixtures[1], budgetOwner.cookie);
  assert.equal(firstReservation.duplicate, false);
  assert.equal(secondReservation.duplicate, false);
  const storageBlocked = await putFixturePart(budgetFixtures[2], budgetOwner.cookie, true);
  assert.equal(storageBlocked.response.status, 429);
  assert.equal(storageBlocked.payload.code, "RECORDING_UPLOAD_STORAGE_LIMIT");
  const budgetOwnerDeleted = await requestJson("/api/auth/delete", { cookie: budgetOwner.cookie, method: "DELETE" });
  assert.equal(budgetOwnerDeleted.ok, true);
  assert.equal(budgetOwnerDeleted.status, "deleted");

  console.log(JSON.stringify({
    activeUploadLimitStatus: quotaBlocked.response.status,
    boundedMemoryAssembly: committed.assembly === "bounded-temp-file",
    corruptAssemblyRejected,
    maxAssemblyBufferBytes: committed.assemblyMaxBufferedBytes,
    concurrentAcceptedUploads: quotaAccepted.length,
    authoritativeDurationMs: committed.durationMs,
    claimedDurationMs,
    deletedStagingMeetings: ownerDeleted.status === "deleted" && budgetOwnerDeleted.status === "deleted",
    duplicatePartAccepted: duplicate.duplicate,
    exactBytesSaved: committed.totalBytes,
    interruptedProgress: resumableStatus.receivedParts,
    meetingId,
    repeatCommitIdempotent: repeatedCommit.receivedAt === committed.receivedAt,
    retryAfterSeconds: Number(quotaBlocked.response.headers.get("retry-after")),
    staleCleanupVerified,
    storageReservationLimitStatus: storageBlocked.response.status,
    tempAssemblyCleanupVerified,
    totalParts,
    userIsolationStatus: forbidden.response.status,
  }, null, 2));
} finally {
  await Promise.allSettled(registered.map((cookie) => requestJson("/api/auth/delete", { allowError: true, cookie, method: "DELETE" })));
}

async function registerUser(label, forwardedFor) {
  const payload = await requestJson("/api/auth/register", {
    body: {
      email: `resumable-${label}-${stamp}@ownminutes.local`,
      name: `Resumable ${label}`,
      password: `OwnMinutes-${stamp}`,
    },
    headers: { "x-forwarded-for": forwardedFor },
    method: "POST",
    returnResponse: true,
  });
  return { cookie: extractCookie(payload.response) };
}

async function putPart(partIndex, bytes, cookie, options = {}) {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return requestJson(`/api/meetings/${meetingId}/recording-upload?uploadId=${encodeURIComponent(uploadId)}&part=${partIndex}`, {
    allowError: options.allowError,
    body: bytes,
    cookie,
    headers: {
      "Content-Length": String(bytes.byteLength),
      "Content-Type": "application/octet-stream",
      "X-OwnMinutes-Duration-Ms": String(claimedDurationMs),
      "X-OwnMinutes-Mime-Type": mimeType,
      "X-OwnMinutes-Part-Sha256": sha256,
      "X-OwnMinutes-Recorded-At": String(recordedAt),
      "X-OwnMinutes-Total-Bytes": String(audio.byteLength),
      "X-OwnMinutes-Total-Parts": String(totalParts),
    },
    method: "PUT",
    returnResponse: options.allowError,
  });
}

async function status(cookie, options = {}) {
  return requestJson(`/api/meetings/${meetingId}/recording-upload?uploadId=${encodeURIComponent(uploadId)}`, {
    allowError: options.allowError,
    cookie,
    returnResponse: options.allowError,
  });
}

async function commit(cookie, options = {}) {
  return requestJson(`/api/meetings/${meetingId}/recording-upload?uploadId=${encodeURIComponent(uploadId)}`, {
    allowError: options.allowError,
    cookie,
    method: "POST",
    returnResponse: options.allowError,
  });
}

function buildQuotaFixture(index) {
  const fixtureAudio = buildSilentWav(16_000, 1);
  return {
    audio: fixtureAudio,
    meetingId: `smoke-resumable-quota-${index}-${stamp}`,
    recordedAt: recordedAt + index + 1,
    uploadId: `recording-${crypto.randomUUID()}`,
  };
}

function buildReservationFixture(index) {
  return {
    audio: Buffer.alloc(partBytes),
    meetingId: `smoke-resumable-storage-${index}-${stamp}`,
    recordedAt: recordedAt + 200 + index,
    totalBytes: 96 * 1024 * 1024,
    totalParts: 24,
    uploadId: `recording-${crypto.randomUUID()}`,
  };
}

async function putFixturePart(fixture, cookie, allowError = false) {
  const sha256 = crypto.createHash("sha256").update(fixture.audio).digest("hex");
  const fixtureTotalBytes = fixture.totalBytes ?? fixture.audio.byteLength;
  const fixtureTotalParts = fixture.totalParts ?? 1;
  return requestJson(
    `/api/meetings/${fixture.meetingId}/recording-upload?uploadId=${encodeURIComponent(fixture.uploadId)}&part=0`,
    {
      allowError,
      body: fixture.audio,
      cookie,
      headers: {
        "Content-Length": String(fixture.audio.byteLength),
        "Content-Type": "application/octet-stream",
        "X-OwnMinutes-Duration-Ms": "1000",
        "X-OwnMinutes-Mime-Type": mimeType,
        "X-OwnMinutes-Part-Sha256": sha256,
        "X-OwnMinutes-Recorded-At": String(fixture.recordedAt),
        "X-OwnMinutes-Total-Bytes": String(fixtureTotalBytes),
        "X-OwnMinutes-Total-Parts": String(fixtureTotalParts),
      },
      method: "PUT",
      returnResponse: allowError,
    },
  );
}

async function fixtureStatus(fixture, cookie) {
  return requestJson(`/api/meetings/${fixture.meetingId}/recording-upload?uploadId=${encodeURIComponent(fixture.uploadId)}`, { cookie });
}

async function fixtureStatusAllowError(fixture, cookie) {
  return requestJson(`/api/meetings/${fixture.meetingId}/recording-upload?uploadId=${encodeURIComponent(fixture.uploadId)}`, {
    allowError: true,
    cookie,
    returnResponse: true,
  });
}

async function commitFixture(fixture, cookie, allowError = false) {
  return requestJson(`/api/meetings/${fixture.meetingId}/recording-upload?uploadId=${encodeURIComponent(fixture.uploadId)}`, {
    allowError,
    cookie,
    method: "POST",
    returnResponse: allowError,
  });
}

async function listAssemblyDirectories() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("ownminutes-recording-assembly-"));
}

async function expireLocalRecordingUploadLease(fixture) {
  const manifestPath = path.join(process.cwd(), ".data", "meetings", fixture.meetingId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.recordingUpload?.uploadId, fixture.uploadId);
  manifest.recordingUpload.updatedAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function requestJson(pathname, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Origin", browserOrigin);
  headers.set("Sec-Fetch-Site", "same-origin");
  if (options.cookie) headers.set("Cookie", options.cookie);
  let body = options.body;
  if (body && !Buffer.isBuffer(body)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body,
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${pathname} returned non-JSON ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok && !options.allowError) {
    throw new Error(`${pathname} failed ${response.status}: ${JSON.stringify(payload)}`);
  }
  return options.returnResponse ? { payload, response } : payload;
}

function extractCookie(response) {
  const header = response.headers.get("set-cookie") || "";
  const match = header.match(/ownminutes_session=[^;]+/);
  assert.ok(match, "registration must return a session cookie");
  return match[0];
}

function buildSilentWav(sampleRate, seconds) {
  const dataBytes = sampleRate * seconds * 2;
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
