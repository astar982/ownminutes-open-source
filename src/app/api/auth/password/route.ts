import { NextRequest, NextResponse } from "next/server";
import { AuthError, changePassword } from "@/lib/server/auth-repository";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { getCurrentUser, getRequestSessionToken } from "@/lib/server/current-user";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const body = requirePlainRecord(await readBoundedJson(request, 8 * 1024));
    const currentSessionToken = (await getRequestSessionToken()) ?? null;
    const updatedUser = await changePassword(user.id, {
      currentPassword: boundedString(body.currentPassword, {
        field: "currentPassword",
        maxLength: 1_024,
        required: true,
        trim: false,
      }),
      currentSessionToken,
      newPassword: boundedString(body.newPassword, {
        field: "newPassword",
        maxLength: 1_024,
        required: true,
        trim: false,
      }),
    });

    return NextResponse.json({ ok: true, user: updatedUser });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "修改密码失败。" }, { status: 500 });
  }
}
