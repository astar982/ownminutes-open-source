#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(process.cwd(), "src") },
});
const {
  MeetingSharePolicyError,
  meetingShareLifetimeMs,
  resolveMeetingShareExpiresAt,
} = jiti("../src/lib/meeting-share-policy.ts");
const { resolveMeetingSharePresentation } = jiti("../src/lib/meeting-share-presentation.ts");
const sharePageSource = await readFile("src/app/share/[id]/page.tsx", "utf8");
const shareMarkdownRouteSource = await readFile("src/app/api/share/[id]/markdown/route.ts", "utf8");
const {
  getMeetingShareAnalyticsMetrics,
  recordMeetingShareViewBestEffort,
} = jiti("../src/lib/server/meeting-share-analytics.ts");
const {
  commitPreparedPublicMeetingShare,
  MeetingSharePublicationPreparationError,
} = jiti("../src/lib/server/meeting-share-publication.ts");
const meetingStoreSource = await readFile("src/lib/server/meeting-audio-store.ts", "utf8");

const now = new Date("2026-07-30T00:00:00.000Z");
const defaultExpiry = resolveMeetingShareExpiresAt(undefined, now);
assert.equal(Date.parse(defaultExpiry) - now.getTime(), meetingShareLifetimeMs);

const requestedExpiry = "2026-08-02T00:00:00.000Z";
assert.equal(resolveMeetingShareExpiresAt(requestedExpiry, now), requestedExpiry);

assert.throws(
  () => resolveMeetingShareExpiresAt("invalid", now),
  (error) => error instanceof MeetingSharePolicyError && error.code === "share_expiry_invalid",
);
assert.throws(
  () => resolveMeetingShareExpiresAt("2026-07-29T00:00:00.000Z", now),
  (error) => error instanceof MeetingSharePolicyError && error.code === "share_expiry_out_of_range",
);
assert.throws(
  () => resolveMeetingShareExpiresAt("2026-08-30T00:00:00.000Z", now),
  (error) => error instanceof MeetingSharePolicyError && error.code === "share_expiry_out_of_range",
);

const real = resolveMeetingSharePresentation({
  durationMs: 123_000,
  isDemo: false,
  result: {
    title: "真实空结果会议",
    transcript: [],
    summary: {
      actionItems: [],
      decisions: [],
      speakerViews: [],
      summary: "",
    },
  },
});
assert.equal(real.title, "真实空结果会议");
assert.equal(real.displayDurationMs, 123_000);
assert.deepEqual(real.transcript, []);
assert.deepEqual(real.decisions, []);
assert.deepEqual(real.actions, []);

const analyticsFailuresBefore = getMeetingShareAnalyticsMetrics().writeFailures;
const originalConsoleError = console.error;
const analyticsFailureLogs = [];
console.error = (...args) => analyticsFailureLogs.push(args);
let analyticsFallback;
try {
  analyticsFallback = await recordMeetingShareViewBestEffort(
    "public-readable-meeting",
    {
      record: async () => {
        const error = new Error("foreign key detail must stay private");
        error.name = "PostgresForeignKeyError";
        throw error;
      },
    },
  );
} finally {
  console.error = originalConsoleError;
}
assert.equal(real.title, "真实空结果会议");
assert.equal(analyticsFallback.recorded, false);
assert.equal(analyticsFallback.analytics, null);
assert.equal(
  getMeetingShareAnalyticsMetrics().writeFailures,
  analyticsFailuresBefore + 1,
);
assert.equal(analyticsFailureLogs.length, 1);
assert.equal(JSON.stringify(analyticsFailureLogs).includes("public-readable-meeting"), false);
assert.equal(JSON.stringify(analyticsFailureLogs).includes("foreign key detail"), false);

let anonymousVisibility = "private";
const catalogFailureEvents = [];
let catalogPreparationError;
await assert.rejects(
  commitPreparedPublicMeetingShare({
    prepareCatalog: async () => {
      catalogFailureEvents.push("catalog");
      throw new Error("injected catalog preparation failure");
    },
    prepareAnalytics: async () => {
      catalogFailureEvents.push("analytics");
    },
    commitPublicManifest: async () => {
      catalogFailureEvents.push("manifest");
      anonymousVisibility = "public";
    },
  }),
  (error) => {
    catalogPreparationError = error;
    return error instanceof MeetingSharePublicationPreparationError;
  },
);
assert.deepEqual(catalogFailureEvents, ["catalog"]);
assert.equal(anonymousVisibility, "private");
assert.equal(catalogPreparationError.code, "share_publication_not_committed");
assert.equal(catalogPreparationError.status, 503);
assert.equal(catalogPreparationError.retryable, true);
assert.equal(catalogPreparationError.publicManifestCommitted, false);

