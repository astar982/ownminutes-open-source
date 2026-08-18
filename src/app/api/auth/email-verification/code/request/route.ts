import { after, NextRequest, NextResponse } from "next/server";
import { requestEmailVerification } from "@/lib/server/auth-repository";
import { sendEmailVerificationEmail } from "@/lib/email-delivery";
import {
  AuthRateLimitBackendError,
  buildEmailVerificationRateLimitScopes,
  clearEmailVerificationAttemptsForScopes,
  getEmailVerificationRateLimitStateForScopes,
  recordEmailVerificationAttemptForScopes,
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
  let email: string;
  try {
    const body = requirePlainRecord(await readBoundedJson(request, 8 * 1024));
    email = boundedString(body.email, { field: "email", maxLength: 320, required: true });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
  const ip = getAuthRateLimitClientIp(request);
  const requestScopes = buildEmailVerificationRateLimitScopes({
    action: "request",
    email,
    ip,
  });

  try {
    const rateLimit = await getEmailVerificationRateLimitStateForScopes(requestScopes);
    if (rateLimit.blocked) return rateLimitResponse(rateLimit.retryAfterSeconds);
    const nextRateLimit = await recordEmailVerificationAttemptForScopes(requestScopes);
    if (nextRateLimit.blocked) return rateLimitResponse(nextRateLimit.retryAfterSeconds);

    const result = await requestEmailVerification({ email });
    if (result.verificationToken && result.verificationCode) {
      await clearEmailVerificationAttemptsForScopes(
        buildEmailVerificationRateLimitScopes({ action: "confirm", email, ip }).filter((scope) => scope.scope !== "ip"),
      );
      const emailInput = {
        codeExpiresAt: result.codeExpiresAt,
        email,
        expiresAt: result.expiresAt,
        locale: request.headers.get("accept-language") || undefined,
        verificationCode: result.verificationCode,
        verificationToken: result.verificationToken,
      };
      after(async () => {
        try {
          await sendEmailVerificationEmail(emailInput);
        } catch {
          console.error("Email verification code delivery failed.");
        }
      });
    }

    const exposeLocalCredential = canExposeLocalAuthToken(request);
    await waitForPublicAuthResponseFloor(startedAtMs, !exposeLocalCredential);
    return NextResponse.json({
      ok: true,
      retryAfterSeconds: 60,
      verificationCode: exposeLocalCredential ? result.verificationCode : undefined,
      verificationToken: exposeLocalCredential ? result.verificationToken : undefined,
      message: "如果该邮箱可以验证，我们会发送新的验证码。",
    });
  } catch (error) {
    if (error instanceof AuthRateLimitBackendError) {
      return authRateLimitBackendResponse(error);
    }
    console.error(error);
    return NextResponse.json({ ok: false, error: "验证码请求失败，请稍后重试。" }, { status: 500 });
  }
}

function rateLimitResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      ok: false,
      code: "email_verification_code_rate_limited",
      error: "验证码请求过多，请稍后再试。",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
    },
  );
}
