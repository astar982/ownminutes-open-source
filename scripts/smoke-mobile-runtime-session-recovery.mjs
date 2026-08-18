#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  assertNoAuthoritativeSessionRejection,
  isRecordingStartSessionCurrent,
  MobileApiResponseError,
  runtimeSessionFailureDisposition,
  shouldBlockRecordingSensitiveMutation,
} = await jiti.import("../apps/mobile/src/session-recovery.ts");

const unauthorized = new Response(JSON.stringify({ error: "session expired" }), {
  headers: { "content-type": "application/json" },
  status: 401,
});
await assert.rejects(
  () => assertNoAuthoritativeSessionRejection(unauthorized),
  (error) => error instanceof MobileApiResponseError && error.status === 401 && error.message === "session expired",
);
await assert.rejects(
  () => assertNoAuthoritativeSessionRejection(new Response("not-json", { status: 403 }), { forbiddenIsAuthoritative: true }),
  (error) => error instanceof MobileApiResponseError && error.status === 403,
);
const forbiddenBusinessResponse = new Response(JSON.stringify({ error: "not allowed" }), { status: 403 });
assert.equal(await assertNoAuthoritativeSessionRejection(forbiddenBusinessResponse), forbiddenBusinessResponse);
const transientFailure = new Response("temporary", { status: 503 });
assert.equal(await assertNoAuthoritativeSessionRejection(transientFailure), transientFailure);

assert.equal(runtimeSessionFailureDisposition(new TypeError("offline"), false), "preserve");
assert.equal(runtimeSessionFailureDisposition({ status: 429 }, false), "preserve");
assert.equal(runtimeSessionFailureDisposition({ status: 500 }, true), "preserve");
assert.equal(runtimeSessionFailureDisposition({ status: 401 }, false), "preserve");
assert.equal(runtimeSessionFailureDisposition(new MobileApiResponseError("expired", 401), false), "reauthenticate-now");
assert.equal(runtimeSessionFailureDisposition(new MobileApiResponseError("forbidden", 403), true), "preserve");
assert.equal(
  runtimeSessionFailureDisposition(new MobileApiResponseError("revoked", 403, { authoritative: true }), true),
  "reauthenticate-after-recording",
);
assert.equal(
  shouldBlockRecordingSensitiveMutation({ recordingLifecycleBusy: true, recordingStopInFlight: false }),
  true,
);
assert.equal(
  shouldBlockRecordingSensitiveMutation({ recordingLifecycleBusy: false, recordingStopInFlight: true }),
  true,
);
assert.equal(
  shouldBlockRecordingSensitiveMutation({ recordingLifecycleBusy: false, recordingStopInFlight: false }),
  false,
);
const recordingStartFence = { generation: 7, userId: "user-a" };
assert.equal(
  isRecordingStartSessionCurrent(recordingStartFence, {
    generation: 7,
    reauthenticationRequired: false,
    userId: "user-a",
  }),
  true,
);
assert.equal(
  isRecordingStartSessionCurrent(recordingStartFence, {
    generation: 8,
    reauthenticationRequired: false,
    userId: "user-a",
  }),
  false,
);
assert.equal(
  isRecordingStartSessionCurrent(recordingStartFence, {
    generation: 7,
    reauthenticationRequired: true,
    userId: "user-a",
  }),
  false,
);
assert.equal(
  isRecordingStartSessionCurrent(recordingStartFence, {
    generation: 7,
    reauthenticationRequired: false,
    userId: "user-b",
  }),
  false,
);

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const syncStart = appSource.indexOf("async function syncPendingRecordings(");
const syncEnd = appSource.indexOf("async function retryUpload()", syncStart);
const syncSource = appSource.slice(syncStart, syncEnd);
const clearStart = appSource.indexOf("const clearLocalSession = useCallback(");
const clearEnd = appSource.indexOf("async function confirmDeleteAccount()", clearStart);
const clearSource = appSource.slice(clearStart, clearEnd);
const logoutStart = appSource.indexOf("async function logout()");
const logoutEnd = appSource.indexOf("function switchAuthMode(", logoutStart);
const logoutSource = appSource.slice(logoutStart, logoutEnd);
const deleteStart = appSource.indexOf("async function confirmDeleteAccount()");
const deleteEnd = appSource.indexOf("async function shareAccountExport()", deleteStart);
const deleteSource = appSource.slice(deleteStart, deleteEnd);
const recordingStart = appSource.indexOf("async function startRecording()");
const recordingEnd = appSource.indexOf("async function doStartRecording(", recordingStart);
const recordingSource = appSource.slice(recordingStart, recordingEnd);
const doRecordingStartEnd = appSource.indexOf("async function pauseRecording()", recordingEnd);
const doRecordingSource = appSource.slice(recordingEnd, doRecordingStartEnd);
const providerStart = appSource.indexOf("async function saveProviderConfig()");
const providerEnd = appSource.indexOf("async function openProviderUrl(", providerStart);
const providerSource = appSource.slice(providerStart, providerEnd);

