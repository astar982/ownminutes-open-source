import { after, NextRequest, NextResponse } from "next/server";
import { AuthError, requestPasswordReset } from "@/lib/server/auth-repository";
import { getEmailDiagnostics } from "@/lib/email-diagnostics";
import { sendPasswordResetEmail } from "@/lib/email-delivery";
import {
  AuthRateLimitBackendError,
  buildPasswordResetRateLimitScopes,
  getPasswordResetRateLimitStateForScopes,
  recordPasswordResetAttemptForScopes,
} from "@/lib/server/auth-rate-limit";
import { getAuthRateLimitClientIp } from "@/lib/server/auth-client-identity";
import { canExposeLocalAuthToken } from "@/lib/server/auth-token-exposure";
import { waitForPublicAuthResponseFloor } from "@/lib/server/auth-response-timing";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { authRateLimitBackendResponse } from "@/lib/server/auth-rate-limit-response";
import { publicMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const originResponse = publicMutationOriginResponse(request);
  if (originResponse) return originResponse;
  const startedAtMs = Date.now();
  try {
    const body = requirePlainRecord(await readBoundedJson(request, 8 * 1024));
    const email = boundedString(body.email, { field: "email", maxLength: 320, required: true });
    const scopes = buildPasswordResetRateLimitScopes({
      email,
      ip: getAuthRateLimitClientIp(request),
    });
    const rateLimit = await getPasswordResetRateLimitStateForScopes(scopes);
    if (rateLimit.blocked) {
      return rateLimitResponse(rateLimit.retryAfterSeconds);
    }
    const nextRateLimit = await recordPasswordResetAttemptForScopes(scopes);
    if (nextRateLimit.blocked) {
      return rateLimitResponse(nextRateLimit.retryAfterSeconds);
    }

    const exposeResetToken = canExposeResetToken(request);
    const result = await requestPasswordReset({ email });
    let emailResult = { sent: false, provider: getEmailDiagnostics().provider };
    if (result.resetToken && result.expiresAt) {
      const emailInput = {
        email,
        expiresAt: result.expiresAt,
        locale: request.headers.get("accept-language") || undefined,
        resetToken: result.resetToken,
      };
      if (exposeResetToken) {
        try {
          emailResult = await sendPasswordResetEmail(emailInput);
        } catch {
          console.error("Password reset email delivery failed.");
        }
      } else {
        after(async () => {
          try {
            await sendPasswordResetEmail(emailInput);
          } catch {
            console.error("Password reset email delivery failed.");
          }
        });
      }
    }

    await waitForPublicAuthResponseFloor(startedAtMs, !exposeResetToken);

    return NextResponse.json({
      ok: true,
      emailSent: true,
      expiresAt: exposeResetToken ? result.expiresAt : undefined,
      resetToken: exposeResetToken ? result.resetToken : undefined,
      delivery: exposeResetToken
        ? {
            provider: emailResult.provider,
            sent: emailResult.sent,
          }
        : undefined,
      remainingAttempts: exposeResetToken ? nextRateLimit.remainingAttempts : undefined,
      message: "如果该邮箱存在，我们会发送密码重置链接。",
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

function rateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      ok: false,
      code: "password_reset_rate_limited",
      error: "密码重置请求过多，请稍后再试。",
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

function canExposeResetToken(request: NextRequest) {
  if (process.env.NODE_ENV !== "production" && process.env.OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE === "1") return true;
  return canExposeLocalAuthToken(request);
}

function authErrorResponse(error: unknown) {
  if (error instanceof BoundedRequestError) {
    return NextResponse.json(
      { ok: false, code: error.code, error: error.message },
      { status: error.status },
    );
  }
  if (error instanceof AuthRateLimitBackendError) {
    return authRateLimitBackendResponse(error);
  }
  if (error instanceof AuthError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  }

  console.error(error);
  return NextResponse.json({ ok: false, error: "密码重置请求失败，请稍后重试。" }, { status: 500 });
}
