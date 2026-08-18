#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appleIapSource = fs.readFileSync(path.join(root, "src", "lib", "apple-iap.ts"), "utf8");
const notificationRouteSource = fs.readFileSync(path.join(root, "src", "app", "api", "payments", "apple", "notifications", "route.ts"), "utf8");
const transactionRouteSource = fs.readFileSync(path.join(root, "src", "app", "api", "payments", "apple", "transactions", "route.ts"), "utf8");
const paymentDiagnosticsSource = fs.readFileSync(path.join(root, "src", "lib", "payment-diagnostics.ts"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

const summary = {
  hasOfficialLibrary: Boolean(packageJson.dependencies?.["@apple/app-store-server-library"]),
  importsSignedDataVerifier: appleIapSource.includes("SignedDataVerifier") && appleIapSource.includes("@apple/app-store-server-library"),
  verifiesOuterNotification: appleIapSource.includes("verifyAndDecodeNotification(signedPayload)"),
  verifiesNestedTransaction: appleIapSource.includes("verifyAndDecodeTransaction(notification.data.signedTransactionInfo)"),
  verifiesLookupTransactionJws:
    appleIapSource.includes("await verifyAppleTransactionSignedInfo(signedTransactionInfo, environment)") &&
    appleIapSource.includes("verifyAndDecodeTransaction(signedTransactionInfo)"),
  bindsTransactionToAccount:
    appleIapSource.includes("createAppleIapAccountToken") &&
    appleIapSource.includes('"app_account_token_mismatch"'),
  usesCurrentAppStoreServerHosts:
    appleIapSource.includes("https://api.storekit.apple.com") &&
    appleIapSource.includes("https://api.storekit-sandbox.apple.com") &&
    !appleIapSource.includes("api.storekit.itunes.apple.com"),
  supportsAutomaticEnvironmentFallback:
    appleIapSource.includes('environment === "auto" ? ["production", "sandbox"]') &&
    appleIapSource.includes("payload.errorCode === 4040010") &&
    appleIapSource.includes("verifyAppleTransactionSignedInfo(signedTransactionInfo, environment)"),
  securelyVerifiesBothNotificationEnvironments:
    appleIapSource.includes("for (const environment of environments)") &&
    appleIapSource.includes("verifyAndDecodeNotification(signedPayload)") &&
    appleIapSource.includes("getAppleIapNotificationVerifierConfig(environment)"),
  productionMocksDisabled:
    appleIapSource.includes('process.env.NODE_ENV !== "production"') &&
    appleIapSource.includes('process.env.OWNMINUTES_ENABLE_IAP_MOCK === "1"') &&
    appleIapSource.includes("input.allowLocalMock && isAppleIapMockEnabled()") &&
    appleIapSource.includes("options.allowLocalMock && isAppleIapMockEnabled()") &&
    appleIapSource.includes("isExactLoopbackUrl(request.url)") &&
    !appleIapSource.includes('request.headers.get("x-forwarded-host")'),
  rejectsSupersededTransactions:
    appleIapSource.includes("transaction.isUpgraded") &&
    appleIapSource.includes('"transaction_superseded"') &&
    transactionRouteSource.includes('"transaction_superseded"'),
  preservesSignedCommerceFields:
    ["currency", "price", "storefront", "offerIdentifier", "offerType", "offerDiscountType"].every((field) =>
      appleIapSource.includes(`${field}:`),
    ),
  boundsAppleApiFetch:
    appleIapSource.includes("AbortSignal.timeout(getAppleIapFetchTimeoutMs())") &&
    appleIapSource.includes('"app_store_server_api_timeout"'),
  gatesPurchaseOpeningFromDiagnostics:
    appleIapSource.includes("diagnostics.acceptingPurchases") &&
    appleIapSource.includes("assertAppleIapRuntimeEnvironmentAllowed") &&
    transactionRouteSource.includes("assertAppleIapRuntimeEnvironmentAllowed(lookup.environment)") &&
    notificationRouteSource.includes("assertAppleIapRuntimeEnvironmentAllowed(verifiedPreview.environment)") &&
    paymentDiagnosticsSource.includes("durableBillingRepository") &&
    paymentDiagnosticsSource.includes("OWNMINUTES_AUTH_REPOSITORY"),
  rejectsFailedTransactionLookup:
    appleIapSource.includes('if (!response.ok)') &&
    appleIapSource.includes('"missing_signed_transaction"') &&
    appleIapSource.includes("assertAppleTransactionEligible(transaction"),
  rejectsIneligibleEntitlements:
    appleIapSource.includes('"product_id_mismatch"') &&
    appleIapSource.includes('"transaction_revoked"') &&
    appleIapSource.includes('"subscription_expired"'),
  parsesRootCertificates:
    appleIapSource.includes("APPLE_ROOT_CERTIFICATES") &&
    appleIapSource.includes("APP_STORE_SERVER_NOTIFICATION_ROOT_CERTIFICATES") &&
    appleIapSource.includes("crypto.X509Certificate"),
  requiresProductionAppAppleId: appleIapSource.includes("environment === \"production\" && !appAppleId"),
  routeUsesVerifier: notificationRouteSource.includes("verifyAppleNotificationSignedPayload(signedPayload)"),
  routeRecordsVerifiedNotification:
    notificationRouteSource.includes("verified Apple notification") &&
    notificationRouteSource.includes("recordAppleIapNotification") &&
    !notificationRouteSource.includes("apple_iap_notification_verifier_not_implemented"),
  notificationResponseIsMinimal:
    notificationRouteSource.includes("return NextResponse.json({ ok: true })") &&
    !notificationRouteSource.includes("verification: {") &&
    !notificationRouteSource.includes("result,") &&
    !notificationRouteSource.includes("missing: guard.missing"),
  diagnosticsRequireRootCertificates:
    paymentDiagnosticsSource.includes("serverNotificationVerifier") &&
    paymentDiagnosticsSource.includes("APPLE_ROOT_CERTIFICATES or APP_STORE_SERVER_NOTIFICATION_ROOT_CERTIFICATES"),
  envDocumentsVerifier:
    envExample.includes("APPLE_ROOT_CERTIFICATES=") &&
    envExample.includes("APPLE_ROOT_CERTIFICATE_PATHS=") &&
    envExample.includes("APPLE_APP_APPLE_ID=") &&
    envExample.includes("APPLE_IAP_ENABLE_ONLINE_CHECKS=0"),
  leaksSecrets:
    appleIapSource.includes("AKL") ||
    notificationRouteSource.includes("sk-proj") ||
    envExample.includes("-----BEGIN PRIVATE KEY-----"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.hasOfficialLibrary ||
  !summary.importsSignedDataVerifier ||
  !summary.verifiesOuterNotification ||
  !summary.verifiesNestedTransaction ||
  !summary.verifiesLookupTransactionJws ||
  !summary.bindsTransactionToAccount ||
  !summary.usesCurrentAppStoreServerHosts ||
  !summary.supportsAutomaticEnvironmentFallback ||
  !summary.securelyVerifiesBothNotificationEnvironments ||
  !summary.productionMocksDisabled ||
  !summary.rejectsSupersededTransactions ||
  !summary.preservesSignedCommerceFields ||
  !summary.boundsAppleApiFetch ||
  !summary.gatesPurchaseOpeningFromDiagnostics ||
  !summary.rejectsFailedTransactionLookup ||
  !summary.rejectsIneligibleEntitlements ||
  !summary.parsesRootCertificates ||
  !summary.requiresProductionAppAppleId ||
  !summary.routeUsesVerifier ||
  !summary.routeRecordsVerifiedNotification ||
  !summary.notificationResponseIsMinimal ||
  !summary.diagnosticsRequireRootCertificates ||
  !summary.envDocumentsVerifier ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}
