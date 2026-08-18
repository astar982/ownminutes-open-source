import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";
import {
  deleteUserMeeting,
  MeetingAccessError,
  readUserMeetingDetail,
  updateMeetingMetadata,
  updateMeetingSpeakers,
  updateMeetingSummary,
  updateMeetingTranscriptSpeakers,
} from "@/lib/server/meeting-audio-store";
import { closeVolcanoRealtimeSession } from "@/lib/server/volcano-realtime-asr";
import { cancelMeetingFinalizationJobs } from "@/lib/server/finalization-queue";
import { meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";
import { BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  try {
    return NextResponse.json({
      ok: true,
      meeting: await readUserMeetingDetail(id, user.id),
    });
  } catch (error) {
    if (error instanceof MeetingAccessError) {
      return meetingErrorResponse(error);
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "会议读取失败。" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const deletion = await deleteUserMeeting(id, user.id);
    closeVolcanoRealtimeSession(user.id, id);
    void cancelMeetingFinalizationJobs(id, user.id).catch((error) => {
      console.error("Meeting was deleted, but finalization cancellation is pending.", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    });
    return NextResponse.json({
      ok: true,
      ...deletion,
    });
  } catch (error) {
    if (error instanceof MeetingAccessError) {
      return meetingErrorResponse(error);
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "会议删除失败。" }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const body = requirePlainRecord(await readBoundedJson(request, 512 * 1024));

    if (isSpeakerNamesInput(body.speakerNames)) {
      return NextResponse.json({
        ok: true,
        ...(await updateMeetingSpeakers({
          meetingId: id,
          ownerUserId: user.id,
          speakerNames: body.speakerNames,
        })),
      });
    }

    if (body.transcriptSpeakerAssignments !== undefined) {
      if (!isTranscriptSpeakerAssignmentsInput(body.transcriptSpeakerAssignments)) {
        return NextResponse.json({ ok: false, error: "发言段归属格式无效。" }, { status: 400 });
      }

      return NextResponse.json({
        ok: true,
        ...(await updateMeetingTranscriptSpeakers({
          meetingId: id,
          ownerUserId: user.id,
          speakerAssignments: body.transcriptSpeakerAssignments,
        })),
      });
    }

    if (isSummaryPatchInput(body.summaryPatch)) {
      return NextResponse.json({
        ok: true,
        ...(await updateMeetingSummary({
          meetingId: id,
          ownerUserId: user.id,
          summaryPatch: body.summaryPatch,
        })),
      });
    }

    const tags = Array.isArray(body.tags) ? body.tags.filter((item): item is string => typeof item === "string") : undefined;
    const participants = Array.isArray(body.participants) ? body.participants.filter((item): item is string => typeof item === "string") : undefined;

    return NextResponse.json({
      ok: true,
      ...(await updateMeetingMetadata({
        meetingId: id,
        ownerUserId: user.id,
        participants,
        project: typeof body.project === "string" ? body.project : undefined,
        tags,
        title: typeof body.title === "string" ? body.title : undefined,
      })),
    });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof MeetingAccessError) {
      return meetingErrorResponse(error);
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "会议信息更新失败。" }, { status: 500 });
  }
}

function meetingErrorResponse(error: MeetingAccessError) {
  return NextResponse.json(meetingAccessErrorBody(error), {
    status: error.status,
    headers: meetingAccessErrorHeaders(error),
  });
}

function isSpeakerNamesInput(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string");
}

function isTranscriptSpeakerAssignmentsInput(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 500 && entries.every(([key, item]) => key.trim().length > 0 && typeof item === "string");
}

function isSummaryPatchInput(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["summary", "topics", "speakerViews", "decisions", "actionItems", "risks", "openQuestions", "knowledgePoints"]);
  return Object.keys(value).some((key) => allowed.has(key)) && Object.keys(value).every((key) => allowed.has(key));
}
