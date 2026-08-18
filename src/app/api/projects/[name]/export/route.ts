import { NextResponse } from "next/server";
import { buildProjectMarkdown, filterMeetingsByProject } from "@/lib/project-summaries";
import { getCurrentUser } from "@/lib/server/current-user";
import { listUserMeetings, readUserMeetingDetail } from "@/lib/server/meeting-audio-store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  const projectName = decodeProjectName(name);
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  try {
    const meetings = await listUserMeetings(user.id);
    const projectMeetings = filterMeetingsByProject(meetings, projectName);

    if (!projectMeetings.length) {
      return NextResponse.json({ ok: false, error: "项目不存在或没有会议。" }, { status: 404 });
    }

    const details = await Promise.all(projectMeetings.map((meeting) => readUserMeetingDetail(meeting.meetingId, user.id)));
    const markdown = buildProjectMarkdown(projectName, details);
    const filename = `${safeFilename(projectName)}-会议索引.md`;

    return new Response(markdown, {
      headers: {
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Type": "text/markdown; charset=utf-8",
      },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ ok: false, error: "项目 Markdown 导出失败。" }, { status: 500 });
  }
}

function decodeProjectName(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "ownminutes-project";
}
