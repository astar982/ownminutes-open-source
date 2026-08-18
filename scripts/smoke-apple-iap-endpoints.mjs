#!/usr/bin/env node

import { buildToneWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-iap-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const smokeClientIp = `203.0.113.${(process.pid % 200) + 1}`;
const mutationHeaders = { "Sec-Fetch-Site": "same-origin" };

async function main() {
  const unauthenticatedTransaction = await postJson("/api/payments/apple/transactions", {
    transactionId: "1000000000000000",
    productId: "ownminutes.plus.monthly",
  });

  const register = await postJson("/api/auth/register", {
    name: "IAP Smoke",
    email,
    password,
  });
  const cookie = extractCookie(register.response, register.payload);
  const firstAccountToken = await getJson("/api/payments/apple/account-token", cookie);
  const repeatedAccountToken = await getJson("/api/payments/apple/account-token", cookie);
  const freeUsageMeetingId = `smoke-iap-free-usage-${timestamp}`;
  const freeUsageUpload = await uploadChunk(freeUsageMeetingId, cookie, 7);
  const freeUsageFinalize = await postJson(
    `/api/meetings/${freeUsageMeetingId}/finalize`,
    {
      title: "IAP lifetime Free trial ledger smoke",
      expectedLastSequence: freeUsageUpload.payload.totalChunks,
      totalBytes: freeUsageUpload.payload.totalBytes,
    },
    cookie,
  );
  const usageBeforePurchase = await getJson("/api/account/usage", cookie);
  // The runtime intentionally uses the mock provider, so no customer quota may
  // be consumed even though the route exercises the official-quota ledger.
  const expectedFreeTrialDebit = 0;
  const expectedFreeTrialRemaining = 60 - expectedFreeTrialDebit;

  const invalidTransaction = await postJson("/api/payments/apple/transactions", {}, cookie);
  const pendingTransaction = await postJson(
    "/api/payments/apple/transactions",
    {
      transactionId: "1000000000000000",
      productId: "ownminutes.plus.monthly",
    },
    cookie,
  );
  const mockTransactionId = `smoke_iap_plus_${timestamp}`;
  const recordedTransaction = await postJson(
    "/api/payments/apple/transactions",
    {
      transactionId: mockTransactionId,
      productId: "ownminutes.plus.monthly",
    },
    cookie,
  );
  const duplicateTransaction = await postJson(
    "/api/payments/apple/transactions",
    {
      transactionId: mockTransactionId,
      productId: "ownminutes.plus.monthly",
    },
    cookie,
  );
  const secondRegister = await postJson("/api/auth/register", {
    name: "IAP Smoke Second",
    email: `second-${email}`,
    password,
  });
  const secondCookie = extractCookie(secondRegister.response, secondRegister.payload);
  const secondAccountToken = await getJson("/api/payments/apple/account-token", secondCookie);
  const crossAccountClaim = await postJson(
    "/api/payments/apple/transactions",
    { transactionId: mockTransactionId, productId: "ownminutes.plus.monthly" },
    secondCookie,
  );
  const deleteSecondResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { ...mutationHeaders, Cookie: secondCookie },
  });
  const deleteSecondPayload = await readJson(deleteSecondResult, "/api/auth/delete", { allowError: true });
  const proRegister = await postJson("/api/auth/register", {
    name: "IAP Smoke Pro",
    email: `pro-${email}`,
    password,
  });
  const proCookie = extractCookie(proRegister.response, proRegister.payload);
  const proAccountToken = await getJson("/api/payments/apple/account-token", proCookie);
  const proTransactionId = `smoke_iap_pro_${timestamp}`;
  const proTransaction = await postJson(
    "/api/payments/apple/transactions",
    { transactionId: proTransactionId, productId: "ownminutes.pro.monthly" },
    proCookie,
  );
  const proUserAfterPurchase = await getJson("/api/auth/me", proCookie);
  const proUsageAfterPurchase = await getJson("/api/account/usage", proCookie);
  const mismatchedProduct = await postJson(
    "/api/payments/apple/transactions",
    { transactionId: `smoke_iap_mismatch_${timestamp}`, productId: "ownminutes.plus.monthly" },
    cookie,
  );
  const expiredSubscription = await postJson(
    "/api/payments/apple/transactions",
    { transactionId: `smoke_iap_expired_${timestamp}`, productId: "ownminutes.plus.monthly" },
    cookie,
  );
  const revokedTransaction = await postJson(
    "/api/payments/apple/transactions",
    { transactionId: `smoke_iap_revoked_${timestamp}`, productId: "ownminutes.plus.monthly" },
    cookie,
  );
  const supersededTransaction = await postJson(
    "/api/payments/apple/transactions",
    { transactionId: `smoke_iap_upgraded_${timestamp}`, productId: "ownminutes.plus.monthly" },
    cookie,
  );
  const userAfterPurchase = await getJson("/api/auth/me", cookie);
  const usageAfterPurchase = await getJson("/api/account/usage", cookie);
  const renewalTransactionId = `smoke_iap_plus_${timestamp}_renewal`;
  const renewalNotificationPayload = {
    signedPayload: makeFakeJws({
      notificationType: "DID_RENEW",
      subtype: "BILLING_RECOVERY",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "LocalMock",
        signedTransactionInfo: makeFakeJws({
          environment: "LocalMock",
          expiresDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
          originalTransactionId: `original_${mockTransactionId}`,
          productId: "ownminutes.plus.monthly",
          purchaseDate: new Date().toISOString(),
          transactionId: renewalTransactionId,
        }),
      },
    }),
  };
  const renewalNotification = await postJson("/api/payments/apple/notifications", renewalNotificationPayload);
  const duplicateRenewalNotification = await postJson("/api/payments/apple/notifications", renewalNotificationPayload);
  const historicalRefundPayload = {
    signedPayload: makeFakeJws({
      notificationType: "REFUND",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "LocalMock",
        signedTransactionInfo: makeFakeJws({
          environment: "LocalMock",
          originalTransactionId: `original_${mockTransactionId}`,
          productId: "ownminutes.plus.monthly",
          transactionId: mockTransactionId,
        }),
      },
    }),
  };
  const historicalRefund = await postJson("/api/payments/apple/notifications", historicalRefundPayload);
  const userAfterHistoricalRefund = await getJson("/api/auth/me", cookie);
  const historicalRefundReversedPayload = {
    signedPayload: makeFakeJws({
      notificationType: "REFUND_REVERSED",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "LocalMock",
        signedTransactionInfo: makeFakeJws({
          environment: "LocalMock",
          originalTransactionId: `original_${mockTransactionId}`,
          productId: "ownminutes.plus.monthly",
          transactionId: mockTransactionId,
        }),
      },
    }),
  };
  const historicalRefundReversed = await postJson("/api/payments/apple/notifications", historicalRefundReversedPayload);
  const userAfterHistoricalRefundReversed = await getJson("/api/auth/me", cookie);
  const renewalRefundNotificationPayload = {
    signedPayload: makeFakeJws({
      notificationType: "REFUND",
      subtype: "VOLUNTARY",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "LocalMock",
        signedTransactionInfo: makeFakeJws({
          environment: "LocalMock",
          originalTransactionId: `original_${mockTransactionId}`,
          productId: "ownminutes.plus.monthly",
          transactionId: renewalTransactionId,
        }),
      },
    }),
  };
  const renewalRefundNotification = await postJson("/api/payments/apple/notifications", renewalRefundNotificationPayload);
  const userAfterRenewalRefund = await getJson("/api/auth/me", cookie);
  const usageAfterRenewalRefund = await getJson("/api/account/usage", cookie);
  const refundReversedPayload = {
    signedPayload: makeFakeJws({
      notificationType: "REFUND_REVERSED",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "LocalMock",
        signedTransactionInfo: makeFakeJws({
          environment: "LocalMock",
          originalTransactionId: `original_${mockTransactionId}`,
          productId: "ownminutes.plus.monthly",
          transactionId: renewalTransactionId,
        }),
      },
    }),
  };
  const refundReversedNotification = await postJson("/api/payments/apple/notifications", refundReversedPayload);
  const userAfterRefundReversed = await getJson("/api/auth/me", cookie);
  const graceExpiredPayload = {
    signedPayload: makeFakeJws({
      notificationType: "GRACE_PERIOD_EXPIRED",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "LocalMock",
        signedTransactionInfo: makeFakeJws({
          environment: "LocalMock",
          originalTransactionId: `original_${mockTransactionId}`,
          productId: "ownminutes.plus.monthly",
          transactionId: renewalTransactionId,
        }),
      },
    }),
  };
  const graceExpiredNotification = await postJson("/api/payments/apple/notifications", graceExpiredPayload);
  const userAfterGraceExpired = await getJson("/api/auth/me", cookie);
  const usageAfterGraceExpired = await getJson("/api/account/usage", cookie);
  const missingNotification = await postJson("/api/payments/apple/notifications", {});
  const pendingNotification = await postJson("/api/payments/apple/notifications", {
    signedPayload: makeFakeJws({
      notificationType: "DID_RENEW",
      subtype: "AUTO_RENEW_ENABLED",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "Sandbox",
        signedTransactionInfo: makeFakeJws({
          originalTransactionId: "1000000000000000",
          productId: "ownminutes.plus.monthly",
          transactionId: "1000000000000001",
        }),
      },
    }),
  });
  const refundNotificationPayload = {
    signedPayload: makeFakeJws({
      notificationType: "REFUND",
      subtype: "VOLUNTARY",
      data: {
        bundleId: "com.ownminutes.app",
        environment: "LocalMock",
        signedTransactionInfo: makeFakeJws({
          environment: "LocalMock",
          originalTransactionId: `original_${mockTransactionId}`,
          productId: "ownminutes.plus.monthly",
          transactionId: mockTransactionId,
        }),
      },
    }),
  };
  const refundNotification = await postJson("/api/payments/apple/notifications", refundNotificationPayload);
  const duplicateRefundNotification = await postJson("/api/payments/apple/notifications", refundNotificationPayload);
  const userAfterRefund = await getJson("/api/auth/me", cookie);
  const usageAfterRefund = await getJson("/api/account/usage", cookie);

  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { ...mutationHeaders, Cookie: cookie },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });

  const text = JSON.stringify({
    unauthenticatedTransaction: unauthenticatedTransaction.payload,
    invalidTransaction: invalidTransaction.payload,
    pendingTransaction: pendingTransaction.payload,
    recordedTransaction: recordedTransaction.payload,
    duplicateTransaction: duplicateTransaction.payload,
    freeUsageFinalize: freeUsageFinalize.payload,
    proTransaction: proTransaction.payload,
    mismatchedProduct: mismatchedProduct.payload,
    expiredSubscription: expiredSubscription.payload,
    revokedTransaction: revokedTransaction.payload,
    supersededTransaction: supersededTransaction.payload,
    renewalNotification: renewalNotification.payload,
    duplicateRenewalNotification: duplicateRenewalNotification.payload,
    renewalRefundNotification: renewalRefundNotification.payload,
    missingNotification: missingNotification.payload,
    pendingNotification: pendingNotification.payload,
    refundNotification: refundNotification.payload,
    duplicateRefundNotification: duplicateRefundNotification.payload,
  });
  const summary = {
    unauthenticatedRejected: unauthenticatedTransaction.response.status === 401,
    invalidTransactionRejected: invalidTransaction.response.status === 400 && invalidTransaction.payload.code === "missing_transaction_id",
    transactionRequiresIapConfig:
      pendingTransaction.response.status === 503 &&
      pendingTransaction.payload.code === "apple_iap_not_configured" &&
      Array.isArray(pendingTransaction.payload.missing),
    mockTransactionRecorded:
      recordedTransaction.response.status === 201 &&
      recordedTransaction.payload.ok === true &&
      recordedTransaction.payload.entitlementGranted === true &&
      recordedTransaction.payload.duplicate === false &&
      recordedTransaction.payload.order?.provider === "apple_iap" &&
      recordedTransaction.payload.order?.status === "paid" &&
      recordedTransaction.payload.order?.plan === "plus" &&
      recordedTransaction.payload.order?.externalTransactionId === mockTransactionId &&
      recordedTransaction.payload.order?.originalTransactionId === `original_${mockTransactionId}`,
    mockProcessingPreservesLifetimeFreeTrial:
      freeUsageUpload.response.status === 200 &&
      freeUsageFinalize.response.status === 200 &&
      freeUsageFinalize.payload.billing?.officialMinutesCharged === expectedFreeTrialDebit &&
      usageBeforePurchase.payload.usage?.plan === "free" &&
      usageBeforePurchase.payload.usage?.officialMinutesTotal === 60 &&
      usageBeforePurchase.payload.usage?.officialMinutesUsed === expectedFreeTrialDebit &&
      usageBeforePurchase.payload.usage?.officialMinutesRemaining === expectedFreeTrialRemaining,
    freeTrialUsageObserved: {
      uploadStatus: freeUsageUpload.response.status,
      uploadCode: freeUsageUpload.payload.code,
      finalizeStatus: freeUsageFinalize.response.status,
      finalizeCode: freeUsageFinalize.payload.code,
      processingRoute: freeUsageFinalize.payload.billing?.processingRoute,
      officialMinutesCharged: freeUsageFinalize.payload.billing?.officialMinutesCharged,
      officialMinutesUsed: usageBeforePurchase.payload.usage?.officialMinutesUsed,
    },
    duplicateTransactionIdempotent:
      duplicateTransaction.response.status === 200 &&
      duplicateTransaction.payload.ok === true &&
      duplicateTransaction.payload.duplicate === true &&
      duplicateTransaction.payload.order?.id === recordedTransaction.payload.order?.id,
    proTransactionRecordedAtLaunchPrice:
      proTransaction.response.status === 201 &&
      proTransaction.payload.ok === true &&
      proTransaction.payload.entitlementGranted === true &&
      proTransaction.payload.duplicate === false &&
      proTransaction.payload.order?.provider === "apple_iap" &&
      proTransaction.payload.order?.status === "paid" &&
      proTransaction.payload.order?.plan === "pro" &&
      proTransaction.payload.order?.productId === "ownminutes.pro.monthly" &&
      proTransaction.payload.order?.externalTransactionId === proTransactionId &&
      proTransaction.payload.order?.priceMilliunits === "19990" &&
      proTransaction.payload.order?.currency === "USD" &&
      proUserAfterPurchase.payload.user?.plan === "pro" &&
      proUsageAfterPurchase.payload.usage?.plan === "pro" &&
      proUsageAfterPurchase.payload.usage?.officialMinutesTotal === 1800,
    proPurchaseObserved: {
      responseStatus: proTransaction.response.status,
      responseCode: proTransaction.payload.code,
      responseError: proTransaction.payload.error,
      accountTokenStatus: proAccountToken.response.status,
      orderPlan: proTransaction.payload.order?.plan,
      orderProductId: proTransaction.payload.order?.productId,
      orderPriceMilliunits: proTransaction.payload.order?.priceMilliunits,
      orderCurrency: proTransaction.payload.order?.currency,
      userPlan: proUserAfterPurchase.payload.user?.plan,
      usagePlan: proUsageAfterPurchase.payload.usage?.plan,
      officialMinutesTotal: proUsageAfterPurchase.payload.usage?.officialMinutesTotal,
    },
    mismatchedProductRejected: mismatchedProduct.response.status === 400 && mismatchedProduct.payload.code === "product_id_mismatch",
    expiredSubscriptionRejected: expiredSubscription.response.status === 422 && expiredSubscription.payload.code === "subscription_expired",
    revokedTransactionRejected: revokedTransaction.response.status === 422 && revokedTransaction.payload.code === "transaction_revoked",
    supersededTransactionRejected:
      supersededTransaction.response.status === 422 && supersededTransaction.payload.code === "transaction_superseded",
    userUpgradedToPlus: userAfterPurchase.payload.user?.plan === "plus" && usageAfterPurchase.payload.usage?.officialMinutesTotal === 600,
    renewalNotificationRecorded: renewalNotification.response.status === 200 && isMinimalSuccess(renewalNotification.payload),
    duplicateRenewalNotificationIdempotent:
      duplicateRenewalNotification.response.status === 200 &&
      isMinimalSuccess(duplicateRenewalNotification.payload),
    historicalRefundPreservesCurrentEntitlement:
      historicalRefund.response.status === 200 &&
      isMinimalSuccess(historicalRefund.payload) &&
      userAfterHistoricalRefund.payload.user?.plan === "plus",
    historicalRefundReversalPreservesCurrentEntitlement:
      historicalRefundReversed.response.status === 200 &&
      isMinimalSuccess(historicalRefundReversed.payload) &&
      userAfterHistoricalRefundReversed.payload.user?.plan === "plus",
    renewalRefundNotificationRecorded:
      renewalRefundNotification.response.status === 200 &&
      isMinimalSuccess(renewalRefundNotification.payload),
    userReturnsFreeAfterRenewalRefund:
      userAfterRenewalRefund.payload.user?.plan === "free" &&
      usageAfterRenewalRefund.payload.usage?.officialMinutesTotal === 60 &&
      usageAfterRenewalRefund.payload.usage?.officialMinutesUsed === expectedFreeTrialDebit &&
      usageAfterRenewalRefund.payload.usage?.officialMinutesRemaining === expectedFreeTrialRemaining,
    refundReversedRestoresEntitlement:
      refundReversedNotification.response.status === 200 &&
      isMinimalSuccess(refundReversedNotification.payload) &&
      userAfterRefundReversed.payload.user?.plan === "plus",
    gracePeriodExpiredRevokesEntitlement:
      graceExpiredNotification.response.status === 200 &&
      isMinimalSuccess(graceExpiredNotification.payload) &&
      userAfterGraceExpired.payload.user?.plan === "free" &&
      usageAfterGraceExpired.payload.usage?.officialMinutesTotal === 60 &&
      usageAfterGraceExpired.payload.usage?.officialMinutesUsed === expectedFreeTrialDebit &&
      usageAfterGraceExpired.payload.usage?.officialMinutesRemaining === expectedFreeTrialRemaining,
    missingNotificationRejected: missingNotification.response.status === 400 && missingNotification.payload.code === "missing_signed_payload",
    notificationRequiresIapConfig:
      pendingNotification.response.status === 503 &&
      pendingNotification.payload.code === "apple_iap_not_configured" &&
      !Object.hasOwn(pendingNotification.payload, "preview") &&
      !Object.hasOwn(pendingNotification.payload, "missing"),
    historicalOriginalRefundRecorded:
      refundNotification.response.status === 200 &&
      isMinimalSuccess(refundNotification.payload),
    duplicateRefundNotificationIdempotent:
      duplicateRefundNotification.response.status === 200 &&
      isMinimalSuccess(duplicateRefundNotification.payload),
    userRolledBackAfterRefund:
      userAfterRefund.payload.user?.plan === "free" &&
      usageAfterRefund.payload.usage?.officialMinutesTotal === 60 &&
      usageAfterRefund.payload.usage?.officialMinutesUsed === expectedFreeTrialDebit &&
      usageAfterRefund.payload.usage?.officialMinutesRemaining === expectedFreeTrialRemaining,
    accountTokenStableAndIsolated:
      firstAccountToken.response.status === 200 &&
      firstAccountToken.payload.appAccountToken === repeatedAccountToken.payload.appAccountToken &&
      firstAccountToken.payload.appAccountToken !== secondAccountToken.payload.appAccountToken,
    crossAccountClaimRejected:
      crossAccountClaim.response.status === 409 && crossAccountClaim.payload.code === "apple_iap_transaction_owner_conflict",
    crossAccountClaimObserved: { status: crossAccountClaim.response.status, code: crossAccountClaim.payload.code },
    secondAccountDeletionAccepted: isAcceptedAccountDeletion(deleteSecondResult, deleteSecondPayload),
    accountDeletionAccepted: isAcceptedAccountDeletion(deleteResult, deletePayload),
    accountDeletionObserved: {
      secondHttpStatus: deleteSecondResult.status,
      secondStatus: deleteSecondPayload.status,
      firstHttpStatus: deleteResult.status,
      firstStatus: deletePayload.status,
    },
    leaksSecrets:
      text.includes("-----BEGIN PRIVATE KEY-----") ||
      text.includes("APPLE_PRIVATE_KEY=") ||
      text.includes("notificationSecret") ||
      text.includes("sharedSecret") ||
      text.includes("sk-proj") ||
      text.includes("AKL"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.unauthenticatedRejected ||
    !summary.invalidTransactionRejected ||
    !summary.transactionRequiresIapConfig ||
    !summary.mockTransactionRecorded ||
    !summary.mockProcessingPreservesLifetimeFreeTrial ||
    !summary.duplicateTransactionIdempotent ||
    !summary.proTransactionRecordedAtLaunchPrice ||
    !summary.mismatchedProductRejected ||
    !summary.expiredSubscriptionRejected ||
    !summary.revokedTransactionRejected ||
    !summary.supersededTransactionRejected ||
    !summary.userUpgradedToPlus ||
    !summary.renewalNotificationRecorded ||
    !summary.duplicateRenewalNotificationIdempotent ||
    !summary.historicalRefundPreservesCurrentEntitlement ||
    !summary.historicalRefundReversalPreservesCurrentEntitlement ||
    !summary.renewalRefundNotificationRecorded ||
    !summary.userReturnsFreeAfterRenewalRefund ||
    !summary.refundReversedRestoresEntitlement ||
    !summary.gracePeriodExpiredRevokesEntitlement ||
    !summary.missingNotificationRejected ||
    !summary.notificationRequiresIapConfig ||
    !summary.historicalOriginalRefundRecorded ||
    !summary.duplicateRefundNotificationIdempotent ||
    !summary.userRolledBackAfterRefund ||
    !summary.accountTokenStableAndIsolated ||
    !summary.crossAccountClaimRejected ||
    !summary.secondAccountDeletionAccepted ||
    !summary.accountDeletionAccepted ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

function isAcceptedAccountDeletion(response, payload) {
  return (
    payload.ok === true &&
    ((response.status === 200 && payload.status === "deleted") ||
      (response.status === 202 && payload.status === "pending_cleanup"))
  );
}

async function getJson(path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
  });
  const payload = await readJson(response, path, { allowError: true });
  return { response, payload };
}

async function uploadChunk(meetingId, cookie, minutes) {
  const audio = new Blob([buildToneWav()], { type: "audio/wav" });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", String(minutes * 60_000));
  form.append("chunk", audio, "chunk-000001.wav");

  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/chunks`, {
    method: "POST",
    headers: { ...mutationHeaders, Cookie: cookie },
    body: form,
  });
  const payload = await readJson(response, `/api/meetings/${meetingId}/chunks`, { allowError: true });
  return { response, payload };
}

async function postJson(path, body, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...mutationHeaders,
      "X-Forwarded-For": smokeClientIp,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, path, { allowError: true });
  return { response, payload };
}

async function readJson(response, path, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response, payload) {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error(`Missing set-cookie header (HTTP ${response.status}: ${JSON.stringify(payload)}).`);
  }
  return cookie.split(";")[0];
}

function isMinimalSuccess(payload) {
  return payload?.ok === true && Object.keys(payload).length === 1;
}

function makeFakeJws(payload) {
  return [encodeBase64Url({ alg: "ES256", kid: "smoke" }), encodeBase64Url(payload), "signature"].join(".");
}

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
