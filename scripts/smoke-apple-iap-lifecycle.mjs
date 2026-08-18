#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-iap-lifecycle-"));
const storePath = path.join(tempDataDir, "store.json");

if (process.env.NODE_ENV === "production") {
  throw new Error("IAP lifecycle smoke must never run with NODE_ENV=production.");
}
if (process.env.OWNMINUTES_AUTH_REPOSITORY !== "local-file") {
  throw new Error("IAP lifecycle smoke requires OWNMINUTES_AUTH_REPOSITORY=local-file.");
}
if (process.env.OWNMINUTES_ENABLE_IAP_MOCK !== "1") {
  throw new Error("IAP lifecycle smoke requires the explicit OWNMINUTES_ENABLE_IAP_MOCK=1 test gate.");
}

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
  bindAppleIapAccount,
  deleteAccount,
  getUserById,
  getUserUsage,
  recordAppleIapNotification,
  recordMeetingFinalizeUsage,
  registerUser,
} = await import("../src/lib/server/auth-store.ts");
const {
  createAppleIapAccountToken,
  isLocalAppleIapMockRequest,
} = await import("../src/lib/apple-iap.ts");

const runId = `${Date.now()}_${process.pid}`;
const productId = "ownminutes.plus.monthly";
const originalTransactionId = `smoke_lifecycle_original_${runId}`;
const initialTransactionId = `smoke_lifecycle_initial_${runId}`;
const renewalTransactionId = `smoke_lifecycle_renewal_${runId}`;
const now = Date.now();
const initialPeriodStartAt = iso(now - 24 * 60 * 60 * 1000);
const initialPeriodEndAt = iso(now + 29 * 24 * 60 * 60 * 1000);
const renewalPeriodStartAt = initialPeriodEndAt;
const renewalPeriodEndAt = iso(now + 59 * 24 * 60 * 60 * 1000);
const graceExpiresAt = iso(now + 66 * 24 * 60 * 60 * 1000);

