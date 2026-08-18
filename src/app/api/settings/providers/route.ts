import { getProviderFieldPresence, providerCatalog } from "@/lib/provider-catalog";
import { getProviderDiagnostic } from "@/lib/transcription-adapter";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";

export const runtime = "nodejs";

export async function GET() {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;
  const diagnostic = getProviderDiagnostic();

  return adminJson({
    diagnostic,
    catalog: providerCatalog.map((provider) => ({
      ...provider,
      fields: provider.fields.map((field) => ({
        ...field,
        configured: getProviderFieldPresence(field.name, diagnostic),
      })),
    })),
    security: {
      secretsReturned: false,
      writableFromBrowser: false,
      reason: "Prototype settings expose setup metadata and readiness only. Commercial secret saving requires encrypted tenant storage.",
    },
  });
}
