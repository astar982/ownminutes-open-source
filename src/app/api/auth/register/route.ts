import { NextRequest, NextResponse } from "next/server";
import { AuthError, createSession, registerUser, requestEmailVerification, SESSION_COOKIE_NAME } from "@/lib/server/auth-repository";
import { isEmailVerificationRequired } from "@/lib/server/email-verification-policy";
import { sendEmailVerificationEmail } from "@/lib/email-delivery";
import { canExposeLocalAuthToken } from "@/lib/server/auth-token-exposure";
import {
  AuthRateLimitBackendError,
  buildRegisterRateLimitIdentifier,
  getRegisterRateLimitState,
  recordRegisterAttempt,
} from "@/lib/server/auth-rate-limit";
import { getAuthRateLimitClientIp } from "@/lib/server/auth-client-identity";
import { boundedString, BoundedRequestError, readBoundedAuthBody } from "@/lib/server/bounded-request";
import { buildSafeSameOriginUrl, isSafeExternalHttps } from "@/lib/server/request-origin";
import { publicMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const originResponse = publicMutationOriginResponse(request);
  if (originResponse) return originResponse;
  const identifier = buildRegisterRateLimitIdentifier({ ip: getAuthRateLimitClientIp(request) });
  try {
    const rateLimit = await getRegisterRateLimitState(identifier);
    if (rateLimit.blocked) {
      return rateLimitResponse(rateLimit.retryAfterSeconds);
    }
  } catch (error) {
    if (error instanceof AuthRateLimitBackendError) return rateLimitBackendResponse(error);
    throw error;
  }

  try {
    const { body, isFormRequest } = await readBoundedAuthBody(request, { maxBytes: 32 * 1024 });
    const nextRateLimit = await recordRegisterAttempt(identifier);
    if (nextRateLimit.blocked) {
      return rateLimitResponse(nextRateLimit.retryAfterSeconds);
    }
    const user = await registerUser({
      email: boundedString(body.email, { field: "email", maxLength: 320, required: true }),
      name: boundedString(body.name, { field: "name", maxLength: 120, required: true }),
      password: boundedString(body.password, {
        field: "password",
        maxLength: 1024,
        required: true,
        trim: false,
      }),
      attribution: {
        source: boundedString(body.source, { field: "source", maxLength: 40 }),
        shareId: boundedString(body.shareId, { field: "shareId", maxLength: 120 }),
      },
    });
    if (isEmailVerificationRequired() && !user.emailVerifiedAt) {
      const verification = await requestEmailVerification({ email: user.email });
      let emailSent = false;
      if (verification.verificationToken && verification.expiresAt) {
        try {
          emailSent = (
            await sendEmailVerificationEmail({
              codeExpiresAt: verification.codeExpiresAt,
              email: user.email,
              expiresAt: verification.expiresAt,
              locale: request.headers.get("accept-language") || undefined,
              verificationCode: verification.verificationCode,
              verificationToken: verification.verificationToken,
            })
          ).sent;
        } catch {
          console.error("Registration verification email delivery failed.");
        }
      }
      if (isFormRequest) {
        return NextResponse.redirect(buildSafeSameOriginUrl(request, `/verify-email?email=${encodeURIComponent(user.email)}`), 303);
      }
      return NextResponse.json({
        ok: true,
        user,
        verificationRequired: true,
        verificationMethod: "code",
        emailSent,
        expiresAt: verification.codeExpiresAt,
        resendAvailableAt: verification.resendAvailableAt,
        retryAfterSeconds: verification.retryAfterSeconds,
        verificationCode: canExposeLocalAuthToken(request) ? verification.verificationCode : undefined,
        verificationToken: canExposeLocalAuthToken(request) ? verification.verificationToken : undefined,
        message: emailSent ? "账号已创建，请查收验证邮件。" : "账号已创建，但验证邮件暂未送达，请重试发送。",
      });
    }

    const session = await createSession(user.id);
    const response = isFormRequest ? NextResponse.redirect(buildSafeSameOriginUrl(request, "/app"), 303) : NextResponse.json({ ok: true, user });
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
    if (error instanceof AuthRateLimitBackendError) return rateLimitBackendResponse(error);
    return authErrorResponse(error);
  }
}

function rateLimitBackendResponse(error: AuthRateLimitBackendError) {
  return NextResponse.json(
    { ok: false, code: error.code, error: error.message },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}

function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
  }

  console.error(error);
  return NextResponse.json({ ok: false, error: "注册失败，请稍后重试。" }, { status: 500 });
}

function rateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      ok: false,
      code: "register_rate_limited",
      error: "注册请求过多，请稍后再试。",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, retryAfterSeconds)),
      },
    },
  );
}
