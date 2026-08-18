"use client";

import { CheckCircle2, UserRoundCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { TranscriptSegment } from "@/lib/meeting";

const pageSize = 30;

export function MeetingTranscriptSpeakerEditor({
  meetingId,
  speakers,
  transcript,
}: {
  meetingId: string;
  speakers: string[];
  transcript: TranscriptSegment[];
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => buildDrafts(transcript));
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const uniqueSpeakers = useMemo(
    () => Array.from(new Set(speakers.map(normalizeSpeaker).filter((speaker) => speaker && speaker !== "System"))),
    [speakers],
  );
  const assignments = useMemo(
    () => transcript.reduce<Record<string, string>>((output, segment) => {
      const speaker = normalizeSpeaker(drafts[segment.id] ?? segment.speaker);
      if (speaker && speaker !== segment.speaker) output[segment.id] = speaker;
      return output;
    }, {}),
    [drafts, transcript],
  );

  async function saveAssignments() {
    const invalidSegment = transcript.find((segment) => !normalizeSpeaker(drafts[segment.id] ?? segment.speaker));
    if (invalidSegment) {
      setMessageTone("error");
      setMessage(`${invalidSegment.timestamp} 的发言人姓名不能为空。`);
      return;
    }
    if (Object.keys(assignments).length === 0) {
      setMessageTone("success");
      setMessage("没有需要保存的发言段归属变更。");
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcriptSpeakerAssignments: assignments }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: { transcript?: TranscriptSegment[] };
      };
      if (!response.ok || !payload.ok || !payload.result?.transcript) {
        throw new Error(payload.error || "发言段归属保存失败。");
      }

      setDrafts(buildDrafts(payload.result.transcript));
      setMessageTone("success");
      setMessage(`已校正 ${Object.keys(assignments).length} 条发言归属；逐字稿、分享与 Markdown 已同步。请继续复核纪要归因和待办负责人。`);
      router.refresh();
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "发言段归属保存失败。");
    } finally {
      setSaving(false);
    }
  }

  if (transcript.length === 0) return <p className="text-sm text-[#667085]">暂无逐字稿。</p>;

  return (
    <div>
      <div className="flex items-start gap-2 rounded-lg border border-[#ead9ba] bg-[#fff8e8] px-3 py-2.5 text-xs leading-5 text-[#6f4d13]">
        <UserRoundCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <p>发现某一段被分给了错误的人时，可在该段单独改正。这里不会自动改写会议纪要的观点归因或待办负责人，请在“编辑会议纪要”中继续复核。</p>
      </div>

      <div className="mt-3 space-y-3">
        {transcript.slice(0, visibleCount).map((segment) => {
          const draftSpeaker = drafts[segment.id] ?? segment.speaker;
          return (
            <article className="rounded-lg border border-[#e4e9e6] bg-[#f7faf8] p-3" key={segment.id}>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-mono font-semibold text-[#1f6f55]">{segment.timestamp}</span>
                <span className="font-semibold text-[#667085]">{segment.speaker}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-[#344054]">{segment.text}</p>
              {uniqueSpeakers.length > 1 ? (
                <div className="mt-3 flex flex-wrap gap-2" aria-label={`${segment.timestamp} 发言人快捷选择`}>
                  {uniqueSpeakers.slice(0, 6).map((speaker) => {
                    const selected = normalizeSpeaker(draftSpeaker) === speaker;
                    return (
                      <button
                        aria-pressed={selected}
                        className={`min-h-11 rounded-full border px-3 text-xs font-semibold ${selected ? "border-[#8db8a7] bg-[#eaf2ed] text-[#1f6f55]" : "border-[#dce5df] bg-white text-[#667085]"}`}
                        key={`${segment.id}-${speaker}`}
                        onClick={() => setDrafts((current) => ({ ...current, [segment.id]: speaker }))}
                        type="button"
                      >
                        {speaker}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <label className="mt-3 block">
                <span className="text-xs font-semibold text-[#667085]">发言人姓名</span>
                <input
                  autoComplete="off"
                  className="mt-1.5 h-11 w-full rounded-lg border border-[#dbe4de] bg-white px-3 text-sm font-medium text-[#111827] outline-none focus:border-[#1f6f55] focus:ring-2 focus:ring-[#1f6f55]/15"
                  maxLength={48}
                  onChange={(event) => setDrafts((current) => ({ ...current, [segment.id]: event.target.value }))}
                  spellCheck={false}
                  type="text"
                  value={draftSpeaker}
                />
              </label>
            </article>
          );
        })}
      </div>

      {visibleCount < transcript.length ? (
        <button className="app-secondary-button mt-3 w-full" onClick={() => setVisibleCount((count) => count + pageSize)} type="button">
          再显示 {Math.min(pageSize, transcript.length - visibleCount)} 条
        </button>
      ) : null}

      {message ? (
        <p className={`mt-3 text-sm ${messageTone === "error" ? "text-[#b42318]" : "text-[#1f6f55]"}`} role="status">
          {message}
        </p>
      ) : null}

      <button
        className="app-primary-button mt-4 w-full"
        disabled={saving || Object.keys(assignments).length === 0}
        onClick={() => void saveAssignments()}
        type="button"
      >
        <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
        {saving ? "保存中" : Object.keys(assignments).length > 0 ? `保存 ${Object.keys(assignments).length} 条校正` : "没有待保存校正"}
      </button>
    </div>
  );
}

function buildDrafts(transcript: TranscriptSegment[]) {
  return Object.fromEntries(transcript.map((segment) => [segment.id, segment.speaker]));
}

function normalizeSpeaker(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 48);
}
