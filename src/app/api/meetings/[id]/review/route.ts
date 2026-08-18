import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";
import { MeetingAccessError, updateMeetingHumanReview } from "@/lib/server/meeting-audio-store";
import { meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";
import { BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "请先登录后再确认会议纪要。" }, { status: 401 });
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  const { id } = await context.params;
  try {
    const body = requirePlainRecord(await readBoundedJson(request, 4 * 1024));
    if (typeof body.confirmed !== "boolean") {
      return NextResponse.json({ ok: false, error: "复核状态格式无效。" }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      ...(await updateMeetingHumanReview({ confirmed: body.confirmed, meetingId: id, ownerUserId: user.id })),
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
    return NextResponse.json({ ok: false, error: "会议纪要复核状态保存失败。" }, { status: 500 });
  }
}
