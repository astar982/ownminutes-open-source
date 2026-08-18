"use client";

import { Save, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { MeetingSummary } from "@/lib/meeting-processing";

type MeetingSummaryEditorProps = {
  embedded?: boolean;
  meetingId: string;
  summary: MeetingSummary;
};

export function MeetingSummaryEditor({ embedded = false, meetingId, summary }: MeetingSummaryEditorProps) {
  const router = useRouter();
  const [summaryText, setSummaryText] = useState(summary.summary);
  const [topicsText, setTopicsText] = useState(summary.topics.join("\n"));
  const [risksText, setRisksText] = useState(summary.risks.join("\n"));
  const [openQuestionsText, setOpenQuestionsText] = useState(summary.openQuestions.join("\n"));
  const [knowledgeText, setKnowledgeText] = useState(summary.knowledgePoints.join("\n"));
  const [speakerViewsText, setSpeakerViewsText] = useState(summary.speakerViews.map((item) => `${item.speaker}｜${item.view}`).join("\n"));
  const [decisionsText, setDecisionsText] = useState(summary.decisions.map((item) => `${item.title}｜${item.detail}`).join("\n"));
  const [actionsText, setActionsText] = useState(summary.actionItems.map((item) => `${item.task}｜${item.owner}｜${item.due}｜${item.status === "confirmed" ? "已确认" : "候选"}`).join("\n"));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const previewCounts = useMemo(
    () => ({
      actions: parseActions(actionsText).length,
      decisions: parseDecisions(decisionsText).length,
      knowledge: parseLines(knowledgeText).length,
      risks: parseLines(risksText).length,
      speakerViews: parseSpeakerViews(speakerViewsText).length,
    }),
    [actionsText, decisionsText, knowledgeText, risksText, speakerViewsText],
  );

  async function saveSummary() {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summaryPatch: {
            summary: summaryText,
            topics: parseLines(topicsText),
            speakerViews: parseSpeakerViews(speakerViewsText),
            decisions: parseDecisions(decisionsText),
            actionItems: parseActions(actionsText),
            risks: parseLines(risksText),
            openQuestions: parseLines(openQuestionsText),
            knowledgePoints: parseLines(knowledgeText),
          },
        }),
      });
      const payload = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "会议纪要保存失败。");
      }

      setMessage("会议纪要已保存，分享页和 Obsidian Markdown 会使用修订版。");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "会议纪要保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={embedded ? "" : "rounded-lg border border-[#d9eadf] bg-white p-4 shadow-sm"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#1f6f55]" />
            <h2 className="text-base font-semibold text-[#111827]">人工修订纪要</h2>
          </div>
          <p className="mt-1 text-sm leading-6 text-[#667085]">保存后会同步更新会议详情、分享链接、导出文件和 Obsidian Markdown。</p>
        </div>
        <span className="rounded-full bg-[#effaf3] px-2.5 py-1 text-[11px] font-semibold text-[#1f6f55]">可编辑</span>
      </div>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-[#344054]">摘要</span>
          <textarea
            className="min-h-28 w-full resize-y rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 py-3 text-sm leading-6 outline-none focus:border-[#1f6f55]"
            maxLength={2400}
            value={summaryText}
            onChange={(event) => setSummaryText(event.target.value)}
          />
        </label>

        <EditableListArea label="关键主题" value={topicsText} onChange={setTopicsText} placeholder="每行一个主题" />
        <EditableListArea label="风险与阻塞" value={risksText} onChange={setRisksText} placeholder="每行一个风险或阻塞" />
        <EditableListArea label="未解决问题" value={openQuestionsText} onChange={setOpenQuestionsText} placeholder="每行一个问题" />
        <EditableListArea label="可沉淀知识点" value={knowledgeText} onChange={setKnowledgeText} placeholder="每行一个知识点" />

        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-[#344054]">发言人观点</span>
          <textarea
            className="min-h-24 w-full resize-y rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 py-3 text-sm leading-6 outline-none focus:border-[#1f6f55]"
            value={speakerViewsText}
            onChange={(event) => setSpeakerViewsText(event.target.value)}
            placeholder="每行一条：发言人｜观点"
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-[#344054]">决策记录</span>
          <textarea
            className="min-h-24 w-full resize-y rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 py-3 text-sm leading-6 outline-none focus:border-[#1f6f55]"
            value={decisionsText}
            onChange={(event) => setDecisionsText(event.target.value)}
            placeholder="每行一条：决策标题｜决策说明"
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-[#344054]">待办事项</span>
          <textarea
            className="min-h-24 w-full resize-y rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 py-3 text-sm leading-6 outline-none focus:border-[#1f6f55]"
            value={actionsText}
            onChange={(event) => setActionsText(event.target.value)}
            placeholder="每行一条：事项｜负责人｜截止时间｜已确认/候选"
          />
        </label>

        <div className="rounded-2xl border border-[#e4e8e5] bg-[#f7faf8] p-3 text-xs leading-5 text-[#667085]">
          当前将保存 {previewCounts.speakerViews} 条发言人观点、{previewCounts.decisions} 条决策、{previewCounts.actions} 条待办、{previewCounts.risks} 条风险、{previewCounts.knowledge} 条知识点。
        </div>

        <button className="app-primary-button w-full" disabled={saving} type="button" onClick={() => void saveSummary()}>
          <Save className="h-4 w-4" />
          {saving ? "保存中" : "保存修订版纪要"}
        </button>

        {message ? <p className="rounded-2xl border border-[#d9ded8] bg-[#f7faf7] px-3 py-2 text-sm font-medium text-[#1f6f55]">{message}</p> : null}
      </div>
    </section>
  );
}

function EditableListArea({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-[#344054]">{label}</span>
      <textarea
        className="min-h-20 w-full resize-y rounded-2xl border border-[#d9dfdb] bg-[#fbfcfb] px-3 py-3 text-sm leading-6 outline-none focus:border-[#1f6f55]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function parseLines(value: string) {
  return value
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function parseDecisions(value: string) {
  return value
    .split(/\n+/)
    .map((line, index) => {
      const [title, detail] = splitColumns(line);
      return {
        id: `manual-decision-${index + 1}`,
        title: title || "不确定",
        detail: detail || "不确定",
        status: "confirmed" as const,
      };
    })
    .filter((item) => item.title !== "不确定" || item.detail !== "不确定")
    .slice(0, 20);
}

function parseSpeakerViews(value: string) {
  return value
    .split(/\n+/)
    .map((line) => {
      const [speaker, view] = splitColumns(line);
      return {
        speaker: speaker || "不确定",
        view: view || "不确定",
      };
    })
    .filter((item) => item.speaker !== "不确定" || item.view !== "不确定")
    .slice(0, 20);
}

function parseActions(value: string) {
  return value
    .split(/\n+/)
    .map((line, index) => {
      const [task, owner, due, status] = splitColumns(line);
      return {
        id: `manual-action-${index + 1}`,
        task: task || "不确定",
        owner: owner || "不确定",
        due: due || "不确定",
        status: status === "已确认" || status?.toLowerCase() === "confirmed" ? ("confirmed" as const) : ("candidate" as const),
      };
    })
    .filter((item) => item.task !== "不确定")
    .slice(0, 30);
}

function splitColumns(value: string) {
  return value
    .replace(/^[-*]\s*/, "")
    .split(/[|｜]/)
    .map((item) => item.trim());
}
