import { NextResponse } from "next/server";
import { buildAccountEntitlements } from "@/lib/account-entitlements";
import { getUserUsage, listProviderCredentials } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import { getOfficialProcessingStatus } from "@/lib/server/official-processing-status";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, user: null }, { status: 401 });
  }

  const [baseUsage, providerCredentials] = await Promise.all([getUserUsage(user.id), listProviderCredentials(user.id)]);
  const usage = {
    ...baseUsage,
    officialProcessing: {
      status: getOfficialProcessingStatus(),
    },
  };

  return NextResponse.json({
    ok: true,
    user,
    usage,
    providerCredentials,
    entitlements: buildAccountEntitlements({
      user,
      usage,
      providerCredentials,
    }),
  });
}
