#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createOfflineSessionSnapshot,
  offlineSessionSnapshotTtlMs,
  parseOfflineSessionSnapshot,
  serializeOfflineSessionSnapshot,
  sessionRestoreFailureDisposition,
} from "../apps/mobile/src/offline-session.ts";

const apiBaseUrl = "https://app.ownminutes.app";
const now = Date.parse("2026-07-14T08:00:00.000Z");
const user = {
  createdAt: "2026-07-14T06:00:00.000Z",
  email: "offline@example.com",
  emailVerifiedAt: "2026-07-14T07:00:00.000Z",
  id: "user-offline-1",
  name: "Offline User",
  officialMinutesTotal: 120,
  officialMinutesUsed: 12.5,
  plan: "plus",
  role: "user",
};

const snapshot = createOfflineSessionSnapshot({ apiBaseUrl: `${apiBaseUrl}/`, now, user });
const serialized = serializeOfflineSessionSnapshot({ apiBaseUrl, now, user });
assert.equal(snapshot.apiBaseUrl, apiBaseUrl);
assert.ok(!Object.hasOwn(snapshot.user, "createdAt"));
assert.equal(Date.parse(snapshot.expiresAt) - Date.parse(snapshot.cachedAt), offlineSessionSnapshotTtlMs);
assert.deepEqual(parseOfflineSessionSnapshot(serialized, { apiBaseUrl, now }), snapshot);
assert.ok(parseOfflineSessionSnapshot(serialized, { apiBaseUrl, now: now + offlineSessionSnapshotTtlMs - 1 }));
assert.equal(parseOfflineSessionSnapshot(serialized, { apiBaseUrl, now: now + offlineSessionSnapshotTtlMs }), null);
assert.equal(parseOfflineSessionSnapshot(serialized, { apiBaseUrl: "https://other.ownminutes.app", now }), null);
assert.equal(parseOfflineSessionSnapshot("{truncated", { apiBaseUrl, now }), null);
assert.equal(parseOfflineSessionSnapshot("x".repeat(9 * 1024), { apiBaseUrl, now }), null);

const unexpectedSecret = JSON.stringify({ ...snapshot, sessionCookie: "should-not-be-accepted" });
assert.equal(parseOfflineSessionSnapshot(unexpectedSecret, { apiBaseUrl, now }), null);
assert.ok(!/(password|cookie|secret|token|apiKey)/i.test(serialized));

assert.equal(sessionRestoreFailureDisposition(new TypeError("Network request failed")), "preserve");
assert.equal(sessionRestoreFailureDisposition({ status: 500 }), "preserve");
assert.equal(sessionRestoreFailureDisposition({ status: 429 }), "preserve");
assert.equal(sessionRestoreFailureDisposition({ status: 401 }), "invalidate");
assert.equal(sessionRestoreFailureDisposition({ status: 403 }), "invalidate");

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const sessionRecoverySource = readFileSync("apps/mobile/src/session-recovery.ts", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const clearSessionStart = appSource.indexOf("const clearLocalSession = useCallback(");
const clearSessionEnd = appSource.indexOf("async function confirmDeleteAccount()", clearSessionStart);
const clearSessionSource = appSource.slice(clearSessionStart, clearSessionEnd);

assert.ok(appSource.includes('const offlineSessionSnapshotKey = "ownminutes_offline_session_v1"'));
assert.ok(appSource.includes('sessionRestoreFailureDisposition(error) === "invalidate"'));
assert.ok(appSource.includes("if (cachedUser)"));
assert.ok(appSource.includes("setOfflineSessionRestored(true)"));
assert.ok(appSource.includes('setAutoSyncMessage(t("auth.offlineSessionActive"), "warning")'));
assert.ok(appSource.includes("const standaloneLocalRecordings = userBrowsableLocalRecordings.filter("));
assert.ok(appSource.includes('if (networkStatus !== "online" && localRecording)'));
assert.ok(appSource.includes("openLocalRecording(localRecording)"));
assert.ok(appSource.includes("const selectedPlaybackRecording = selectedMeetingLocalRecording ?? selectedLocalRecording"));
assert.ok(appSource.includes('t("record.offlineTitle")'));
assert.ok(i18nSource.includes('offlineTitle: "离线记录模式"'));
assert.ok(i18nSource.includes('offlineSessionActive: "Using the saved offline session.'));
assert.ok(i18nSource.includes('offlineSessionActive: "当前使用本机离线会话。'));
assert.ok(i18nSource.includes('offlineSessionActive: "目前使用本機離線工作階段。'));
assert.ok(appSource.includes("setOfflineSessionRetryTick((value) => value + 1)"));
assert.ok(appSource.includes("}, 30_000)"));
assert.ok(appSource.includes("await Promise.allSettled([\n        refreshMeetings(storedCookie)"));
assert.ok(clearSessionSource.includes("SecureStore.deleteItemAsync(sessionCookieKey)"));
assert.ok(clearSessionSource.includes("SecureStore.deleteItemAsync(offlineSessionSnapshotKey)"));
assert.ok(apiSource.includes('export { MobileApiResponseError } from "./session-recovery"'));
assert.ok(sessionRecoverySource.includes("export class MobileApiResponseError extends Error"));
assert.ok(apiSource.includes("throw new MobileApiResponseError"));

console.log(JSON.stringify({
  authoritativeRejectionsInvalidate: true,
  cacheTtlHours: offlineSessionSnapshotTtlMs / 60 / 60 / 1000,
  malformedAndCrossServerRejected: true,
  offlineColdStartPreservesSession: true,
  secretFieldsPersisted: false,
}, null, 2));
