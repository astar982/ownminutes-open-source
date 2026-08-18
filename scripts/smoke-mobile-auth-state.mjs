#!/usr/bin/env node

import assert from "node:assert/strict";
import { initialEmailVerificationState } from "../apps/mobile/src/email-verification-state.ts";

const nowMs = Date.parse("2026-07-19T10:00:00.000Z");

assert.deepEqual(
  initialEmailVerificationState(
    { emailSent: false, retryAfterSeconds: 17 },
    { defaultResendSeconds: 60, nowMs },
  ),
  { deliveryFailed: true, resendSeconds: 17 },
);
assert.deepEqual(
  initialEmailVerificationState(
    { emailSent: false },
    { defaultResendSeconds: 60, nowMs },
  ),
  { deliveryFailed: true, resendSeconds: 0 },
);
assert.deepEqual(
  initialEmailVerificationState(
    { emailSent: true },
    { defaultResendSeconds: 60, nowMs },
  ),
  { deliveryFailed: false, resendSeconds: 60 },
);
assert.deepEqual(
  initialEmailVerificationState(
    { emailSent: false, resendAvailableAt: "2026-07-19T10:00:42.100Z", retryAfterSeconds: 8 },
    { defaultResendSeconds: 60, nowMs },
  ),
  { deliveryFailed: true, resendSeconds: 43 },
);

console.log(JSON.stringify({
  deliveryFailureIsVisible: true,
  resendAvailabilityUsesServerTiming: true,
  successfulDeliveryKeepsDefaultCooldown: true,
}, null, 2));
