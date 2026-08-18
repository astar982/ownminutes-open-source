"use client";

import { ArrowRight, CheckCircle2, KeyRound, LockKeyhole, Mail } from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

type ResetLinkState = {
  message: string | null;
  token: string;
};

function isResetLinkToken(value: string) {
  return /^[A-Za-z0-9_-]{24,128}$/.test(value);
}

export function PasswordResetPanel() {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [resetLink, setResetLink] = useState<ResetLinkState>({ message: null, token: "" });
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [submittingConfirm, setSubmittingConfirm] = useState(false);
  const [resetComplete, setResetComplete] = useState(false);

  const activeToken = token || resetLink.token;
  const canRequest = useMemo(() => email.includes("@"), [email]);
  const canConfirm = useMemo(() => isResetLinkToken(activeToken) && newPassword.length >= 8, [activeToken, newPassword]);
  const showConfirmForm = isResetLinkToken(activeToken);
  const visibleMessage = message || resetLink.message;

  useEffect(() => {
    function captureResetLink() {
      const current = new URL(window.location.href);
      const fragmentParams = new URLSearchParams(current.hash.replace(/^#/, ""));
      const hasToken = current.searchParams.has("token") || fragmentParams.has("token");
      if (!hasToken) return;
      const incomingToken = (fragmentParams.get("token") || current.searchParams.get("token") || "").trim();
      current.searchParams.delete("token");
      fragmentParams.delete("token");
      const remainingFragment = fragmentParams.toString();
      window.history.replaceState(null, "", `${current.pathname}${current.search}${remainingFragment ? `#${remainingFragment}` : ""}`);

      setMessage(null);
      setToken("");
      setDevToken(null);
      setNewPassword("");
      setResetComplete(false);
      setResetLink({
        message: isResetLinkToken(incomingToken) ? "重置链接已载入，请设置新密码。" : "重置链接格式无效，请重新申请。",
        token: isResetLinkToken(incomingToken) ? incomingToken : "",
      });
    }

    queueMicrotask(captureResetLink);
    window.addEventListener("hashchange", captureResetLink);
    window.addEventListener("popstate", captureResetLink);
    return () => {
      window.removeEventListener("hashchange", captureResetLink);
      window.removeEventListener("popstate", captureResetLink);
    };
  }, []);

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRequest) {
      setMessage("请输入有效邮箱。");
      return;
    }

    setSubmittingRequest(true);
    setMessage(null);
    setDevToken(null);
    setResetComplete(false);
    setResetLink({ message: null, token: "" });

    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "密码重置请求失败。");
        return;
      }
      const localResetToken = typeof payload.resetToken === "string" ? payload.resetToken.trim() : "";
      setDevToken(localResetToken || null);
      if (isResetLinkToken(localResetToken)) {
        setToken(localResetToken);
      } else {
        setToken("");
      }
      setMessage(payload.message || "如果该邮箱存在，我们会发送密码重置链接。");
    } catch {
      setMessage("请求失败，请确认本地服务正在运行。");
    } finally {
      setSubmittingRequest(false);
    }
  }

  async function confirmReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canConfirm) {
      setMessage("请输入有效 token 和至少 8 位新密码。");
      return;
    }

    setSubmittingConfirm(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: activeToken, newPassword }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        if (response.status === 400 && String(payload.error || "").includes("重置链接")) {
          setToken("");
          setDevToken(null);
          setResetLink({ message: null, token: "" });
          setResetComplete(false);
        }
        setMessage(payload.error || "密码重置失败。");
        return;
      }
      setMessage("密码已重置，请返回登录。");
      setNewPassword("");
      setToken("");
      setResetLink({ message: null, token: "" });
      setDevToken(null);
      setResetComplete(true);
    } catch {
      setMessage("请求失败，请确认本地服务正在运行。");
    } finally {
      setSubmittingConfirm(false);
    }
  }

  return (
    <main className="min-h-[100dvh] bg-[#f7f5ef] px-4 py-5 text-[#121411]">
      <div className="mx-auto flex min-h-[calc(100dvh-40px)] w-full max-w-[430px] items-center">
        <section className="w-full rounded-lg border border-[#ddd5c7] bg-white p-5 shadow-sm">
          <Link className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f6f55]" href="/login">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[#1f6f55] text-sm font-bold text-white">O</span>
            OwnMinutes
          </Link>

          <div className="mt-7">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#effaf3] text-[#1f6f55]">
              <KeyRound className="h-5 w-5" />
            </span>
            <h1 className="mt-4 text-2xl font-semibold tracking-normal">重置密码</h1>
            <p className="mt-2 text-sm leading-6 text-[#667085]">输入注册邮箱获取重置链接，再设置新密码。生产环境会通过邮件发送链接。</p>
          </div>

          {!showConfirmForm && !resetComplete ? (
            <form className="mt-6 space-y-3" onSubmit={requestReset}>
              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-[#344054]">
                  <Mail className="h-4 w-4 text-[#1f6f55]" />
                  注册邮箱
                </span>
                <input
                  className="auth-input"
                  autoComplete="email"
                  inputMode="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  type="email"
                  value={email}
                />
              </label>
              <button className="primary-action h-11 w-full justify-center" disabled={!canRequest || submittingRequest} type="submit">
                {submittingRequest ? "发送中" : "发送重置链接"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>
          ) : null}

          {showConfirmForm ? (
            <form className="mt-5 space-y-3 border-t border-[#ebe4d8] pt-5" onSubmit={confirmReset}>
              <input aria-hidden="true" autoComplete="username" className="sr-only" name="username" readOnly tabIndex={-1} type="email" value={email} />
              <label className="block">
                <span className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-[#344054]">
                  <LockKeyhole className="h-4 w-4 text-[#1f6f55]" />
                  新密码
                </span>
                <input
                  className="auth-input"
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="至少 8 位"
                  type="password"
                  value={newPassword}
                />
              </label>
              <button className="primary-action h-11 w-full justify-center" disabled={!canConfirm || submittingConfirm} type="submit">
                {submittingConfirm ? "重置中" : "确认重置"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>
          ) : null}

          {visibleMessage ? (
            <div aria-live="polite" className="mt-4 rounded-md border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-sm font-medium text-[#1f6f55]">
              {visibleMessage}
            </div>
          ) : null}

          {devToken ? (
            <div className="mt-3 rounded-md border border-[#ead28b] bg-[#fff9e8] px-3 py-2 text-xs leading-5 text-[#76530a]">
              本地开发 token：<span className="break-all font-mono">{devToken}</span>
            </div>
          ) : null}

          <Link className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[#1f6f55]" href="/login">
            <CheckCircle2 className="h-4 w-4" />
            返回登录
          </Link>
        </section>
      </div>
    </main>
  );
}
