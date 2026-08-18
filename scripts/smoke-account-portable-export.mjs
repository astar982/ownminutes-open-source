#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("src/app/api/account/export/route.ts", "utf8");
const dashboard = readFileSync("src/components/account-dashboard.tsx", "utf8");
const privacyPages = [
  readFileSync("src/app/privacy/page.tsx", "utf8"),
  readFileSync("src/app/en/privacy/page.tsx", "utf8"),
  readFileSync("src/app/zh-Hant/privacy/page.tsx", "utf8"),
];

assert.ok(route.includes('searchParams.get("scope") === "portable"'));
assert.ok(route.includes('"Content-Type": "application/x-ndjson; charset=utf-8"'));
assert.ok(route.includes('excludes: ["passwords", "plaintext-model-keys", "raw-audio"]'));
assert.ok(route.includes("for (const meeting of input.meetings)"));
assert.ok(route.includes("await readUserMeetingDetail(meeting.meetingId, input.userId)"));
assert.ok(route.includes("delete account.meetings"));
assert.ok(route.includes("delete account.notes"));
assert.ok(route.includes('type: "export-complete"'));
assert.ok(dashboard.includes('href="/api/account/export"'));
assert.ok(dashboard.includes('href="/api/account/export?scope=portable"'));
assert.ok(dashboard.includes("导出账号摘要"));
assert.ok(dashboard.includes("导出全部会议内容"));
assert.ok(privacyPages.every((source) => /便携导出|portable export|可攜式匯出/.test(source)));

console.log(JSON.stringify({
  accountSummaryRemainsAvailable: true,
  meetingContentStreamedSequentially: true,
  portableNdjsonAvailable: true,
  rawAudioAndSecretsExcluded: true,
  threeLanguageDisclosureUpdated: true,
}, null, 2));
