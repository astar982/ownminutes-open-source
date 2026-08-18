import { NextRequest, NextResponse } from "next/server";
import { deleteAccount } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import { SESSION_COOKIE_NAME } from "@/lib/server/auth-repository";
import { closeVolcanoRealtimeSessionsForUser } from "@/lib/server/volcano-realtime-asr";
import { assertAccountDeletionStorageIntegrity, deleteAllUserMeetings } from "@/lib/server/meeting-audio-store";
import { withUserWriteLock } from "@/lib/server/meeting-write-lock";
import { MeetingAccessError, meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { createAccountDeletionTicket, verifyAccountDeletionTicket } from "@/lib/server/account-deletion-ticket";
import {
  cancelAccountDeletionCleanupForActiveUser,
  resolveAccountDeletionStatus,
  scheduleAccountDeletionCleanup,
} from "@/lib/server/account-deletion-state";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import {
  authenticatedMutationOriginResponse,
  publicMutationOriginResponse,
} from "@/lib/server/sensitive-action-guard";
import { SecretAuditUnavailableError } from "@/lib/server/secret-audit";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Please sign in." }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...createAccountDeletionTicket(user.id) });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ ok: false, error: "Account deletion confirmation is unavailable." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const originResponse = publicMutationOriginResponse(request);
  if (originResponse) return originResponse;
  let ticketValue: string;
  try {
    const body = requirePlainRecord(await readBoundedJson(request, 8 * 1024));
    ticketValue = boundedString(body.ticket, { field: "ticket", maxLength: 4_096, required: true });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
  const ticket = verifyAccountDeletionTicket(ticketValue);
  if (!ticket) return NextResponse.json({ ok: false, error: "Invalid or expired deletion receipt." }, { status: 400 });
  const status = await resolveAccountDeletionStatus(ticket.userId);
  return NextResponse.json({ ok: true, status });
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    return await withUserWriteLock(user.id, async () => {
      const existingStatus = await resolveAccountDeletionStatus(user.id);
      if (existingStatus !== "active") return deletionResponse(existingStatus);
      await assertAccountDeletionStorageIntegrity();
      closeVolcanoRealtimeSessionsForUser(user.id);
      // Authentication is invalidated immediately. Tenant-wide object
      // discovery and physical S3 deletion are durable Worker work, never an
      // unbounded HTTP request under the user lock.
      const cleanup = await scheduleAccountDeletionCleanup(user.id);
      try {
        if (!cleanup.scheduled) {
          const inlineCleanup = await deleteAllUserMeetings(user.id);
          if (inlineCleanup.cleanupPending) {
            throw new MeetingAccessError("账号数据仍有无法安全归属的对象，删除尚未完成。", 503, {
              code: "account_object_cleanup_pending",
              retryable: true,
              retryAfterSeconds: 30,
            });
          }
        }
        await deleteAccount(user.id);
      } catch (error) {
        if (cleanup.scheduled) {
          await cancelAccountDeletionCleanupForActiveUser(user.id).catch(() => undefined);
        }
        throw error;
      }
      const status = await resolveAccountDeletionStatus(user.id);
      if (status === "active") throw new Error("Account deletion did not persist its soft-delete state.");
      return deletionResponse(status);
    });
  } catch (error) {
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(meetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }
    if (error instanceof SecretAuditUnavailableError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }
    console.error(error);
    return NextResponse.json({ ok: false, error: "账号删除暂时失败，请稍后重试。" }, { status: 500 });
  }
}

function deletionResponse(status: "pending_cleanup" | "deleted") {
  const response = NextResponse.json(
    { ok: true, status },
    { status: status === "pending_cleanup" ? 202 : 200 },
  );
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
