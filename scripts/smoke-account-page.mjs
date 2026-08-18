#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-account-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const accountDashboardSource = await readFile(new URL("../src/components/account-dashboard.tsx", import.meta.url), "utf8");
  const unauthenticated = await fetch(`${baseUrl}/account`, { redirect: "manual" });
  const register = await postJson(
    "/api/auth/register",
    {
      name: "Account Smoke",
      email,
      password,
    },
    null,
    { "x-forwarded-for": testIp },
  );
  const cookie = extractCookie(register.response);
  const account = await fetch(`${baseUrl}/account`, {
    headers: { Cookie: cookie },
  });
  const html = await account.text();
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });

  const summary = {
    unauthenticatedRedirects: unauthenticated.status === 307 && unauthenticated.headers.get("location") === "/login",
    registerOk: register.payload.ok === true,
    accountStatus: account.status,
    hasTitle: html.includes("我的账号"),
    hasPrimaryTabHeader: html.includes('data-primary-tab-header="account"') && !html.includes("返回录音") && !html.includes(">Account<"),
    hasEmail: html.includes(email),
    hasUnifiedMobileShell:
      html.includes("bg-[#eef1f4]") &&
      html.includes("max-w-[430px] bg-[#f7f6f2]") &&
      html.includes('data-account-ui="native-list-v29"') &&
      html.includes('data-account-section="profile"') &&
      html.includes('data-account-section="usage"') &&
      html.includes('data-account-disclosure="plans"') &&
      html.includes('data-account-disclosure="providers"') &&
      html.includes('data-account-disclosure="security"') &&
      html.includes('data-account-row="meetings"') &&
      !html.includes("rounded-[26px] bg-[#13261f]"),
    hasSettingsLink: html.includes('href="/settings"'),
    hasNewMeetingLink: html.includes('href="/app"'),
    hasUsageStatus: html.includes("使用状态"),
    hasProviderSection: html.includes("模型配置"),
    hasMeetingSection: html.includes("会议记录"),
    hasPasswordSection: html.includes("修改密码"),
    hasPasswordManagerIdentity:
      accountDashboardSource.includes('autoComplete="username"') &&
      accountDashboardSource.includes('name="username"') &&
      accountDashboardSource.includes("value={user.email}"),
    hasExportActions: html.includes("导出账号摘要") && html.includes("导出全部会议内容"),
    hidesInternalAcceptanceEntry: !html.includes("打开 MVP 验收中心"),
    hasBottomRecordNav: html.includes(">记录</"),
    hasBottomMeetingsNav: html.includes(">会议</"),
    hidesLegacyBottomSettingsNav: !html.includes(">设置</"),
    hasBottomAccountNav: html.includes(">我的</"),
    hasUnifiedPrimaryNav: html.includes('data-app-primary-nav="record-meetings-account"'),
    deleteOk: deletePayload.ok === true,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.unauthenticatedRedirects ||
    !summary.registerOk ||
    summary.accountStatus !== 200 ||
    !summary.hasTitle ||
    !summary.hasPrimaryTabHeader ||
    !summary.hasEmail ||
    !summary.hasUnifiedMobileShell ||
    !summary.hasSettingsLink ||
    !summary.hasNewMeetingLink ||
    !summary.hasUsageStatus ||
    !summary.hasProviderSection ||
    !summary.hasMeetingSection ||
    !summary.hasPasswordSection ||
    !summary.hasPasswordManagerIdentity ||
    !summary.hasExportActions ||
    !summary.hidesInternalAcceptanceEntry ||
    !summary.hasBottomRecordNav ||
    !summary.hasBottomMeetingsNav ||
    !summary.hidesLegacyBottomSettingsNav ||
    !summary.hasBottomAccountNav ||
    !summary.hasUnifiedPrimaryNav ||
    !summary.deleteOk
  ) {
    process.exitCode = 1;
  }
}

async function postJson(path, body, cookie, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, path);
  return { response, payload };
}

async function readJson(response, path, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing set-cookie header");
  return cookie.split(";")[0];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
