import { NextRequest, NextResponse } from "next/server";
import { runVolcanoAsrLiveTest, validateAsrTranscribeSample } from "@/lib/provider-health";
import { BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
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

  let body: Awaited<ReturnType<typeof readBody>>;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
  if (body.audioTooLarge) {
    return NextResponse.json(
      {
        ok: false,
        result: {
          ok: false,
          live: body.live === true,
          mode: body.mode === "transcribe" ? "transcribe" : "submit",
          status: "failed",
          verificationLevel: "none",
          title: "音频样本过大",
          detail: "ASR 测试样本当前限制为 2MB 以内，请截取 3-30 秒清晰中文语音后重试。",
          missing: [],
          nextAction: "压缩或截短样本到 2MB 以内。",
          checkedAt: new Date().toISOString(),
        },
      },
      { status: 413 },
    );
  }

  const live = body.live === true;
  const reachesProvider =
    body.mode !== "transcribe" ||
    Boolean(body.audioBase64 && validateAsrTranscribeSample(body).ok);
  if (live && reachesProvider) {
    const cooldown = consumeSensitiveActionCooldown(user.id, `asr-test:${body.mode}`, 60_000);
    if (!cooldown.allowed) return sensitiveActionCooldownResponse(cooldown.retryAfterSeconds);
  }
  const result = await runVolcanoAsrLiveTest(user.id, {
    audioBase64: body.audioBase64,
    durationMs: body.durationMs,
    fileName: body.fileName,
    live,
    mimeType: body.mimeType,
    mode: body.mode,
  });

  return NextResponse.json({
    ok: result.ok,
    result,
  });
}

async function readBody(request: NextRequest) {
  const input = requirePlainRecord(await readBoundedJson(request, 2_100_000));
  const audioBase64 = typeof input.audioBase64 === "string" ? input.audioBase64 : undefined;
  const audioTooLarge = Boolean(audioBase64 && audioBase64.length > 2_000_000);

  return {
    audioBase64: audioBase64 && !audioTooLarge ? audioBase64 : undefined,
    audioTooLarge,
    durationMs: typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? Math.max(0, Math.min(120_000, Math.round(input.durationMs)))
      : undefined,
    fileName: typeof input.fileName === "string" ? input.fileName.slice(0, 120) : undefined,
    live: input.live === true,
    mimeType: typeof input.mimeType === "string" ? input.mimeType.slice(0, 80) : undefined,
    mode: input.mode === "transcribe" ? "transcribe" : "submit",
  } as const;
}
