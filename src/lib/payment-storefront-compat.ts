export type LegacyPaymentProduct = {
  plan: "free" | "plus" | "pro";
  productId: string;
};

export type LegacyPaymentDiagnosticsInput = {
  acceptingPurchases: boolean;
  generatedAt: string;
  provider: "simulated" | "apple-iap" | "external-billing";
  productionReady: boolean;
  configured: {
    accountBinding: boolean;
    iapEnvironment: "auto" | "production" | "sandbox";
    idempotency: boolean;
    productIds: boolean;
  };
  capabilities: {
    grantsOfficialQuota: boolean;
    hasServerEndpoints: boolean;
    verifiesTransactions: boolean;
  };
};

export function buildLegacyPaymentStorefrontResponse(
  diagnostics: LegacyPaymentDiagnosticsInput,
  catalog: LegacyPaymentProduct[],
) {
  const products = catalog
    .filter((item) => (item.plan === "plus" || item.plan === "pro") && Boolean(item.productId.trim()))
    .map(({ plan, productId }) => ({ plan, productId }));
  const productIds = products.map((item) => item.productId);
  const acceptingPurchases =
    diagnostics.acceptingPurchases &&
    diagnostics.provider === "apple-iap" &&
    products.length > 0;

  return {
    ok: true,
    diagnostics: {
      acceptingPurchases,
      generatedAt: diagnostics.generatedAt,
      provider: diagnostics.provider,
      productionReady: diagnostics.productionReady,
      configured: {
        accountBinding: diagnostics.configured.accountBinding,
        iapEnvironment: diagnostics.configured.iapEnvironment,
        idempotency: diagnostics.configured.idempotency,
        productIds: diagnostics.configured.productIds && products.length > 0,
      },
      capabilities: {
        grantsOfficialQuota: diagnostics.capabilities.grantsOfficialQuota,
        hasServerEndpoints: diagnostics.capabilities.hasServerEndpoints,
        verifiesTransactions: diagnostics.capabilities.verifiesTransactions,
      },
      // Kept for the legacy response contract without exposing server configuration gaps.
      missing: [],
    },
    productIds,
    products,
  };
}