try {
  const loopbackRequest = new Request("http://127.0.0.1:3003/api/payments/apple/transactions");
  const forwardedHostSpoof = new Request("https://example.com/api/payments/apple/transactions", {
    headers: { "x-forwarded-host": "127.0.0.1:3003" },
  });
  const explicitMockGateWorks =
    isLocalAppleIapMockRequest(loopbackRequest, initialTransactionId) === true &&
    isLocalAppleIapMockRequest(forwardedHostSpoof, initialTransactionId) === false;

  const user = registerUser({
    email: `iap-lifecycle-${runId}@ownminutes.local`,
    name: "IAP Lifecycle Smoke",
    password: `OwnMinutes-${runId}`,
  });
  const appAccountToken = createAppleIapAccountToken(user.id, { allowLocalMock: true });
  bindAppleIapAccount(user.id, appAccountToken);
  const rotatedAccountToken = createAppleIapAccountToken(user.id, {
    keyVersion: "v2",
    secret: "rotated-account-binding-secret-for-smoke-v2",
  });
  bindAppleIapAccount(user.id, rotatedAccountToken, "v2");
  const bindingsAfterRotation = readStore().appleIapAccountBindings.filter((item) => item.userId === user.id);

  const freeUsage = recordMeetingFinalizeUsage(user.id, {
    durationMs: 7 * 60 * 1000,
    meetingId: `smoke-free-usage-${runId}`,
    resultGeneratedAt: iso(now - 2_000),
    route: "official_quota",
  });

  const subscribedInput = notification({
    appAccountToken,
    expiresDate: initialPeriodEndAt,
    notificationType: "SUBSCRIBED",
    notificationUUID: `notification_subscribed_${runId}`,
    originalTransactionId,
    payload: "subscribed",
    purchaseDate: initialPeriodStartAt,
    signedDate: iso(now - 1_000),
    transactionId: initialTransactionId,
  });
  const subscribed = recordAppleIapNotification(subscribedInput);
  const storeAfterSubscribed = readStore();
  const userAfterSubscribed = findUser(storeAfterSubscribed, user.id);
  const initialOrder = findOrder(storeAfterSubscribed, initialTransactionId);

  const plusUsage = recordMeetingFinalizeUsage(user.id, {
    durationMs: 13 * 60 * 1000,
    meetingId: `smoke-plus-usage-${runId}`,
    resultGeneratedAt: iso(now),
    route: "official_quota",
  });

  const renewalInput = notification({
    appAccountToken,
    expiresDate: renewalPeriodEndAt,
    notificationType: "DID_RENEW",
    notificationUUID: `notification_renewed_${runId}`,
    originalTransactionId,
    payload: "renewed",
    purchaseDate: renewalPeriodStartAt,
    signedDate: iso(now + 1_000),
    transactionId: renewalTransactionId,
  });
  const renewed = recordAppleIapNotification(renewalInput);
  const storeAfterRenewal = readStore();
  const userAfterRenewal = findUser(storeAfterRenewal, user.id);
  const renewalOrder = findOrder(storeAfterRenewal, renewalTransactionId);
  const initialGrantAfterRenewal = findGrant(storeAfterRenewal, initialOrder.entitlementGrantId);
  const renewalGrant = findGrant(storeAfterRenewal, renewalOrder.entitlementGrantId);
  const countsAfterRenewal = lifecycleCounts(storeAfterRenewal);

  const duplicateRenewal = recordAppleIapNotification(renewalInput);
  const storeAfterDuplicate = readStore();
  const countsAfterDuplicate = lifecycleCounts(storeAfterDuplicate);

  let hashCollisionError;
  try {
    recordAppleIapNotification({
      ...renewalInput,
      payloadSha256: sha256("renewed-but-mutated"),
      reason: "mutated payload with reused notificationUUID",
    });
  } catch (error) {
    hashCollisionError = error;
  }
  const storeAfterHashCollision = readStore();

  const staleRenewalTransactionId = `smoke_lifecycle_stale_renewal_${runId}`;
  const staleRenewal = recordAppleIapNotification(notification({
    appAccountToken,
    expiresDate: initialPeriodEndAt,
    notificationType: "DID_RENEW",
    notificationUUID: `notification_stale_renewal_${runId}`,
    originalTransactionId,
    payload: "stale-renewal",
    purchaseDate: initialPeriodStartAt,
    signedDate: iso(now + 500),
    transactionId: staleRenewalTransactionId,
  }));
  const storeAfterStaleRenewal = readStore();
  const userAfterStaleRenewal = findUser(storeAfterStaleRenewal, user.id);
  const subscriptionAfterStaleRenewal = findSubscription(storeAfterStaleRenewal, originalTransactionId);

  const graceInput = notification({
    appAccountToken,
    expiresDate: renewalPeriodEndAt,
    graceExpiresDate: graceExpiresAt,
    notificationType: "DID_FAIL_TO_RENEW",
    notificationUUID: `notification_grace_${runId}`,
    originalTransactionId,
    payload: "grace",
    signedDate: iso(now + 2_000),
    subtype: "GRACE_PERIOD",
    transactionId: renewalTransactionId,
  });
  const grace = recordAppleIapNotification(graceInput);
  const storeAfterGrace = readStore();
  const subscriptionAfterGrace = findSubscription(storeAfterGrace, originalTransactionId);
  const usageAfterGrace = getUserUsage(user.id);
  const statusDuringGrace = recordAppleIapNotification(notification({
    appAccountToken,
    notificationType: "DID_CHANGE_RENEWAL_STATUS",
    notificationUUID: `notification_status_during_grace_${runId}`,
    originalTransactionId,
    payload: "status-during-grace",
    signedDate: iso(now + 2_500),
    transactionId: renewalTransactionId,
  }));
  const subscriptionAfterStatusDuringGrace = findSubscription(readStore(), originalTransactionId);

  const refund = recordAppleIapNotification(notification({
    appAccountToken,
    notificationType: "REFUND",
    notificationUUID: `notification_refund_${runId}`,
    originalTransactionId,
    payload: "refund",
    signedDate: iso(now + 3_000),
    transactionId: renewalTransactionId,
  }));
  const storeAfterRefund = readStore();
  const userAfterRefund = findUser(storeAfterRefund, user.id);
  const orderAfterRefund = findOrder(storeAfterRefund, renewalTransactionId);
  const grantAfterRefund = findGrant(storeAfterRefund, orderAfterRefund.entitlementGrantId);

  const refundReversed = recordAppleIapNotification(notification({
    appAccountToken,
    notificationType: "REFUND_REVERSED",
    notificationUUID: `notification_refund_reversed_${runId}`,
    originalTransactionId,
    payload: "refund-reversed",
    signedDate: iso(now + 4_000),
    transactionId: renewalTransactionId,
  }));

  const newerRestore = recordAppleIapNotification(notification({
    appAccountToken,
    notificationType: "REFUND_REVERSED",
    notificationUUID: `notification_newer_restore_${runId}`,
    originalTransactionId,
    payload: "newer-restore",
    signedDate: iso(now + 6_000),
    transactionId: renewalTransactionId,
  }));
  const staleRefund = recordAppleIapNotification(notification({
    appAccountToken,
    notificationType: "REFUND",
    notificationUUID: `notification_stale_refund_${runId}`,
    originalTransactionId,
    payload: "stale-refund",
    signedDate: iso(now + 5_500),
    transactionId: renewalTransactionId,
  }));
  const storeAfterStaleRefund = readStore();
  const userAfterStaleRefund = findUser(storeAfterStaleRefund, user.id);
  const orderAfterStaleRefund = findOrder(storeAfterStaleRefund, renewalTransactionId);
  const grantAfterStaleRefund = findGrant(storeAfterStaleRefund, orderAfterStaleRefund.entitlementGrantId);
  const subscriptionAfterStaleRefund = findSubscription(storeAfterStaleRefund, originalTransactionId);

  const expired = recordAppleIapNotification(notification({
    appAccountToken,
    notificationType: "EXPIRED",
    notificationUUID: `notification_expired_${runId}`,
    originalTransactionId,
    payload: "expired",
    signedDate: iso(now + 7_000),
    transactionId: renewalTransactionId,
  }));
  const storeAfterExpired = readStore();
  const userAfterExpired = findUser(storeAfterExpired, user.id);
  const orderAfterExpired = findOrder(storeAfterExpired, renewalTransactionId);
  const grantAfterExpired = findGrant(storeAfterExpired, orderAfterExpired.entitlementGrantId);
  const subscriptionAfterExpired = findSubscription(storeAfterExpired, originalTransactionId);

  const orderingUser = registerUser({
    email: `iap-ordering-${runId}@ownminutes.local`,
    name: "IAP Ordering Smoke",
    password: `OwnMinutes-Ordering-${runId}`,
  });
  const orderingToken = createAppleIapAccountToken(orderingUser.id, { allowLocalMock: true });
  bindAppleIapAccount(orderingUser.id, orderingToken);
  const orderingOriginal = `smoke_ordering_original_${runId}`;
  const orderingInitial = `smoke_ordering_initial_${runId}`;
  const orderingRenewal = `smoke_ordering_renewal_${runId}`;
  const orderingUpgrade = `smoke_ordering_upgrade_${runId}`;
  const orderingInitialEnd = iso(now + 5_000);
  const orderingRenewalStart = orderingInitialEnd;
  const orderingRenewalEnd = iso(now + 59 * 24 * 60 * 60 * 1000);
  recordAppleIapNotification(notification({
    appAccountToken: orderingToken,
    expiresDate: orderingInitialEnd,
    notificationType: "SUBSCRIBED",
    notificationUUID: `notification_ordering_initial_${runId}`,
    originalTransactionId: orderingOriginal,
    payload: "ordering-initial",
    purchaseDate: initialPeriodStartAt,
    signedDate: iso(now + 10_000),
    transactionId: orderingInitial,
  }));
  const preferenceBeforeRenewal = recordAppleIapNotification(notification({
    appAccountToken: orderingToken,
    notificationType: "DID_CHANGE_RENEWAL_STATUS",
    notificationUUID: `notification_preference_before_renewal_${runId}`,
    originalTransactionId: orderingOriginal,
    payload: "preference-before-renewal",
    signedDate: iso(now + 12_000),
    transactionId: orderingInitial,
  }));
  const delayedRenewal = recordAppleIapNotification(notification({
    appAccountToken: orderingToken,
    expiresDate: orderingRenewalEnd,
    notificationType: "DID_RENEW",
    notificationUUID: `notification_delayed_renewal_${runId}`,
    originalTransactionId: orderingOriginal,
    payload: "delayed-renewal",
    purchaseDate: orderingRenewalStart,
    signedDate: iso(now + 11_000),
    transactionId: orderingRenewal,
  }));
  const upgradePeriodStart = iso(now + 30_000);
  const shorterUpgradeEnd = iso(now + 45 * 24 * 60 * 60 * 1000);
  const upgrade = recordAppleIapNotification(notification({
    appAccountToken: orderingToken,
    expiresDate: shorterUpgradeEnd,
    notificationType: "DID_CHANGE_RENEWAL_PREF",
    notificationUUID: `notification_upgrade_${runId}`,
    originalTransactionId: orderingOriginal,
    payload: "upgrade",
    plan: "pro",
    productId: "ownminutes.pro.monthly",
    purchaseDate: upgradePeriodStart,
    signedDate: iso(now + 13_000),
    subtype: "UPGRADE",
    transactionId: orderingUpgrade,
  }));
  const countsBeforeDowngrade = lifecycleCounts(readStore());
  const downgrade = recordAppleIapNotification(notification({
    appAccountToken: orderingToken,
    notificationType: "OFFER_REDEEMED",
    notificationUUID: `notification_downgrade_${runId}`,
    originalTransactionId: orderingOriginal,
    payload: "downgrade",
    plan: "plus",
    productId: "ownminutes.plus.monthly",
    signedDate: iso(now + 14_000),
    subtype: "DOWNGRADE",
    transactionId: orderingUpgrade,
  }));
  const storeAfterUpgradeDowngrade = readStore();
  const orderingUserAfter = findUser(storeAfterUpgradeDowngrade, orderingUser.id);
  const orderingSubscriptionAfter = findSubscription(storeAfterUpgradeDowngrade, orderingOriginal);

  const graceRecoveryUser = registerUser({
    email: `iap-grace-recovery-${runId}@ownminutes.local`,
    name: "IAP Grace Recovery",
    password: `OwnMinutes-Grace-${runId}`,
  });
  const graceRecoveryToken = createAppleIapAccountToken(graceRecoveryUser.id, { allowLocalMock: true });
  bindAppleIapAccount(graceRecoveryUser.id, graceRecoveryToken);
  const graceRecoveryOriginal = `smoke_grace_recovery_original_${runId}`;
  const graceRecoveryTransaction = `smoke_grace_recovery_tx_${runId}`;
  const alreadyExpiredAt = iso(now - 1_000);
  recordAppleIapNotification(notification({
    appAccountToken: graceRecoveryToken,
    expiresDate: alreadyExpiredAt,
    notificationType: "SUBSCRIBED",
    notificationUUID: `notification_grace_recovery_initial_${runId}`,
    originalTransactionId: graceRecoveryOriginal,
    payload: "grace-recovery-initial",
    purchaseDate: iso(now - 31 * 24 * 60 * 60 * 1000),
    signedDate: iso(now - 2_000),
    transactionId: graceRecoveryTransaction,
  }));
  const usageAfterExpiryReconciliation = getUserUsage(graceRecoveryUser.id);
  const delayedGrace = recordAppleIapNotification(notification({
    appAccountToken: graceRecoveryToken,
    expiresDate: alreadyExpiredAt,
    graceExpiresDate: graceExpiresAt,
    notificationType: "DID_FAIL_TO_RENEW",
    notificationUUID: `notification_delayed_grace_${runId}`,
    originalTransactionId: graceRecoveryOriginal,
    payload: "delayed-grace",
    signedDate: iso(now + 15_000),
    subtype: "GRACE_PERIOD",
    transactionId: graceRecoveryTransaction,
  }));
  const storeAfterDelayedGrace = readStore();
  const recoveredGraceGrant = findGrant(
    storeAfterDelayedGrace,
    findOrder(storeAfterDelayedGrace, graceRecoveryTransaction).entitlementGrantId,
  );
  const countsBeforeDelete = lifecycleCounts(readStore());

  deleteAccount(user.id);
  const storeAfterDelete = readStore();
  const deletedUser = findUser(storeAfterDelete, user.id);
  const countsAfterDelete = lifecycleCounts(storeAfterDelete);

  const summary = {
    isolatedLocalFileStore: storePath.startsWith(os.tmpdir()) && fs.existsSync(storePath),
    explicitNonProductionMockGate: explicitMockGateWorks,
    accountBindingRotationRetainsPreviousVersion:
      rotatedAccountToken !== appAccountToken &&
      bindingsAfterRotation.some((item) => item.keyVersion === "v1" && item.appAccountToken === appAccountToken) &&
      bindingsAfterRotation.some((item) => item.keyVersion === "v2" && item.appAccountToken === rotatedAccountToken),
    subscribedCreatesFirstPeriod:
      subscribed.action === "purchased" &&
      subscribed.duplicate === false &&
      initialOrder.periodStartAt === initialPeriodStartAt &&
      initialOrder.periodEndAt === initialPeriodEndAt,
    firstPurchaseResetsUsedMinutes:
      freeUsage.officialMinutesUsed > 0 &&
      userAfterSubscribed.plan === "plus" &&
      userAfterSubscribed.officialMinutesTotal === 600 &&
      userAfterSubscribed.officialMinutesUsed === 0,
    renewalCreatesNewPeriod:
      renewed.action === "renewed" &&
      renewed.duplicate === false &&
      renewalOrder.id !== initialOrder.id &&
      renewalOrder.periodStartAt === renewalPeriodStartAt &&
      renewalOrder.periodEndAt === renewalPeriodEndAt &&
      userAfterRenewal.officialMinutesBillingOrderId === renewalOrder.id &&
      initialGrantAfterRenewal.status === "revoked" &&
      renewalGrant.status === "active",
    renewalResetsUsedMinutes:
      plusUsage.officialMinutesUsed > 0 &&
      userAfterRenewal.plan === "plus" &&
      userAfterRenewal.officialMinutesUsed === 0,
    notificationUuidIdempotent:
      duplicateRenewal.action === "renewed" &&
      duplicateRenewal.duplicate === true &&
      sameCounts(countsAfterRenewal, countsAfterDuplicate),
    notificationUuidHashCollisionRejected:
      hashCollisionError?.status === 409 &&
      hashCollisionError?.code === "apple_notification_payload_mismatch" &&
      sameCounts(countsAfterRenewal, lifecycleCounts(storeAfterHashCollision)) &&
      storeAfterHashCollision.appleNotificationEvents.find((item) => item.notificationUUID === renewalInput.notificationUUID)?.payloadSha256 === renewalInput.payloadSha256,
    staleRenewalCannotReplaceNewerPeriod:
      staleRenewal.action === "renewed" &&
      staleRenewal.duplicate === true &&
      !storeAfterStaleRenewal.billingOrders.some((item) => item.externalTransactionId === staleRenewalTransactionId) &&
      subscriptionAfterStaleRenewal.currentTransactionId === renewalTransactionId &&
      userAfterStaleRenewal.officialMinutesBillingOrderId === renewalOrder.id,
    gracePreservesEntitlement:
      grace.action === "grace" &&
      grace.duplicate === false &&
      subscriptionAfterGrace.status === "grace" &&
      subscriptionAfterGrace.graceExpiresAt === graceExpiresAt &&
      usageAfterGrace.plan === "plus",
    statusOnlyEventPreservesGraceDeadline:
      statusDuringGrace.action === "renewal_status" &&
      subscriptionAfterStatusDuringGrace.status === "grace" &&
      subscriptionAfterStatusDuringGrace.graceExpiresAt === graceExpiresAt,
    refundRevokesEntitlement:
      refund.action === "refunded" &&
      refund.duplicate === false &&
      userAfterRefund.plan === "free" &&
      userAfterRefund.officialMinutesTotal === 60 &&
      userAfterRefund.officialMinutesUsed === freeUsage.officialMinutesUsed &&
      userAfterRefund.freeTrialMinutesUsed === freeUsage.officialMinutesUsed &&
      orderAfterRefund.status === "refunded" &&
      grantAfterRefund.status === "refunded",
    refundReversalRestoresBeforeExpiry:
      refundReversed.action === "restored" &&
      refundReversed.duplicate === false &&
      refundReversed.user?.plan === "plus",
    staleRefundCannotOverrideNewerRestore:
      newerRestore.action === "restored" &&
      staleRefund.action === "refunded" &&
      staleRefund.duplicate === true &&
      userAfterStaleRefund.plan === "plus" &&
      orderAfterStaleRefund.status === "paid" &&
      orderAfterStaleRefund.statusSignedDate === iso(now + 6_000) &&
      grantAfterStaleRefund.status === "active" &&
      subscriptionAfterStaleRefund.status === "active" &&
      subscriptionAfterStaleRefund.lastSignedDate === iso(now + 6_000),
    expiredRevokesEntitlement:
      expired.action === "expired" &&
      expired.duplicate === false &&
      userAfterExpired.plan === "free" &&
      userAfterExpired.officialMinutesTotal === 60 &&
      userAfterExpired.officialMinutesUsed === freeUsage.officialMinutesUsed &&
      userAfterExpired.freeTrialMinutesUsed === freeUsage.officialMinutesUsed &&
      orderAfterExpired.status === "paid" &&
      grantAfterExpired.status === "revoked" &&
      subscriptionAfterExpired.status === "expired",
    statusNotificationCannotBlockNewerPeriod:
      preferenceBeforeRenewal.action === "renewal_status" &&
      delayedRenewal.action === "renewed" &&
      delayedRenewal.duplicate === false &&
      orderingSubscriptionAfter.currentTransactionId === orderingUpgrade,
    immediateUpgradeUsesNewPeriodAndPlan:
      upgrade.action === "purchased" &&
      upgrade.duplicate === false &&
      orderingUserAfter.plan === "pro" &&
      orderingUserAfter.officialMinutesTotal === 1800 &&
      orderingSubscriptionAfter.productId === "ownminutes.pro.monthly" &&
      findOrder(storeAfterUpgradeDowngrade, orderingUpgrade).currency === "USD" &&
      findOrder(storeAfterUpgradeDowngrade, orderingUpgrade).amountCents === 1_999 &&
      findOrder(storeAfterUpgradeDowngrade, orderingUpgrade).periodStartAt === upgradePeriodStart,
    downgradeStaysScheduledWithoutImmediateEntitlementChange:
      downgrade.action === "renewal_status" &&
      downgrade.duplicate === false &&
      orderingUserAfter.plan === "pro" &&
      countsBeforeDowngrade.billingOrders === lifecycleCounts(storeAfterUpgradeDowngrade).billingOrders,
    delayedGraceRepairsExpiryReconciliation:
      usageAfterExpiryReconciliation.plan === "free" &&
      delayedGrace.action === "grace" &&
      delayedGrace.duplicate === false &&
      delayedGrace.user?.plan === "plus" &&
      recoveredGraceGrant.status === "active" &&
      recoveredGraceGrant.statusReason.includes("restored after delayed Apple lifecycle notification"),
    deletionPreservesAppleLedgerAndBinding:
      getUserById(user.id) === null &&
      Boolean(deletedUser.deletedAt) &&
      deletedUser.name === "Deleted User" &&
      deletedUser.plan === "free" &&
      deletedUser.officialMinutesTotal === 0 &&
      sameCounts(countsBeforeDelete, countsAfterDelete) &&
      storeAfterDelete.billingOrders.filter((item) => item.userId === user.id).length === 2 &&
      storeAfterDelete.appleIapAccountBindings.some((item) => item.userId === user.id && item.appAccountToken === appAccountToken) &&
      storeAfterDelete.appleSubscriptions.some((item) => item.userId === user.id && item.originalTransactionId === originalTransactionId) &&
      storeAfterDelete.usageEvents.every((item) => item.userId !== user.id),
    lifecycleCounts: countsAfterDelete,
    leaksSensitiveMaterial: JSON.stringify(storeAfterDelete).includes("-----BEGIN PRIVATE KEY-----"),
  };

  console.log(JSON.stringify(summary, null, 2));
  const failed = Object.entries(summary)
    .filter(([key, value]) => key !== "lifecycleCounts" && value !== true && key !== "leaksSensitiveMaterial")
    .map(([key]) => key);
  if (summary.leaksSensitiveMaterial) failed.push("leaksSensitiveMaterial");
  if (failed.length > 0) throw new Error(`IAP lifecycle smoke failed: ${failed.join(", ")}`);
} finally {
  fs.rmSync(tempDataDir, { force: true, recursive: true });
}

