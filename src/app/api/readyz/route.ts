import { NextResponse } from "next/server";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";
import { getRuntimeReadinessReport } from "@/lib/server/runtime-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const report = await getRuntimeReadinessReport();
  const status = report.ok ? 200 : 503;

  try {
    const auth = await authorizeAdminApi();
    if (auth.ok) return adminJson(report, { status });
  } catch {
    // Readiness must remain observable even when the auth repository is unavailable.
  }

  return NextResponse.json(
    {
      ok: report.ok,
      releaseReady: report.releaseReady,
      service: report.service,
      status: report.status,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    },
  );
}
