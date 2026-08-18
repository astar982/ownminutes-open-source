import { getStorageDiagnostics } from "@/lib/storage-diagnostics";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;
  return adminJson({
    ok: true,
    diagnostics: getStorageDiagnostics(),
  });
}
