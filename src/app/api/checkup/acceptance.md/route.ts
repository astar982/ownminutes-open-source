import { authorizeAdminApi } from "@/lib/server/admin-api";
import { buildCheckupAcceptanceReport } from "@/lib/server/checkup-acceptance-report";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;

  const report = await buildCheckupAcceptanceReport(auth.user);

  return new Response(report.markdown, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`ownminutes-acceptance-${report.generatedAt.slice(0, 10)}.md`)}`,
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Authorization, Cookie",
    },
  });
}
