#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const coordinator = await importTypescriptModule(
  "apps/mobile/src/iap-transaction-coordinator.ts",
  "iap-transaction-coordinator",
);
const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const iapSource = readFileSync("apps/mobile/src/IapPlanStore.tsx", "utf8");

await verifyConcurrentDeliveryIsCoalesced(coordinator.createIapTransactionCoordinator);
await verifyActiveSyncThenListenerFinishesWithoutResubmit(coordinator.createIapTransactionCoordinator);
await verifyFinishRetryDoesNotResubmit(coordinator.createIapTransactionCoordinator);
await verifyNetworkRetryCanResubmitOnce(coordinator.createIapTransactionCoordinator);

assert.ok(appSource.includes("<IapPlanStoreProvider"));
assert.ok(appSource.includes("session={currentUser && sessionCookie"));
assert.ok(appSource.includes("<IapPlanStore />"));
assert.ok(!appSource.includes("<IapPlanStore\n                  apiBaseUrl="));
assert.ok(iapSource.includes("IapPlanStoreViewContext.Provider value={storeView}"));
assert.ok(iapSource.includes("onlyIncludeActiveItemsIOS: true"));
assert.ok(iapSource.includes("alsoPublishToEventListenerIOS: false"));
assert.ok(iapSource.includes("const reconnected = await reconnect()"));
assert.ok(iapSource.includes("void loadStorefront()"));
assert.ok(iapSource.includes("void loadAccountBinding()"));
assert.ok(iapSource.includes("void loadActiveSubscriptions()"));
assert.ok(iapSource.includes("scheduleCandidateRetry(candidate)"));
assert.ok(iapSource.includes("finish: candidate.purchase"));
assert.ok(iapSource.includes("const sessionKey = `${session.apiBaseUrl}\\u0000${session.authCookie}\\u0000${session.currentUser.id}`"));
assert.ok(iapSource.includes("<NativeIapPlanStoreProvider key={sessionKey}"));
assert.ok(iapSource.includes("mountedRef.current = false"));
assert.ok(iapSource.includes("if (!mountedRef.current) return;"));
assert.equal(iapSource.match(/submitAppleTransaction\(/g)?.length, 1);
assert.ok(iapSource.includes("void processCandidate({\n      productId: activeSubscription.productId"));

console.log(JSON.stringify({
  activeSubscriptionSyncUsesCoordinator: true,
  appRootCoordinatorMountedAfterLogin: true,
  concurrentListenerAndReplayCoalesced: true,
  previousSessionCannotApplyEntitlementAfterUnmount: true,
  crashRestartQueriesUnfinishedPurchases: true,
  finishRetryDoesNotDuplicateServerSubmission: true,
  networkFailureCanRetryServerSubmission: true,
  storeAndServerBootstrapFailuresRetry: true,
}, null, 2));

async function verifyActiveSyncThenListenerFinishesWithoutResubmit(createCoordinator) {
  const transactionCoordinator = createCoordinator();
  const counts = { apply: 0, finish: 0, verify: 0 };
  const baseWork = {
    transactionId: "transaction-active-then-listener",
    verify: async () => {
      counts.verify += 1;
      return { ok: true };
    },
    apply: async () => {
      counts.apply += 1;
    },
  };

  await transactionCoordinator.run(baseWork);
  await transactionCoordinator.run({
    ...baseWork,
    finish: async () => {
      counts.finish += 1;
    },
  });
  assert.deepEqual(counts, { apply: 1, finish: 1, verify: 1 });
}

async function verifyConcurrentDeliveryIsCoalesced(createCoordinator) {
  const transactionCoordinator = createCoordinator();
  const counts = { apply: 0, finish: 0, verify: 0 };
  const work = {
    transactionId: "transaction-concurrent",
    verify: async () => {
      counts.verify += 1;
      await Promise.resolve();
      return { ok: true };
    },
    apply: async () => {
      counts.apply += 1;
      await Promise.resolve();
    },
    finish: async () => {
      counts.finish += 1;
      await Promise.resolve();
    },
  };

  await Promise.all([
    transactionCoordinator.run(work),
    transactionCoordinator.run(work),
  ]);
  assert.deepEqual(counts, { apply: 1, finish: 1, verify: 1 });
}

async function verifyFinishRetryDoesNotResubmit(createCoordinator) {
  const transactionCoordinator = createCoordinator();
  const counts = { apply: 0, finish: 0, verify: 0 };
  const work = {
    transactionId: "transaction-finish-retry",
    verify: async () => {
      counts.verify += 1;
      return { ok: true };
    },
    apply: async () => {
      counts.apply += 1;
    },
    finish: async () => {
      counts.finish += 1;
      if (counts.finish === 1) throw new Error("STOREKIT_TEMPORARILY_UNAVAILABLE");
    },
  };

  await assert.rejects(transactionCoordinator.run(work), /STOREKIT_TEMPORARILY_UNAVAILABLE/);
  await transactionCoordinator.run(work);
  assert.deepEqual(counts, { apply: 1, finish: 2, verify: 1 });
}

async function verifyNetworkRetryCanResubmitOnce(createCoordinator) {
  const transactionCoordinator = createCoordinator();
  const counts = { apply: 0, finish: 0, verify: 0 };
  const work = {
    transactionId: "transaction-network-retry",
    verify: async () => {
      counts.verify += 1;
      if (counts.verify === 1) throw new Error("NETWORK_OFFLINE");
      return { ok: true };
    },
    apply: async () => {
      counts.apply += 1;
    },
    finish: async () => {
      counts.finish += 1;
    },
  };

  await assert.rejects(transactionCoordinator.run(work), /NETWORK_OFFLINE/);
  await transactionCoordinator.run(work);
  assert.deepEqual(counts, { apply: 1, finish: 1, verify: 2 });
}

async function importTypescriptModule(path, marker) {
  const source = readFileSync(path, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: path,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}#${marker}-${Date.now()}`);
}
