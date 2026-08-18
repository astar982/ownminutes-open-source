import { NextResponse } from "next/server";
import { listAdminUsers } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  if (user.role !== "admin") {
    return NextResponse.json({ ok: false, error: "当前账号没有后台权限。" }, { status: 403 });
  }

  return NextResponse.json({
    ok: true,
    users: await listAdminUsers(),
  });
}
