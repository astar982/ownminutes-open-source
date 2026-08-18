import { NextRequest, NextResponse } from "next/server";
import { AuthError, createSession, SESSION_COOKIE_NAME, verifyEmailWithCode } from "@/lib/server/auth-repository";
import {
  AuthRateLimitBackendError,
  buildEmailVerificationRateLimitScopes,
  getEmailVerificationRateLimitStateForScopes,
  recordEmailVerificationAttemptForScopes,
} from "@/lib/server/auth-rate-limit";
import { getAuthRateLimitClientIp } from "@/lib/server/auth-client-identity";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { authRateLimitBackendResponse } from "@/lib/server/auth-rate-limit-response";
import { isSafeExternalHttps } from "@/lib/server/request-origin";
import { publicMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const originResponse = publicMutationOriginResponse(request);
  if (originResponse) return originResponse;
  let email: string;
  let code: string;
  try {
    const body = requirePlainRecord(await readBoundedJson(request, 8 * 1024));
    email = boundedString(body.email, { field: "email", maxLength: 320, required: true });
    code = boundedString(body.code, { field: "code", maxLength: 32, required: true });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
  const scopes = buildEmailVerificationRateLimitScopes({
    action: "confirm",
    email,
    ip: getAuthRateLimitClientIp(request),
  });
  try {
    const rateLimit = await getEmailVerificationRateLimitStateForScopes(scopes);
    if (rateLimit.blocked) return rateLimitResponse(rateLimit.retryAfterSeconds);
    const user = await verifyEmailWithCode({ email, code });
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
    if (error instanceof AuthError) {
      try {
        const nextRateLimit = await recordEmailVerificationAttemptForScopes(scopes);
        if (nextRateLimit.blocked) {
          return rateLimitResponse(nextRateLimit.retryAfterSeconds);
        }
      } catch (rateLimitError) {
        if (rateLimitError instanceof AuthRateLimitBackendError) {
          return authRateLimitBackendResponse(rateLimitError);
        }
        throw rateLimitError;
      }
      return NextResponse.json(
        {
          ok: false,
          code: "invalid_email_verification_code",
          error: "验证码无效或已过期，请重新获取后再试。",
        },
        { status: 400 },
      );
    }
    if (error instanceof AuthRateLimitBackendError) {
      return authRateLimitBackendResponse(error);
    }
    console.error(error);
    return NextResponse.json({ ok: false, error: "邮箱验证失败，请稍后重试。" }, { status: 500 });
  }
}

function rateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      ok: false,
      code: "email_verification_code_rate_limited",
      error: "验证码尝试次数过多，请稍后再试。",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
    },
  );
}