function notification(input) {
  const resolvedProductId = input.productId || productId;
  const isProProduct = resolvedProductId === "ownminutes.pro.monthly";
  return {
    amountCents: isProProduct ? 1_999 : 799,
    appAccountToken: input.appAccountToken,
    currency: "USD",
    environment: "LocalMock",
    expiresDate: input.expiresDate,
    graceExpiresDate: input.graceExpiresDate,
    idempotencyKey: input.transactionId ? `apple:${input.originalTransactionId}:${input.transactionId}:${resolvedProductId}` : undefined,
    notificationType: input.notificationType,
    notificationUUID: input.notificationUUID,
    originalTransactionId: input.originalTransactionId,
    payloadSha256: sha256(input.payload),
    plan: input.plan || "plus",
    priceMilliunits: isProProduct ? 19_990 : 7_990,
    productId: resolvedProductId,
    purchaseDate: input.purchaseDate,
    reason: `local lifecycle smoke ${input.notificationType}`,
    signedDate: input.signedDate,
    storefront: "USA",
    subtype: input.subtype,
    transactionId: input.transactionId,
  };
}

function readStore() {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function findUser(store, userId) {
  const user = store.users.find((item) => item.id === userId);
  if (!user) throw new Error(`Missing user ${userId}.`);
  return user;
}

function findOrder(store, transactionId) {
  const order = store.billingOrders.find((item) => item.externalTransactionId === transactionId);
  if (!order) throw new Error(`Missing billing order for ${transactionId}.`);
  return order;
}

function findGrant(store, grantId) {
  const grant = store.entitlementGrants.find((item) => item.id === grantId);
  if (!grant) throw new Error(`Missing entitlement grant ${grantId}.`);
  return grant;
}

function findSubscription(store, transactionId) {
  const subscription = store.appleSubscriptions.find((item) => item.originalTransactionId === transactionId);
  if (!subscription) throw new Error(`Missing Apple subscription ${transactionId}.`);
  return subscription;
}

function lifecycleCounts(store) {
  return {
    accountBindings: store.appleIapAccountBindings.length,
    billingOrders: store.billingOrders.length,
    entitlementGrants: store.entitlementGrants.length,
    notificationEvents: store.appleNotificationEvents.length,
    subscriptions: store.appleSubscriptions.length,
  };
}

function sameCounts(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function iso(value) {
  return new Date(value).toISOString();
}
