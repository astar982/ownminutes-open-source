import { NextResponse } from "next/server";
import { getUserUsage } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import { getOfficialProcessingStatus } from "@/lib/server/official-processing-status";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  const usage = await getUserUsage(user.id);
  return NextResponse.json({
    ok: true,
    usage: {
      ...usage,
      officialProcessing: {
        status: getOfficialProcessingStatus(),
      },
    },
  });
}
