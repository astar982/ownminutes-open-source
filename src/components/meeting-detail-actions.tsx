"use client";

import { BookOpenCheck, CheckCircle2, ClipboardCopy, Download, ExternalLink, Eye, EyeOff, Link2, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MeetingResultQuality } from "@/lib/meeting-result-quality";
import type { MeetingFinalizationState } from "@/lib/server/meeting-finalization-state";
import type { MeetingHumanReview } from "@/lib/server/meeting-human-review";

type ShareState = {
  visibility: "private" | "public";
  includeTranscript: boolean;
  expiresAt?: string;
};

export function MeetingDetailActions({
  embedded = false,
  meetingId,
  meetingTitle,
  hasResult,
  markdown,
  processing,
  quality,
  humanReview,
  share,
}: {
  embedded?: boolean;
  meetingId: string;
  meetingTitle: string;
  hasResult: boolean;
  markdown: string | null;
  processing: MeetingFinalizationState | null;
  quality: MeetingResultQuality;
  humanReview: MeetingHumanReview;
  share: ShareState;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const isPublic = isShareActive(share);
  const expiresLabel = getExpiresLabel(share.expiresAt);
  const sharePath = `/share/${meetingId}`;
  const isUnverifiedResult = quality.status !== "verified";
  const processingActive = processing?.status === "queued" || processing?.status === "processing";

  async function updateHumanReview(confirmed: boolean) {
    if (confirmed && !window.confirm("请确认你已核对逐字稿、发言人、会议摘要、决策和待办。确认后才可以发布当前版本。")) return;
    setBusy("review");
    setMessage(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "人工复核状态保存失败。");
        return;
      }
      setMessage(confirmed ? "已确认当前纪要，现在可以发布。" : "已撤销确认，公开分享已同步撤销。");
      router.refresh();
    } catch {
      setMessage("人工复核状态保存请求失败。");
    } finally {
      setBusy(null);
    }
  }

  async function retryFinalization() {
    setBusy("finalize");
    setMessage(null);
    try {
      const operationId = hasResult ? createBrowserReprocessOperationId() : undefined;
      const response = await fetch(`/api/meetings/${meetingId}/finalize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(operationId ? { "Idempotency-Key": operationId } : {}),
        },
        body: JSON.stringify({ title: meetingTitle, force: hasResult, operationId }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "会议纪要处理失败。");
        return;
      }
      setMessage(payload.queued ? "会议纪要已进入后台队列，可稍后刷新查看。" : payload.idempotent ? "已有正式结果，已恢复当前会议状态。" : "会议纪要已生成。");
      router.refresh();
    } catch {
      setMessage("会议纪要处理请求失败，音频仍保留，可稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function updateShare(nextShare: ShareState) {
    if (!confirmShareChange(nextShare, quality)) return;

    setBusy("share");
    setMessage(null);

    try {
      const response = await fetch(`/api/meetings/${meetingId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...nextShare, confirmUnverified: nextShare.visibility === "public" && quality.status !== "verified" }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "分享设置更新失败。");
        return;
      }

      setMessage(nextShare.visibility === "public" ? "分享链接已发布。" : "分享链接已撤销。");
      router.refresh();
    } catch {
      setMessage("分享设置请求失败。");
    } finally {
      setBusy(null);
    }
  }

  async function copyMarkdown() {
    if (!markdown) return;
    setBusy("copy");
    setMessage(null);

    try {
      await navigator.clipboard.writeText(markdown);
      setMessage("Markdown 已复制。");
    } catch {
      setMessage("复制失败，可以改用下载 Markdown。");
    } finally {
      setBusy(null);
    }
  }

  async function copyShareLink() {
    if (!isPublic) return;
    setBusy("share-link");
    setMessage(null);

    try {
      await navigator.clipboard.writeText(`${window.location.origin}${sharePath}`);
      setMessage("分享链接已复制。");
    } catch {
      setMessage("复制失败，可以打开分享页后从浏览器地址栏复制。");
    } finally {
      setBusy(null);
    }
  }

  async function saveToObsidian() {
    if (!markdown) return;
    setBusy("obsidian");
    setMessage(null);

    try {
      const response = await fetch(`/api/meetings/${meetingId}/obsidian`, { method: "POST" });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "写入 Obsidian 失败。");
        return;
      }

      setMessage(`已保存到 Obsidian：${payload.saved?.relativePath || "OwnMinutes"}`);
    } catch {
      setMessage("写入 Obsidian 请求失败。");
    } finally {
      setBusy(null);
    }
  }

  async function deleteMeeting() {
    const confirmed = window.confirm("确定删除这场会议吗？音频分片、纪要、分享链接和 Markdown 都会被删除。");
    if (!confirmed) return;

    setBusy("delete");
    setMessage(null);

    try {
      const response = await fetch(`/api/meetings/${meetingId}`, { method: "DELETE" });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "会议删除失败。");
        return;
      }

      router.push("/meetings");
      router.refresh();
    } catch {
      setMessage("会议删除请求失败。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={embedded ? "" : "rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm"}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#111827]">分享与知识库</h2>
          <p className="mt-1 text-sm leading-6 text-[#667085]">发布给外部查看，或导出 Markdown 沉淀到 Obsidian。</p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${isPublic ? "bg-[#effaf3] text-[#1f6f55]" : "bg-[#f2f5f1] text-[#667085]"}`}>
          {isPublic ? "已公开" : "私密"}
        </span>
      </div>

      <div className="grid gap-2">
        {!hasResult || processing?.status === "failed" ? (
          <button className="app-primary-button w-full" disabled={busy === "finalize" || processingActive} type="button" onClick={() => void retryFinalization()}>
            <RotateCcw className="h-4 w-4" />
            {processingActive ? "纪要处理中" : processing?.status === "failed" ? "重试生成纪要" : "生成会议纪要"}
          </button>
        ) : null}
        {isUnverifiedResult ? (
          <div className="rounded-2xl border border-[#ead28b] bg-[#fff9e8] p-3">
            <p className="text-sm font-semibold text-[#76530a]">结果质量：{quality.publishLabel}</p>
            <p className="mt-1 text-xs leading-5 text-[#7a5a18]">{quality.shareWarningDetail} 发布前请人工复核。</p>
          </div>
        ) : null}

        {hasResult ? (
          <div className={`rounded-2xl border p-3 ${humanReview.status === "confirmed" ? "border-[#b9d8c9] bg-[#effaf3]" : "border-[#d8dde4] bg-[#f7f8f9]"}`} data-meeting-human-review={humanReview.status}>
            <div className="flex items-start gap-3">
              {humanReview.status === "confirmed" ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#1f6f55]" /> : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#667085]" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[#111827]">{humanReview.status === "confirmed" ? "已人工确认" : humanReview.needsReconfirmation ? "内容已变化，请重新确认" : "待人工确认"}</p>
                <p className="mt-1 text-xs leading-5 text-[#667085]">
                  {humanReview.status === "confirmed" ? "当前版本已核对。重新生成或修改内容后，需再次确认。" : "请核对逐字稿、发言人、摘要、决策和待办，确认后才能发布。"}
                </p>
              </div>
            </div>
            <button
              className="app-secondary-button mt-3 w-full"
              disabled={busy === "review"}
              type="button"
              onClick={() => void updateHumanReview(humanReview.status !== "confirmed")}
            >
              <ShieldCheck className="h-4 w-4" />
              {busy === "review" ? "保存中" : humanReview.status === "confirmed" ? "撤销确认" : "确认已完成复核"}
            </button>
          </div>
        ) : null}

        <button
          className="app-primary-button w-full"
          disabled={busy === "share" || (!isPublic && humanReview.status !== "confirmed")}
          type="button"
          onClick={() =>
            void updateShare({
              visibility: isPublic ? "private" : "public",
              includeTranscript: isPublic ? false : share.includeTranscript,
              expiresAt: isPublic ? undefined : getFutureIsoDate(7),
            })
          }
        >
          {isPublic ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          {isPublic ? "撤销分享" : "发布分享"}
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            className="app-secondary-button w-full"
            disabled={busy === "share" || !isPublic}
            type="button"
            onClick={() => void updateShare({ visibility: "public", includeTranscript: !share.includeTranscript, expiresAt: share.expiresAt })}
          >
            {share.includeTranscript ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {share.includeTranscript ? "隐藏逐字稿" : "公开逐字稿"}
          </button>

          <button className="app-secondary-button w-full" disabled={!isPublic || busy === "share-link"} type="button" onClick={() => void copyShareLink()}>
            <Link2 className="h-4 w-4" />
            复制分享链接
          </button>
        </div>

        <div className="rounded-2xl border border-[#e4e8e5] bg-[#f7faf8] p-3">
          <p className="text-xs font-semibold text-[#667085]">分享有效期</p>
          <p className="mt-1 text-sm font-semibold text-[#111827]">{expiresLabel}</p>
          <div className="mt-3">
            <button
              className="min-h-11 w-full rounded-full bg-white px-3 py-2 text-xs font-semibold text-[#344054] disabled:opacity-50"
              disabled={busy === "share" || !isPublic}
              type="button"
              onClick={() => void updateShare({ visibility: "public", includeTranscript: share.includeTranscript, expiresAt: getFutureIsoDate(7) })}
            >
              从现在起续期 7 天
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Link className={`app-secondary-button w-full ${isPublic ? "" : "pointer-events-none opacity-50"}`} href={sharePath}>
            <ExternalLink className="h-4 w-4" />
            分享页
          </Link>

          <a className={`app-secondary-button w-full ${markdown ? "" : "pointer-events-none opacity-50"}`} href={`/api/meetings/${meetingId}/export`}>
            <Download className="h-4 w-4" />
            下载 Markdown
          </a>
        </div>

        <button className="app-secondary-button w-full" disabled={!markdown || busy === "copy"} type="button" onClick={() => void copyMarkdown()}>
          <ClipboardCopy className="h-4 w-4" />
          复制 Obsidian Markdown
        </button>

        <button className="app-secondary-button w-full" disabled={!markdown || busy === "obsidian"} type="button" onClick={() => void saveToObsidian()}>
          <BookOpenCheck className="h-4 w-4" />
          保存到 Obsidian
        </button>

        <div className="mt-2 border-t border-[#eef1ee] pt-3">
          <button className="app-danger-button w-full" disabled={busy === "delete"} type="button" onClick={() => void deleteMeeting()}>
            <Trash2 className="h-4 w-4" />
            删除会议
          </button>
        </div>
      </div>

      {message ? <p className="mt-3 rounded-2xl border border-[#d9ded8] bg-[#f7faf7] px-3 py-2 text-sm font-medium text-[#1f6f55]">{message}</p> : null}
    </section>
  );
}

function createBrowserReprocessOperationId() {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `reprocess-${suffix}`;
}

function confirmShareChange(nextShare: ShareState, quality: MeetingResultQuality) {
  if (nextShare.visibility !== "public") return true;

  const qualityWarning =
    quality.status !== "verified"
      ? `\n\n质量提示：当前结果是${quality.publishLabel}，${quality.shareWarningDetail} 发布后拥有链接的人会看到质量提示，但仍可能把内容当作会议事实传播。请确认你已经人工复核。`
      : "";

  if (nextShare.includeTranscript) {
    return window.confirm(`确认公开分享并包含逐字稿？拥有链接的人可以查看摘要、发言人观点、决策、待办和逐字稿。${qualityWarning}`);
  }

  return window.confirm(`确认发布分享链接？拥有链接的人可以查看摘要、发言人观点、决策和待办，逐字稿默认隐藏。${qualityWarning}`);
}

function isShareActive(share: ShareState) {
  if (share.visibility !== "public") return false;
  if (!share.expiresAt) return false;

  const expiresAt = new Date(share.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;

  return expiresAt.getTime() > Date.now();
}

function getFutureIsoDate(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getExpiresLabel(value?: string) {
  if (!value) return "需要重新发布";

  const expiresAt = new Date(value);
  if (Number.isNaN(expiresAt.getTime())) return "有效期异常";
  if (expiresAt.getTime() <= Date.now()) return "已过期";

  return `${expiresAt.toLocaleDateString("zh-CN")} 过期`;
}