const analyticsPreparationEvents = [];
await assert.rejects(
  commitPreparedPublicMeetingShare({
    prepareCatalog: async () => {
      analyticsPreparationEvents.push("catalog");
    },
    prepareAnalytics: async () => {
      analyticsPreparationEvents.push("analytics");
      throw new Error("injected analytics preparation failure");
    },
    commitPublicManifest: async () => {
      analyticsPreparationEvents.push("manifest");
      anonymousVisibility = "public";
    },
  }),
  (error) =>
    error instanceof MeetingSharePublicationPreparationError &&
    error.stage === "analytics" &&
    error.publicManifestCommitted === false,
);
assert.deepEqual(analyticsPreparationEvents, ["catalog", "analytics"]);
assert.equal(anonymousVisibility, "private");

const successfulPublicationEvents = [];
await commitPreparedPublicMeetingShare({
  prepareCatalog: async () => {
    successfulPublicationEvents.push("catalog");
  },
  prepareAnalytics: async () => {
    successfulPublicationEvents.push("analytics");
  },
  commitPublicManifest: async () => {
    successfulPublicationEvents.push("manifest");
    anonymousVisibility = "public";
  },
});
assert.deepEqual(successfulPublicationEvents, ["catalog", "analytics", "manifest"]);
assert.equal(anonymousVisibility, "public");
assert.match(
  meetingStoreSource,
  /new MeetingAccessError\(error\.message, error\.status,[\s\S]*code: error\.code,[\s\S]*retryable: error\.retryable/,
);
const privateCommitStart = meetingStoreSource.indexOf("async function commitPrivateMeetingShareManifest");
const privateCommitEnd = meetingStoreSource.indexOf("export async function updateMeetingHumanReview", privateCommitStart);
const privateCommitBody = meetingStoreSource.slice(privateCommitStart, privateCommitEnd);
assert.ok(privateCommitStart >= 0 && privateCommitEnd > privateCommitStart);
assert.ok(
  privateCommitBody.indexOf("await objectStore.putText") <
    privateCommitBody.indexOf("await upsertMeetingCatalog"),
);

const missingRealResult = resolveMeetingSharePresentation({
  durationMs: 60_000,
  isDemo: false,
  result: null,
});
assert.equal(missingRealResult.title, "会议纪要");
assert.deepEqual(missingRealResult.transcript, []);
assert.deepEqual(missingRealResult.decisions, []);
assert.deepEqual(missingRealResult.actions, []);

const demo = resolveMeetingSharePresentation({
  durationMs: 0,
  isDemo: true,
  result: null,
});
assert.equal(demo.title, "OwnMinutes 产品方案讨论");
assert.equal(demo.displayDurationMs, 303_000);
assert.ok(demo.transcript.length > 0);
assert.ok(demo.decisions.length > 0);
assert.ok(demo.actions.length > 0);
assert.ok(
  sharePageSource.indexOf("if (!isCanonicalMeetingId(id)) notFound()") <
    sharePageSource.indexOf("readMeetingShareSnapshot(id)", sharePageSource.indexOf("export default async function SharePage")),
);
assert.ok(
  shareMarkdownRouteSource.indexOf("if (!isCanonicalMeetingId(id))") <
    shareMarkdownRouteSource.indexOf("readMeetingShareSnapshot(id)"),
);

console.log(
  JSON.stringify(
    {
      defaultShareLifetimeDays: meetingShareLifetimeMs / 24 / 60 / 60 / 1000,
      demoUsesDemoContent: true,
      readableShareSurvivesAnalyticsFailure: true,
      malformedShareIdsFailClosedBeforeStorage: true,
      publicManifestCommitsAfterCatalogAndAnalytics: true,
      publicSharePreparationFailureStaysPrivate: true,
      publicSharePreparationFailureIsRetryable503: true,
      privateRevokeCommitsManifestFirst: true,
      realEmptyResultStaysEmpty: true,
      shareAnalyticsFailureDoesNotFakeCount: true,
      realDurationPreserved: true,
    },
    null,
    2,
  ),
);
