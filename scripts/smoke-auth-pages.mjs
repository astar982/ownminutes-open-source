#!/usr/bin/env node

import fs from "node:fs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";

async function main() {
  const [loginResponse, registerResponse, verificationResponse, passwordResetResponse] = await Promise.all([
    fetch(`${baseUrl}/login`),
    fetch(`${baseUrl}/register`),
    fetch(`${baseUrl}/verify-email`),
    fetch(`${baseUrl}/reset-password?token=smoke-password-reset-token-1234567890`),
  ]);
  const [loginHtml, registerHtml, verificationHtml, passwordResetHtml] = await Promise.all([
    loginResponse.text(),
    registerResponse.text(),
    verificationResponse.text(),
    passwordResetResponse.text(),
  ]);
  const source = fs.readFileSync("src/components/auth-panel.tsx", "utf8");
  const verificationSource = fs.readFileSync("src/components/email-verification-panel.tsx", "utf8");
  const passwordResetSource = fs.readFileSync("src/components/password-reset-panel.tsx", "utf8");

  const summary = {
    loginStatus: loginResponse.status,
    registerStatus: registerResponse.status,
    verificationStatus: verificationResponse.status,
    passwordResetStatus: passwordResetResponse.status,
    loginHasAppShell: loginHtml.includes("OwnMinutes") && loginHtml.includes("欢迎回来") && loginHtml.includes("登录后继续处理你的会议记录。"),
    registerHasAppShell: registerHtml.includes("OwnMinutes") && registerHtml.includes("创建 OwnMinutes 账号") && registerHtml.includes("创建账号，开始记录自己的会议。"),
    hasCostPositioning:
      registerHtml.includes("BYOK 免费使用") &&
      registerHtml.includes("模型费用由你自己控制") &&
      source.includes("Free 免费路径") &&
      source.includes("Plus 省心路径") &&
      source.includes("Pro 重度路径") &&
      !source.includes("分钟包") &&
      !source.includes("低价按量路径"),
    hasMobileAppVisualSystem:
      source.includes("bg-[#eef1f4]") &&
      source.includes("max-w-[430px]") &&
      source.includes("auth-device-shell") &&
      source.includes("rounded-none bg-[#f7f6f2]") &&
      source.includes("sm:rounded-[28px]") &&
      source.includes("auth-device-body") &&
      source.includes("rounded-[24px] bg-white") &&
      source.includes("space-y-2.5"),
    hasAuthControls:
      loginHtml.includes("保持登录") &&
      loginHtml.includes("忘记密码") &&
      registerHtml.includes("姓名或团队名") &&
      registerHtml.includes("服务条款") &&
      registerHtml.includes("隐私政策"),
    hasPrimaryCtas: loginHtml.includes("还没有账号？免费注册") && registerHtml.includes("已有账号？登录") && registerHtml.includes("查看方案"),
    hasEmailVerificationFlow:
      verificationHtml.includes("OwnMinutes") &&
      verificationSource.includes("验证邮箱") &&
      verificationSource.includes("重新发送验证邮件") &&
      verificationSource.includes("完成验证") &&
      verificationSource.includes("完成邮箱验证后，账号才会签发登录会话") &&
      verificationSource.includes('fragmentParams.get("token")') &&
      verificationSource.includes("setVerificationLink({") &&
      !verificationSource.includes('placeholder="邮件链接会自动带入"'),
    hasPasswordResetLinkLanding:
      passwordResetHtml.includes("重置密码") &&
      passwordResetSource.includes('current.searchParams.get("token")') &&
      passwordResetSource.includes('fragmentParams.get("token")') &&
      passwordResetSource.includes("setResetLink({") &&
      passwordResetSource.includes("showConfirmForm = isResetLinkToken(activeToken)") &&
      passwordResetSource.includes("重置链接已载入，请设置新密码。") &&
      passwordResetSource.includes("window.history.replaceState") &&
      !passwordResetSource.includes("重置 token"),
    avoidsLandingOnlyLayout:
      !source.includes("hero") &&
      !source.includes("rounded-[34px] bg-[#f4f3ee]") &&
      !source.includes("rounded-[26px] bg-[#13261f]") &&
      !source.includes("min-h-[calc(100dvh-32px)]") &&
      !source.includes("MiniValue"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    summary.loginStatus !== 200 ||
    summary.registerStatus !== 200 ||
    summary.verificationStatus !== 200 ||
    summary.passwordResetStatus !== 200 ||
    !summary.loginHasAppShell ||
    !summary.registerHasAppShell ||
    !summary.hasCostPositioning ||
    !summary.hasMobileAppVisualSystem ||
    !summary.hasAuthControls ||
    !summary.hasPrimaryCtas ||
    !summary.hasEmailVerificationFlow ||
    !summary.hasPasswordResetLinkLanding ||
    !summary.avoidsLandingOnlyLayout
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
