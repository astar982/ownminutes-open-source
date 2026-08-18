import { NextRequest, NextResponse } from "next/server";
import { AuthError, createSession, loginUser, SESSION_COOKIE_NAME } from "@/lib/server/auth-repository";
import {
  AuthRateLimitBackendError,
  buildLoginRateLimitScopes,
  runLoginRateLimitedVerifier,
} from "@/lib/server/auth-rate-limit";
import { getAuthRateLimitClientIp } from "@/lib/server/auth-client-identity";
import { boundedString, BoundedRequestError, readBoundedAuthBody } from "@/lib/server/bounded-request";
import { buildSafeSameOriginUrl, isSafeExternalHttps } from "@/lib/server/request-origin";
import { publicMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const originResponse = publicMutationOriginResponse(request);
  if (originResponse) return originResponse;
  try {
    const { body, isFormRequest } = await readBoundedAuthBody(request, { maxBytes: 32 * 1024 });
    const email = boundedString(body.email, { field: "email", maxLength: 320, required: true });
    const password = boundedString(body.password, {
      field: "password",
      maxLength: 1024,
      required: true,
      trim: false,
    });
    const scopes = buildLoginRateLimitScopes({
      email,
      ip: getAuthRateLimitClientIp(request),
    });
    const verification = await runLoginRateLimitedVerifier(
      scopes,
      () => loginUser({ email, password }),
      (error) => error instanceof AuthError && error.status === 401,
    );
    if (!verification.admitted) {
      return rateLimitResponse(verification.rateLimit.retryAfterSeconds);
    }
    if (!verification.verified) {
      if (verification.rateLimit.blocked) {
        return rateLimitResponse(verification.rateLimit.retryAfterSeconds);
      }
      throw verification.error;
    }
    const user = verification.value;
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
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    }
    if (error instanceof AuthRateLimitBackendError) {
      return rateLimitBackendResponse(error);
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "登录失败，请稍后重试。" }, { status: 500 });
  }
}

function rateLimitBackendResponse(error: AuthRateLimitBackendError) {
  return NextResponse.json(
    { ok: false, code: error.code, error: error.message },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}

function rateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      ok: false,
      code: "login_rate_limited",
      error: "登录失败次数过多，请稍后再试。",
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
