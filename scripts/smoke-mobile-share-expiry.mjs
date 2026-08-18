#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createDefaultMeetingShareExpiresAt,
  mobileMeetingShareLifetimeMs,
} from "../apps/mobile/src/meeting-share.ts";

const now = new Date("2026-07-30T00:00:00.000Z");
const expiresAt = createDefaultMeetingShareExpiresAt(now);
assert.equal(expiresAt, "2026-08-06T00:00:00.000Z");
assert.equal(Date.parse(expiresAt) - now.getTime(), 7 * 24 * 60 * 60 * 1_000);
assert.equal(mobileMeetingShareLifetimeMs, 7 * 24 * 60 * 60 * 1_000);
assert.throws(() => createDefaultMeetingShareExpiresAt(new Date(Number.NaN)), /Invalid meeting share creation time/);

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const typesSource = readFileSync("apps/mobile/src/types.ts", "utf8");
assert.ok(appSource.includes("const expiresAt = input.visibility === \"public\""));
assert.ok(appSource.includes("expiresAt,"));
assert.ok(appSource.includes('t("meetingShare.expiresAt"'));
assert.ok(apiSource.includes("expiresAt: params.expiresAt"));
assert.ok(typesSource.includes("expiresAt?: string;"));

console.log(JSON.stringify({
  explicitExpirySentByMobile: true,
  expiryDisplayedToUser: true,
  lifetimeDays: mobileMeetingShareLifetimeMs / (24 * 60 * 60 * 1_000),
}, null, 2));
