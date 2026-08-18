#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-checkup-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `203.0.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
async function main() {
  const unauthenticatedExport = await fetch(`${baseUrl}/api/checkup/acceptance.md`, { redirect: "manual" });
  const unauthenticatedObsidianSave = await fetch(`${baseUrl}/api/checkup/acceptance/obsidian`, {
    method: "POST",
    redirect: "manual",
  });
  const register = await postJson(
    "/api/auth/register",
    {
      name: "Checkup Smoke",
      email,
      password,
    },
    null,
    { "x-forwarded-for": testIp },
  );
  const cookie = extractCookie(register.response);
  const checkup = await fetch(`${baseUrl}/checkup`, {
    headers: { Cookie: cookie },
  });
  const html = await checkup.text();
  const acceptanceExport = await fetch(`${baseUrl}/api/checkup/acceptance.md`, {
    headers: { Cookie: cookie },
  });
  const acceptanceMarkdown = await acceptanceExport.text();
  const readinessResponse = await fetch(`${baseUrl}/api/release/readiness`);
  const readinessPayload = await readJson(readinessResponse, "/api/release/readiness");
  const readinessReport = readinessPayload.report;
  const blockers = readinessReport?.blockers ?? [];
  const blockerById = new Map(blockers.map((item) => [item.id, item]));
  const criticalBlockers = blockers.filter((item) => item.priority === "critical");
  const summaryModelBlocker = blockerById.get("summary-model");
  const criticalCommandsAppearEverywhere = criticalBlockers.every(
    (item) =>
      typeof item.verificationCommand === "string" &&
      item.verificationCommand.length > 0 &&
      hasBlockerCommand(html, item.id, item.verificationCommand) &&
      acceptanceMarkdown.includes(`本地验证命令：${item.verificationCommand}`),
  );
  const criticalEvidenceTemplatesAppearEverywhere = criticalBlockers.every(
    (item) =>
      html.includes(`data-evidence-template-id="${escapeHtmlAttribute(item.id)}"`) &&
      html.includes(`data-evidence-command="${escapeHtmlAttribute(item.id)}"`) &&
      acceptanceMarkdown.includes(item.title) &&
      acceptanceMarkdown.includes(`Runbook：${item.runbook?.path ?? "未配置"}`),
  );
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete");

  const summary = {
    unauthenticatedExportRejected: unauthenticatedExport.status === 401,
    registerOk: register.payload.ok === true,
    checkupStatus: checkup.status,
    hasTitle: html.includes("验收中心"),
    hasUnifiedMobileShell:
      html.includes("ownminutes-mobile-shell") &&
      html.includes("bg-[#f8f7f3]") &&
      html.includes("rounded-lg border border-[#e2ddd2] bg-white") &&
      html.includes("app-icon-button-dark") &&
      html.includes('data-app-primary-nav="record-meetings-account"') &&
      html.includes('aria-current="page"') &&
      !html.includes("rounded-[1.5rem] bg-[#16261f]") &&
      !html.includes("bg-[#16261f] p-5 text-white"),
    hasChecklist: html.includes("验收清单"),
    hasManualAcceptanceScript: html.includes("人工验收脚本"),
    hasGoNoGoDecision:
      html.includes("Go/No-Go 判定") &&
      html.includes("当前结论：") &&
      html.includes("NO-GO") &&
      html.includes("禁止公开商用或正式上架") &&
      html.includes("只允许本地 MVP、内部试用或受控 TestFlight 准备") &&
      html.includes("必须补齐的证据"),
    hasReadinessStage:
      html.includes("当前阶段") &&
      html.includes("本地 MVP 可测") &&
      html.includes("MVP Ready") &&
      html.includes(">MVP<") &&
      html.includes(">TestFlight<") &&
      html.includes(">商用<") &&
      html.includes('data-readiness-stage="mvp"'),
    hasManualLoginStep: html.includes("注册或登录测试账号"),
    hasManualModelStep: html.includes("配置模型或确认 BYOK 路径"),
    hasManualIphoneLongRecordingStep:
      html.includes("验收 iPhone / TestFlight 长录音") &&
      html.includes("5、30、90 分钟录音") &&
      html.includes("锁屏、切后台、来电、耳机断开、弱网和断网恢复"),
    hasManualRecordingStep: html.includes("录制真人多人会议") && html.includes("2-4 位真人") && html.includes("远近场、打断、噪声或口音"),
    hasManualSummaryStep: html.includes("检查会后纪要质量"),
    hasManualShareStep: html.includes("发布分享并导出知识库"),
    hasManualObsidianSaveStep: html.includes("保存到 Obsidian") && html.includes("Vault 内相对路径"),
    hasManualFinalDecisionStep: html.includes("做最终上线判断"),
    hasManualPassLabel: html.includes("通过标准"),
    hasManualEvidenceLabel: html.includes("证据建议"),
    hasAcceptanceExportLink: html.includes("导出验收单") && html.includes("/api/checkup/acceptance.md"),
    hasAcceptanceObsidianSave: html.includes("保存验收单到 Obsidian") && html.includes("/api/checkup/acceptance/obsidian"),
    unauthenticatedObsidianSaveRejected: unauthenticatedObsidianSave.status === 401,
    acceptanceExportStatus: acceptanceExport.status,
    acceptanceExportContentType: acceptanceExport.headers.get("content-type")?.includes("text/markdown") === true,
    acceptanceExportAttachment: acceptanceExport.headers.get("content-disposition")?.includes("ownminutes-acceptance") === true,
    acceptanceExportHasTitle: acceptanceMarkdown.includes("# OwnMinutes MVP 验收单"),
    acceptanceExportHasManualScript:
      acceptanceMarkdown.includes("## 人工验收脚本") &&
      acceptanceMarkdown.includes("验收 iPhone / TestFlight 长录音") &&
      acceptanceMarkdown.includes("5、30、90 分钟录音") &&
      acceptanceMarkdown.includes("录制真人多人会议"),
    acceptanceExportHasGoNoGo:
      acceptanceMarkdown.includes("## Go/No-Go 判定") &&
      acceptanceMarkdown.includes("- 当前结论：NO-GO") &&
      acceptanceMarkdown.includes("- 当前阶段：本地 MVP 可测") &&
      acceptanceMarkdown.includes("- 判定标题：禁止公开商用或正式上架") &&
      acceptanceMarkdown.includes("- 允许范围：只允许本地 MVP、内部试用或受控 TestFlight 准备") &&
      acceptanceMarkdown.includes("真实 ASR 和总结模型完成生产 preflight、summary:preflight、短会验收和质量抽样") &&
      acceptanceMarkdown.includes("Apple IAP/TestFlight 沙盒购买、退款、续期、过期和权益回收证据齐全"),
    acceptanceExportDistinguishesSummaryReadiness:
      acceptanceMarkdown.includes("- 账号级总结模型可用：") &&
      acceptanceMarkdown.includes(`- 总结模型生产门禁：${summaryModelBlocker ? "未通过" : "已通过"}`) &&
      acceptanceMarkdown.includes("- 总结模型生产缺口：") &&
      acceptanceMarkdown.includes("账号级可用不等于生产就绪") &&
      acceptanceMarkdown.includes("release readiness 的 summary-model 门禁") &&
      acceptanceMarkdown.includes(summaryModelBlocker ? `- summary-model 下一步：${summaryModelBlocker.nextAction}` : "- summary-model 下一步：无"),
    acceptanceExportHasEvidenceFields:
      acceptanceMarkdown.includes("验收人：") &&
      acceptanceMarkdown.includes("验收设备：") &&
      acceptanceMarkdown.includes("证据建议：") &&
      acceptanceMarkdown.includes("证据链接或截图："),
    acceptanceExportHasAutomationEvidence:
      acceptanceMarkdown.includes("## 自动化验收证据") &&
      acceptanceMarkdown.includes("分组：自动化验收") &&
      acceptanceMarkdown.includes("App 工作台 smoke") &&
      acceptanceMarkdown.includes("录音前确认 smoke") &&
      acceptanceMarkdown.includes("账号删除 smoke") &&
      acceptanceMarkdown.includes("会议历史闭环 smoke") &&
      acceptanceMarkdown.includes("分享发布确认 smoke") &&
      acceptanceMarkdown.includes("iOS Simulator 截图 smoke") &&
      acceptanceMarkdown.includes("状态：Ready") &&
      acceptanceMarkdown.includes("证据：`npm run smoke:app` 已配置。"),
    acceptanceExportHasLaunchReadinessPacks:
      acceptanceMarkdown.includes("## 上线准备包") &&
      acceptanceMarkdown.includes("### 模型与识别准备包") &&
      acceptanceMarkdown.includes("### 生产基础设施准备包") &&
      acceptanceMarkdown.includes("### 商业化与上架准备包") &&
      acceptanceMarkdown.includes("火山 ASR 运行时凭证") &&
      acceptanceMarkdown.includes("summary:preflight 结果") &&
      acceptanceMarkdown.includes("JSON-only、幻觉处理、重试和人工复核策略") &&
      acceptanceMarkdown.includes("PostgreSQL DATABASE_URL 和最小权限账号") &&
      acceptanceMarkdown.includes("每日 AES-256-GCM .ombak 备份与异地复制记录") &&
      acceptanceMarkdown.includes("独立主机数据库/对象恢复演练证据") &&
      acceptanceMarkdown.includes("Apple Developer / App Store Connect / IAP 商品") &&
      acceptanceMarkdown.includes("本地验证命令：npm run smoke:asr-preflight") &&
      acceptanceMarkdown.includes("npm run production:restore-drill") &&
      acceptanceMarkdown.includes("本地验证命令：npm run smoke:iap-preflight"),
    acceptanceExportHasLaunchAcceptanceGate:
      acceptanceMarkdown.includes("## 最终上线总验收包") &&
      acceptanceMarkdown.includes("npm run launch:acceptance:evidence:draft") &&
      acceptanceMarkdown.includes("OWNMINUTES_LAUNCH_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/launch-latest.md npm run launch:acceptance:evidence") &&
      acceptanceMarkdown.includes("npm run smoke:launch-evidence") &&
      acceptanceMarkdown.includes("docs/launch-acceptance-runbook.md") &&
      acceptanceMarkdown.includes(".data/acceptance/launch-latest.md"),
    acceptanceExportHasEvidenceTemplates:
      acceptanceMarkdown.includes("## 关键阻塞证据采集模板") &&
      acceptanceMarkdown.includes("必填字段：") &&
      acceptanceMarkdown.includes("ASR Key 类型：") &&
      acceptanceMarkdown.includes("Migration 版本：") &&
      acceptanceMarkdown.includes(".ombak artifact 时间/大小/哈希：") &&
      acceptanceMarkdown.includes("商品 ID：") &&
      acceptanceMarkdown.includes("App URL：") &&
      acceptanceMarkdown.includes("结论：待验收") &&
      criticalEvidenceTemplatesAppearEverywhere,
    acceptanceExportHasBlockers: acceptanceMarkdown.includes("## 关键上线阻塞") && acceptanceMarkdown.includes("Critical Blocked"),
    acceptanceExportHasLayeredReadiness:
      acceptanceMarkdown.includes("- MVP Ready：是") &&
      acceptanceMarkdown.includes("- TestFlight Ready：否") &&
      acceptanceMarkdown.includes("- Commercial Ready：否"),
    acceptanceExportHasVerificationCommands:
      criticalCommandsAppearEverywhere,
    acceptanceExportLeaksSecrets: leaksSecrets(acceptanceMarkdown),
    hasModelStep: html.includes("配置自己的模型"),
    hasAccountVsProductionSummaryCopy: summaryModelBlocker
      ? html.includes("总结模型生产门禁") &&
        html.includes("账号级可用不等于生产就绪") &&
        html.includes("生产 summary-model 仍以 release readiness 为准") &&
        html.includes('data-summary-production-gate="blocked"') &&
        html.includes("JSON-only、幻觉处理、重试和人工复核")
      : html.includes("summary-model 已通过 release readiness") &&
        html.includes('data-summary-production-gate="ready"') &&
        html.includes("最终人工验收") &&
        html.includes("Obsidian Markdown"),
    hasRecordingStep: html.includes("录制 1 分钟测试会议"),
    hasRecommendedNextStep: html.includes("推荐下一步"),
    hasPrimaryBlocker: html.includes("首要上线阻塞"),
    hasCriticalBlockerOrder: html.includes("关键阻塞处理顺序"),
    hasLaunchReadinessPacks:
      html.includes("上线准备包") &&
      html.includes("模型与识别准备包") &&
      html.includes("生产基础设施准备包") &&
      html.includes("商业化与上架准备包") &&
      html.includes("火山 ASR 运行时凭证") &&
      html.includes("PostgreSQL DATABASE_URL 和最小权限账号") &&
      html.includes("每日 AES-256-GCM .ombak 备份与异地复制记录") &&
      html.includes("独立主机数据库/对象恢复演练证据") &&
      html.includes("Apple Developer / App Store Connect / IAP 商品") &&
      html.includes('data-launch-pack-id="ai-provider"') &&
      html.includes('data-launch-pack-id="production-foundation"') &&
      html.includes('data-launch-pack-id="commercial-release"') &&
      html.includes('data-pack-command="file-asr"') &&
      html.includes('data-pack-command="database"') &&
      html.includes('data-pack-command="payments"'),
    hasEvidenceTemplates:
      html.includes("证据采集模板") &&
      html.includes("避免只说“已配置”但没有可复查证据") &&
      html.includes('data-evidence-template-id="file-asr"') &&
      html.includes('data-evidence-template-id="database"') &&
      html.includes('data-evidence-template-id="payments"') &&
      html.includes('data-evidence-command="file-asr"') &&
      html.includes("ASR Key 类型") &&
      html.includes("Migration 版本") &&
      html.includes(".ombak artifact 时间/大小/哈希") &&
      html.includes("商品 ID") &&
      html.includes("建议存放") &&
      html.includes("私有 Obsidian 验收记录或私有 GitHub issue") &&
      criticalEvidenceTemplatesAppearEverywhere,
    hasCriticalBlockerWarning: html.includes("不能进入公开商用或 App Store 正式上架"),
    hasBlockerAcceptanceEvidence:
      html.includes("验收证据") &&
      html.includes("ASR 小音频测试达到 transcribed") &&
      html.includes("真实 PostgreSQL 执行 migration") &&
      html.includes("TestFlight 或 Apple sandbox"),
    hasLocalVerificationCommand: html.includes("本地验证命令"),
    hasCriticalBlockerCount: html.includes("个关键阻塞"),
    hasReadiness: html.includes("上线阻塞"),
    hasAutomationSection: html.includes("自动化验收"),
    hasAppSmoke: html.includes("App 工作台 smoke"),
    hasRecordingConsentSmoke: html.includes("录音前确认 smoke"),
    hasManualAcceptanceExportSmoke: html.includes("人工验收单导出"),
    hasRecordingRunbook: html.includes("录音长测 runbook"),
    hasMeetingsSmoke: html.includes("会议历史闭环 smoke"),
    hasShareConfirmationSmoke: html.includes("分享发布确认 smoke"),
    hasObsidianVaultSmoke: html.includes("Obsidian Vault 写入 smoke"),
    hasAccountSmoke: html.includes("账号页 smoke"),
    hasAccountDeletionSmoke: html.includes("账号删除 smoke"),
    hasPricingSmoke: html.includes("价格页 smoke"),
    hasSettingsSmoke: html.includes("模型设置 smoke"),
    hasAsrRunbook: html.includes("ASR 运行时接入 runbook"),
    hasDeploymentRunbook: html.includes("公网部署 runbook"),
    hasRemoteStorageSmoke: html.includes("远程对象存储 smoke"),
    hasMobileUiSmoke: html.includes("Expo iOS 主屏 UI smoke"),
    hasIosSimulatorUiSmoke: html.includes("iOS Simulator 截图 smoke"),
    hasTestflightConfigSmoke: html.includes("TestFlight 配置 smoke"),
    hasIosTestflightRunbook: html.includes("iOS TestFlight 验收 runbook"),
    hasIosTestflightEvidenceSmoke:
      html.includes("iOS TestFlight 真机证据检查 smoke") &&
      html.includes("npm run ios:testflight:evidence:draft") &&
      html.includes(".data/acceptance/ios-testflight-latest.md"),
    hasPostgresMigrationSmoke: html.includes("PostgreSQL 迁移 smoke"),
    hasSecretManagementSmoke: html.includes("密钥管理 smoke"),
    hasAppleIapVerifierSmoke: html.includes("Apple IAP verifier smoke"),
    hasEntitlementBillingGuardSmoke: html.includes("权益与账单防护 smoke"),
    hasAsrRunbookPath: html.includes("docs/asr-runtime-runbook.md"),
    hasAsrVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "file-asr"),
    hasRealtimeVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "realtime-asr"),
    hasSummaryVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "summary-model"),
    hasDatabaseRunbookPath: html.includes("docs/postgres-migration-runbook.md"),
    hasDatabaseVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "database"),
    hasObjectStorageRunbookPath: html.includes("docs/object-storage-runbook.md"),
    hasStorageVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "object-storage"),
    hasSecretRunbookPath: html.includes("docs/secret-management-runbook.md"),
    hasSecretVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "secret-management"),
    hasAppleIapRunbookPath: html.includes("docs/apple-iap-sandbox-runbook.md"),
    hasAppleIapVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "payments"),
    hasDeploymentRunbookPath: html.includes("docs/public-deployment-runbook.md"),
    hasDeploymentVerificationCommand: blockerCommandPresentOrNotRequired(html, blockerById, "public-url"),
    hasBottomRecordNav: html.includes(">记录</"),
    hasBottomMeetingsNav: html.includes(">会议</"),
    hasBottomSettingsNav: html.includes(">设置</"),
    hasBottomAccountNav: html.includes(">我的</"),
    deleteOk: deletePayload.ok === true,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.unauthenticatedExportRejected ||
    !summary.registerOk ||
    summary.checkupStatus !== 200 ||
    !summary.hasTitle ||
    !summary.hasUnifiedMobileShell ||
    !summary.hasChecklist ||
    !summary.hasManualAcceptanceScript ||
    !summary.hasGoNoGoDecision ||
    !summary.hasReadinessStage ||
    !summary.hasManualLoginStep ||
    !summary.hasManualModelStep ||
    !summary.hasManualIphoneLongRecordingStep ||
    !summary.hasManualRecordingStep ||
    !summary.hasManualSummaryStep ||
    !summary.hasManualShareStep ||
    !summary.hasManualObsidianSaveStep ||
    !summary.hasManualFinalDecisionStep ||
    !summary.hasManualPassLabel ||
    !summary.hasManualEvidenceLabel ||
    !summary.hasAcceptanceExportLink ||
    !summary.hasAcceptanceObsidianSave ||
    !summary.unauthenticatedObsidianSaveRejected ||
    summary.acceptanceExportStatus !== 200 ||
    !summary.acceptanceExportContentType ||
    !summary.acceptanceExportAttachment ||
    !summary.acceptanceExportHasTitle ||
    !summary.acceptanceExportHasManualScript ||
    !summary.acceptanceExportHasGoNoGo ||
    !summary.acceptanceExportDistinguishesSummaryReadiness ||
    !summary.acceptanceExportHasEvidenceFields ||
    !summary.acceptanceExportHasAutomationEvidence ||
    !summary.acceptanceExportHasLaunchReadinessPacks ||
    !summary.acceptanceExportHasLaunchAcceptanceGate ||
    !summary.acceptanceExportHasEvidenceTemplates ||
    !summary.acceptanceExportHasBlockers ||
    !summary.acceptanceExportHasLayeredReadiness ||
    !summary.acceptanceExportHasVerificationCommands ||
    summary.acceptanceExportLeaksSecrets ||
    !summary.hasModelStep ||
    !summary.hasAccountVsProductionSummaryCopy ||
    !summary.hasRecordingStep ||
    !summary.hasRecommendedNextStep ||
    !summary.hasPrimaryBlocker ||
    !summary.hasCriticalBlockerOrder ||
    !summary.hasLaunchReadinessPacks ||
    !summary.hasEvidenceTemplates ||
    !summary.hasCriticalBlockerWarning ||
    !summary.hasBlockerAcceptanceEvidence ||
    !summary.hasLocalVerificationCommand ||
    !summary.hasCriticalBlockerCount ||
    !summary.hasReadiness ||
    !summary.hasAutomationSection ||
    !summary.hasAppSmoke ||
    !summary.hasRecordingConsentSmoke ||
    !summary.hasManualAcceptanceExportSmoke ||
    !summary.hasRecordingRunbook ||
    !summary.hasMeetingsSmoke ||
    !summary.hasShareConfirmationSmoke ||
    !summary.hasObsidianVaultSmoke ||
    !summary.hasAccountSmoke ||
    !summary.hasAccountDeletionSmoke ||
    !summary.hasPricingSmoke ||
    !summary.hasSettingsSmoke ||
    !summary.hasAsrRunbook ||
    !summary.hasDeploymentRunbook ||
    !summary.hasRemoteStorageSmoke ||
    !summary.hasMobileUiSmoke ||
    !summary.hasIosSimulatorUiSmoke ||
    !summary.hasTestflightConfigSmoke ||
    !summary.hasIosTestflightRunbook ||
    !summary.hasIosTestflightEvidenceSmoke ||
    !summary.hasPostgresMigrationSmoke ||
    !summary.hasSecretManagementSmoke ||
    !summary.hasAppleIapVerifierSmoke ||
    !summary.hasEntitlementBillingGuardSmoke ||
    !summary.hasAsrRunbookPath ||
    !summary.hasAsrVerificationCommand ||
    !summary.hasRealtimeVerificationCommand ||
    !summary.hasSummaryVerificationCommand ||
    !summary.hasDatabaseRunbookPath ||
    !summary.hasDatabaseVerificationCommand ||
    !summary.hasObjectStorageRunbookPath ||
    !summary.hasStorageVerificationCommand ||
    !summary.hasSecretRunbookPath ||
    !summary.hasSecretVerificationCommand ||
    !summary.hasAppleIapRunbookPath ||
    !summary.hasAppleIapVerificationCommand ||
    !summary.hasDeploymentRunbookPath ||
    !summary.hasDeploymentVerificationCommand ||
    !summary.hasBottomRecordNav ||
    !summary.hasBottomMeetingsNav ||
    !summary.hasBottomSettingsNav ||
    !summary.hasBottomAccountNav ||
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

async function readJson(response, path) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing set-cookie header");
  return cookie.split(";")[0];
}

function hasBlockerCommand(html, id, command) {
  return html.includes(`data-blocker-id="${escapeHtmlAttribute(id)}"`) && html.includes(`data-verification-command="${escapeHtmlAttribute(command)}"`);
}

function blockerCommandPresentOrNotRequired(html, blockerById, id) {
  const blocker = blockerById.get(id);
  if (!blocker) return true;
  return typeof blocker.verificationCommand === "string" && hasBlockerCommand(html, id, blocker.verificationCommand);
}

function escapeHtmlAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function leaksSecrets(value) {
  return value.includes("AKL") || value.includes("Secret Access Key") || value.includes("sk-proj") || value.includes("WVRC");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
