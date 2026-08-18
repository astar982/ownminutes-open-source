import { NextRequest, NextResponse } from "next/server";
import { AuthError, resetPasswordWithToken } from "@/lib/server/auth-repository";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { publicMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const originResponse = publicMutationOriginResponse(request);
  if (originResponse) return originResponse;
  try {
    const body = requirePlainRecord(await readBoundedJson(request, 16 * 1024));
    await resetPasswordWithToken({
      token: boundedString(body.token, { field: "token", maxLength: 4_096, required: true }),
      newPassword: boundedString(body.newPassword, {
        field: "newPassword",
        maxLength: 1_024,
        required: true,
        trim: false,
      }),
    });

    return NextResponse.json({
      ok: true,
      message: "密码已重置，请使用新密码登录。",
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

function authErrorResponse(error: unknown) {
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
  return NextResponse.json({ ok: false, error: "密码重置失败，请稍后重试。" }, { status: 500 });
}
