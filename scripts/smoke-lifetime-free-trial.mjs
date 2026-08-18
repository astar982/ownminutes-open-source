#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-lifetime-free-trial-"));
const storePath = path.join(tempDataDir, "store.json");
process.env.OWNMINUTES_AUTH_DATA_DIR = tempDataDir;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const sourcePath = path.join(repoRoot, "src", specifier.slice(2));
    for (const candidate of [`${sourcePath}.ts`, `${sourcePath}.tsx`, path.join(sourcePath, "index.ts")]) {
      if (fs.existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  getUserUsage,
  recordMeetingFinalizeUsage,
  registerUser,
  updateUserPlan,
} = await import("../src/lib/server/auth-store.ts");

try {
  const runId = `${Date.now()}_${process.pid}`;
  const user = registerUser({
    email: `lifetime-trial-${runId}@ownminutes.local`,
    name: "Lifetime Trial Smoke",
    password: `OwnMinutes-${runId}`,
  });
  const registeredStoreUser = findStoreUser(user.id);
  const used = recordMeetingFinalizeUsage(user.id, {
    durationMs: 7 * 60 * 1000,
    meetingId: `lifetime-trial-meeting-${runId}`,
    resultGeneratedAt: new Date().toISOString(),
    route: "official_quota",
  });

  // Simulate an account written by the former monthly-Free implementation.
  mutateStoreUser(user.id, (record) => {
    delete record.freeTrialMinutesTotal;
    delete record.freeTrialMinutesUsed;
    delete record.freeTrialGrantedAt;
    record.officialMinutesPeriodSource = "free";
    record.officialMinutesPeriodEndAt = "2020-01-01T00:00:00.000Z";
  });
  const legacyFreeAfterDeadline = getUserUsage(user.id);
  const migratedFree = findStoreUser(user.id);

  updateUserPlan(user.id, "plus");
  const returnedFromPaid = updateUserPlan(user.id, "free");
  const returnedUsage = getUserUsage(user.id);

  const legacyPaid = registerUser({
    email: `legacy-paid-${runId}@ownminutes.local`,
    name: "Legacy Paid Smoke",
    password: `OwnMinutes-Legacy-${runId}`,
  });
  updateUserPlan(legacyPaid.id, "plus");
  mutateStoreUser(legacyPaid.id, (record) => {
    delete record.freeTrialMinutesTotal;
    delete record.freeTrialMinutesUsed;
    delete record.freeTrialGrantedAt;
  });
  const legacyPaidReturned = updateUserPlan(legacyPaid.id, "free");

  const summary = {
    registrationGetsSingleTrial:
      user.plan === "free" &&
      user.officialMinutesTotal === 60 &&
      user.officialMinutesUsed === 0 &&
      registeredStoreUser.freeTrialMinutesTotal === 60 &&
      registeredStoreUser.freeTrialMinutesUsed === 0 &&
      registeredStoreUser.officialMinutesPeriodSource === "free_trial" &&
      !registeredStoreUser.officialMinutesPeriodEndAt,
    freeUsageUpdatesDurableTrial:
      used.officialMinutesUsed === 7 &&
      findStoreUser(user.id).freeTrialMinutesUsed === 7,
    legacyFreeKeepsCurrentRemainderOnce:
      legacyFreeAfterDeadline.officialMinutesTotal === 60 &&
      legacyFreeAfterDeadline.officialMinutesUsed === 7 &&
      legacyFreeAfterDeadline.officialMinutesRemaining === 53 &&
      migratedFree.freeTrialMinutesUsed === 7 &&
      migratedFree.officialMinutesPeriodSource === "free_trial" &&
      !migratedFree.officialMinutesPeriodEndAt,
    paidReturnRestoresOriginalSnapshot:
      returnedFromPaid.plan === "free" &&
      returnedFromPaid.officialMinutesTotal === 60 &&
      returnedFromPaid.officialMinutesUsed === 7 &&
      returnedUsage.officialMinutesRemaining === 53,
    legacyPaidDoesNotReceiveSecondTrial:
      legacyPaidReturned.plan === "free" &&
      legacyPaidReturned.officialMinutesTotal === 60 &&
      legacyPaidReturned.officialMinutesUsed === 60,
  };

  console.log(JSON.stringify(summary, null, 2));
  const failed = Object.entries(summary).filter(([, value]) => value !== true).map(([key]) => key);
  if (failed.length > 0) throw new Error(`Lifetime Free trial smoke failed: ${failed.join(", ")}`);
} finally {
  fs.rmSync(tempDataDir, { force: true, recursive: true });
}

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function findStoreUser(userId) {
  const user = readStore().users.find((record) => record.id === userId);
  if (!user) throw new Error(`Missing store user ${userId}.`);
  return user;
}

function mutateStoreUser(userId, mutator) {
  const store = readStore();
  const user = store.users.find((record) => record.id === userId);
  if (!user) throw new Error(`Missing store user ${userId}.`);
  mutator(user);
  fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}
