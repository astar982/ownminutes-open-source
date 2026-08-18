import { NextResponse } from "next/server";
import { getAppleIapProductCatalog } from "@/lib/apple-iap";
import { getPaymentDiagnostics } from "@/lib/payment-diagnostics";
import { getCurrentUser } from "@/lib/server/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, code: "authentication_required", error: "请先登录。" },
      { status: 401, headers: privateHeaders() },
    );
  }

  const diagnostics = getPaymentDiagnostics();
  let products: Array<{
    amountCents: number;
    currency: string;
    plan: string;
    productId: string;
  }> = [];
  try {
    products = getAppleIapProductCatalog().map(({ amountCents, currency, plan, productId }) => ({
      amountCents,
      currency,
      plan,
      productId,
    }));
  } catch {
    // Invalid server-side mapping is represented as an unavailable storefront.
  }
  const acceptingPurchases =
    diagnostics.acceptingPurchases &&
    diagnostics.provider === "apple-iap" &&
    products.length > 0;

  return NextResponse.json(
    {
      ok: true,
      storefront: {
        acceptingPurchases,
        provider: {
          id: diagnostics.provider,
          status: acceptingPurchases ? "available" : "unavailable",
        },
        products,
      },
    },
    { headers: privateHeaders() },
  );
}

function privateHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Authorization, Cookie",
  };
}
