"use client";

import { FileText, FolderKanban, Hash, Save, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type MeetingMetadataEditorProps = {
  embedded?: boolean;
  meetingId: string;
  title: string;
  metadata: {
    participants: string[];
    project?: string;
    tags: string[];
  };
};

const suggestedTags = ["决策", "待办", "复盘", "产品", "客户", "成本"];

export function MeetingMetadataEditor({ embedded = false, meetingId, metadata, title: initialTitle }: MeetingMetadataEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [project, setProject] = useState(metadata.project || "");
  const [participantsInput, setParticipantsInput] = useState(metadata.participants.join("\n"));
  const [tagInput, setTagInput] = useState(metadata.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function saveMetadata() {
    if (!title.trim()) {
      setMessage("会议标题不能为空。");
      return;
    }
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          project,
          participants: parseParticipants(participantsInput),
          tags: parseTags(tagInput),
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "会议信息保存失败。");
        return;
      }

      setMessage("会议信息已保存。");
      router.refresh();
    } catch {
      setMessage("会议信息保存请求失败。");
    } finally {
      setSaving(false);
    }
  }

  function addSuggestedTag(tag: string) {
    const tags = parseTags(tagInput);
    if (tags.some((item) => item.toLowerCase() === tag.toLowerCase())) return;
    setTagInput([...tags, tag].join(", "));
  }

  const normalizedTags = parseTags(tagInput);
  const projectLabel = project.trim() || "未归档";

  return (
    <section className={embedded ? "" : "rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm"}>
      <div>
        <h2 className="text-base font-semibold text-[#111827]">会议信息与归档</h2>
        <p className="mt-1 text-sm leading-6 text-[#667085]">标题、参会人、项目和标签会同步到会议历史、分享与 Obsidian Markdown。</p>
      </div>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#344054]">
            <FileText className="h-4 w-4 text-[#1f6f55]" />
            会议标题
          </span>
          <input className="h-11 w-full rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 text-sm outline-none focus:border-[#1f6f55]" maxLength={80} onChange={(event) => setTitle(event.target.value)} value={title} />
        </label>

        <label className="block">
          <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#344054]">
            <FolderKanban className="h-4 w-4 text-[#1f6f55]" />
            项目
          </span>
          <input
            className="h-11 w-full rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 text-sm outline-none focus:border-[#1f6f55]"
            maxLength={60}
            onChange={(event) => setProject(event.target.value)}
            placeholder="例如：OwnMinutes MVP"
            value={project}
          />
        </label>

        <label className="block">
          <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#344054]">
            <Users className="h-4 w-4 text-[#1f6f55]" />
            参会人
          </span>
          <textarea
            className="min-h-24 w-full resize-y rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 py-2 text-sm leading-6 outline-none focus:border-[#1f6f55]"
            onChange={(event) => setParticipantsInput(event.target.value)}
            placeholder={"每行一位，例如：\n王鹏远\n产品同事"}
            value={participantsInput}
          />
          <span className="mt-2 block text-xs leading-5 text-[#667085]">每行一位，最多保存 30 位参会人。</span>
        </label>

        <label className="block">
          <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#344054]">
            <Hash className="h-4 w-4 text-[#1f6f55]" />
            标签
          </span>
          <input
            className="h-11 w-full rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 text-sm outline-none focus:border-[#1f6f55]"
            onChange={(event) => setTagInput(event.target.value)}
            placeholder="产品, 设计, 待复盘"
            value={tagInput}
          />
          <span className="mt-2 block text-xs leading-5 text-[#667085]">用逗号或空格分隔，最多保存 8 个标签。</span>
        </label>

        <div>
          <p className="text-xs font-semibold text-[#667085]">常用标签</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {suggestedTags.map((tag) => {
              const active = normalizedTags.some((item) => item.toLowerCase() === tag.toLowerCase());
              return (
                <button
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                    active ? "border-[#b9d8c9] bg-[#effaf3] text-[#1f6f55]" : "border-[#e4e8e5] bg-[#fbfcfb] text-[#475467]"
                  }`}
                  disabled={active || normalizedTags.length >= 8}
                  key={tag}
                  onClick={() => addSuggestedTag(tag)}
                  type="button"
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-[#e4e8e5] bg-[#f7faf8] p-3">
          <p className="text-xs font-semibold text-[#667085]">保存后会这样沉淀</p>
          <p className="mt-2 text-sm font-semibold text-[#111827]">{projectLabel}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {normalizedTags.length ? (
              normalizedTags.map((tag) => (
                <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-[#1f6f55]" key={tag}>
                  #{tag}
                </span>
              ))
            ) : (
              <span className="text-xs text-[#98a2b3]">暂无标签</span>
            )}
          </div>
        </div>

        <button className="app-primary-button w-full" disabled={saving || !title.trim()} onClick={() => void saveMetadata()} type="button">
          <Save className="h-4 w-4" />
          {saving ? "保存中" : "保存会议信息"}
        </button>

        {message ? <p className="rounded-2xl border border-[#d9ded8] bg-[#f7faf7] px-3 py-2 text-sm font-medium text-[#1f6f55]">{message}</p> : null}
      </div>
    </section>
  );
}

function parseParticipants(value: string) {
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const item of value.split(/[\n,，、]+/)) {
    const participant = item.replace(/\s+/g, " ").trim().slice(0, 48);
    const key = participant.toLowerCase();
    if (!participant || seen.has(key)) continue;
    seen.add(key);
    participants.push(participant);
    if (participants.length >= 30) break;
  }
  return participants;
}

function parseTags(value: string) {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const item of value.split(/[\s,，、]+/)) {
    const tag = item.trim().replace(/^#/, "");
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }

  return tags;
}
