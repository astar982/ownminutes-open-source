import { NextResponse } from "next/server";
import { AppleIapInputError, createAppleIapAccountToken, getAppleIapAccountTokenKeyVersion } from "@/lib/apple-iap";
import { getCurrentUser } from "@/lib/server/current-user";
import { AuthError, bindAppleIapAccount } from "@/lib/server/auth-repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });

  try {
    const appAccountToken = createAppleIapAccountToken(user.id, { allowLocalMock: isLoopbackRequest(request) });
    await bindAppleIapAccount(user.id, appAccountToken, getAppleIapAccountTokenKeyVersion());
    return NextResponse.json({
      ok: true,
      appAccountToken,
    });
  } catch (error) {
    if (error instanceof AppleIapInputError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: 503 });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, code: "apple_iap_account_binding_failed", error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, error: "Apple 账号绑定初始化失败。" }, { status: 500 });
  }
}

function isLoopbackRequest(request: Request) {
  if (process.env.NODE_ENV === "production" || process.env.OWNMINUTES_ENABLE_IAP_MOCK !== "1") return false;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
