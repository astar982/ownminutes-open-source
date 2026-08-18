import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";
import { assessMeetingResultQuality } from "@/lib/meeting-result-quality";
import { MeetingAccessError, readUserMeetingDetail, updateMeetingShare } from "@/lib/server/meeting-audio-store";
import { meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录后再修改分享权限。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const body = requirePlainRecord(await readBoundedJson(request, 8 * 1024));
    const visibility = body.visibility === "public" ? "public" : "private";
    const includeTranscript = Boolean(body.includeTranscript);
    if (body.expiresAt !== undefined && typeof body.expiresAt !== "string") {
      return NextResponse.json({ ok: false, error: "分享有效期格式无效。", code: "share_expiry_invalid" }, { status: 400 });
    }
    const expiresAt = typeof body.expiresAt === "string"
      ? boundedString(body.expiresAt, { field: "expiresAt", maxLength: 64 })
      : undefined;
    const meeting = await readUserMeetingDetail(id, user.id);
    if (visibility === "public") {
      const meetingResult = meeting.result;
      if (!meetingResult) {
        return NextResponse.json({ ok: false, error: "请先生成会议纪要，再发布分享链接。", code: "meeting_result_required" }, { status: 409 });
      }
      if (meeting.humanReview.status !== "confirmed") {
        return NextResponse.json(
          {
            ok: false,
            error: "请先逐项核对逐字稿、纪要和待办，并确认当前版本后再发布。",
            code: "human_review_required",
            humanReview: meeting.humanReview,
          },
          { status: 409 },
        );
      }
      const quality = assessMeetingResultQuality(meetingResult);
      if (quality.status !== "verified" && body.confirmUnverified !== true) {
        return NextResponse.json(
          {
            ok: false,
            error: "当前纪要尚未通过正式识别验收。人工复核后，请明确确认发布未验证内容。",
            code: "unverified_result_confirmation_required",
            qualityConfirmationRequired: true,
            quality: {
              status: quality.status,
              publishLabel: quality.publishLabel,
              warning: quality.shareWarningDetail,
            },
          },
          { status: 409 },
        );
      }
    }
    const result = await updateMeetingShare({
      meetingId: id,
      ownerUserId: user.id,
      visibility,
      includeTranscript,
      expiresAt,
    });

    return NextResponse.json({
      ok: true,
      ...result,
      shareUrl: `/share/${id}`,
    });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(meetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "分享权限更新失败。" }, { status: 500 });
  }
}
