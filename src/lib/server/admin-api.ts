import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";

export async function authorizeAdminApi() {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, code: "authentication_required", error: "请先登录。" },
        { status: 401, headers: privateNoStoreHeaders() },
      ),
    };
  }
  if (user.role !== "admin") {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, code: "admin_required", error: "当前账号没有后台权限。" },
        { status: 403, headers: privateNoStoreHeaders() },
      ),
    };
  }
  return { ok: true as const, user };
}

export function adminJson(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(privateNoStoreHeaders())) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return NextResponse.json(data, { ...init, headers });
}

function privateNoStoreHeaders() {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "Authorization, Cookie",
  };
}
