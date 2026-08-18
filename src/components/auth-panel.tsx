"use client";

import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Mail,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type AuthMode = "login" | "register";

type AuthPanelProps = {
  attribution?: {
    shareId?: string;
    source?: string;
  };
  mode: AuthMode;
};

export function AuthPanel({ attribution, mode }: AuthPanelProps) {
  const isRegister = mode === "register";
  const router = useRouter();
  const source = attribution?.source === "share" ? "share" : "";
  const shareId = source === "share" ? attribution?.shareId || "" : "";
  const fromSharedMeeting = isRegister && source === "share" && Boolean(shareId);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);

    const formData = new FormData(event.currentTarget);
    const submittedName = String(formData.get("name") ?? name).trim();
    const submittedEmail = String(formData.get("email") ?? email).trim();
    const submittedPassword = String(formData.get("password") ?? password);
    const submittedAgree = formData.get("agree") === "on" || agree;
    const submittedRemember = !isRegister && (formData.get("remember") === "on" || remember);
    const formReady =
      submittedEmail.includes("@") &&
      submittedPassword.length >= 8 &&
      (!isRegister || (submittedName.length >= 2 && submittedAgree));

    setName(submittedName);
    setEmail(submittedEmail);
    setPassword(submittedPassword);
    setAgree(submittedAgree);
    setRemember(submittedRemember);

    if (!formReady) {
      setMessage(isRegister ? "请补全注册信息后继续。" : "请输入有效邮箱和至少 8 位密码。");
      return;
    }

    setSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch(isRegister ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: submittedName,
          email: submittedEmail,
          password: submittedPassword,
          remember: submittedRemember,
          source,
          shareId,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        if (payload.code === "email_verification_required") {
          router.push(`/verify-email?email=${encodeURIComponent(submittedEmail)}`);
          return;
        }
        setMessage(payload.error || "账号请求失败，请稍后重试。");
        return;
      }

      if (payload.verificationRequired) {
        const params = new URLSearchParams({ email: submittedEmail });
        if (payload.verificationToken) params.set("token", payload.verificationToken);
        router.push(`/verify-email?${params.toString()}`);
        return;
      }

      setMessage(isRegister ? "账号已创建，正在进入工作台。" : "登录成功，正在进入工作台。");
      router.push("/app");
      router.refresh();
    } catch {
      setMessage("网络请求失败，请确认本地服务正在运行。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-[100dvh] bg-[#eef1f4] text-[#121411]">
      <div className="mx-auto grid min-h-[100dvh] w-full max-w-[1160px] gap-5 px-0 py-0 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(390px,0.62fr)] lg:items-center lg:gap-8 lg:px-8">
        <section className="order-2 hidden min-h-[720px] flex-col justify-between rounded-[28px] border border-[#d7dbd2] bg-[#fbfaf6] p-8 shadow-[0_24px_70px_rgba(23,31,27,0.10)] lg:flex">
          <BrandStory />
        </section>

        <section className="order-1 flex items-center justify-center lg:order-2">
          <div className="auth-device-shell flex min-h-[100dvh] w-full max-w-[430px] flex-col overflow-hidden rounded-none bg-[#f7f6f2] shadow-none sm:min-h-[780px] sm:rounded-[28px] sm:shadow-[0_28px_90px_rgba(23,31,27,0.18)]">
            <div className="auth-device-header flex items-center justify-between gap-3 px-5 pb-3 pt-5 sm:pb-4">
              <Link className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f6f55]" href="/app">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1f6f55] text-sm font-bold text-white">O</span>
                OwnMinutes
              </Link>
              <Link className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-[#1f6f55] shadow-sm" href={isRegister ? "/login" : "/register"}>
                {isRegister ? "登录" : "注册"}
              </Link>
            </div>

            <div className="auth-device-body flex flex-1 items-center px-5 pb-5">
              <div className="w-full rounded-[24px] bg-white p-4 shadow-[0_16px_42px_rgba(23,31,27,0.08)] sm:p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase text-[#1f6f55]">{isRegister ? "免费账号" : "账号登录"}</p>
                    <h1 className="mt-1 text-xl font-semibold tracking-normal text-[#121411] sm:text-2xl">{isRegister ? "创建 OwnMinutes 账号" : "欢迎回来"}</h1>
                    <p className="mt-1 text-xs leading-5 text-[#667085]">
                      {isRegister ? "创建账号，开始记录自己的会议。" : "登录后继续处理你的会议记录。"}
                    </p>
                  </div>
                </div>

                <form action={isRegister ? "/api/auth/register" : "/api/auth/login"} className="mt-3 space-y-2.5 sm:mt-4 sm:space-y-3" method="post" onSubmit={handleSubmit}>
                  {source ? <input name="source" type="hidden" value={source} /> : null}
                  {shareId ? <input name="shareId" type="hidden" value={shareId} /> : null}
                  {fromSharedMeeting ? (
                    <div className="rounded-2xl border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-xs leading-5 text-[#1f6f55]">
                      你是从公开会议纪要进入的。注册后可以创建自己的会议记录工作台。
                    </div>
                  ) : null}

                  {isRegister ? (
                    <Field label="姓名或团队名" icon={<UserRound className="h-4 w-4" />}>
                      <input
                        className="auth-input"
                        autoComplete="name"
                        name="name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="例如 Wang 或 OwnMinutes Team"
                      />
                    </Field>
                  ) : null}

                  <Field label="邮箱" icon={<Mail className="h-4 w-4" />}>
                    <input
                      className="auth-input"
                      autoComplete="email"
                      inputMode="email"
                      name="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      type="email"
                    />
                  </Field>

                  <Field label="密码" icon={<LockKeyhole className="h-4 w-4" />}>
                    <div className="relative">
                      <input
                        className="auth-input pr-12"
                        autoComplete={isRegister ? "new-password" : "current-password"}
                        name="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="至少 8 位"
                        type={showPassword ? "text" : "password"}
                      />
                      <button
                        className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[#667085] hover:bg-[#f2f5f1]"
                        type="button"
                        onClick={() => setShowPassword((value) => !value)}
                        title={showPassword ? "隐藏密码" : "显示密码"}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </Field>

                  <div className="flex flex-col gap-2 text-xs leading-5 text-[#44515f]">
                    {isRegister ? (
                      <label className="inline-flex items-start gap-2">
                        <input className="mt-1 accent-[#1f6f55]" checked={agree} name="agree" onChange={(event) => setAgree(event.target.checked)} type="checkbox" />
                        <span>
                          我已阅读并同意
                          <Link className="font-semibold text-[#1f6f55] hover:text-[#185941]" href="/terms">服务条款</Link>
                          和
                          <Link className="font-semibold text-[#1f6f55] hover:text-[#185941]" href="/privacy">隐私政策</Link>
                          。
                        </span>
                      </label>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <label className="inline-flex items-center gap-2">
                          <input className="accent-[#1f6f55]" checked={remember} name="remember" onChange={(event) => setRemember(event.target.checked)} type="checkbox" />
                          保持登录
                        </label>
                        <Link className="font-semibold text-[#1f6f55] hover:text-[#185941]" href="/reset-password">
                          忘记密码
                        </Link>
                      </div>
                    )}
                  </div>

                  {submitted && message ? (
                    <div className="rounded-2xl border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-sm font-medium text-[#1f6f55]">
                      {message}
                    </div>
                  ) : null}

                  <button className="app-primary-button h-12 w-full" disabled={submitting} type="submit">
                    {submitting ? "处理中" : isRegister ? "创建账号" : "登录"}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </form>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
                  <Link className="font-semibold text-[#1f6f55] hover:text-[#185941]" href={isRegister ? "/login" : "/register"}>
                    {isRegister ? "已有账号？登录" : "还没有账号？免费注册"}
                  </Link>
                  <Link className="text-[#667085] hover:text-[#121411]" href="/pricing">查看方案</Link>
                </div>

                <div className="mt-3 flex items-start gap-2 border-t border-[#e6e9e5] pt-3 text-xs leading-5 text-[#667085] sm:mt-4">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#b7791f]" />
                  <p>BYOK 免费使用，模型费用由你自己控制。</p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function BrandStory() {
  return (
    <>
      <div>
        <Link className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f6f55]" href="/app">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[#1f6f55] text-sm font-bold text-white">O</span>
          OwnMinutes
        </Link>

        <div className="mt-16 max-w-xl">
          <p className="text-sm font-semibold uppercase tracking-[0.12em] text-[#1f6f55]">BYOK meeting notes</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-normal text-[#121411] sm:text-5xl">
            把会议可靠录下来，整理成可核对的逐字稿、纪要和待办。
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-[#667085]">
            免费注册即可获得一次性 60 分钟官方体验；也可以配置自己的模型，长期使用时由你控制模型费用。
          </p>
        </div>
      </div>

      <div className="mt-10 grid gap-3">
        <TrustItem icon={<KeyRound className="h-4 w-4" />} title="Free 免费路径" detail="BYOK 永久免费，并附带一次性 60 分钟官方体验额度。" />
        <TrustItem icon={<Sparkles className="h-4 w-4" />} title="Plus 省心路径" detail="计划提供每月 600 分钟官方额度；真实购买开放前不会扣款。" />
        <TrustItem icon={<ShieldCheck className="h-4 w-4" />} title="Pro 重度路径" detail="计划提供每月 1800 分钟官方额度；真实购买开放前不会扣款。" />
      </div>
    </>
  );
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-xs font-semibold text-[#344054] sm:mb-2 sm:text-sm">
        <span className="text-[#1f6f55]">{icon}</span>
        {label}
      </span>
      {children}
    </label>
  );
}

function TrustItem({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-[#111827]">
        <span className="text-[#1f6f55]">{icon}</span>
        {title}
      </div>
      <p className="mt-2 text-xs leading-5 text-[#667085]">{detail}</p>
    </div>
  );
}
