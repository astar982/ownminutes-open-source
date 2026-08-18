import { NextResponse } from "next/server";
import { applyMeetingMetadataToMarkdown } from "@/lib/meeting-markdown";
import { applyMeetingResultQualityNotice } from "@/lib/meeting-result-quality";
import { getCurrentUser } from "@/lib/server/current-user";
import { MeetingAccessError, readUserMeetingDetail } from "@/lib/server/meeting-audio-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  try {
    const detail = await readUserMeetingDetail(id, user.id);
    const rawMarkdown = detail.obsidianMarkdown || detail.result?.obsidianMarkdown;

    if (!rawMarkdown) {
      return NextResponse.json({ ok: false, error: "当前会议还没有可导出的 Markdown。" }, { status: 404 });
    }

    const markdown = applyMeetingResultQualityNotice(applyMeetingMetadataToMarkdown(rawMarkdown, detail.metadata), detail.result);
    const filename = `${safeFilename(detail.title || id)}.md`;

    return new Response(markdown, {
      headers: {
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Type": "text/markdown; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof MeetingAccessError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "Markdown 导出失败。" }, { status: 500 });
  }
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "ownminutes-meeting";
}
