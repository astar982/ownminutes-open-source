"use client";

import { CheckCircle2, TriangleAlert, UserRoundPen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export function MeetingSpeakerEditor({ embedded = false, meetingId, speakers }: { embedded?: boolean; meetingId: string; speakers: string[] }) {
  const router = useRouter();
  const uniqueSpeakers = useMemo(() => Array.from(new Set(speakers.map((speaker) => speaker.trim()).filter((speaker) => speaker && speaker !== "System"))), [speakers]);
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(uniqueSpeakers.map((speaker) => [speaker, speaker])));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (uniqueSpeakers.length === 0) return null;

  async function saveSpeakerNames() {
    setSaving(true);
    setMessage(null);

    try {
      const speakerNames = Object.fromEntries(
        uniqueSpeakers
          .map((speaker) => [speaker, (names[speaker] || "").replace(/\s+/g, " ").trim()] as const)
          .filter(([speaker, name]) => name && speaker !== name),
      );

      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ speakerNames }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "发言人名称保存失败。");
      }

      setMessage(Object.keys(speakerNames).length > 0 ? "发言人名称已更新。" : "没有需要更新的发言人名称。");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "发言人名称保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={embedded ? "" : "rounded-lg border border-[#d9eadf] bg-white p-4 shadow-sm"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <UserRoundPen className="h-4 w-4 text-[#1f6f55]" />
            <h2 className="text-base font-semibold text-[#111827]">发言人校正</h2>
          </div>
          <p className="mt-1 text-sm leading-6 text-[#667085]">保存后会同步更新逐字稿、纪要、分享页和 Obsidian Markdown。</p>
        </div>
        <span className="rounded-full bg-[#effaf3] px-2.5 py-1 text-[11px] font-semibold text-[#1f6f55]">{uniqueSpeakers.length} 人</span>
      </div>

      <div className="mt-3 flex gap-2 rounded-2xl border border-[#ead9ba] bg-[#fff8e8] px-3 py-2.5 text-xs leading-5 text-[#6f4d13]">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p>单设备混合录音无法承诺 100% 自动区分说话人；发布分享或沉淀到知识库前，请人工确认发言人标签和待办负责人。</p>
      </div>

      <div className="mt-4 space-y-3">
        {uniqueSpeakers.map((speaker) => (
          <label key={speaker} className="block rounded-2xl bg-[#f7faf8] p-3">
            <span className="text-xs font-semibold text-[#667085]">{speaker}</span>
            <input
              className="mt-2 h-11 w-full rounded-xl border border-[#dbe4de] bg-white px-3 text-sm font-medium text-[#111827] outline-none focus:border-[#1f6f55] focus:ring-2 focus:ring-[#1f6f55]/12"
              maxLength={48}
              type="text"
              value={names[speaker] ?? speaker}
              onChange={(event) =>
                setNames((current) => ({
                  ...current,
                  [speaker]: event.target.value,
                }))
              }
            />
          </label>
        ))}
      </div>

      <button className="app-primary-button mt-4 w-full" disabled={saving} type="button" onClick={() => void saveSpeakerNames()}>
        <CheckCircle2 className="h-4 w-4" />
        {saving ? "保存中" : "保存发言人名称"}
      </button>
      {message ? <p className="mt-3 text-center text-sm font-medium text-[#1f6f55]">{message}</p> : null}
    </section>
  );
}
