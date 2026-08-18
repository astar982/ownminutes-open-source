import { NextResponse } from "next/server";
import { AuthRateLimitBackendError } from "@/lib/server/auth-rate-limit";

export function authRateLimitBackendResponse(error: AuthRateLimitBackendError) {
  return NextResponse.json(
    { ok: false, code: error.code, error: error.message },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "30",
      },
    },
  );
}
