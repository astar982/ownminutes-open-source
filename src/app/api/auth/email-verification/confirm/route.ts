import { NextRequest, NextResponse } from "next/server";
import { AuthError, createSession, SESSION_COOKIE_NAME, verifyEmailWithToken } from "@/lib/server/auth-repository";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { isSafeExternalHttps } from "@/lib/server/request-origin";
import { publicMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const originResponse = publicMutationOriginResponse(request);
  if (originResponse) return originResponse;
  try {
    const body = requirePlainRecord(await readBoundedJson(request, 8 * 1024));
    const token = boundedString(body.token, { field: "token", maxLength: 4_096, required: true });
    const user = await verifyEmailWithToken(token);
    const session = await createSession(user.id);
    const response = NextResponse.json({ ok: true, user, message: "邮箱验证成功。" });
    response.cookies.set(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSafeExternalHttps(request),
      path: "/",
      maxAge: session.maxAge,
    });
    return response;
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    }
    console.error(error);
    return NextResponse.json({ ok: false, error: "邮箱验证失败，请稍后重试。" }, { status: 500 });
  }
}
