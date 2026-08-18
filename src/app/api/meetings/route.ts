import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";
import { listUserMeetings } from "@/lib/server/meeting-audio-store";
import { meetingHistoryUnavailableResponse } from "@/lib/server/meeting-errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
    }

    const query = new URL(request.url).searchParams.get("q")?.trim() || "";
    return NextResponse.json({
      ok: true,
      meetings: query
        ? await listUserMeetings(user.id, { query })
        : await listUserMeetings(user.id),
      query,
    });
  } catch (error) {
    console.error("Meeting history lookup failed.", {
      thrownValueType: error instanceof Error ? "error" : "non_error",
    });
    return meetingHistoryUnavailableResponse();
  }
}
