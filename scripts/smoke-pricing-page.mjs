#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-pricing-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const publicPricing = await fetch(`${baseUrl}/pricing`);
  const publicHtml = await publicPricing.text();
  const register = await postJson(
    "/api/auth/register",
    {
      name: "Pricing Smoke",
      email,
      password,
    },
    null,
    { "x-forwarded-for": testIp },
  );
  const cookie = extractCookie(register.response);
  const signedInPricing = await fetch(`${baseUrl}/pricing`, {
    headers: { Cookie: cookie },
  });
  const signedInHtml = await signedInPricing.text();
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });

  const summary = {
    publicStatus: publicPricing.status,
    publicHasTitle: publicHtml.includes("方案与成本"),
    publicHasOffer: publicHtml.includes("自己控成本，不被年费绑住。"),
    publicHasByok: publicHtml.includes("BYOK") && publicHtml.includes("Free 路径"),
    publicHidesUnavailableMinutePack:
      !publicHtml.includes("分钟包") &&
      !publicHtml.includes("Extra Minutes") &&
      !publicHtml.includes("¥3.9") &&
      !publicHtml.includes("120 分钟"),
    publicHasMembership: publicHtml.includes("Plus 路径") && publicHtml.includes("Pro 路径"),
    publicHasCurrentSubscriptionOffer:
      publicHtml.includes("一次性 60 分钟官方体验额度") &&
      !publicHtml.includes("每月 60 分钟官方体验额度") &&
      !publicHtml.includes("¥0") &&
      publicHtml.includes("US$7.99/月") &&
      publicHtml.includes("每月 600 分钟官方额度") &&
      publicHtml.includes("US$19.99/月") &&
      publicHtml.includes("每月 1800 分钟官方额度") &&
      !publicHtml.includes("每月 2400 分钟官方额度"),
    publicHasCostSelfTest:
      publicHtml.includes("成本自测") &&
      publicHtml.includes("先按会议频率选路径") &&
      publicHtml.includes("先体验或愿意配置模型") &&
      publicHtml.includes("Free + BYOK") &&
      publicHtml.includes("每月约 600 分钟以内") &&
      publicHtml.includes(">Plus<") &&
      publicHtml.includes(">Pro<") &&
      publicHtml.includes("推荐判断") &&
      publicHtml.includes("愿意配置模型就长期使用 Free + BYOK"),
    publicHasRegisterCta: publicHtml.includes("免费注册") || publicHtml.includes("免费开始"),
    publicHasUnifiedMobileShell:
      publicHtml.includes("ownminutes-mobile-shell") &&
      publicHtml.includes("bg-[#f8f7f3]") &&
      publicHtml.includes("rounded-lg border border-[#e2ddd2] bg-white") &&
      publicHtml.includes("app-icon-button-dark") &&
      !publicHtml.includes("rounded-[1.5rem] bg-[#16261f]") &&
      !publicHtml.includes("bg-[#16261f] p-5 text-white"),
    publicHasLegalLinks:
      publicHtml.includes('href="/support"') &&
      publicHtml.includes('href="/privacy"') &&
      publicHtml.includes('href="/terms"') &&
      publicHtml.includes('href="/data-deletion"'),
    registerOk: register.payload.ok === true,
    signedInStatus: signedInPricing.status,
    signedInUsesAccountCta: signedInHtml.includes("去账号中心选择"),
    signedInHasSettingsCta: signedInHtml.includes('href="/settings"') && signedInHtml.includes("配置自己的模型"),
    hasBottomRecordNav: signedInHtml.includes(">记录</"),
    hasBottomMeetingsNav: signedInHtml.includes(">会议</"),
    hasBottomSettingsNav: signedInHtml.includes(">设置</"),
    signedInHasActiveAccountNav: signedInHtml.includes('aria-current="page"') && signedInHtml.includes('href="/account"'),
    hasBottomAccountNav: signedInHtml.includes(">我的</"),
    hasUnifiedPrimaryNav: signedInHtml.includes('data-app-primary-nav="record-meetings-account"') && !signedInHtml.includes(">方案</"),
    deleteOk: deletePayload.ok === true,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    summary.publicStatus !== 200 ||
    !summary.publicHasTitle ||
    !summary.publicHasOffer ||
    !summary.publicHasByok ||
    !summary.publicHidesUnavailableMinutePack ||
    !summary.publicHasMembership ||
    !summary.publicHasCurrentSubscriptionOffer ||
    !summary.publicHasCostSelfTest ||
    !summary.publicHasRegisterCta ||
    !summary.publicHasUnifiedMobileShell ||
    !summary.publicHasLegalLinks ||
    !summary.registerOk ||
    summary.signedInStatus !== 200 ||
    !summary.signedInUsesAccountCta ||
    !summary.signedInHasSettingsCta ||
    !summary.hasBottomRecordNav ||
    !summary.hasBottomMeetingsNav ||
    !summary.hasBottomSettingsNav ||
    !summary.signedInHasActiveAccountNav ||
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
