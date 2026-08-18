import { NextResponse } from "next/server";
import { getUserUsage, listProviderCredentials } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import { listUserMeetings, readUserMeetingDetail } from "@/lib/server/meeting-audio-store";
import { getUserProviderHealth } from "@/lib/provider-health";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  const generatedAt = new Date().toISOString();
  const [meetings, providerHealth, usage, providerCredentials] = await Promise.all([
    listUserMeetings(user.id),
    getUserProviderHealth(user.id),
    getUserUsage(user.id),
    listProviderCredentials(user.id),
  ]);
  const exportDate = generatedAt.slice(0, 10);
  const portable = new URL(request.url).searchParams.get("scope") === "portable";

  const payload = {
    ok: true,
    exportVersion: 1,
    generatedAt,
    product: "OwnMinutes",
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      plan: user.plan,
      createdAt: user.createdAt,
      officialMinutesTotal: user.officialMinutesTotal,
      officialMinutesUsed: user.officialMinutesUsed,
      officialMinutesRemaining: usage.officialMinutesRemaining,
      processingMode: user.processingMode,
    },
    usage,
    providerCredentials,
    providerHealth: providerHealth.map((item) => ({
      providerId: item.providerId,
      label: item.label,
      status: item.status,
      canUseFor: item.canUseFor,
      liveChecked: item.liveChecked,
      missing: item.missing,
      nextActions: item.nextActions,
      updatedAt: item.updatedAt,
    })),
    meetings: meetings.map((meeting) => ({
      meetingId: meeting.meetingId,
      title: meeting.title,
      generatedAt: meeting.generatedAt,
      updatedAt: meeting.updatedAt,
      durationMs: meeting.durationMs,
      totalBytes: meeting.totalBytes,
      totalChunks: meeting.totalChunks,
      share: meeting.share,
      hasResult: meeting.hasResult,
      transcriptCount: meeting.transcriptCount,
    })),
    notes: [
      "账号摘要导出不包含原始音频、逐字稿全文、会议 Markdown 全文或任何模型密钥原文。",
      "如需可迁移内容，可使用“导出全部会议内容”；该便携导出包含逐字稿、会议结果和 Markdown，但仍不包含原始音频或任何模型密钥原文。",
      "删除账号会删除会议音频、纪要、Markdown、公开分享、Provider 配置和用量流水。",
    ],
  };

  if (portable) {
    return createPortableMeetingExport({
      exportDate,
      generatedAt,
      meetings,
      payload,
      userId: user.id,
    });
  }

  return new NextResponse(`${JSON.stringify(payload, null, 2)}\n`, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="ownminutes-account-export-${exportDate}.json"`,
      "Cache-Control": "no-store",
    },
  });
}

function createPortableMeetingExport(input: {
  exportDate: string;
  generatedAt: string;
  meetings: Awaited<ReturnType<typeof listUserMeetings>>;
  payload: Record<string, unknown>;
  userId: string;
}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          const account = { ...input.payload };
          const meetingIndex = account.meetings;
          delete account.meetings;
          delete account.notes;
          controller.enqueue(encoder.encode(`${JSON.stringify({
            type: "ownminutes-export",
            exportVersion: 2,
            generatedAt: input.generatedAt,
            product: "OwnMinutes",
            format: "application/x-ndjson",
            includes: ["account", "usage", "masked-provider-config", "meeting-results", "meeting-markdown"],
            excludes: ["passwords", "plaintext-model-keys", "raw-audio"],
            account,
            meetingIndex,
            notes: [
              "会议记录随后按行输出，包含当前可用的正式结果、逐字稿和 Markdown。",
              "便携导出不包含密码、模型密钥原文或原始录音。",
            ],
          })}\n`));

          for (const meeting of input.meetings) {
            const detail = await readUserMeetingDetail(meeting.meetingId, input.userId);
            controller.enqueue(encoder.encode(`${JSON.stringify({
              type: "meeting",
              meetingId: detail.meetingId,
              title: detail.title,
              generatedAt: detail.generatedAt,
              updatedAt: detail.updatedAt,
              durationMs: detail.durationMs,
              metadata: detail.metadata,
              share: detail.share,
              humanReview: detail.humanReview,
              result: detail.result,
              obsidianMarkdown: detail.obsidianMarkdown,
            })}\n`));
          }

          controller.enqueue(encoder.encode(`${JSON.stringify({
            type: "export-complete",
            meetingCount: input.meetings.length,
          })}\n`));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="ownminutes-portable-export-${input.exportDate}.ndjson"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
