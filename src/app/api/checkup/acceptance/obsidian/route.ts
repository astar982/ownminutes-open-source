import { NextResponse } from "next/server";
import { adminJson, authorizeAdminApi } from "@/lib/server/admin-api";
import { buildCheckupAcceptanceFileName, buildCheckupAcceptanceReport } from "@/lib/server/checkup-acceptance-report";
import { ObsidianVaultError, writeMarkdownToObsidianVault } from "@/lib/server/obsidian-vault";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await authorizeAdminApi();
  if (!auth.ok) return auth.response;
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const report = await buildCheckupAcceptanceReport(auth.user);
    const saved = await writeMarkdownToObsidianVault({
      directoryErrorMessage: "无法创建 Obsidian 验收记录目录。",
      directorySegments: ["OwnMinutes", "验收记录"],
      fileName: buildCheckupAcceptanceFileName(auth.user.id, report.generatedAt),
      markdown: report.markdown,
    });

    return adminJson({
      ok: true,
      saved: {
        fileName: saved.fileName,
        relativePath: saved.relativePath,
      },
    });
  } catch (error) {
    if (error instanceof ObsidianVaultError) {
      return adminJson({ ok: false, error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "保存验收单到 Obsidian 失败。" }, { status: 500 });
  }
}
