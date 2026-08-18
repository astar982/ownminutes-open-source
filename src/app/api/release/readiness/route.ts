import { getReleaseReadinessReport } from "@/lib/release-readiness";
import { getRuntimeSecretDiagnostics } from "@/lib/secret-diagnostics";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;
  const report = getReleaseReadinessReport(await getRuntimeSecretDiagnostics());

  return adminJson({
    ok: true,
    generatedAt: report.generatedAt,
    summary: report.summary,
    blockers: report.blockers,
    nextAction: report.nextAction,
    report,
  });
}
