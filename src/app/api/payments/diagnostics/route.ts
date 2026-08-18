import { NextResponse } from "next/server";
import { getAppleIapProductCatalog } from "@/lib/apple-iap";
import { getPaymentDiagnostics } from "@/lib/payment-diagnostics";
import { buildLegacyPaymentStorefrontResponse } from "@/lib/payment-storefront-compat";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const diagnostics = getPaymentDiagnostics();
  let products: ReturnType<typeof getAppleIapProductCatalog> = [];
  try {
    products = getAppleIapProductCatalog();
  } catch {
    // A broken mapping must close the legacy storefront instead of falling back to default SKUs.
  }

  const auth = await authorizeAdminApi();
  if (auth.ok) {
    return adminJson({
      ok: true,
      diagnostics,
      productIds: products.map((item) => item.productId),
      products: products.map(({ plan, productId }) => ({ plan, productId })),
    });
  }

  return NextResponse.json(
    buildLegacyPaymentStorefrontResponse(diagnostics, products),
    { headers: compatibilityHeaders() },
  );
}

function compatibilityHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "Authorization, Cookie",
  };
}
