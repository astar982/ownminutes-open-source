#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  defaultRecordingUploadMaxActivePerUser,
  defaultRecordingUploadMaxStagedBytesPerUser,
  defaultRecordingUploadStaleHours,
  getRecordingUploadResourcePolicy,
  isRecordingUploadStale,
  recordingUploadResourceViolation,
} from "../src/lib/server/recording-upload-resource-policy.ts";
import { MeetingObjectStoreHttpError, isMissingMeetingObjectError } from "../src/lib/server/meeting-object-store.ts";

const original = {
  active: process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_ACTIVE_PER_USER,
  bytes: process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER,
  hours: process.env.OWNMINUTES_RECORDING_UPLOAD_STALE_HOURS,
};

try {
  delete process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_ACTIVE_PER_USER;
  delete process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER;
  delete process.env.OWNMINUTES_RECORDING_UPLOAD_STALE_HOURS;
  const defaults = getRecordingUploadResourcePolicy();
  assert.equal(defaults.maxActiveUploadsPerUser, defaultRecordingUploadMaxActivePerUser);
  assert.ok(defaults.maxStagedBytesPerUser >= defaultRecordingUploadMaxStagedBytesPerUser);
  assert.equal(defaults.staleAfterMs, defaultRecordingUploadStaleHours * 60 * 60 * 1000);

  const now = Date.now();
  assert.equal(isRecordingUploadStale(new Date(now - 71 * 60 * 60 * 1000).toISOString(), defaults, now), false);
  assert.equal(isRecordingUploadStale(new Date(now - 72 * 60 * 60 * 1000).toISOString(), defaults, now), true);
  assert.equal(isRecordingUploadStale("invalid-date", defaults, now), true);
  assert.equal(isMissingMeetingObjectError(Object.assign(new Error("missing manifest"), { code: "ENOENT" })), true);
  assert.equal(isMissingMeetingObjectError(new MeetingObjectStoreHttpError("GET", 404, "NoSuchKey")), true);
  assert.equal(isMissingMeetingObjectError(new MeetingObjectStoreHttpError("PUT", 404, "NoSuchKey")), false);
  assert.equal(isMissingMeetingObjectError(new Error("ENOENT: missing manifest")), false);
  assert.equal(isMissingMeetingObjectError(new Error("Object store GET failed: 404")), false);
  assert.equal(isMissingMeetingObjectError(new Error("Object store GET failed: 500")), false);
  assert.equal(isMissingMeetingObjectError(new SyntaxError("invalid manifest JSON")), false);
  assert.equal(
    recordingUploadResourceViolation(
      { activeUploads: defaults.maxActiveUploadsPerUser, stagedBytes: defaults.maxStagedBytesPerUser },
      defaults,
    ),
    null,
  );
  assert.equal(
    recordingUploadResourceViolation(
      { activeUploads: defaults.maxActiveUploadsPerUser + 1, stagedBytes: defaults.maxStagedBytesPerUser },
      defaults,
    ),
    "active-upload-limit",
  );
  assert.equal(
    recordingUploadResourceViolation(
      { activeUploads: 1, stagedBytes: defaults.maxStagedBytesPerUser + 1 },
      defaults,
    ),
    "staged-bytes-limit",
  );

  process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_ACTIVE_PER_USER = "2";
  process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER = String(512 * 1024 * 1024);
  process.env.OWNMINUTES_RECORDING_UPLOAD_STALE_HOURS = "24";
  const configured = getRecordingUploadResourcePolicy();
  assert.equal(configured.maxActiveUploadsPerUser, 2);
  assert.equal(configured.maxStagedBytesPerUser, 512 * 1024 * 1024);
  assert.equal(configured.staleAfterMs, 24 * 60 * 60 * 1000);

  process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_ACTIVE_PER_USER = "0";
  process.env.OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER = "1";
  process.env.OWNMINUTES_RECORDING_UPLOAD_STALE_HOURS = "999999";
  const invalid = getRecordingUploadResourcePolicy();
  assert.equal(invalid.maxActiveUploadsPerUser, defaultRecordingUploadMaxActivePerUser);
  assert.ok(invalid.maxStagedBytesPerUser >= defaultRecordingUploadMaxStagedBytesPerUser);
  assert.equal(invalid.staleAfterMs, defaultRecordingUploadStaleHours * 60 * 60 * 1000);

  console.log(JSON.stringify({
    configuredMaxActive: configured.maxActiveUploadsPerUser,
    configuredMaxStagedBytes: configured.maxStagedBytesPerUser,
    configuredStaleHours: configured.staleAfterMs / 60 / 60 / 1000,
    defaultMaxActive: defaults.maxActiveUploadsPerUser,
    defaultMaxStagedBytes: defaults.maxStagedBytesPerUser,
    defaultStaleHours: defaults.staleAfterMs / 60 / 60 / 1000,
    invalidConfigurationFailsClosed: true,
    manifestReadErrorsFailClosed: true,
    stagedBytesBoundaryVerified: true,
    staleBoundaryVerified: true,
  }, null, 2));
} finally {
  restore("OWNMINUTES_RECORDING_UPLOAD_MAX_ACTIVE_PER_USER", original.active);
  restore("OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER", original.bytes);
  restore("OWNMINUTES_RECORDING_UPLOAD_STALE_HOURS", original.hours);
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
