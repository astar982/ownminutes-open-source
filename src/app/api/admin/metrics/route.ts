import { getAdminCommercialMetrics, getAdminFunnel, getAdminGrowthMetrics, getAdminMetrics, listAdminBillingOrders, listAdminEntitlementGrants } from "@/lib/server/auth-repository";
import { getMeetingShareAnalyticsSummary } from "@/lib/server/meeting-audio-store";
import { getAccountDeletionCleanupDiagnostics } from "@/lib/server/account-deletion-cleanup-worker";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";
import { getLegacyDeletionCleanupDiagnostics } from "@/lib/server/legacy-deletion-cleanup";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;

  const [metrics, commercialMetrics, growthMetrics, funnel, entitlementGrants, billingOrders, shareAnalytics, deletionCleanup, accountDeletionCleanup] = await Promise.all([
    getAdminMetrics(),
    getAdminCommercialMetrics(),
    getAdminGrowthMetrics(),
    getAdminFunnel(),
    listAdminEntitlementGrants(),
    listAdminBillingOrders(),
    getMeetingShareAnalyticsSummary(),
    getLegacyDeletionCleanupDiagnostics(10),
    getAccountDeletionCleanupDiagnostics(10),
  ]);

  const accountDeletionCleanupSummary = Object.fromEntries(
    Object.entries(accountDeletionCleanup).filter(([key]) => key !== "inventory"),
  );
  return adminJson({
    ok: true,
    generatedAt: new Date().toISOString(),
    metrics,
    commercialMetrics,
    growthMetrics,
    funnel,
    entitlementGrants,
    billingOrders,
    shareAnalytics,
    deletionCleanup,
    accountDeletionCleanup: accountDeletionCleanupSummary,
  });
}
