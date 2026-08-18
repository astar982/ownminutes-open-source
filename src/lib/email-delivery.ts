import { getEmailDiagnostics } from "@/lib/email-diagnostics";

export type PasswordResetEmailInput = {
  email: string;
  expiresAt?: string;
  locale?: string;
  resetToken: string;
};

export type EmailVerificationEmailInput = {
  codeExpiresAt?: string;
  email: string;
  expiresAt?: string;
  locale?: string;
  verificationCode?: string;
  verificationToken: string;
};

export type EmailDeliveryResult = {
  sent: boolean;
  provider: "none" | "resend";
  reason?: string;
};

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<EmailDeliveryResult> {
  const diagnostics = getEmailDiagnostics();
  if (!diagnostics.productionReady) {
    return {
      sent: false,
      provider: diagnostics.provider,
      reason: `Email provider not configured: ${diagnostics.missing.join(", ")}`,
    };
  }

  const apiKey = getEnv("RESEND_API_KEY", "OWNMINUTES_RESEND_API_KEY");
  const from = getEnv("OWNMINUTES_EMAIL_FROM", "EMAIL_FROM");
  const appUrl = getEnv("OWNMINUTES_APP_URL", "NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
  const resetUrl = `${appUrl}/reset-password#token=${encodeURIComponent(input.resetToken)}`;
  const content = buildPasswordResetContent(resetUrl, input.expiresAt, normalizeEmailLocale(input.locale));
  const response = await fetchResendEmail({
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.email,
      subject: content.subject,
      text: content.text,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend email failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  return { sent: true, provider: "resend" };
}

export async function sendEmailVerificationEmail(input: EmailVerificationEmailInput): Promise<EmailDeliveryResult> {
  const diagnostics = getEmailDiagnostics();
  if (!diagnostics.productionReady) {
    return {
      sent: false,
      provider: diagnostics.provider,
      reason: `Email provider not configured: ${diagnostics.missing.join(", ")}`,
    };
  }

  const apiKey = getEnv("RESEND_API_KEY", "OWNMINUTES_RESEND_API_KEY");
  const from = getEnv("OWNMINUTES_EMAIL_FROM", "EMAIL_FROM");
  const appUrl = getEnv("OWNMINUTES_APP_URL", "NEXT_PUBLIC_APP_URL").replace(/\/$/, "");
  const verificationUrl = `${appUrl}/verify-email#token=${encodeURIComponent(input.verificationToken)}`;
  const locale = normalizeEmailLocale(input.locale);
  const content = buildEmailVerificationContent({
    codeExpiresAt: input.codeExpiresAt,
    expiresAt: input.expiresAt,
    locale,
    verificationCode: input.verificationCode,
    verificationUrl,
  });
  const response = await fetchResendEmail({
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.email,
      subject: content.subject,
      text: content.text,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend email failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return { sent: true, provider: "resend" };
}

function buildPasswordResetContent(resetUrl: string, expiresAt: string | undefined, locale: "en" | "zh-Hans" | "zh-Hant") {
  if (locale === "zh-Hans") {
    return {
      subject: "重置您的 OwnMinutes 密码",
      text: [
        "您正在重置 OwnMinutes 密码。",
        "",
        `重置链接：${resetUrl}`,
        expiresAt ? `链接有效期至：${expiresAt}` : "链接有效期约 30 分钟。",
        "",
        "如果不是您本人操作，请忽略这封邮件。",
      ].join("\n"),
    };
  }
  if (locale === "zh-Hant") {
    return {
      subject: "重設您的 OwnMinutes 密碼",
      text: [
        "您正在重設 OwnMinutes 密碼。",
        "",
        `重設連結：${resetUrl}`,
        expiresAt ? `連結有效期至：${expiresAt}` : "連結有效期約 30 分鐘。",
        "",
        "若不是您本人操作，請忽略這封郵件。",
      ].join("\n"),
    };
  }
  return {
    subject: "Reset your OwnMinutes password",
    text: [
      "A password reset was requested for your OwnMinutes account.",
      "",
      `Reset link: ${resetUrl}`,
      expiresAt ? `The link expires at: ${expiresAt}` : "The link expires in about 30 minutes.",
      "",
      "If you did not request this, ignore this email.",
    ].join("\n"),
  };
}

function buildEmailVerificationContent(input: {
  codeExpiresAt?: string;
  expiresAt?: string;
  locale: "en" | "zh-Hans" | "zh-Hant";
  verificationCode?: string;
  verificationUrl: string;
}) {
  if (input.locale === "zh-Hans") {
    return {
      subject: "您的 OwnMinutes 邮箱验证码",
      text: [
        "欢迎使用 OwnMinutes。",
        "",
        input.verificationCode ? `验证码：${input.verificationCode}` : undefined,
        input.codeExpiresAt ? `验证码有效期至：${input.codeExpiresAt}` : "验证码有效期约 10 分钟。",
        "请勿向任何人转发此验证码。",
        "",
        "旧版 App 也可以使用下面的一次性验证链接：",
        input.verificationUrl,
        input.expiresAt ? `链接有效期至：${input.expiresAt}` : "链接有效期约 24 小时。",
        "",
        "验证完成后即可登录。若不是您本人注册，请忽略这封邮件。",
      ].filter(Boolean).join("\n"),
    };
  }
  if (input.locale === "zh-Hant") {
    return {
      subject: "您的 OwnMinutes 電子郵件驗證碼",
      text: [
        "歡迎使用 OwnMinutes。",
        "",
        input.verificationCode ? `驗證碼：${input.verificationCode}` : undefined,
        input.codeExpiresAt ? `驗證碼有效期至：${input.codeExpiresAt}` : "驗證碼有效期約 10 分鐘。",
        "請勿向任何人轉傳此驗證碼。",
        "",
        "舊版 App 也可以使用下方的一次性驗證連結：",
        input.verificationUrl,
        input.expiresAt ? `連結有效期至：${input.expiresAt}` : "連結有效期約 24 小時。",
        "",
        "完成驗證後即可登入。若不是您本人註冊，請忽略這封郵件。",
      ].filter(Boolean).join("\n"),
    };
  }
  return {
    subject: "Your OwnMinutes verification code",
    text: [
      "Welcome to OwnMinutes.",
      "",
      input.verificationCode ? `Verification code: ${input.verificationCode}` : undefined,
      input.codeExpiresAt ? `The code expires at: ${input.codeExpiresAt}` : "The code expires in about 10 minutes.",
      "Do not share this code with anyone.",
      "",
      "Older app versions can use this one-time verification link:",
      input.verificationUrl,
      input.expiresAt ? `The link expires at: ${input.expiresAt}` : "The link expires in about 24 hours.",
      "",
      "After verification, you can sign in. If you did not create this account, ignore this email.",
    ].filter(Boolean).join("\n"),
  };
}

function normalizeEmailLocale(value?: string): "en" | "zh-Hans" | "zh-Hant" {
  const normalized = value?.trim().toLowerCase().split(",", 1)[0]?.split(";", 1)[0]?.trim() || "";
  if (/^(zh-hant|zh-tw|zh-hk|zh-mo)(-|$)/.test(normalized)) return "zh-Hant";
  if (/^(zh-hans|zh-cn|zh-sg|zh)(-|$)/.test(normalized)) return "zh-Hans";
  return "en";
}

async function fetchResendEmail(init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch("https://api.resend.com/emails", { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Resend email request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}
