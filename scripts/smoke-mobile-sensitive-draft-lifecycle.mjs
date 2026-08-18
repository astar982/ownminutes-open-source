#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("apps/mobile/App.tsx", "utf8");
const clearStart = source.indexOf("const clearProviderDrafts = useCallback");
const clearEnd = source.indexOf("useEffect(() =>", clearStart);
const clearFlow = source.slice(clearStart, clearEnd);
const sessionFailureStart = source.indexOf("const noteAuthenticatedSessionFailure");
const sessionFailureEnd = source.indexOf("const heroLocalStatusLabel", sessionFailureStart);
const sessionFailureFlow = source.slice(sessionFailureStart, sessionFailureEnd);
const clearSessionStart = source.indexOf("const clearLocalSession");
const clearSessionEnd = source.indexOf("useEffect(() =>", clearSessionStart);
const clearSessionFlow = source.slice(clearSessionStart, clearSessionEnd);
const saveStart = source.indexOf("async function saveProviderConfig()");
const saveEnd = source.indexOf("async function removeProviderCredential", saveStart);
const saveFlow = source.slice(saveStart, saveEnd);
const exportStart = source.indexOf("async function shareAccountExport()");
const exportEnd = source.indexOf("async function saveProviderConfig()", exportStart);
const exportFlow = source.slice(exportStart, exportEnd);

for (const setter of [
  'setProviderAppId("")',
  'setProviderModel("")',
  'setProviderBaseUrl("")',
  'setProviderAsrApiKey("")',
  'setProviderAsrToken("")',
  'setProviderArkApiKey("")',
  "setShowProviderEditor(false)",
]) {
  assert.ok(clearFlow.includes(setter), `missing provider draft reset: ${setter}`);
}
assert.ok(source.includes("providerDraftUserIdRef.current !== nextUserId"));
assert.ok(sessionFailureFlow.includes("clearProviderDrafts()"));
assert.ok(clearSessionFlow.includes("clearProviderDrafts()"));
assert.ok(saveFlow.includes("finally"));
assert.ok(saveFlow.includes("clearProviderDrafts(true)"));
assert.ok(source.includes("function toggleProviderEditor()"));
assert.ok(source.includes("onPress={toggleProviderEditor}"));

assert.ok(exportFlow.includes("FileSystem.cacheDirectory"));
assert.ok(exportFlow.includes("await FileSystem.deleteAsync(temporaryExportUri, { idempotent: true })"));
assert.ok(!exportFlow.includes("Clipboard.setStringAsync(text)"));
assert.ok(exportFlow.includes('t("accountActions.shareUnavailableBody")'));

console.log(JSON.stringify({
  providerDraftsClearAcrossAccountAndEditorBoundaries: true,
  providerDraftsClearAfterSaveAttempt: true,
  accountExportUsesEphemeralCacheFile: true,
  accountExportNeverFallsBackToWholeAccountClipboard: true,
}, null, 2));
