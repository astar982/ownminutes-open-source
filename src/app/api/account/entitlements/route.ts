import { NextResponse } from "next/server";
import { buildAccountEntitlements } from "@/lib/account-entitlements";
import { getUserUsage, listProviderCredentials } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  const [usage, providerCredentials] = await Promise.all([getUserUsage(user.id), listProviderCredentials(user.id)]);

  return NextResponse.json({
    ok: true,
    entitlements: buildAccountEntitlements({
      user,
      usage,
      providerCredentials,
    }),
  });
}
