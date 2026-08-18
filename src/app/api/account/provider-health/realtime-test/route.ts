import { NextRequest, NextResponse } from "next/server";
import { runVolcanoRealtimeAuthTest } from "@/lib/provider-health";
import { getCurrentUser } from "@/lib/server/current-user";
import {
  assertSensitiveActionOrigin,
  consumeSensitiveActionCooldown,
  sensitiveActionCooldownResponse,
  sensitiveActionErrorResponse,
} from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  try {
    assertSensitiveActionOrigin(request);
  } catch (error) {
    return sensitiveActionErrorResponse(error) ?? NextResponse.json({ ok: false, error: "请求被拒绝。" }, { status: 403 });
  }
  const cooldown = consumeSensitiveActionCooldown(user.id, "realtime-asr-auth-test", 30_000);
  if (!cooldown.allowed) return sensitiveActionCooldownResponse(cooldown.retryAfterSeconds);

  const result = await runVolcanoRealtimeAuthTest(user.id);
  return NextResponse.json({ ok: result.ok, result });
}
