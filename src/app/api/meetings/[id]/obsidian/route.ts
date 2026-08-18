import { NextResponse } from "next/server";
import { applyMeetingMetadataToMarkdown } from "@/lib/meeting-markdown";
import { applyMeetingResultQualityNotice } from "@/lib/meeting-result-quality";
import { getCurrentUser } from "@/lib/server/current-user";
import { MeetingAccessError, readUserMeetingDetail } from "@/lib/server/meeting-audio-store";
import { ObsidianVaultError, writeMeetingMarkdownToObsidianVault } from "@/lib/server/obsidian-vault";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const detail = await readUserMeetingDetail(id, user.id);
    const rawMarkdown = detail.obsidianMarkdown || detail.result?.obsidianMarkdown;

    if (!rawMarkdown) {
      return NextResponse.json({ ok: false, error: "当前会议还没有可写入 Obsidian 的 Markdown。" }, { status: 404 });
    }

    const markdown = applyMeetingResultQualityNotice(applyMeetingMetadataToMarkdown(rawMarkdown, detail.metadata), detail.result);
    const saved = await writeMeetingMarkdownToObsidianVault({ detail, markdown });

    return NextResponse.json({
      ok: true,
      saved: {
        fileName: saved.fileName,
        relativePath: saved.relativePath,
      },
    });
  } catch (error) {
    if (error instanceof MeetingAccessError || error instanceof ObsidianVaultError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "写入 Obsidian 失败。" }, { status: 500 });
  }
}
