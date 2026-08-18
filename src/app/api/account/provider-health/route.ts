import { NextRequest, NextResponse } from "next/server";
import { getProviderSetupReport, getUserProviderHealth, getUserProviderHealthById } from "@/lib/provider-health";
import { boundedString, BoundedRequestError } from "@/lib/server/bounded-request";
import { getCurrentUser } from "@/lib/server/current-user";
import {
  assertSensitiveActionOrigin,
  consumeSensitiveActionCooldown,
  sensitiveActionCooldownResponse,
  sensitiveActionErrorResponse,
} from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  try {
    const providerId = boundedString(request.nextUrl.searchParams.get("providerId"), {
      field: "providerId",
      maxLength: 64,
    });
    const live = request.nextUrl.searchParams.get("live") === "1";
    if (live) {
      assertSensitiveActionOrigin(request, { requireBrowserEvidenceForGet: true });
      const cooldown = consumeSensitiveActionCooldown(user.id, `provider-health:${providerId || "all"}`, 30_000);
      if (!cooldown.allowed) return sensitiveActionCooldownResponse(cooldown.retryAfterSeconds);
    }
    const health = providerId ? [await getUserProviderHealthById(user.id, providerId, { live })] : await getUserProviderHealth(user.id, { live });

    return NextResponse.json({
      ok: true,
      live,
      health,
      setupReport: getProviderSetupReport(health),
    });
  } catch (error) {
    const sensitiveError = sensitiveActionErrorResponse(error);
    if (sensitiveError) return sensitiveError;
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
