#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const adminCookie = process.env.SMOKE_ADMIN_COOKIE?.trim() || "";

async function main() {
  const response = await fetch(`${baseUrl}/api/payments/diagnostics`, {
    cache: "no-store",
    headers: adminCookie ? { Cookie: adminCookie } : undefined,
  });
  const payload = await readJson(response, "/api/payments/diagnostics");
  if (!adminCookie) {
    validatePublicCompatibilityResponse(response, payload);
    return;
  }

  const diagnostics = payload.diagnostics;
  const text = JSON.stringify(payload);
  const provider = diagnostics?.provider;
  const checks = diagnostics?.checks ?? [];
  const summary = {
    ok: payload.ok === true,
    provider,
    acceptingPurchases: diagnostics?.acceptingPurchases,
    productionReady: diagnostics?.productionReady,
    checkCount: checks.length,
    hasCapabilities: Boolean(diagnostics?.capabilities && typeof diagnostics.capabilities === "object"),
    hasIapServerEndpoints: diagnostics?.capabilities?.hasServerEndpoints === true && checks.some((check) => check.id === "apple-server-endpoints" && check.status === "pass"),
    hasMissingList: Array.isArray(diagnostics?.missing),
    simulatedBillingDisabled: diagnostics?.configured?.simulatedBillingEnabled === false,
    defaultsToSandbox: diagnostics?.configured?.iapEnvironment === "sandbox",
    requiresBundleId: diagnostics?.missing?.some((item) => item.includes("APPLE_BUNDLE_ID")),
    requiresAppleRootCertificates: diagnostics?.missing?.some((item) => item.includes("APPLE_ROOT_CERTIFICATES")),
    requiresAccountBindingSecret: diagnostics?.missing?.some((item) => item.includes("OWNMINUTES_APP_SECRET")),
    requiresNotificationUrl: diagnostics?.missing?.includes("OWNMINUTES_IAP_NOTIFICATION_URL"),
    requiresSandboxPurchaseProof: diagnostics?.missing?.includes("OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF"),
    requiresSandboxRenewalProof: diagnostics?.missing?.includes("OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF"),
    requiresSandboxRefundProof: diagnostics?.missing?.includes("OWNMINUTES_IAP_SANDBOX_REFUND_PROOF"),
    requiresSandboxExpirationProof: diagnostics?.missing?.includes("OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF"),
    requiresDbLedgerProof: diagnostics?.missing?.includes("OWNMINUTES_IAP_DB_LEDGER_PROOF"),
    requiresLegalIdentity: diagnostics?.missing?.some((item) => item.includes("OWNMINUTES_LEGAL_OPERATOR_NAME")),
    notificationVerifierDisabled: diagnostics?.configured?.serverNotificationVerifier === false,
    accountBindingDisabled: diagnostics?.configured?.accountBinding === false,
    notificationUrlDisabled: diagnostics?.configured?.notificationUrl === false,
    sandboxEvidenceDisabled:
      diagnostics?.configured?.sandboxPurchaseProof === false &&
      diagnostics?.configured?.sandboxRenewalProof === false &&
      diagnostics?.configured?.sandboxRefundProof === false &&
      diagnostics?.configured?.sandboxExpirationProof === false,
    dbLedgerProofDisabled: diagnostics?.configured?.dbLedgerProof === false,
    simulatedPlanCapabilityDisabled: diagnostics?.capabilities?.usesSimulatedPlanSwitching === false,
    lifecycleEvidenceCapabilityDisabled: diagnostics?.capabilities?.hasSandboxLifecycleEvidence === false,
    ledgerEvidenceCapabilityDisabled: diagnostics?.capabilities?.hasLedgerEvidence === false,
    statusesValid: checks.every((check) => ["pass", "fail", "manual"].includes(check.status)),
    simulatedProviderBlocked: provider === "simulated" ? diagnostics?.productionReady === false : true,
    purchasesBlockedWithoutProductionReadiness:
      provider === "simulated" ? diagnostics?.acceptingPurchases === false : diagnostics?.acceptingPurchases === diagnostics?.productionReady,
    hasPurchaseOpeningGate: checks.some((check) => check.id === "purchase-opening-gate" && check.status === "fail"),
    simulatedPlanCheck: checks.some((check) => check.id === "simulated-plan-switching" && check.status === "fail"),
    hasProductionAppAppleIdCheck: checks.some((check) => check.id === "production-app-apple-id"),
    hasAccountBindingCheck: checks.some((check) => check.id === "account-binding" && check.status === "fail"),
    hasNotificationUrlGate: checks.some((check) => check.id === "server-notifications" && check.status === "fail"),
    hasSandboxPurchaseGate: checks.some((check) => check.id === "sandbox-purchase-proof" && check.status === "fail"),
    hasSandboxRenewalGate: checks.some((check) => check.id === "sandbox-renewal-proof" && check.status === "fail"),
    hasSandboxRefundGate: checks.some((check) => check.id === "sandbox-refund-proof" && check.status === "fail"),
    hasSandboxExpirationGate: checks.some((check) => check.id === "sandbox-expiration-proof" && check.status === "fail"),
    hasDbLedgerGate: checks.some((check) => check.id === "db-ledger-proof" && check.status === "fail"),
    hasLegalIdentityGate: checks.some((check) => check.id === "legal-operator-identity" && check.status === "fail"),
    leaksSecrets:
      text.includes("-----BEGIN PRIVATE KEY-----") ||
      text.includes("APPLE_PRIVATE_KEY=") ||
      text.includes("notificationSecret") ||
      text.includes("transactionId") ||
      text.includes("originalTransactionId") ||
      text.includes("sharedSecret") ||
      text.includes("AKL") ||
      text.includes("sk-proj"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    !["simulated", "apple-iap", "external-billing"].includes(summary.provider) ||
    summary.checkCount < 7 ||
    !summary.hasCapabilities ||
    !summary.hasIapServerEndpoints ||
    !summary.hasMissingList ||
    !summary.simulatedBillingDisabled ||
    !summary.defaultsToSandbox ||
    !summary.requiresBundleId ||
    !summary.requiresAppleRootCertificates ||
    !summary.requiresAccountBindingSecret ||
    !summary.requiresNotificationUrl ||
    !summary.requiresSandboxPurchaseProof ||
    !summary.requiresSandboxRenewalProof ||
    !summary.requiresSandboxRefundProof ||
    !summary.requiresSandboxExpirationProof ||
    !summary.requiresDbLedgerProof ||
    !summary.requiresLegalIdentity ||
    !summary.notificationVerifierDisabled ||
    !summary.accountBindingDisabled ||
    !summary.notificationUrlDisabled ||
    !summary.sandboxEvidenceDisabled ||
    !summary.dbLedgerProofDisabled ||
    !summary.simulatedPlanCapabilityDisabled ||
    !summary.lifecycleEvidenceCapabilityDisabled ||
    !summary.ledgerEvidenceCapabilityDisabled ||
    !summary.statusesValid ||
    !summary.simulatedProviderBlocked ||
    !summary.purchasesBlockedWithoutProductionReadiness ||
    !summary.hasPurchaseOpeningGate ||
    !summary.simulatedPlanCheck ||
    !summary.hasProductionAppAppleIdCheck ||
    !summary.hasAccountBindingCheck ||
    !summary.hasNotificationUrlGate ||
    !summary.hasSandboxPurchaseGate ||
    !summary.hasSandboxRenewalGate ||
    !summary.hasSandboxRefundGate ||
    !summary.hasSandboxExpirationGate ||
    !summary.hasDbLedgerGate ||
    !summary.hasLegalIdentityGate ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

function validatePublicCompatibilityResponse(response, payload) {
  const diagnostics = payload.diagnostics;
  const serialized = JSON.stringify(payload);
  const diagnosticsKeys = Object.keys(diagnostics ?? {}).sort();
  const configuredKeys = Object.keys(diagnostics?.configured ?? {}).sort();
  const capabilityKeys = Object.keys(diagnostics?.capabilities ?? {}).sort();
  const products = Array.isArray(payload.products) ? payload.products : [];
  const summary = {
    ok: payload.ok === true,
    cacheDisabled: response.headers.get("cache-control")?.includes("no-store") === true,
    legacyDiagnosticsShape:
      JSON.stringify(diagnosticsKeys) === JSON.stringify([
        "acceptingPurchases",
        "capabilities",
        "configured",
        "generatedAt",
        "missing",
        "productionReady",
        "provider",
      ]),
    minimalConfiguredShape:
      JSON.stringify(configuredKeys) === JSON.stringify([
        "accountBinding",
        "iapEnvironment",
        "idempotency",
        "productIds",
      ]),
    minimalCapabilitiesShape:
      JSON.stringify(capabilityKeys) === JSON.stringify([
        "grantsOfficialQuota",
        "hasServerEndpoints",
        "verifiesTransactions",
      ]),
    internalGapsHidden: Array.isArray(diagnostics?.missing) && diagnostics.missing.length === 0,
    productIdsMatch:
      Array.isArray(payload.productIds) &&
      JSON.stringify(payload.productIds) === JSON.stringify(products.map((item) => item.productId)),
    acceptingPurchasesHasCatalog:
      diagnostics?.acceptingPurchases !== true ||
      (diagnostics.provider === "apple-iap" && products.length > 0),
    leaksInternalDiagnostics:
      serialized.includes("\"checks\"") ||
      serialized.includes("\"notes\"") ||
      serialized.includes("applePrivateKey") ||
      serialized.includes("serverNotificationSecret") ||
      serialized.includes("APPLE_PRIVATE_KEY") ||
      serialized.includes("OWNMINUTES_APP_SECRET"),
    adminDetailedDiagnosticsSkipped: true,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (
    !summary.ok ||
    !summary.cacheDisabled ||
    !summary.legacyDiagnosticsShape ||
    !summary.minimalConfiguredShape ||
    !summary.minimalCapabilitiesShape ||
    !summary.internalGapsHidden ||
    !summary.productIdsMatch ||
    !summary.acceptingPurchasesHasCatalog ||
    summary.leaksInternalDiagnostics
  ) {
    process.exitCode = 1;
  }
}

async function readJson(response, path) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
