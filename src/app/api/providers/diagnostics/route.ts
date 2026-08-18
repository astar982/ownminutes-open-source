import { getProviderDiagnostic } from "@/lib/transcription-adapter";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;
  return adminJson(getProviderDiagnostic());
}
