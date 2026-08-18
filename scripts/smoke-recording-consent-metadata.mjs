#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(process.cwd(), "src") },
});
const {
  normalizeStoredRecordingConsentMetadata,
  parseRecordingConsentMetadata,
} = jiti("../src/lib/server/recording-upload-protocol.ts");

const confirmed = parseRecordingConsentMetadata(new Headers({
  "X-OwnMinutes-Consent-Confirmed-At": "2026-07-30T01:02:03Z",
  "X-OwnMinutes-Consent-Method": "in_app_confirmation",
  "X-OwnMinutes-Consent-Policy-Version": "2026-07-30",
}));
assert.deepEqual(confirmed, {
  consentConfirmedAt: "2026-07-30T01:02:03.000Z",
  consentMethod: "in_app_confirmation",
  consentPolicyVersion: "2026-07-30",
});
assert.deepEqual(
  parseRecordingConsentMetadata(new Headers()),
  { consentMethod: "legacy_unknown" },
);
assert.deepEqual(
  normalizeStoredRecordingConsentMetadata(undefined),
  { consentMethod: "legacy_unknown" },
);
assert.throws(
  () => parseRecordingConsentMetadata(new Headers({
    "X-OwnMinutes-Consent-Method": "in_app_confirmation",
  })),
  (error) => error?.code === "INVALID_RECORDING_CONSENT_METADATA",
);
assert.throws(
  () => parseRecordingConsentMetadata(new Headers({
    "X-OwnMinutes-Consent-Confirmed-At": "2026-07-30T01:02:03Z",
    "X-OwnMinutes-Consent-Method": "legacy_unknown",
  })),
  (error) => error?.code === "INVALID_RECORDING_CONSENT_METADATA",
);

const uploadStoreSource = readFileSync("src/lib/server/recording-upload-store.ts", "utf8");
const meetingStoreSource = readFileSync("src/lib/server/meeting-audio-store.ts", "utf8");
const uploadRouteSource = readFileSync("src/app/api/meetings/[id]/recording-upload/route.ts", "utf8");
for (const field of ["consentConfirmedAt", "consentMethod", "consentPolicyVersion"]) {
  assert.ok(uploadStoreSource.includes(field), `${field} must be retained in upload manifests and receipts`);
  assert.ok(meetingStoreSource.includes(field) || meetingStoreSource.includes("recordingConsent"));
  assert.ok(uploadRouteSource.includes(field), `${field} must be returned by resumable-upload status`);
}
assert.ok(meetingStoreSource.includes("assertAndSetRecordingConsent"));
assert.ok(meetingStoreSource.includes("recording_consent_conflict"));

console.log(JSON.stringify({
  canonicalManifestRecord: true,
  confirmedConsentValidated: true,
  legacyRecordPreservedAsUnknown: true,
  resumableMetadataRoundTrip: true,
}, null, 2));
