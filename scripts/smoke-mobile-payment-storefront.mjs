#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const iapSource = readFileSync("apps/mobile/src/IapPlanStore.tsx", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const diagnosticsRouteSource = readFileSync("src/app/api/payments/diagnostics/route.ts", "utf8");
const compatibility = await importTypescriptModule(
  "src/lib/payment-storefront-compat.ts",
  "payment-storefront-compat",
);

assert.ok(apiSource.includes("export async function fetchPaymentStorefront"));
assert.ok(apiSource.includes("/api/payments/storefront"));
assert.ok(apiSource.includes("headers: { Cookie: authCookie }"));
assert.ok(iapSource.includes("fetchPaymentStorefront(apiBaseUrl, authCookie)"));
assert.ok(!iapSource.includes("fetchPaymentDiagnostics"));
assert.ok(iapSource.includes("storefront?.acceptingPurchases === true"));
assert.ok(iapSource.includes('storefront.provider.id === "apple-iap"'));
assert.ok(iapSource.includes('storefront.provider.status === "available"'));
assert.ok(iapSource.includes("if (!serverReady)"));
assert.ok(iapSource.includes('disabledLabel={serverReady ? t("purchaseState.waiting") : t("purchaseState.notOpen")}'));
assert.ok(iapSource.includes('disabledLabel={t("purchaseState.notOpen")}'));
assert.equal(i18nSource.match(/notOpen: /g)?.length, 3);
assert.equal(i18nSource.match(/waiting: /g)?.length, 3);
assert.ok(diagnosticsRouteSource.includes("const auth = await authorizeAdminApi()"));
assert.ok(diagnosticsRouteSource.includes("if (auth.ok)"));
assert.ok(diagnosticsRouteSource.includes("buildLegacyPaymentStorefrontResponse(diagnostics, products)"));
assert.ok(!diagnosticsRouteSource.includes("if (!auth.ok) return auth.response"));

const detailedDiagnostics = {
  acceptingPurchases: true,
  generatedAt: "2026-07-30T00:00:00.000Z",
  provider: "apple-iap",
  productionReady: true,
  configured: {
    accountBinding: true,
    applePrivateKey: true,
    iapEnvironment: "production",
    idempotency: true,
    productIds: true,
    serverNotificationSecret: true,
  },
  capabilities: {
    grantsOfficialQuota: true,
    handlesRefunds: true,
    hasServerEndpoints: true,
    verifiesTransactions: true,
  },
  checks: [{ detail: "internal", id: "private-check", status: "pass" }],
  missing: ["PRIVATE_INTERNAL_CONFIG"],
  notes: ["internal note"],
};
const legacyPayload = compatibility.buildLegacyPaymentStorefrontResponse(detailedDiagnostics, [
  { plan: "plus", productId: "ownminutes.plus.monthly" },
  { plan: "pro", productId: "ownminutes.pro.monthly" },
]);
assert.equal(legacyPayload.diagnostics.acceptingPurchases, true);
assert.deepEqual(Object.keys(legacyPayload.diagnostics).sort(), [
  "acceptingPurchases",
  "capabilities",
  "configured",
  "generatedAt",
  "missing",
  "productionReady",
  "provider",
]);
assert.deepEqual(Object.keys(legacyPayload.diagnostics.configured).sort(), [
  "accountBinding",
  "iapEnvironment",
  "idempotency",
  "productIds",
]);
assert.deepEqual(legacyPayload.diagnostics.missing, []);
assert.ok(!JSON.stringify(legacyPayload).includes("PRIVATE_INTERNAL_CONFIG"));
assert.ok(!JSON.stringify(legacyPayload).includes("private-check"));

const invalidMappingPayload = compatibility.buildLegacyPaymentStorefrontResponse(detailedDiagnostics, []);
assert.equal(invalidMappingPayload.diagnostics.acceptingPurchases, false);
assert.deepEqual(invalidMappingPayload.products, []);
assert.deepEqual(invalidMappingPayload.productIds, []);

console.log(JSON.stringify({
  adminDiagnosticsRemainPrivileged: true,
  anonymousLegacyContractIsMinimal: true,
  invalidMappingFailsClosed: true,
  internalDiagnosticsNotUsedByCustomers: true,
  storefrontFailureDisablesPurchases: true,
  simulatedOrClosedPurchasesStayDisabled: true,
  unavailableCtaIsExplicitInAllLocales: true,
}, null, 2));

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
