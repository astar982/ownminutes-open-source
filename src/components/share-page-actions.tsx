"use client";

import { ClipboardCopy, Download } from "lucide-react";
import { useState } from "react";

export function SharePageActions({ exportHref, isPublic }: { exportHref: string; isPublic: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function copyLink() {
    setBusy("link");
    setMessage(null);

    try {
      await navigator.clipboard.writeText(window.location.href);
      setMessage("分享链接已复制。");
    } catch {
      setMessage("复制链接失败，可以手动复制浏览器地址。");
    } finally {
      setBusy(null);
    }
  }

  async function copyMarkdown() {
    setBusy("markdown");
    setMessage(null);

    try {
      const response = await fetch(exportHref);
      const markdown = await response.text();

      if (!response.ok) {
        setMessage("当前没有可复制的公开 Markdown。");
        return;
      }

      await navigator.clipboard.writeText(markdown);
      setMessage(isPublic ? "公开 Markdown 已复制。" : "Markdown 已复制。");
    } catch {
      setMessage("复制 Markdown 失败，可以改用下载。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#175743] text-sm font-semibold text-white disabled:opacity-60"
          disabled={busy === "link"}
          type="button"
          onClick={() => void copyLink()}
        >
          <ClipboardCopy className="h-4 w-4" />
          复制链接
        </button>
        <a className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-[#dfe5e1] bg-white text-sm font-semibold text-[#17241e]" href={exportHref}>
          <Download className="h-4 w-4" />
          下载
        </a>
      </div>
      <button
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-[#dfe5e1] bg-[#fbfcfb] text-sm font-semibold text-[#17241e] disabled:opacity-60"
        disabled={busy === "markdown"}
        type="button"
        onClick={() => void copyMarkdown()}
      >
        <ClipboardCopy className="h-4 w-4" />
        {isPublic ? "复制公开 Markdown" : "复制 Markdown"}
      </button>
      {message ? <p className="rounded-lg border border-[#d9ded8] bg-[#f7faf7] px-3 py-2 text-center text-xs font-semibold text-[#1f6f55]">{message}</p> : null}
    </div>
  );
}