assert.ok(apiSource.includes("return assertNoAuthoritativeSessionRejection(response, { ...sessionOptions, language: mobileApiLanguage })"));
assert.ok(appSource.includes("const [sessionReauthenticationRequired, setSessionReauthenticationRequired]"));
assert.ok(appSource.includes("recordingLifecycleBusyRef.current = recordingLifecycleBusy"));
assert.ok(appSource.includes("runtimeSessionFailureDisposition(error, recordingLifecycleBusyRef.current)"));
assert.ok(appSource.includes("setInterval(() => void validate(), 30_000)"));
assert.ok(appSource.includes('t("auth.sessionExpiredRecording")'));
assert.ok(appSource.includes('t("runtime.realtimeAuthExpired")'));
assert.ok(i18nSource.includes('realtimeAuthExpired: "Sign-in expired, so live draft upload stopped.'));
assert.ok(i18nSource.includes('realtimeAuthExpired: "登录已过期，已停止上传实时草稿。'));
assert.ok(i18nSource.includes('sessionExpiredRecording: "Recording continues on this device.'));
assert.ok(i18nSource.includes('sessionExpiredRecording: "会议继续本地录制。结束并保存后会返回登录'));
assert.ok(i18nSource.includes('sessionExpiredRecording: "會議繼續在本機錄製。'));
assert.ok(syncSource.includes("if (sessionReauthenticationRequiredRef.current)"));
assert.ok(syncSource.includes("if (isCurrentSyncSession() && noteAuthenticatedSessionFailure(error))"));
assert.ok(syncSource.includes("nextRetryAt: undefined"));
assert.ok(syncSource.includes("if (authenticationRejected)"));
assert.ok(clearSource.includes("if (!sessionReauthenticationRequired || recordingLifecycleBusy) return"));
assert.ok(clearSource.includes('clearLocalSession(t("auth.sessionExpiredIdle"))'));
assert.ok(clearSource.includes("recordingGenerationRef.current += 1"));
assert.ok(i18nSource.includes('sessionExpiredIdle: "本机录音不会删除，正在返回登录页。"'));
assert.ok(logoutSource.includes("shouldBlockRecordingSensitiveMutation({"));
assert.ok(logoutSource.indexOf("shouldBlockRecordingSensitiveMutation({") < logoutSource.indexOf("await logoutAccount("));
assert.ok(logoutSource.includes("accountSessionMutationInFlightRef.current = true"));
assert.ok(logoutSource.includes("accountSessionMutationInFlightRef.current = false"));
assert.ok(appSource.includes('<MenuAction disabled={recordingLifecycleBusy} detail={t("account.signOutDetail")}'));
assert.ok(appSource.includes('<MenuAction danger disabled={recordingLifecycleBusy}'));
assert.ok(deleteSource.match(/shouldBlockRecordingSensitiveMutation\(\{/g)?.length >= 2);
assert.ok(deleteSource.indexOf("shouldBlockRecordingSensitiveMutation({") < deleteSource.indexOf("deleteAccountWithConfirmation({"));
assert.ok(deleteSource.includes("accountSessionMutationInFlightRef.current = true"));
assert.ok(deleteSource.includes("accountSessionMutationInFlightRef.current = false"));
assert.ok(recordingSource.includes("if (accountSessionMutationInFlightRef.current)"));
assert.ok(recordingSource.includes("const recordingStartFence: RecordingStartSessionFence"));
assert.ok(recordingSource.includes("if (!recordingStartSessionIsCurrent(recordingStartFence)) return"));
assert.ok(doRecordingSource.includes("recordingStatusRef.current = \"requesting\""));
assert.ok(doRecordingSource.includes("recordingLifecycleBusyRef.current = true"));
assert.ok((doRecordingSource.match(/recordingStartSessionIsCurrent\(recordingStartFence\)/g) || []).length >= 4);
assert.ok(doRecordingSource.indexOf("recordingStartSessionIsCurrent(recordingStartFence)") <
  doRecordingSource.indexOf("recorder.record({ forDuration:"));
assert.ok(doRecordingSource.includes("await abandonStaleRecordingStart()"));
assert.ok(i18nSource.includes('accountMutationBlockedBody: "录音正在启动、进行、暂停或安全保存时'));
assert.ok(providerSource.match(/shouldBlockRecordingSensitiveMutation\(\{/g)?.length >= 4);
assert.ok(providerSource.indexOf("shouldBlockRecordingSensitiveMutation({") < providerSource.indexOf("await saveProviderCredential({"));
assert.ok(providerSource.indexOf("shouldBlockRecordingSensitiveMutation({", providerSource.indexOf("confirmDeleteProviderCredential")) <
  providerSource.indexOf("deleteProviderCredential(", providerSource.indexOf("confirmDeleteProviderCredential")));
assert.ok(providerSource.match(/providerMutationInFlightRef\.current = true/g)?.length >= 3);
assert.ok(providerSource.match(/providerMutationInFlightRef\.current = false/g)?.length >= 3);
assert.ok(recordingSource.includes("if (providerMutationInFlightRef.current)"));
assert.ok(appSource.includes("disabled={processingModeSaving || recordingLifecycleBusy}"));
assert.ok(appSource.includes("disabled={providerSaving || Boolean(providerDeleting) || recordingLifecycleBusy}"));
assert.ok(i18nSource.includes('providerMutationBlockedBody: "录音正在进行或安全保存时'));
assert.ok(i18nSource.includes('providerMutationInProgressBody: "请等待当前凭据或处理方式变更完成'));

console.log(JSON.stringify({
  accountSessionMutationCannotSplitActiveRecorder: true,
  activeSessionRevalidatedEverySeconds: 30,
  authoritativeIdleRejectionRequiresLogin: true,
  authoritativeRecordingRejectionDeferred: true,
  businessForbiddenDoesNotInvalidateSession: true,
  pendingAudioPreservedWithoutRetryBackoff: true,
  providerCredentialsFrozenDuringRecording: true,
  recordingConsentCannotOutliveSession: true,
  realtimeDraftStopsWithoutStoppingRecorder: true,
  transientFailuresPreserveSession: true,
}, null, 2));
