#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const { MeetingAccessError, meetingAccessErrorBody, meetingAccessErrorHeaders, meetingHistoryUnavailableResponse } = await import(
  new URL("../src/lib/server/meeting-errors.ts", import.meta.url)
);
const { MeetingObjectStoreHttpError, readOptionalMeetingObject } = await import(
  new URL("../src/lib/server/meeting-object-store.ts", import.meta.url)
);
const { classifyFinalizationFailure, sanitizeFinalizationMessage } = await import(
  new URL("../src/lib/server/finalization-error-policy.ts", import.meta.url)
);

const accessError = new MeetingAccessError("No access.", 403);
const busyError = new MeetingAccessError("Meeting is syncing.", 503, {
  code: "meeting_write_lock_timeout",
  retryable: true,
  retryAfterSeconds: 15,
});
const accessBody = meetingAccessErrorBody(accessError);
const busyBody = meetingAccessErrorBody(busyError);
const invalidAudio = classifyFinalizationFailure(
  new Error(
    "Audio file normalization failed: EBML header parsing failed at /var/folders/private/ownminutes-asr-audio/recording.webm https://private.example/audio?X-Amz-Signature=fixture-secret",
  ),
);
const invalidAudioDuration = classifyFinalizationFailure(
  new Error("无法读取音频时长，请确认音频文件完整后重试。"),
);
const audioDurationTimeout = classifyFinalizationFailure(new Error("音频时长检测超时，请重试上传。"));
const audioDurationProbeUnavailable = classifyFinalizationFailure(
  new Error("服务端暂时无法校验音频时长，请稍后重试。"),
);
const temporaryProvider = classifyFinalizationFailure(
  new Error("fetch failed for https://provider.example/private?X-Amz-Credential=fixture and HTTP 503"),
);
const sanitizedLegacyMessage = sanitizeFinalizationMessage(
  "failed at /Users/example/private/audio.wav https://private.example/audio?X-Amz-Signature=fixture-secret postgres://user:secret@db/ownminutes",
);
const historyResponse = meetingHistoryUnavailableResponse();
const historyBody = await historyResponse.json();
const missingObject = await readOptionalMeetingObject(async () => {
  throw Object.assign(new Error("fixture object does not exist"), { code: "ENOENT" });
});
const missingRemoteObject = await readOptionalMeetingObject(async () => {
  throw new MeetingObjectStoreHttpError("GET", 404, "<Error><Code>NoSuchKey</Code></Error>");
});
const storageFailure = new Error(
  "Object store GET failed: 503 https://private.example/audio?X-Amz-Signature=fixture-secret /var/private/object",
);
let propagatedStorageFailure;
try {
  await readOptionalMeetingObject(async () => {
    throw storageFailure;
  });
} catch (error) {
  propagatedStorageFailure = error;
}
let propagatedCorruptJson;
try {
  await readOptionalMeetingObject(async () => JSON.parse("ENOENT"));
} catch (error) {
  propagatedCorruptJson = error;
}
const misleadingMissingMessage = new Error("Object store GET failed: 404 but this is not a typed store response");
let propagatedMisleadingMissingMessage;
try {
  await readOptionalMeetingObject(async () => {
    throw misleadingMissingMessage;
  });
} catch (error) {
  propagatedMisleadingMissingMessage = error;
}
const meetingHistoryRouteSource = await readFile(
  new URL("../src/app/api/meetings/route.ts", import.meta.url),
  "utf8",
);
const summary = {
  accessErrorKeepsNonRetryable4xx:
    accessError.name === "MeetingAccessError" &&
    accessError.status === 403 &&
    accessError.retryable === false &&
    accessBody.ok === false &&
    !("retryable" in accessBody) &&
    meetingAccessErrorHeaders(accessError) === undefined,
  busyErrorIsStructuredRetryable503:
    busyError.status === 503 &&
    busyBody.code === "meeting_write_lock_timeout" &&
    busyBody.retryable === true &&
    meetingAccessErrorHeaders(busyError)?.["Retry-After"] === "15",
  invalidAudioIsSafeStructured422:
    invalidAudio.status === 422 &&
    invalidAudio.code === "audio_processing_failed" &&
    invalidAudio.retryable === false &&
    invalidAudio.message.includes("录音文件无法解码") &&
    !invalidAudio.message.match(/\/var\/|https?:|X-Amz|EBML|ffmpeg/i),
  invalidAudioDurationIsSafeStructured422:
    invalidAudioDuration.status === 422 &&
    invalidAudioDuration.code === "audio_processing_failed" &&
    invalidAudioDuration.retryable === false &&
    invalidAudioDuration.message.includes("录音文件无法解码"),
  audioDurationTimeoutIsSafeRetryable503:
    audioDurationTimeout.status === 503 &&
    audioDurationTimeout.code === "audio_processing_temporary_failure" &&
    audioDurationTimeout.retryable === true,
  audioDurationProbeUnavailableIsSafe503:
    audioDurationProbeUnavailable.status === 503 &&
    audioDurationProbeUnavailable.code === "audio_processing_unavailable" &&
    audioDurationProbeUnavailable.retryable === false,
  temporaryProviderIsSafeRetryable503:
    temporaryProvider.status === 503 &&
    temporaryProvider.code === "provider_or_storage_temporary_failure" &&
    temporaryProvider.retryable === true &&
    !temporaryProvider.message.match(/https?:|X-Amz|HTTP 503|provider\.example/i),
  legacyMessagesRedactPathsUrlsAndCredentials:
    sanitizedLegacyMessage.includes("[redacted-path]") &&
    sanitizedLegacyMessage.includes("[redacted-url]") &&
    sanitizedLegacyMessage.includes("[redacted-database-url]") &&
    !sanitizedLegacyMessage.match(/\/Users\/|private\.example|fixture-secret|user:secret/i),
  meetingHistoryFailureIsStructuredRetryable503:
    historyResponse.status === 503 &&
    historyResponse.headers.get("content-type")?.includes("application/json") === true &&
    historyResponse.headers.get("cache-control") === "no-store" &&
    historyResponse.headers.get("retry-after") === "30" &&
    historyBody.ok === false &&
    historyBody.code === "meeting_history_unavailable" &&
    historyBody.retryable === true,
  meetingHistoryFailureHidesInternalDetails:
    !JSON.stringify(historyBody).match(/postgres(?:ql)?:\/\/|password|secret|token|\/var\/|\/Users\/|X-Amz|https?:\/\//i),
  missingObjectRemainsAnOptionalNull: missingObject === null,
  missingRemoteObjectRemainsAnOptionalNull: missingRemoteObject === null,
  storageFailurePropagatesToApiBoundary: propagatedStorageFailure === storageFailure,
  enoentJsonSyntaxErrorPropagatesToApiBoundary:
    propagatedCorruptJson instanceof SyntaxError && propagatedCorruptJson.message.includes("ENOENT"),
  misleadingMissingMessagePropagatesToApiBoundary: propagatedMisleadingMissingMessage === misleadingMissingMessage,
  meetingHistoryRouteUsesJsonErrorBoundary:
    meetingHistoryRouteSource.includes("try {") &&
    meetingHistoryRouteSource.includes("meetingHistoryUnavailableResponse()") &&
    meetingHistoryRouteSource.indexOf("try {") < meetingHistoryRouteSource.indexOf("getCurrentUser()") &&
    meetingHistoryRouteSource.indexOf("getCurrentUser()") < meetingHistoryRouteSource.indexOf("listUserMeetings(user.id)"),
  noInternalDetailsExposed:
    !JSON.stringify({
      accessBody,
      audioDurationProbeUnavailable,
      audioDurationTimeout,
      busyBody,
      historyBody,
      invalidAudio,
      invalidAudioDuration,
      temporaryProvider,
    }).match(
      /DATABASE_URL|postgres(?:ql)?:\/\/|password|secret|token|\/var\/|\/Users\/|X-Amz|https?:\/\//i,
    ),
};

console.log(JSON.stringify(summary, null, 2));
if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
