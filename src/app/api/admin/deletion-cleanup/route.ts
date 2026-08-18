import { NextRequest } from "next/server";
import { getAccountDeletionCleanupDiagnostics } from "@/lib/server/account-deletion-cleanup-worker";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";
import { getLegacyDeletionCleanupDiagnostics } from "@/lib/server/legacy-deletion-cleanup";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;

  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") || 25);
  try {
    const [diagnostics, accountCleanup] = await Promise.all([
      getLegacyDeletionCleanupDiagnostics(requestedLimit),
      getAccountDeletionCleanupDiagnostics(requestedLimit),
    ]);
    return adminJson({ ok: true, diagnostics, accountCleanup });
  } catch (error) {
    console.error("Legacy deletion cleanup diagnostics failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return adminJson(
      { ok: false, error: "删除清理诊断暂时不可用，请检查数据库 migration 和 Worker 状态。" },
      { status: 503 },
    );
  }
}
