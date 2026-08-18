#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-settings-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const providerSetupSource = await readFile(new URL("../src/components/provider-setup-wizard.tsx", import.meta.url), "utf8");
  const realtimeTestRouteSource = await readFile(new URL("../src/app/api/account/provider-health/realtime-test/route.ts", import.meta.url), "utf8");
  const publicSettings = await fetch(`${baseUrl}/settings`);
  const publicHtml = await publicSettings.text();
  const register = await postJson(
    "/api/auth/register",
    {
      name: "Settings Smoke",
      email,
      password,
    },
    undefined,
    { "x-forwarded-for": testIp },
  );
  const cookie = extractCookie(register.response);
  const settings = await fetch(`${baseUrl}/settings`, {
    headers: { Cookie: cookie },
  });
  const html = await settings.text();
  const healthBefore = await getJson("/api/account/provider-health", cookie);
  const asrTestBefore = await postJson("/api/account/provider-health/asr-test", { live: false }, cookie);
  await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Settings ASR",
      fields: {
        VOLCANO_ASR_APP_ID: "settings-app-id",
        VOLCANO_ASR_RESOURCE_ID: "volc.seedasr.auc",
        VOLCANO_REALTIME_ASR_RESOURCE_ID: "volc.seedasr.sauc.duration",
        VOLCANO_ASR_WS_URL: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
      },
      secrets: { VOLCANO_ASR_API_KEY: "settings-secret-api-key" },
    },
    cookie,
  );
  await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-ark",
      label: "Settings Ark",
      fields: { ARK_CHAT_MODEL: "settings-endpoint-id", ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3" },
      secrets: { ARK_API_KEY: "settings-ark-api-key" },
    },
    cookie,
  );
  const healthAfter = await getJson("/api/account/provider-health", cookie);
  const asrTestAfter = await postJson("/api/account/provider-health/asr-test", { live: false }, cookie);
  const asrTranscribePreflight = await postJson("/api/account/provider-health/asr-test", { live: false, mode: "transcribe" }, cookie);
  const asrTranscribeNoSample = await postJson("/api/account/provider-health/asr-test", { live: true, mode: "transcribe" }, cookie, {}, { allowError: true });
  const asrTranscribeInvalidSample = await postJson(
    "/api/account/provider-health/asr-test",
    {
      audioBase64: Buffer.from("not audio").toString("base64"),
      durationMs: 1000,
      fileName: "sample.txt",
      live: true,
      mimeType: "text/plain",
      mode: "transcribe",
    },
    cookie,
    {},
    { allowError: true },
  );
  const deleteAsr = await deleteJson("/api/account/provider-credentials?providerId=volcano-asr", cookie);
  const healthAfterDelete = await getJson("/api/account/provider-health", cookie);
  const asrTestAfterDelete = await postJson("/api/account/provider-health/asr-test", { live: false }, cookie);
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });

  const summary = {
    publicStatus: publicSettings.status,
    publicShowsLoginPrompt: publicHtml.includes("登录后配置自己的模型") && publicHtml.includes('href="/login"') && publicHtml.includes('href="/register"'),
    registerOk: register.payload.ok === true,
    settingsStatus: settings.status,
    hasSettingsTitle: html.includes("模型与服务"),
    hasPrimaryTabHeader: html.includes('data-primary-tab-header="settings"') && !html.includes("返回录音"),
    hasHeroOffer: html.includes("按自己的用量控制成本"),
    hasSetupFormBeforeGuidance:
      html.indexOf("配置自己的模型") > 0 &&
      html.indexOf("第一次配置") > 0 &&
      html.indexOf("配置自己的模型") < html.indexOf("第一次配置") &&
      html.includes("加密保存配置"),
    hasUnifiedMobileShell:
      html.includes("bg-[#e8eeeb]") &&
      html.includes("max-w-[430px] bg-[#f7faf8]") &&
      html.includes('data-settings-ui="native-list-v27"') &&
      html.includes('data-settings-section="provider-status"') &&
      html.includes('data-settings-disclosure="provider"') &&
      html.includes('data-settings-disclosure="guide"') &&
      !html.includes("rounded-[26px] bg-[#13261f]"),
    hasNarrowSetupContainment:
      html.includes("grid min-w-0 gap-4") &&
      html.includes("min-w-0 rounded-lg") &&
      providerSetupSource.includes('className="mt-1 truncate text-sm') &&
      providerSetupSource.includes("title={userEmail}"),
    protectsSecretEntry:
      providerSetupSource.includes('name="ark-api-key"') &&
      providerSetupSource.includes('name="asr-api-key"') &&
      providerSetupSource.includes('name="asr-token"') &&
      providerSetupSource.includes('autoComplete="off"') &&
      providerSetupSource.includes('type={revealed ? "text" : "password"}') &&
      providerSetupSource.includes('aria-pressed={revealed}') &&
      providerSetupSource.includes('data-form-type="other"') &&
      providerSetupSource.includes('data-lpignore="true"') &&
      providerSetupSource.includes('setApiKey("")') &&
      providerSetupSource.includes('setAsrToken("")') &&
      !providerSetupSource.includes('name="asr-api-key" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="推荐填写，保存后只显示掩码" type="text"'),
    hidesInternalReadiness:
      !html.includes("当前首要阻塞") &&
      !html.includes("本地 MVP 可测不等于 TestFlight") &&
      !html.includes("商用版后台待补能力"),
    hasGuidedSetup:
      html.includes("连接会议转写") &&
      html.includes("连接纪要模型") &&
      html.includes("完成一次验证"),
    hidesAdminCheckupForUser:
      !html.includes("管理员验收中心") &&
      !html.includes("查看全局发布门禁和运维诊断") &&
      !html.includes('href="/checkup"'),
    hasRealtimeAsrFields:
      html.includes("实时 ASR WebSocket URL") &&
      html.includes("实时草稿参数") &&
      html.includes("实时 Resource ID") &&
      html.includes("会后文件识别 Resource ID"),
    hasAsrTestInterpretation:
      html.includes("ASR 测试判定") &&
      html.includes("not_configured") &&
      html.includes("preflight_pass") &&
      html.includes("submitted") &&
      html.includes("transcribed") &&
      html.includes("completed_empty") &&
      html.includes("完整识别") &&
      html.includes("failed") &&
      html.includes("request id") &&
      html.includes("配置保存后再测试"),
    hasAsrTranscriptUpload:
      html.includes("ASR 完整识别测试") &&
      html.includes("上传或直接录制真实中文样本") &&
      html.includes("建议 3-30 秒") &&
      html.includes("选择音频样本") &&
      html.includes("录 10 秒测试样本") &&
      html.includes("运行完整识别测试"),
    hasFileAsrLabel: html.includes("会议转写"),
    hasSummaryLabel: html.includes("纪要生成"),
    hasAsrLiveTestButton: html.includes("ASR 小音频真实测试"),
    hasRealtimeAsrTestButton:
      html.includes("实时识别连接测试") &&
      providerSetupSource.includes("/api/account/provider-health/realtime-test") &&
      realtimeTestRouteSource.includes("runVolcanoRealtimeAuthTest"),
    hasBottomRecordNav: html.includes(">记录</"),
    hasBottomMeetingsNav: html.includes(">会议</"),
    hidesLegacyBottomSettingsNav: !html.includes(">设置</"),
    hasBottomAccountNav: html.includes(">我的</"),
    hasUnifiedPrimaryNav: html.includes('data-app-primary-nav="record-meetings-account"') && !html.includes(">方案</"),
    healthBeforeOk: healthBefore.payload.ok === true,
    healthBeforeScore: healthBefore.payload.setupReport?.score,
    healthBeforeMissingBoth: healthBefore.payload.setupReport?.readyCount === 0,
    asrTestBeforeBlocked: asrTestBefore.payload.ok === false && asrTestBefore.payload.result?.status === "not_configured",
    healthAfterOk: healthAfter.payload.ok === true,
    healthAfterScore: healthAfter.payload.setupReport?.score,
    healthAfterReadyBoth: healthAfter.payload.setupReport?.readyCount === 2,
    healthAfterHasCapabilities:
      healthAfter.payload.setupReport?.capabilities?.some((item) => item.id === "file_asr" && item.ready === true) &&
      healthAfter.payload.setupReport?.capabilities?.some((item) => item.id === "summary" && item.ready === true),
    healthAfterExposesRealtimeProtocol:
      healthAfter.payload.health?.some(
        (item) =>
          item.providerId === "volcano-asr" &&
          item.canUseFor?.includes("realtime_asr") &&
          item.checks?.some((check) => check.id === "realtime_ws" && check.ok === true && String(check.detail || "").includes("参数已配置")),
      ),
    asrTestAfterPreflightPass: asrTestAfter.payload.ok === true && asrTestAfter.payload.result?.status === "preflight_pass",
    asrTestAfterVerificationLevel: asrTestAfter.payload.result?.verificationLevel === "preflight",
    asrTestAfterHasNextAction: typeof asrTestAfter.payload.result?.nextAction === "string" && asrTestAfter.payload.result.nextAction.length > 0,
    asrTranscribePreflightPass:
      asrTranscribePreflight.payload.ok === true &&
      asrTranscribePreflight.payload.result?.mode === "transcribe" &&
      asrTranscribePreflight.payload.result?.status === "preflight_pass" &&
      asrTranscribePreflight.payload.result?.verificationLevel === "preflight",
    asrTranscribeNoSampleBlocked:
      asrTranscribeNoSample.payload.ok === false &&
      asrTranscribeNoSample.payload.result?.mode === "transcribe" &&
      asrTranscribeNoSample.payload.result?.status === "failed" &&
      asrTranscribeNoSample.payload.result?.missing?.includes("audio sample") &&
      String(asrTranscribeNoSample.payload.result?.detail || "").includes("真实中文语音样本"),
    asrTranscribeInvalidSampleBlocked:
      asrTranscribeInvalidSample.payload.ok === false &&
      asrTranscribeInvalidSample.payload.result?.mode === "transcribe" &&
      asrTranscribeInvalidSample.payload.result?.status === "failed" &&
      asrTranscribeInvalidSample.payload.result?.missing?.includes("supported audio sample") &&
      String(asrTranscribeInvalidSample.payload.result?.title || "").includes("样本不合格"),
    deleteAsrOk: deleteAsr.payload.ok === true && deleteAsr.payload.providerCredentials?.length === 1,
    healthAfterDeleteOk: healthAfterDelete.payload.ok === true,
    healthAfterDeleteKeepsSummary: healthAfterDelete.payload.setupReport?.readyCount === 1 && healthAfterDelete.payload.setupReport?.score === 50,
    asrTestAfterDeleteBlocked: asrTestAfterDelete.payload.ok === false && asrTestAfterDelete.payload.result?.status === "not_configured",
    responseHidesSecrets:
      !JSON.stringify(healthAfter.payload).includes("settings-secret-api-key") &&
      !JSON.stringify(healthAfter.payload).includes("settings-ark-api-key") &&
      !JSON.stringify(asrTestAfter.payload).includes("settings-secret-api-key") &&
      !JSON.stringify(asrTranscribePreflight.payload).includes("settings-secret-api-key") &&
      !JSON.stringify(asrTranscribeNoSample.payload).includes("settings-secret-api-key") &&
      !JSON.stringify(asrTranscribeInvalidSample.payload).includes("settings-secret-api-key") &&
      !JSON.stringify(deleteAsr.payload).includes("settings-secret-api-key"),
    deleteOk: deletePayload.ok === true,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.registerOk ||
    summary.publicStatus !== 200 ||
    !summary.publicShowsLoginPrompt ||
    summary.settingsStatus !== 200 ||
    !summary.hasSettingsTitle ||
    !summary.hasPrimaryTabHeader ||
    !summary.hasHeroOffer ||
    !summary.hasSetupFormBeforeGuidance ||
    !summary.hasUnifiedMobileShell ||
    !summary.hasNarrowSetupContainment ||
    !summary.protectsSecretEntry ||
    !summary.hidesInternalReadiness ||
    !summary.hasGuidedSetup ||
    !summary.hidesAdminCheckupForUser ||
    !summary.hasRealtimeAsrFields ||
    !summary.hasAsrTestInterpretation ||
    !summary.hasAsrTranscriptUpload ||
    !summary.hasFileAsrLabel ||
    !summary.hasSummaryLabel ||
    !summary.hasAsrLiveTestButton ||
    !summary.hasRealtimeAsrTestButton ||
    !summary.hasBottomRecordNav ||
    !summary.hasBottomMeetingsNav ||
    !summary.hidesLegacyBottomSettingsNav ||
    !summary.hasBottomAccountNav ||
    !summary.hasUnifiedPrimaryNav ||
    !summary.healthBeforeOk ||
    summary.healthBeforeScore !== 0 ||
    !summary.healthBeforeMissingBoth ||
    !summary.asrTestBeforeBlocked ||
    !summary.healthAfterOk ||
    summary.healthAfterScore !== 100 ||
    !summary.healthAfterReadyBoth ||
    !summary.healthAfterHasCapabilities ||
    !summary.healthAfterExposesRealtimeProtocol ||
    !summary.asrTestAfterPreflightPass ||
    !summary.asrTestAfterVerificationLevel ||
    !summary.asrTestAfterHasNextAction ||
    !summary.asrTranscribePreflightPass ||
    !summary.asrTranscribeNoSampleBlocked ||
    !summary.asrTranscribeInvalidSampleBlocked ||
    !summary.deleteAsrOk ||
    !summary.healthAfterDeleteOk ||
    !summary.healthAfterDeleteKeepsSummary ||
    !summary.asrTestAfterDeleteBlocked ||
    !summary.responseHidesSecrets ||
    !summary.deleteOk
  ) {
    process.exitCode = 1;
  }
}

async function postJson(path, body, cookie, extraHeaders = {}, options = {}) {
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
  const payload = await readJson(response, path, options);
  return { response, payload };
}

async function getJson(path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
  });
  const payload = await readJson(response, path);
  return { response, payload };
}

async function deleteJson(path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
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
