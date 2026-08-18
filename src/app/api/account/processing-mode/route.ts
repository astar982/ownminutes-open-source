import { NextResponse } from "next/server";
import { isUserProcessingMode } from "@/lib/processing-route";
import { getUserProviderHealth } from "@/lib/provider-health";
import {
  AuthError,
  getUserProcessingMode,
  updateUserProcessingMode,
} from "@/lib/server/auth-repository";
import { BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { getCurrentUser } from "@/lib/server/current-user";
import {
  assertSensitiveActionOrigin,
  consumeSensitiveActionCooldown,
  sensitiveActionCooldownResponse,
  sensitiveActionErrorResponse,
} from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, processingMode: await getUserProcessingMode(user.id) });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    assertSensitiveActionOrigin(request);
    body = requirePlainRecord(await readBoundedJson(request, 4 * 1024));
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
  if (!isUserProcessingMode(body.processingMode)) {
    return NextResponse.json({ ok: false, error: "请选择官方额度或自己的模型。" }, { status: 400 });
  }

  try {
    if (body.processingMode === "byok") {
      const cooldown = consumeSensitiveActionCooldown(user.id, "enable-byok", 60_000);
      if (!cooldown.allowed) return sensitiveActionCooldownResponse(cooldown.retryAfterSeconds);
      const health = await getUserProviderHealth(user.id, { live: true });
      const asrReady = health.some((item) => item.providerId === "volcano-asr" && item.status === "ready");
      const summaryReady = health.some((item) => item.providerId === "volcano-ark" && item.status === "ready");
      if (!asrReady || !summaryReady) {
        return NextResponse.json(
          {
            ok: false,
            code: "byok_health_not_ready",
            error: "自己的模型尚未全部通过健康检查，请先检查语音识别和纪要总结。",
          },
          { status: 409 },
        );
      }
    }

    const updatedUser = await updateUserProcessingMode(user.id, body.processingMode);
    return NextResponse.json({ ok: true, processingMode: updatedUser.processingMode, user: updatedUser });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json({ ok: false, error: "处理方式保存失败，请稍后重试。" }, { status: 500 });
  }
}
