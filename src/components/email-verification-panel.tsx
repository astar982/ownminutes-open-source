"use client";

import { ArrowRight, CheckCircle2, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";

type VerificationLinkState = {
  message: string | null;
  token: string;
};

function isVerificationLinkToken(value: string) {
  return /^[A-Za-z0-9_-]{24,128}$/.test(value);
}

export function EmailVerificationPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(searchParams.get("email") || "");
  const [token, setToken] = useState("");
  const [verificationLink, setVerificationLink] = useState<VerificationLinkState>({ message: null, token: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const activeToken = token || verificationLink.token;
  const canConfirm = useMemo(() => isVerificationLinkToken(activeToken), [activeToken]);
  const visibleMessage = message || verificationLink.message || "请打开验证邮件中的链接。";

  useEffect(() => {
    function captureVerificationLink() {
      const next = new URL(window.location.href);
      const fragmentParams = new URLSearchParams(next.hash.replace(/^#/, ""));
      const hasToken = next.searchParams.has("token") || fragmentParams.has("token");
      if (!hasToken) return;
      const incomingToken = (fragmentParams.get("token") || next.searchParams.get("token") || "").trim();
      next.searchParams.delete("token");
      fragmentParams.delete("token");
      const remainingFragment = fragmentParams.toString();
      window.history.replaceState(null, "", `${next.pathname}${next.search}${remainingFragment ? `#${remainingFragment}` : ""}`);

      setMessage(null);
      setToken("");
      setVerificationLink({
        message: isVerificationLinkToken(incomingToken) ? "验证链接已载入，请完成验证。" : "验证链接格式无效，请重新发送。",
        token: isVerificationLinkToken(incomingToken) ? incomingToken : "",
      });
    }

    queueMicrotask(captureVerificationLink);
    window.addEventListener("hashchange", captureVerificationLink);
    window.addEventListener("popstate", captureVerificationLink);
    return () => {
      window.removeEventListener("hashchange", captureVerificationLink);
      window.removeEventListener("popstate", captureVerificationLink);
    };
  }, []);

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/email-verification/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: activeToken }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        if (response.status === 400) {
          setToken("");
          setVerificationLink({ message: null, token: "" });
        }
        setMessage(payload.error || "邮箱验证失败，请重新发送。");
        return;
      }
      setMessage("邮箱验证成功，正在进入工作台。");
      router.replace("/app");
      router.refresh();
    } catch {
      setMessage("网络请求失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    if (!email.includes("@")) {
      setMessage("请输入注册邮箱。");
      return;
    }
    setResending(true);
    try {
      const response = await fetch("/api/auth/email-verification/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "验证邮件发送失败。");
        return;
      }
      if (isVerificationLinkToken(payload.verificationToken || "")) setToken(payload.verificationToken);
      setMessage(payload.verificationToken ? "本地验证凭据已自动带入。" : payload.message);
    } catch {
      setMessage("网络请求失败，请稍后重试。");
    } finally {
      setResending(false);
    }
  }

  return (
    <main className="min-h-[100dvh] bg-[#eef1f4] px-4 py-5 text-[#121411]">
      <div className="mx-auto flex min-h-[calc(100dvh-40px)] w-full max-w-[430px] items-center">
        <section className="w-full rounded-lg border border-[#d7dbd2] bg-white p-5 shadow-sm">
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f6f55]" href="/login">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[#1f6f55] text-sm font-bold text-white">O</span>
            OwnMinutes
          </Link>
          <span className="mt-7 flex h-11 w-11 items-center justify-center rounded-lg bg-[#effaf3] text-[#1f6f55]">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <h1 className="mt-4 text-2xl font-semibold tracking-normal">验证邮箱</h1>
          <p className="mt-2 text-sm leading-6 text-[#667085]">完成邮箱验证后，账号才会签发登录会话。</p>

          <label className="mt-6 block">
            <span className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-[#344054]"><Mail className="h-4 w-4" />注册邮箱</span>
            <input className="auth-input" inputMode="email" onChange={(event) => setEmail(event.target.value)} type="email" value={email} />
          </label>
          <button className="secondary-action mt-3 !h-11 w-full justify-center" disabled={resending} onClick={resend} type="button">
            <RefreshCw className="h-4 w-4" />
            {resending ? "发送中" : "重新发送验证邮件"}
          </button>

          <form className="mt-5 space-y-3 border-t border-[#ebe4d8] pt-5" onSubmit={confirm}>
            <button className="primary-action !h-11 w-full justify-center" disabled={!canConfirm || submitting} type="submit">
              {submitting ? "验证中" : "完成验证"} <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="mt-4 flex items-start gap-2 rounded-md bg-[#f7f8f6] px-3 py-2 text-xs leading-5 text-[#667085]">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#1f6f55]" />
            <p>{visibleMessage}</p>
          </div>
        </section>
      </div>
    </main>
  );
}
