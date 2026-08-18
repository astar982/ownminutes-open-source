#!/usr/bin/env node

import { readFileSync } from "node:fs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-app-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const unauthenticated = await fetch(`${baseUrl}/app`, { redirect: "manual" });
  const register = await postJson(
    "/api/auth/register",
    { name: "App Smoke", email, password },
    null,
    { "x-forwarded-for": testIp },
  );
  const cookie = extractCookie(register.response);
  const app = await fetch(`${baseUrl}/app`, { headers: { Cookie: cookie } });
  const html = await app.text();
  const recorderSource = readFileSync("src/components/meeting-recorder.tsx", "utf8");
  const audioPipelineSource = readFileSync("src/lib/audio-pipeline.ts", "utf8");
  const recorderStoreSource = readFileSync("src/lib/browser-recording-store.ts", "utf8");
  const stableRecorderSource = readFileSync("src/hooks/use-stable-recorder.ts", "utf8");
  const accountSource = readFileSync("src/components/account-dashboard.tsx", "utf8");
  const meetingDetailSource = readFileSync("src/app/meetings/[id]/page.tsx", "utf8");
  const navSource = readFileSync("src/components/app-bottom-nav.tsx", "utf8");
  const cssSource = readFileSync("src/app/globals.css", "utf8");
  const v25StyleStart = cssSource.indexOf("/* Mobile recorder v25");
  const v25StyleEnd = cssSource.indexOf(".app-home-header-v18", v25StyleStart);
  const v25Styles = cssSource.slice(v25StyleStart, v25StyleEnd);
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });

  const checks = {
    unauthenticatedRedirects: unauthenticated.status === 307 && unauthenticated.headers.get("location") === "/login",
    registerOk: register.payload.ok === true,
    appStatus: app.status === 200,
    hasFocusedV25Shell:
      html.includes('data-app-workspace-ui="mobile-recorder-v25"') &&
      html.includes('data-recorder-home="focused"') &&
      html.includes("OwnMinutes") &&
      html.includes("会议记录") &&
      html.includes("待开始") &&
      html.includes('aria-label="会议标题"') &&
      !html.includes("录音工作台"),
    hasSinglePrimaryRecorder:
      html.includes("app-recorder-stage-v25") &&
      html.includes("app-record-primary-v25") &&
      html.includes("app-timer-v25") &&
      html.includes("app-waveform-v25") &&
      recorderSource.includes('app-record-primary-v25 ${recordingActive ? "is-stop" : ""}') &&
      recorderSource.includes('recordingActive ? "结束会议" : primaryActionCopy') &&
      recorderSource.includes("Array.from({ length: 36 })") &&
      !recorderSource.includes("app-record-orb-v20"),
    keepsMeetingIdentityThroughRecording:
      html.includes('aria-label="会议标题"') &&
      recorderSource.includes("createDefaultMeetingTitle") &&
      recorderSource.includes("normalizeMeetingTitle") &&
      recorderSource.includes("session.title || createDefaultMeetingTitle()") &&
      recorderStoreSource.includes("title?: string") &&
      recorderStoreSource.includes("session.title = title || session.title"),
    hidesDashboardClutter:
      !recorderSource.includes("showStateStrip") &&
      !recorderSource.includes("function StatusMetric") &&
      !recorderSource.includes("function FlowHint") &&
      !html.includes("app-provider-strip-v18") &&
      !html.includes("app-meeting-brief-v18") &&
      !html.includes("app-recorder-console-v18"),
    keepsRecorderSettings:
      recorderSource.includes("SettingsSheet") &&
      recorderSource.includes('aria-label="关闭录音设置"') &&
      recorderSource.includes('aria-label="刷新麦克风设备"') &&
      recorderSource.includes("麦克风选择") &&
      recorderSource.includes("录音自检") &&
      recorderSource.includes("ModelReadinessCard") &&
      recorderSource.includes('data-provider-nudge={!modelReady ? "compact" : undefined}'),
    keepsRecordingConsent:
      recorderSource.includes("showRecordingConsent") &&
      recorderSource.includes("RecordingConsentDialog") &&
      recorderSource.includes("确认并开始录音") &&
      recorderSource.includes("请确认参会人已经知情并同意录音"),
    hasDurableBrowserRecordingRecovery:
      recorderStoreSource.includes('databaseName = "ownminutes-browser-recordings"') &&
      recorderStoreSource.includes("persistBrowserAudioChunk") &&
      recorderStoreSource.includes("markBrowserAudioChunkUploaded") &&
      recorderStoreSource.includes("loadLatestRecoverableBrowserRecording") &&
      recorderStoreSource.includes("loadBrowserRecording") &&
      recorderSource.indexOf("await persistBrowserAudioChunk") < recorderSource.indexOf("await uploadAudioChunkOnce(meetingId, chunk)") &&
      recorderSource.includes("未同步分片已重试") &&
      recorderSource.includes('window.addEventListener("online", handleOnline)') &&
      stableRecorderSource.includes("restoreFromBlob"),
    browserRecoveryUploadsAreSingleFlightAndCountUniqueServerChunks:
      recorderSource.includes("browserChunkUploadsInFlightRef") &&
      recorderSource.includes("browserChunkSyncInFlightRef") &&
      recorderSource.includes("uploaded: Math.max(current.uploaded, ack.totalChunks)") &&
      recorderSource.includes("acknowledgedChunkUploadsRef") &&
      !recorderSource.includes("uploaded: current.uploaded + 1"),
    failedBrowserChunksBlockFinalizationAndStayRecoverable:
      recorderSource.includes("uploadState.failed === 0") &&
      recorderSource.includes("重试同步音频") &&
      recorderSource.includes("markBrowserRecordingFinalized") &&
      recorderSource.includes("本地录音不会被删除") &&
      recorderSource.indexOf("markBrowserRecordingFinalized(meetingId)") > recorderSource.indexOf("if (result)") &&
      !recorderSource.slice(recorderSource.indexOf("if (result)"), recorderSource.indexOf("if (finalTranscript"))
        .includes("deleteBrowserRecording(meetingId)"),
    browserFinalizationSealsTheCompleteRecording:
      recorderSource.includes("expectedLastSequence: uploadState.uploaded") &&
      recorderSource.includes("totalBytes: uploadState.savedBytes") &&
      recorderSource.includes("uploadState.savedBytes <= 0") &&
      audioPipelineSource.includes("expectedLastSequence: number") &&
      audioPipelineSource.includes("body: JSON.stringify({ title, force, operationId, ...audioSeal })"),
    hasHonestLocalRecordingStatus:
      recorderSource.includes("browserRecordingStatus") &&
      recorderSource.includes('data-local-recording-state={localRecordingStatus.state}') &&
      recorderSource.includes('"本地保存已就绪"') &&
      recorderSource.includes('"本地录音保存中"') &&
      recorderSource.includes('"本地录音已暂停"') &&
      recorderSource.includes('"本地音频已保存"') &&
      recorderSource.includes('"已恢复本地录音"') &&
      recorderSource.includes('"本地保存异常"') &&
      !recorderSource.includes("已开启本地保存"),
    accountDeletionClearsBrowserAudio:
      recorderStoreSource.includes("deleteBrowserRecordingsForUser") &&
      accountSource.includes("await deleteBrowserRecordingsForUser(user.id)") &&
      accountSource.indexOf('fetch("/api/auth/delete"') < accountSource.indexOf("deleteBrowserRecordingsForUser(user.id)"),
    hasTranscriptAndNotes:
      html.includes("实时转写") &&
      html.includes("会议纪要") &&
      recorderSource.includes("还没有正式纪要") &&
      recorderSource.includes("不展示示例内容") &&
      recorderSource.includes("请先生成正式纪要，再复制 Obsidian Markdown") &&
      !recorderSource.includes("demoTranscript"),
    hasCalmNativeVisualTokens:
      cssSource.includes(".app-recorder-stage-v25") &&
      cssSource.includes(".app-record-primary-v25") &&
      cssSource.includes(".app-recorder-side-action-v25") &&
      cssSource.includes(".app-content-switch-v25") &&
      cssSource.includes(".app-content-tab-v25.is-active") &&
      cssSource.includes('font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display"') &&
      cssSource.includes("background: #f7f8f6") &&
      cssSource.includes("background: #ffffff") &&
      cssSource.includes("background: #d94e45") &&
      v25StyleStart >= 0 &&
      v25StyleEnd > v25StyleStart &&
      v25Styles.includes("linear-gradient") &&
      !v25Styles.includes("radial-gradient"),
    hasThreeItemBottomNav:
      navSource.includes('id: "record"') &&
      navSource.includes('id: "meetings"') &&
      navSource.includes('id: "account"') &&
      navSource.includes("app-bottom-nav") &&
      navSource.includes("grid-cols-3") &&
      navSource.includes('data-app-primary-nav="record-meetings-account"') &&
      !navSource.includes('id: "settings"') &&
      !navSource.includes('bg-[#173f34] text-white'),
    avoidsEngineeringCopyOnHome:
      !html.includes("服务端保存") &&
      !html.includes("失败分片") &&
      !html.includes("采样率") &&
      !html.includes(">Provider<"),
    keepsMeetingDetailHeaderFocused:
      meetingDetailSource.includes(">会议详情</h1>") &&
      !meetingDetailSource.includes(">Meeting</p>") &&
      !meetingDetailSource.includes("uppercase tracking-[0.18em]"),
    hidesProviderDiagnosticsFromHome:
      recorderSource.includes("音频已保存，纪要已生成。当前转写结果需要检查。") &&
      recorderSource.includes("纪要生成失败，音频仍已安全保存。请稍后重试。") &&
      !recorderSource.includes('diagnostics.join("；")'),
    deleteOk: deletePayload.ok === true,
  };

  console.log(JSON.stringify(checks, null, 2));
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}

async function postJson(path, body, cookie, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
