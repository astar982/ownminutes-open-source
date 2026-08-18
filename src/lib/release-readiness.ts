import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { getDatabaseDiagnostics } from "@/lib/database-diagnostics";
import { getDeploymentDiagnostics } from "@/lib/deployment-diagnostics";
import { getEmailDiagnostics } from "@/lib/email-diagnostics";
import { getPaymentDiagnostics } from "@/lib/payment-diagnostics";
import {
  getSecretDiagnostics,
  type SecretDiagnostics,
} from "@/lib/secret-diagnostics";
import { getStorageDiagnostics } from "@/lib/storage-diagnostics";
import { getProviderDiagnostic } from "@/lib/transcription-adapter";
import { getFinalizationQueueInfo } from "@/lib/server/finalization-queue";

export type ReleaseReadinessStatus = "ready" | "warning" | "blocked";

export type ReleaseReadinessItem = {
  id: string;
  title: string;
  detail: string;
  status: ReleaseReadinessStatus;
  evidence: string;
  nextAction: string;
  runbook?: ReleaseReadinessRunbook;
};

export type ReleaseReadinessGroup = {
  id: string;
  title: string;
  items: ReleaseReadinessItem[];
};

export type ReleaseReadinessSummary = {
  ready: number;
  warning: number;
  blocked: number;
  criticalBlocked: number;
  total: number;
  mvpReady: boolean;
  testflightReady: boolean;
  commercialReady: boolean;
};

export type ReleaseReadinessBlocker = {
  id: string;
  groupId: string;
  groupTitle: string;
  title: string;
  detail: string;
  evidence: string;
  acceptanceEvidence: string;
  nextAction: string;
  priority: "critical" | "high" | "medium";
  runbook?: ReleaseReadinessRunbook;
  verificationCommand?: string;
};

export type ReleaseReadinessNextAction = {
  title: string;
  detail: string;
  nextAction: string;
  priority: ReleaseReadinessBlocker["priority"] | "none";
  runbook?: ReleaseReadinessRunbook;
};

export type ReleaseReadinessRunbook = {
  label: string;
  path: string;
};

export type ReleaseReadinessReport = {
  generatedAt: string;
  summary: ReleaseReadinessSummary;
  groups: ReleaseReadinessGroup[];
  blockers: ReleaseReadinessBlocker[];
  nextAction: ReleaseReadinessNextAction;
};

export function getReleaseReadinessReport(
  runtimeSecretDiagnostics?: SecretDiagnostics,
): ReleaseReadinessReport {
  const providerDiagnostic = getProviderDiagnostic();
  const fileAsrRuntimeReady = Boolean(providerDiagnostic.capabilities?.fileAsrReady ?? providerDiagnostic.ready);
  const asrMeetingBatch = getAsrMeetingBatchReadiness();
  const fileAsrProduction = getFileAsrProductionReadiness(fileAsrRuntimeReady, asrMeetingBatch);
  const fileAsrReady = fileAsrProduction.ready;
  const realtimeAsrReady = Boolean(providerDiagnostic.capabilities?.realtimeProtocolReady ?? providerDiagnostic.capabilities?.realtimeReady ?? false);
  const realtimeAsrConfigured = Boolean(providerDiagnostic.capabilities?.realtimeConfigured ?? false);
  const speakerDiarization = getSpeakerDiarizationReadiness(fileAsrReady, asrMeetingBatch);
  const summaryReady = Boolean(providerDiagnostic.capabilities?.summaryReady ?? providerDiagnostic.ready);
  const summaryMissing = providerDiagnostic.capabilities?.summaryMissing ?? [];
  const databaseDiagnostics = getDatabaseDiagnostics();
  const deploymentDiagnostics = getDeploymentDiagnostics();
  const emailDiagnostics = getEmailDiagnostics();
  const paymentDiagnostics = getPaymentDiagnostics();
  const secretDiagnostics = runtimeSecretDiagnostics ?? getSecretDiagnostics();
  const storageDiagnostics = getStorageDiagnostics();
  const iosSimulatorScreenshotEvidence = getIosSimulatorScreenshotEvidence();
  const providerClosedLoopEvidence = getProviderClosedLoopEvidence();
  const finalizationQueue = getFinalizationQueueInfo();

  const groups: ReleaseReadinessGroup[] = [
    {
      id: "product",
      title: "产品闭环",
      items: [
        item({
          id: "recording-workbench",
          title: "录音工作台",
          detail: "Web 工作台支持开始录音、结束会议、分片上传、结果检查和会后纪要。",
          status: "ready",
          evidence: "MeetingRecorder 已覆盖录音、4 MiB 断点续传、账号级暂存限额、72 小时过期回收、finalize、分享和 Markdown。",
          nextAction: "继续在真机上压测 30/90 分钟录音稳定性。",
        }),
        item({
          id: "mobile-workbench-ui",
          title: "手机工作台 UI",
          detail: "工作台首屏聚焦录音状态、大计时、同步状态、开始录音、实时转写和会议纪要。",
          status: "ready",
          evidence: "`smoke:app` 和浏览器手机视口检查覆盖 `/app` 首屏核心文案与导航。",
          nextAction: "继续在真实手机浏览器和 Expo iOS 客户端复核触控、录音权限和结束会议流程。",
        }),
        item({
          id: "obsidian-export",
          title: "Obsidian Markdown",
          detail: "会后结果可复制 Markdown，分享页默认隐藏逐字稿。",
          status: "ready",
          evidence: "闭环烟测验证 obsidian.md 和分享权限。",
          nextAction: "iOS 端继续验证 Share Sheet 导出到 Files/Obsidian。",
        }),
      ],
    },
    {
      id: "acceptance",
      title: "自动化验收",
      items: [
        item({
          id: "app-workspace-smoke",
          title: "App 工作台 smoke",
          detail: "防止 `/app` 登录门槛、开始录音、实时转写、会议纪要和底部导航回退。",
          status: packageScriptExists("smoke:app") && fileExists("scripts/smoke-app-workspace.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:app") ? "`npm run smoke:app` 已配置。" : "缺少 `npm run smoke:app`。",
          nextAction: packageScriptExists("smoke:app") ? "后续改 `/app` UI 时必须运行。" : "补 `scripts/smoke-app-workspace.mjs` 和 package script。",
        }),
        item({
          id: "recording-consent-smoke",
          title: "录音前确认 smoke",
          detail: "验证 Web/PWA 和 Expo iOS 点击开始录音前会先看到参会人知情同意确认，而不是直接请求麦克风。",
          status:
            packageScriptExists("smoke:app") &&
            packageScriptExists("smoke:mobile-ui") &&
            fileExists("scripts/smoke-app-workspace.mjs") &&
            fileExists("scripts/smoke-mobile-ui.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("smoke:app") && packageScriptExists("smoke:mobile-ui")
              ? "`npm run smoke:app` 和 `npm run smoke:mobile-ui` 已覆盖录音前提示和确认门槛源码防回退。"
              : "缺少 Web 或 Expo iOS 录音前确认 smoke。",
          nextAction: "后续改录音主按钮、权限流程、App Store 合规文案或移动端录音页时必须运行。",
        }),
        item({
          id: "manual-acceptance-script",
          title: "人工验收脚本",
          detail: "在 `/checkup` 提供最终人工验收步骤，覆盖登录、模型配置、1 分钟录音、会后纪要、分享和保存到 Obsidian。",
          status: packageScriptExists("smoke:checkup") && fileExists("scripts/smoke-checkup.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:checkup") ? "`npm run smoke:checkup` 已覆盖人工验收脚本文案。" : "缺少 `npm run smoke:checkup`。",
          nextAction: packageScriptExists("smoke:checkup") ? "最终人工验收前按 `/checkup` 脚本逐项跑。" : "补验收中心 smoke。",
        }),
        item({
          id: "manual-acceptance-export",
          title: "人工验收单导出",
          detail: "登录后可从 `/checkup` 导出 Markdown 验收单，或直接保存到 Obsidian Vault。",
          status:
            packageScriptExists("smoke:checkup") &&
            fileExists("scripts/smoke-checkup.mjs") &&
            fileExists("src/app/api/checkup/acceptance.md/route.ts") &&
            fileExists("src/app/api/checkup/acceptance/obsidian/route.ts")
              ? "ready"
              : "blocked",
          evidence: fileExists("src/app/api/checkup/acceptance.md/route.ts") && fileExists("src/app/api/checkup/acceptance/obsidian/route.ts")
            ? "`/api/checkup/acceptance.md` 和 `/api/checkup/acceptance/obsidian` 已配置，并由 smoke 验证登录门槛、Markdown 附件、Vault 写入和无密钥泄露。"
            : "缺少验收单 Markdown 导出或 Obsidian 保存接口。",
          nextAction: "最终验收前导出 Markdown 验收单，或点击“保存验收单到 Obsidian”。",
        }),
        item({
          id: "account-page-smoke",
          title: "账号页 smoke",
          detail: "防止 `/account` 登录门槛、账号状态、模型入口、会议入口、密码修改、数据导出和底部导航回退。",
          status: packageScriptExists("smoke:account") && fileExists("scripts/smoke-account-page.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:account") ? "`npm run smoke:account` 已配置。" : "缺少 `npm run smoke:account`。",
          nextAction: packageScriptExists("smoke:account") ? "后续改账号页或账号操作入口时必须运行。" : "补 `scripts/smoke-account-page.mjs` 和 package script。",
        }),
        item({
          id: "account-deletion-smoke",
          title: "账号删除 smoke",
          detail: "验证删除账号会清理会议、公开分享、Provider 配置、用量事件和旧 session 访问权限。",
          status: packageScriptExists("smoke:account-deletion") && fileExists("scripts/smoke-account-deletion.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:account-deletion")
            ? "`npm run smoke:account-deletion` 已配置，覆盖删除前导出、删除后 session/API/share/Markdown/login 拒绝和无密钥泄露。"
            : "缺少 `npm run smoke:account-deletion`。",
          nextAction: packageScriptExists("smoke:account-deletion") ? "后续改删除账号、Provider 密钥、会议存储或分享权限时必须运行。" : "补账号删除 smoke。",
        }),
        item({
          id: "pricing-page-smoke",
          title: "价格页 smoke",
          detail: "防止 `/pricing` Free、Plus、Pro 三档方案、法律链接、登录后 CTA 和底部导航回退，并确保未上线的分钟包不会重新出现在公开页面。",
          status: packageScriptExists("smoke:pricing") && fileExists("scripts/smoke-pricing-page.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:pricing") ? "`npm run smoke:pricing` 已配置。" : "缺少 `npm run smoke:pricing`。",
          nextAction: packageScriptExists("smoke:pricing") ? "后续改价格页或商业转化文案时必须运行。" : "补 `scripts/smoke-pricing-page.mjs` 和 package script。",
        }),
        item({
          id: "recording-long-test-runbook",
          title: "录音长测 runbook",
          detail: "明确 5/30/90 分钟、弱网、断网恢复、设备中断和切后台风险的真实验收步骤。",
          status: packageScriptExists("smoke:recording-runbook") && fileExists("docs/recording-long-test-runbook.md") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:recording-runbook") ? "`npm run smoke:recording-runbook` 已配置。" : "缺少录音长测 runbook smoke。",
          nextAction: "按 runbook 跑真实浏览器和 TestFlight 录音长测，记录脱敏证据。",
        }),
        item({
          id: "recording-long-test-evidence-smoke",
          title: "录音长测私有证据检查 smoke",
          detail: "验证 5/30/90 分钟、弱网、断网恢复、设备中断和切后台风险的真实录音证据必须逐场景完整记录，并确认计时、音频文件存在、上传完成后再 finalize、崩溃/卡死状态、内存/电量观察、转写/纪要边界、本地音频、分享、Obsidian、恢复重试和无密钥泄露。",
          status:
            packageScriptExists("recording:acceptance:evidence") &&
            packageScriptExists("smoke:recording-evidence") &&
            fileExists("scripts/check-recording-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-recording-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("recording:acceptance:evidence") && packageScriptExists("smoke:recording-evidence")
              ? "`npm run smoke:recording-evidence` 已配置；真实证据保存在 `.data/acceptance/recording-latest.md` 后用 `npm run recording:acceptance:evidence` 检查，必须逐场景记录开始/结束、计时、音频文件、上传终态、finalize 等待、崩溃/卡死、内存/电量、转写/纪要边界和恢复重试。"
              : "缺少录音长测私有证据检查脚本。",
          nextAction: "真实 5/30/90 分钟和弱网/离线/中断验收后，把脱敏证据保存到 `.data/acceptance/recording-latest.md`，运行 `npm run recording:acceptance:evidence`。",
        }),
        item({
          id: "meetings-closed-loop-smoke",
          title: "会议历史闭环 smoke",
          detail: "验证录完以后能找回、打开、分享、撤销、导出、项目归档和删除。",
          status: packageScriptExists("smoke:meetings") && fileExists("scripts/smoke-closed-loop.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:meetings") ? "`npm run smoke:meetings` 已配置。" : "缺少 `npm run smoke:meetings`。",
          nextAction: packageScriptExists("smoke:meetings") ? "后续改会议历史、分享或 Obsidian 导出时必须运行。" : "把闭环脚本接入 `smoke:meetings`。",
        }),
        item({
          id: "share-confirmation-smoke",
          title: "分享发布确认 smoke",
          detail: "验证 Web/PWA 和 Expo iOS 发布公开分享或公开逐字稿前都有二次确认，并要求当前纪要版本已完成人工复核；内容变化后旧确认和公开分享必须失效。",
          status: packageScriptExists("smoke:share-confirmation") && fileExists("scripts/smoke-share-confirmation.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:share-confirmation")
            ? "`npm run smoke:share-confirmation` 已覆盖结果版本指纹、服务端发布门禁、公开页面、工作台、会议详情、会议历史和 Expo iOS 人工复核与分享确认防回退。"
            : "缺少 `npm run smoke:share-confirmation`。",
          nextAction: "后续改纪要编辑、重新生成、分享按钮、逐字稿公开、分享权限或移动端会议详情时必须运行，并用 `npm run smoke:meetings` 验证完整状态转换。",
        }),
        item({
          id: "obsidian-vault-smoke",
          title: "Obsidian Vault 写入 smoke",
          detail: "验证会议 Markdown 能写入配置的本地 Obsidian Vault，并且响应不暴露服务端绝对路径。",
          status: packageScriptExists("smoke:obsidian-vault") && fileExists("scripts/smoke-obsidian-vault-export.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:obsidian-vault") ? "`npm run smoke:obsidian-vault` 已配置。" : "缺少 `npm run smoke:obsidian-vault`。",
          nextAction: "后续改 Obsidian 写入、会议详情导出或 Markdown 元数据时必须运行。",
        }),
        item({
          id: "settings-provider-smoke",
          title: "模型设置 smoke",
          detail: "验证 BYOK 配置诊断、文件 ASR 测试、实时 ASR 连接测试和密钥不回显。",
          status: packageScriptExists("smoke:settings") && fileExists("scripts/smoke-settings-page.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:settings") ? "`npm run smoke:settings` 已配置。" : "缺少 `npm run smoke:settings`。",
          nextAction: packageScriptExists("smoke:settings") ? "后续改设置页或 provider health 时必须运行。" : "补设置页 smoke。",
        }),
        item({
          id: "asr-diagnostics-smoke",
          title: "ASR 诊断 smoke",
          detail: "验证火山 ASR 运行时凭证判断、AK/SK 不被误判、实时/会后能力标记和密钥不泄露。",
          status: packageScriptExists("smoke:asr") && fileExists("scripts/smoke-asr-diagnostics.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:asr") ? "`npm run smoke:asr` 已配置。" : "缺少 `npm run smoke:asr`。",
          nextAction: packageScriptExists("smoke:asr") ? "接真实火山 Key 前后都必须运行。" : "补 ASR 诊断 smoke。",
        }),
        item({
          id: "asr-production-preflight-smoke",
          title: "会后 ASR 生产 preflight smoke",
          detail: "验证会后文件 ASR 上线前置脚本会阻止账号 AK/SK 被误当运行时凭证、HTTP endpoint、缺真实音频证据、缺质量抽样策略或缺隐私策略进入生产候选。",
          status:
            packageScriptExists("asr:preflight") &&
            packageScriptExists("smoke:asr-preflight") &&
            fileExists("scripts/check-asr-production-env.mjs") &&
            fileExists("scripts/smoke-asr-production-preflight.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:asr-preflight")
            ? "`npm run smoke:asr-preflight` 已配置，覆盖缺环境、账号 AK/SK-only、缺证据策略、HTTP endpoint、完整 API Key 和完整 AppID+Token。"
            : "缺少 `npm run smoke:asr-preflight`。",
          nextAction: "真实 ASR Key 到位后，在同一部署环境运行 `npm run asr:preflight`，再按 runbook 做真实中文音频识别验收。",
        }),
        item({
          id: "realtime-asr-production-preflight-smoke",
          title: "实时 ASR 生产 preflight smoke",
          detail: "验证实时 WebSocket ASR 上线前置脚本会阻止缺少运行时凭证、wss endpoint、resource id、协议实现、心跳、重连、弱网证据、失败隔离证据或真实会议证据的配置进入生产。",
          status:
            packageScriptExists("realtime:preflight") &&
            packageScriptExists("smoke:realtime-preflight") &&
            packageScriptExists("smoke:realtime-protocol") &&
            packageScriptExists("smoke:realtime-live-script") &&
            fileExists("scripts/check-realtime-asr-production-env.mjs") &&
            fileExists("scripts/smoke-realtime-asr-production-preflight.mjs") &&
            fileExists("scripts/smoke-volcano-realtime-protocol.mjs") &&
            fileExists("scripts/run-volcano-realtime-live-acceptance.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:realtime-preflight")
            ? "实时 preflight、协议 smoke 和 live 验收器已配置；覆盖官方域名白名单、鉴权头、协议帧、累计草稿更新、停止握手、心跳、重连和密钥不泄露。"
            : "缺少 `npm run smoke:realtime-preflight`。",
          nextAction: "配置真实火山语音运行时凭证，在有状态 Node 环境完成弱网和 1-3 分钟真实中文会议证据后运行 `npm run realtime:preflight`。",
        }),
        item({
          id: "asr-runtime-runbook",
          title: "ASR 运行时接入 runbook",
          detail: "明确真实火山 ASR Key、ASR 小音频测试、1-3 分钟会议和质量采样的验收步骤。",
          status: packageScriptExists("smoke:asr-runbook") && fileExists("docs/asr-runtime-runbook.md") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:asr-runbook") ? "`npm run smoke:asr-runbook` 已配置。" : "缺少 `npm run smoke:asr-runbook`。",
          nextAction: packageScriptExists("smoke:asr-runbook") ? "拿到真实 ASR Key 后按 runbook 跑小音频和短会验收。" : "补 ASR 运行时接入 runbook。",
        }),
        item({
          id: "asr-sample-transcription-smoke",
          title: "ASR 样本转写 CLI smoke",
          detail: "验证命令行真实样本转写工具存在，能拒绝缺失/空样本，调用真实会后 ASR adapter，并把逐字稿预览写入 `.data` 私有证据而不是终端输出。",
          status:
            packageScriptExists("asr:sample") &&
            packageScriptExists("smoke:asr-sample") &&
            fileExists("scripts/run-asr-sample-transcription.mjs") &&
            fileExists("scripts/smoke-asr-sample-transcription.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:asr-sample")
            ? "`npm run smoke:asr-sample` 已配置；真实样本可用 `OWNMINUTES_ASR_SAMPLE_PATH=/path/to/sample.wav npm run asr:sample` 生成 `.data/acceptance/asr-small-audio-latest.md`。"
            : "缺少 `npm run smoke:asr-sample`。",
          nextAction: fileAsrRuntimeReady
            ? "运行真实 Provider 闭环，再用 1-3 分钟人声会议完成准确率和说话人验收。"
            : "拿到真实 ASR Key 和 3-30 秒普通话样本后运行 `npm run asr:sample`，再做 1-3 分钟会议验收。",
        }),
        item({
          id: "provider-closed-loop-smoke",
          title: "真实 Provider 闭环验收工具",
          detail: "用私有音频样本验证火山正式转写、方舟结构化纪要、分享权限、Markdown、临时 Obsidian Vault 和测试数据清理。",
          status:
            packageScriptExists("provider:closed-loop") &&
            packageScriptExists("smoke:provider-closed-loop-script") &&
            fileExists("scripts/run-provider-closed-loop.mjs") &&
            fileExists("scripts/smoke-provider-closed-loop-script.mjs")
              ? "ready"
              : "blocked",
          evidence: providerClosedLoopEvidence.passed
            ? `本机真实 Provider 闭环私有证据已通过（${providerClosedLoopEvidence.checkedAt}）；证据保存在 \`.data/acceptance/provider-closed-loop-latest.md\`，不进入仓库。`
            : packageScriptExists("smoke:provider-closed-loop-script")
              ? "`npm run smoke:provider-closed-loop-script` 已配置；真实运行会把脱敏结果写入 `.data/acceptance/provider-closed-loop-latest.md`。"
            : "缺少真实 Provider 闭环验收脚本或静态防回退 smoke。",
          nextAction: providerClosedLoopEvidence.passed
            ? "真实 Provider 合成样本闭环已通过；转入 1-3 分钟真人多人会议、远近场、打断和说话人标签验收。"
            : fileAsrRuntimeReady
              ? "使用包含决策、待办、风险和未解决问题的私有中文样本运行 `npm run provider:closed-loop`，然后转入真人多人会议验收。"
            : "先配置火山 ASR 与方舟运行时，再运行真实 Provider 闭环。",
        }),
        item({
          id: "asr-acceptance-evidence-smoke",
          title: "ASR 验收证据模板 smoke",
          detail: "验证真实 ASR 测试必须按统一模板记录 provider、状态、transcribed 证据、会议质量、质量采样和无密钥泄露。",
          status: packageScriptExists("smoke:asr-acceptance") && fileExists("scripts/smoke-asr-acceptance-template.mjs") && fileExists("docs/asr-acceptance-evidence-template.md") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:asr-acceptance") ? "`npm run smoke:asr-acceptance` 已配置。" : "缺少 `npm run smoke:asr-acceptance`。",
          nextAction: "真实 ASR Key 到位后，复制模板到私有 issue 或 Obsidian，按模板记录小音频、短会和质量采样证据。",
        }),
        item({
          id: "asr-acceptance-private-evidence-smoke",
          title: "ASR 私有验收证据检查 smoke",
          detail: "验证真实 ASR/说话人验收私有证据必须覆盖 transcribed 小音频、非 fallback 会议逐字稿、摘要归因、分享/Markdown、多人说话人标签、改名流程、抽样表、实时/正式边界、pending 草稿拒绝和无密钥泄露。",
          status:
            packageScriptExists("asr:acceptance:evidence") &&
            packageScriptExists("smoke:asr-acceptance-evidence") &&
            packageScriptExists("asr:acceptance:collect") &&
            packageScriptExists("smoke:asr-acceptance-collector") &&
            fileExists("scripts/check-asr-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-asr-acceptance-evidence.mjs") &&
            fileExists("scripts/collect-asr-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-asr-acceptance-collector.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("asr:acceptance:evidence") && packageScriptExists("smoke:asr-acceptance-evidence") && packageScriptExists("asr:acceptance:collect")
              ? "`npm run smoke:asr-acceptance-evidence` 与 `npm run smoke:asr-acceptance-collector` 已配置；先运行 `npm run asr:acceptance:collect` 生成 `.data/acceptance/asr-latest.md` 私有草稿，草稿必须保持 pending 且正式 checker 会拒绝；填入真实证据后用 `npm run asr:acceptance:evidence` 检查。"
              : "缺少 ASR 私有证据检查脚本。",
          nextAction: "先运行 `npm run smoke:asr-acceptance-collector && npm run asr:acceptance:collect` 生成私有草稿；真实 ASR/说话人验收后，把脱敏证据保存到 `.data/acceptance/asr-latest.md`，运行 `npm run asr:acceptance:evidence`。",
        }),
        item({
          id: "email-diagnostics-smoke",
          title: "邮件服务 smoke",
          detail: "验证找回密码邮件发送配置有诊断、不会泄露密钥，并能区分开发 token 与生产邮件路径。",
          status: packageScriptExists("smoke:email") && fileExists("scripts/smoke-email-diagnostics.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:email") ? "`npm run smoke:email` 已配置。" : "缺少 `npm run smoke:email`。",
          nextAction: packageScriptExists("smoke:email") ? "后续改密码重置或邮件配置时必须运行。" : "补邮件诊断 smoke。",
        }),
        item({
          id: "email-production-preflight-smoke",
          title: "邮件生产 preflight smoke",
          detail: "验证密码重置邮件上线前置脚本会阻止缺少 Resend Key、发件人、公网 HTTPS App URL、发信域名验证、退信/投诉策略或仍开启开发 token 回显的配置进入生产。",
          status:
            packageScriptExists("email:preflight") &&
            packageScriptExists("smoke:email-preflight") &&
            fileExists("scripts/check-email-production-env.mjs") &&
            fileExists("scripts/smoke-email-production-preflight.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:email-preflight")
            ? "`npm run smoke:email-preflight` 已配置，并覆盖缺环境、localhost、开发 token 回显和完整 Resend 配置。"
            : "缺少 `npm run smoke:email-preflight`。",
          nextAction: "生产启用密码重置邮件前必须在同一部署环境运行 `npm run email:preflight`，再发起真实重置邮件测试。",
        }),
        item({
          id: "postgres-migration-smoke",
          title: "PostgreSQL 迁移 smoke",
          detail: "验证 schema、dry-run migration、账号数据导出、加密备份/隔离恢复和 auth repository PostgreSQL 边界不回退。",
          status:
            packageScriptExists("smoke:database-schema") &&
            packageScriptExists("smoke:database-migrate") &&
            packageScriptExists("smoke:database-export") &&
            packageScriptExists("smoke:production-backup") &&
            packageScriptExists("smoke:production-backup-offsite") &&
            packageScriptExists("production:backup") &&
            packageScriptExists("production:backup:replicate") &&
            packageScriptExists("production:backup:freshness") &&
            packageScriptExists("production:restore-drill") &&
            packageScriptExists("smoke:auth-repository") &&
            fileExists("scripts/run-postgres-migrations.mjs") &&
            fileExists("scripts/export-auth-store-to-postgres.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("smoke:database-schema") &&
            packageScriptExists("smoke:database-migrate") &&
            packageScriptExists("smoke:database-export") &&
            packageScriptExists("smoke:production-backup") &&
            packageScriptExists("smoke:production-backup-offsite") &&
            packageScriptExists("smoke:auth-repository")
              ? "数据库迁移、导出、AES-256-GCM 加密备份、异地回读校验、freshness、隔离恢复和 auth repository smoke 已配置。"
              : "缺少 PostgreSQL 迁移相关 smoke。",
          nextAction: "后续改数据库 schema、migration runner、账号仓库或导出脚本时必须运行。",
        }),
        item({
          id: "postgres-production-preflight-smoke",
          title: "PostgreSQL 生产 preflight smoke",
          detail: "验证数据库上线前置脚本会阻止缺失 DATABASE_URL、未切 PostgreSQL runtime、缺迁移命令、缺备份策略、缺恢复演练、缺 SSL/TLS、缺本地 store 处置、缺最小权限或缺审计声明的配置进入生产。",
          status:
            packageScriptExists("database:preflight") &&
            packageScriptExists("smoke:database-preflight") &&
            fileExists("scripts/check-postgres-production-env.mjs") &&
            fileExists("scripts/smoke-postgres-production-preflight.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:database-preflight")
            ? "`npm run smoke:database-preflight` 已配置，并覆盖缺环境、仅 DATABASE_URL、完整生产环境，以及恢复演练、SSL/TLS、本地 store 处置门禁。"
            : "缺少 `npm run smoke:database-preflight`。",
          nextAction: "生产切换 PostgreSQL 前必须在同一部署环境运行 `npm run database:preflight`。",
        }),
        item({
          id: "postgres-evidence-smoke",
          title: "PostgreSQL 私有证据检查 smoke",
          detail: "验证真实 PostgreSQL 验收私有证据必须覆盖生产 preflight、schema、migration、auth export、runtime writes、注册登录、密码重置、Provider 配置、会议元数据、用量、后台指标、账号删除、备份、恢复演练、最小权限、审计、SSL/TLS、本地 JSON 处置和无密钥泄露。",
          status:
            packageScriptExists("database:acceptance:evidence") &&
            packageScriptExists("smoke:database-evidence") &&
            fileExists("scripts/check-postgres-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-postgres-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("database:acceptance:evidence") && packageScriptExists("smoke:database-evidence")
              ? "`npm run smoke:database-evidence` 已配置；真实证据保存在 `.data/acceptance/postgres-latest.md` 后用 `npm run database:acceptance:evidence` 检查。"
              : "缺少 PostgreSQL 私有证据检查脚本。",
          nextAction: "真实 PostgreSQL migration 和 runtime 切换验收后，把脱敏证据保存到 `.data/acceptance/postgres-latest.md`，运行 `npm run database:acceptance:evidence`。",
        }),
        item({
          id: "secret-management-smoke",
          title: "密钥管理 smoke",
          detail: "验证密钥诊断、Provider 密钥审计、Vault Transit 运行时与仓库闭环、密钥管理 runbook 和不可回显约束。",
          status:
            packageScriptExists("smoke:secrets") &&
            packageScriptExists("smoke:secret-audit") &&
            packageScriptExists("smoke:secret-vault-runtime") &&
            packageScriptExists("smoke:secret-vault-repository") &&
            packageScriptExists("smoke:secret-vault-live-verifier") &&
            packageScriptExists("smoke:secret-runbook") &&
            fileExists("scripts/smoke-secret-diagnostics.mjs") &&
            fileExists("scripts/smoke-secret-audit.mjs") &&
            fileExists("scripts/smoke-vault-transit-secret-provider.mjs") &&
            fileExists("scripts/smoke-vault-provider-repository.mjs") &&
            fileExists("scripts/smoke-vault-live-verifier.mjs") &&
            fileExists("scripts/verify-vault-transit-live.mjs") &&
            fileExists("scripts/smoke-secret-runbook.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("smoke:secrets") &&
            packageScriptExists("smoke:secret-audit") &&
            packageScriptExists("smoke:secret-vault-runtime") &&
            packageScriptExists("smoke:secret-vault-repository") &&
            packageScriptExists("smoke:secret-vault-live-verifier") &&
            packageScriptExists("smoke:secret-runbook")
              ? "`smoke:secrets`、`smoke:secret-audit`、`smoke:secret-vault-runtime`、`smoke:secret-vault-repository`、`smoke:secret-vault-live-verifier`、`smoke:secret-runbook` 已配置。"
              : "缺少密钥管理相关 smoke。",
          nextAction: "后续改 Provider 密钥存储、审计、删除、轮换或 runbook 时必须运行。",
        }),
        item({
          id: "secret-management-production-preflight-smoke",
          title: "密钥管理生产 preflight smoke",
          detail: "验证密钥管理上线前置脚本会阻止声明但未实现的 KMS/托管 store、不完整 Vault Transit、非私有 token 文件，以及缺失轮换、审计、隔离、删除或恢复策略的配置进入生产。",
          status:
            packageScriptExists("secret:preflight") &&
            packageScriptExists("smoke:secret-preflight") &&
            fileExists("scripts/check-secret-production-env.mjs") &&
            fileExists("scripts/smoke-secret-production-preflight.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:secret-preflight")
            ? "`npm run smoke:secret-preflight` 已配置，并覆盖缺环境、无运行适配器的 KMS/托管声明、Vault 缺配置、token 权限错误和完整 Vault Transit。"
            : "缺少 `npm run smoke:secret-preflight`。",
          nextAction: "生产切换 Vault Transit 前必须在同一部署环境运行 `npm run secret:preflight`、`npm run smoke:secret-vault-runtime` 和真实 Vault 验收。",
        }),
        item({
          id: "secret-management-evidence-smoke",
          title: "密钥管理私有证据检查 smoke",
          detail: "验证真实 KMS/托管 secret store 验收私有证据必须覆盖生产 preflight、诊断、审计、Provider 密钥保存、预览不回显、轮换、删除、账号删除、租户隔离、管理员不可见、解密失败审计、备份恢复、本地密文迁移和无密钥泄露。",
          status:
            packageScriptExists("secret:acceptance:evidence") &&
            packageScriptExists("secret:evidence:draft") &&
            packageScriptExists("secret:vault:live:verify") &&
            packageScriptExists("smoke:secret-evidence") &&
            fileExists("scripts/check-secret-acceptance-evidence.mjs") &&
            fileExists("scripts/verify-vault-transit-live.mjs") &&
            fileExists("scripts/smoke-secret-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("secret:acceptance:evidence") &&
            packageScriptExists("secret:evidence:draft") &&
            packageScriptExists("secret:vault:live:verify") &&
            packageScriptExists("smoke:secret-evidence")
              ? "`secret:vault:live:verify` 生成 24 小时有效的私有 Vault live JSON；`smoke:secret-evidence` 会拒绝缺失、过期、非 HTTPS、非 0600 或提交不匹配的证据。"
              : "缺少密钥管理私有证据检查脚本。",
          nextAction: "在真实 Vault 环境先运行 `OWNMINUTES_VAULT_LIVE_VERIFY=1 npm run secret:vault:live:verify`，再填写 Markdown 草稿并运行 `npm run secret:acceptance:evidence`。",
        }),
        item({
          id: "apple-iap-endpoints-smoke",
          title: "Apple IAP 入口 smoke",
          detail: "验证交易校验和服务端通知入口不会在未配置 Apple IAP 时误发权益。",
          status: packageScriptExists("smoke:iap") && fileExists("scripts/smoke-apple-iap-endpoints.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:iap") ? "`npm run smoke:iap` 已配置。" : "缺少 `npm run smoke:iap`。",
          nextAction: packageScriptExists("smoke:iap") ? "后续接 App Store Server API 或通知落账时必须运行。" : "补 Apple IAP endpoint smoke。",
        }),
        item({
          id: "apple-iap-verifier-smoke",
          title: "Apple IAP verifier smoke",
          detail: "验证官方 signedPayload 校验器、Apple 根证书配置、外层通知和内层交易 JWS 校验不会回退。",
          status: packageScriptExists("smoke:iap-verifier") && fileExists("scripts/smoke-apple-iap-verifier.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:iap-verifier") ? "`npm run smoke:iap-verifier` 已配置。" : "缺少 `npm run smoke:iap-verifier`。",
          nextAction: "后续改 Apple 通知签名校验、根证书、票据落账或支付诊断时必须运行。",
        }),
        item({
          id: "apple-iap-production-preflight-smoke",
          title: "Apple IAP 生产 preflight smoke",
          detail: "验证 Apple IAP 上线前置脚本会阻止缺失 App Store API 凭证、Bundle ID、商品、根证书、公开通知 URL、交易校验、权益映射、退款/幂等和沙盒购买/续期/退款/过期/账本证据的配置进入发布。",
          status:
            packageScriptExists("iap:preflight") &&
            packageScriptExists("smoke:iap-preflight") &&
            fileExists("scripts/check-apple-iap-production-env.mjs") &&
            fileExists("scripts/smoke-apple-iap-production-preflight.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:iap-preflight")
            ? "`npm run smoke:iap-preflight` 已配置，并覆盖缺环境、仅凭证、完整 sandbox、production 缺 Apple App ID 和完整 production。"
            : "缺少 `npm run smoke:iap-preflight`。",
          nextAction: "TestFlight 或 sandbox 购买验收前必须在同一部署环境运行 `npm run iap:preflight`。",
        }),
        item({
          id: "entitlement-billing-guard-smoke",
          title: "权益与账单防护 smoke",
          detail: "验证免费额度、BYOK 路由、会员额度、模拟付费禁用、支付诊断和本地账号并发写入不回退。",
          status:
            packageScriptExists("smoke:entitlements") &&
            packageScriptExists("smoke:billing-guard") &&
            packageScriptExists("smoke:payments") &&
            packageScriptExists("smoke:auth-store") &&
            fileExists("scripts/smoke-entitlements.mjs") &&
            fileExists("scripts/smoke-simulated-billing-guard.mjs") &&
            fileExists("scripts/smoke-payment-diagnostics.mjs") &&
            fileExists("scripts/smoke-auth-store-concurrency.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("smoke:entitlements") &&
            packageScriptExists("smoke:billing-guard") &&
            packageScriptExists("smoke:payments") &&
            packageScriptExists("smoke:auth-store")
              ? "`smoke:entitlements`、`smoke:billing-guard`、`smoke:payments`、`smoke:auth-store` 已配置。"
              : "缺少权益、账单或账号存储并发 smoke。",
          nextAction: "后续改套餐、额度、BYOK 路由、支付诊断或账号存储写入时必须运行。",
        }),
        item({
          id: "apple-iap-sandbox-runbook",
          title: "Apple IAP sandbox runbook",
          detail: "明确真实 Apple sandbox 购买、续期、退款、过期通知和数据库账本验收步骤。",
          status: packageScriptExists("smoke:iap-runbook") && fileExists("docs/apple-iap-sandbox-runbook.md") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:iap-runbook") ? "`npm run smoke:iap-runbook` 已配置。" : "缺少 `npm run smoke:iap-runbook`。",
          nextAction: "用 TestFlight 或 sandbox build 跑真实 Plus/Pro 购买、DID_RENEW、REFUND、EXPIRED/REVOKE 证据。",
        }),
        item({
          id: "apple-iap-evidence-smoke",
          title: "Apple IAP 私有证据检查 smoke",
          detail: "验证 Apple sandbox/TestFlight 私有证据必须覆盖 Plus/Pro 购买、重复交易幂等、续期、退款、过期/撤销、账本、账号回滚和无密钥泄露。",
          status:
            packageScriptExists("iap:acceptance:evidence") &&
            packageScriptExists("smoke:iap-evidence") &&
            fileExists("scripts/check-apple-iap-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-apple-iap-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("iap:acceptance:evidence") && packageScriptExists("smoke:iap-evidence")
              ? "`npm run smoke:iap-evidence` 已配置；先运行 `npm run iap:acceptance:evidence:draft` 生成 `.data/acceptance/apple-iap-latest.md` 草稿，草稿必须保持 pending 且正式 checker 会拒绝；填入真实证据后用 `npm run iap:acceptance:evidence` 检查。"
              : "缺少 Apple IAP 私有证据检查脚本。",
          nextAction: "先运行 `npm run iap:acceptance:evidence:draft` 生成草稿；Apple sandbox/TestFlight 验收后，把脱敏证据保存到 `.data/acceptance/apple-iap-latest.md`，运行 `npm run iap:acceptance:evidence`。",
        }),
        item({
          id: "deployment-diagnostics-smoke",
          title: "部署诊断 smoke",
          detail: "验证 `/api/deployment/diagnostics` 和 `/api/health` 可用，且不会把 localhost 误判为可上架公网环境。",
          status: packageScriptExists("smoke:deployment") && fileExists("scripts/smoke-deployment-diagnostics.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:deployment") ? "`npm run smoke:deployment` 已配置。" : "缺少 `npm run smoke:deployment`。",
          nextAction: packageScriptExists("smoke:deployment") ? "后续改部署诊断、健康检查或公网 URL 门禁时必须运行。" : "补部署诊断 smoke。",
        }),
        item({
          id: "public-deployment-runbook",
          title: "公网部署 runbook",
          detail: "明确公网 HTTPS、移动端 API Base URL、合规 URL、健康检查、邮件、Apple IAP 通知和分享链接验收步骤。",
          status: packageScriptExists("smoke:deployment-runbook") && fileExists("docs/public-deployment-runbook.md") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:deployment-runbook") ? "`npm run smoke:deployment-runbook` 已配置。" : "缺少 `npm run smoke:deployment-runbook`。",
          nextAction: packageScriptExists("smoke:deployment-runbook") ? "配置公网 HTTPS 后按 runbook 验证外部访问和移动端 API。" : "补公网部署 runbook。",
        }),
        item({
          id: "public-deployment-evidence-smoke",
          title: "公网部署私有证据检查 smoke",
          detail: "验证公网 HTTPS 验收私有证据必须包含公网 URL、合法路径、同源规则、健康检查、release readiness、登录、短会、分享、密码重置、Apple 通知和无密钥泄露；`deployment:verify` 可先生成草稿，但人工项必须补齐。",
          status:
            packageScriptExists("deployment:acceptance:evidence") &&
            packageScriptExists("smoke:deployment-evidence") &&
            fileExists("scripts/check-public-deployment-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-public-deployment-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("deployment:acceptance:evidence") && packageScriptExists("smoke:deployment-evidence")
              ? "`npm run smoke:deployment-evidence` 已配置；`npm run deployment:evidence:draft` 可生成私有草稿，人工补齐后用 `npm run deployment:acceptance:evidence` 检查。"
              : "缺少公网部署私有证据检查脚本。",
          nextAction: "公网 HTTPS 部署验证后，运行 `npm run deployment:evidence:draft` 生成 `.data/acceptance/public-deployment-latest.md`，补齐人工项，再运行 `npm run deployment:acceptance:evidence`。",
        }),
        item({
          id: "remote-object-storage-smoke",
          title: "远程对象存储 smoke",
          detail: "本地 S3 兼容服务覆盖完整会议 PUT/GET/LIST/DELETE 和当前对象版本的加密备份/隔离恢复；真实云桶 verifier 另要求显式授权、独立 namespace、私有访问和 finally 清理。",
          status: packageScriptExists("smoke:storage-remote") && packageScriptExists("storage:real:verify") && packageScriptExists("smoke:storage-real-verifier") && packageScriptExists("smoke:production-backup") && packageScriptExists("smoke:production-backup-offsite") && packageScriptExists("production:backup") && packageScriptExists("production:backup:replicate") && packageScriptExists("production:backup:freshness") && packageScriptExists("production:restore-drill") && fileExists("scripts/smoke-remote-object-store.mjs") && fileExists("scripts/verify-real-object-storage.mjs") && fileExists("scripts/smoke-real-object-storage-verifier.mjs") && fileExists("scripts/production-backup.mjs") && fileExists("scripts/production-backup-replicate.mjs") && fileExists("scripts/check-production-backup-freshness.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:storage-remote") && packageScriptExists("storage:real:verify") && packageScriptExists("smoke:production-backup-offsite") ? "远程对象协议、加密备份、独立 S3 复制、完整回读校验、freshness 和隔离恢复命令已配置；真实业务桶使用 `OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE=1 npm run storage:real:verify`。" : "缺少远程对象存储或异地备份恢复验收命令。",
          nextAction: packageScriptExists("storage:real:verify") ? "真实私有桶开通后配置 OWNMINUTES_STORAGE_PREFIX，并执行显式授权的云端 verifier。" : "补真实云桶隔离验收器。",
        }),
        item({
          id: "meeting-write-coordination-smoke",
          title: "跨实例会议写入一致性 smoke",
          detail: "验证两个 App 实例并发上传不会覆盖 manifest，删除 tombstone 会阻止迟到分片和会后结果重新创建对象。",
          status:
            packageScriptExists("smoke:meeting-write-coordination") &&
            packageScriptExists("smoke:meeting-write-coordination-runtime") &&
            fileExists("scripts/smoke-meeting-write-coordination.mjs") &&
            fileExists("scripts/smoke-meeting-write-coordination-runtime.mjs") &&
            fileExists("src/lib/server/meeting-write-lock.ts") &&
            fileExists("src/lib/server/postgres-runtime.ts") &&
            fileExists("db/migrations/0009_meeting_deletion_tombstones.sql")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:meeting-write-coordination-runtime")
            ? "静态 smoke 与真实 PostgreSQL 双 Next 实例 runtime smoke 已配置，覆盖 advisory lock、并发分片、精确 manifest、删除 tombstone 和迟到上传 410。"
            : "缺少跨实例会议写入 runtime smoke。",
          nextAction: "后续改会议分片、manifest、结果保存、删除、PostgreSQL pool 或远程对象存储时必须运行。",
        }),
        item({
          id: "object-storage-production-preflight-smoke",
          title: "对象存储生产 preflight smoke",
          detail: "验证对象存储上线前置脚本会阻止缺失 provider、bucket、endpoint、凭证、生命周期、删除证明、成本预算或本地库存决策的配置进入生产。",
          status:
            packageScriptExists("storage:preflight") &&
            packageScriptExists("smoke:storage-preflight") &&
            fileExists("scripts/check-object-storage-production-env.mjs") &&
            fileExists("scripts/smoke-object-storage-production-preflight.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:storage-preflight")
            ? "`npm run smoke:storage-preflight` 已配置，并覆盖缺环境、只配置 bucket、完整 S3/R2/火山 TOS 三种 provider。"
            : "缺少 `npm run smoke:storage-preflight`。",
          nextAction: "生产切换远程对象存储前必须在同一部署环境运行 `npm run storage:preflight`。",
        }),
        item({
          id: "object-storage-evidence-smoke",
          title: "对象存储私有证据检查 smoke",
          detail: "验证真实对象存储验收私有证据必须覆盖生产 preflight、远程 PUT/GET/LIST/DELETE、manifest、音频分片、结果、Markdown、会议删除、账号删除、私有访问、最小权限、恢复读取、生命周期和成本预算。",
          status:
            packageScriptExists("storage:acceptance:evidence") &&
            packageScriptExists("smoke:storage-evidence") &&
            fileExists("scripts/check-object-storage-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-object-storage-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("storage:acceptance:evidence") && packageScriptExists("smoke:storage-evidence")
              ? "`npm run smoke:storage-evidence` 已配置；真实证据保存在 `.data/acceptance/object-storage-latest.md` 后用 `npm run storage:acceptance:evidence` 检查。"
              : "缺少对象存储私有证据检查脚本。",
          nextAction: "真实 S3/R2/TOS bucket 验收后，把脱敏证据保存到 `.data/acceptance/object-storage-latest.md`，运行 `npm run storage:acceptance:evidence`。",
        }),
        item({
          id: "mobile-ui-smoke",
          title: "Expo iOS 主屏 UI smoke",
          detail: "防止 Expo App 四 Tab 信息架构、当前会议主卡、底部固定主录音按钮、实时转写/会议纪要分段、会议、设置和账号入口回退。",
          status: packageScriptExists("smoke:mobile-ui") && fileExists("scripts/smoke-mobile-ui.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:mobile-ui") ? "`npm run smoke:mobile-ui` 已配置。" : "缺少 `npm run smoke:mobile-ui`。",
          nextAction: "后续改 `apps/mobile/App.tsx` 主屏、Tab、录音主控台或移动端信息架构时必须运行。",
        }),
        item({
          id: "ios-simulator-ui-smoke",
          title: "iOS Simulator 截图 smoke",
          detail: "在已启动的 iOS Simulator 中打开 Expo Go 预览并保存主屏截图，防止只靠静态源码判断移动端 UI。",
          status: packageScriptExists("smoke:ios-simulator-ui") && fileExists("scripts/smoke-ios-simulator-ui.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:ios-simulator-ui")
            ? iosSimulatorScreenshotEvidence
            : "缺少 `npm run smoke:ios-simulator-ui`。",
          nextAction: "后续改 Expo iOS 首屏视觉、Safe Area、底部 Tab 或录音主面板时，在模拟器可用时运行并人工查看截图。",
        }),
        item({
          id: "testflight-config-smoke",
          title: "TestFlight 配置 smoke",
          detail: "验证 Expo iOS Bundle ID、麦克风权限、EAS store profile、本地 Xcode App Store 归档、根目录构建脚本和 TestFlight 文档保持一致。",
          status:
            packageScriptExists("smoke:testflight-config") &&
            packageScriptExists("smoke:ios-local-testflight-script") &&
            packageScriptExists("mobile:ios:local:build") &&
            fileExists("scripts/smoke-testflight-config.mjs") &&
            fileExists("scripts/build-ios-local-testflight.mjs") &&
            fileExists("apps/mobile/eas.json")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("smoke:testflight-config") && packageScriptExists("smoke:ios-local-testflight-script")
              ? "EAS 与本地 Xcode 两条 TestFlight 构建路径均有 smoke；本地路径验证 App Store profile、签名、build number 和内置 API 默认值。"
              : "缺少 TestFlight 配置或本地 Xcode 构建 smoke。",
          nextAction: "后续改 Expo/EAS/本地 Xcode/TestFlight、Bundle ID、权限文案或构建脚本时必须运行两套 smoke。",
        }),
        item({
          id: "testflight-preflight-smoke",
          title: "TestFlight 公网 URL preflight smoke",
          detail: "验证 TestFlight 构建前置脚本会拦截缺失环境、仅配置 API、localhost、LAN、公网 HTTP 和错误合规路径，只允许完整公网 HTTPS URL 集合通过。",
          status: packageScriptExists("smoke:testflight-preflight") && fileExists("scripts/smoke-mobile-testflight-preflight.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:testflight-preflight") ? "`npm run smoke:testflight-preflight` 已配置。" : "缺少 `npm run smoke:testflight-preflight`。",
          nextAction: "后续改 TestFlight 构建前置脚本、公网 URL、合规 URL 或移动端 API 配置时必须运行。",
        }),
        item({
          id: "ios-appstore-upload-smoke",
          title: "App Store Connect 本地上传 smoke",
          detail: "验证本地候选包可在不依赖 EAS 的情况下完成 App Store Connect 校验/上传，并拒绝签名探测包、篡改 IPA、脏或过期 commit、本地 API、权限过宽私钥和未显式授权上传。",
          status:
            packageScriptExists("mobile:ios:local:upload-preflight") &&
            packageScriptExists("mobile:ios:local:validate") &&
            packageScriptExists("mobile:ios:local:upload") &&
            packageScriptExists("mobile:ios:local:upload-evidence") &&
            packageScriptExists("smoke:ios-appstore-upload") &&
            fileExists("scripts/upload-ios-local-testflight.mjs") &&
            fileExists("scripts/check-ios-appstore-upload-evidence.mjs") &&
            fileExists("scripts/smoke-ios-appstore-upload.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:ios-appstore-upload")
            ? "`npm run smoke:ios-appstore-upload` 已配置；真实上传必须使用正式 candidate、0600 App Store Connect p8 和双重上传授权，并生成私有脱敏 delivery receipt。"
            : "缺少 App Store Connect 本地上传与私有回执检查工具。",
          nextAction: "稳定公网候选构建完成后，依次运行本地 upload preflight、Apple validate、upload 和 upload-evidence，再进入真实 iPhone TestFlight 验收。",
        }),
        item({
          id: "ios-testflight-runbook",
          title: "iOS TestFlight 验收 runbook",
          detail: "明确 TestFlight 安装、API Base URL、麦克风权限、5/30/90 分钟录音、弱网恢复、分享 Markdown 和账号删除的真机验收步骤。",
          status: packageScriptExists("smoke:ios-testflight-runbook") && fileExists("docs/ios-testflight-acceptance-runbook.md") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:ios-testflight-runbook") ? "`npm run smoke:ios-testflight-runbook` 已配置。" : "缺少 `npm run smoke:ios-testflight-runbook`。",
          nextAction: "进入 TestFlight 前按 runbook 跑模拟器和真实 iPhone 验收，并记录脱敏证据。",
        }),
        item({
          id: "ios-testflight-evidence-smoke",
          title: "iOS TestFlight 真机证据检查 smoke",
          detail: "验证私有 TestFlight/iPhone 验收证据必须覆盖模拟器、5/30/90 分钟、弱网、离线恢复、切后台风险、安装来源、崩溃状态、内存/电量观察、音频回放、分享 Markdown 和账号删除，并禁止密钥泄露。",
          status:
            packageScriptExists("ios:testflight:evidence") &&
            packageScriptExists("ios:testflight:evidence:draft") &&
            packageScriptExists("smoke:ios-testflight-evidence") &&
            fileExists("scripts/check-ios-testflight-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-ios-testflight-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("ios:testflight:evidence") && packageScriptExists("ios:testflight:evidence:draft") && packageScriptExists("smoke:ios-testflight-evidence")
              ? "`npm run smoke:ios-testflight-evidence` 已配置；可先运行 `npm run ios:testflight:evidence:draft` 生成 `.data/acceptance/ios-testflight-latest.md` 草稿。草稿必须保持 pending，直到真实证据逐场景记录安装来源、启动、API 持久化、麦克风权限、崩溃、内存/电量、音频回放和转写/纪要边界后，才能用 `npm run ios:testflight:evidence` 通过。"
              : "缺少 TestFlight 私有证据检查脚本。",
          nextAction: "先运行 `npm run ios:testflight:evidence:draft` 建立草稿；真实 iPhone/TestFlight 验收后填入脱敏证据，再运行 `npm run ios:testflight:evidence`。",
        }),
        item({
          id: "mobile-stability-smoke",
          title: "移动端录制稳定性与恢复 smoke",
          detail: "防止 Expo iOS 丢失后台录音原生配置、固定帧 PCM/CAF 中断可恢复录音、文档目录持久音频、多会议恢复队列、系统音频重置处理、暂停 PCM 语义、后端检查、麦克风权限、Keep Awake、原始音频导出和上传队列提示。",
          status:
            packageScriptExists("smoke:mobile-stability") &&
            fileExists("scripts/smoke-mobile-stability-panel.mjs") &&
            fileExists("scripts/smoke-mobile-interrupted-recording-recovery.mjs") &&
            fileExists("apps/mobile/src/interrupted-recording-recovery.ts")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:mobile-stability")
            ? "`npm run smoke:mobile-stability` 已配置，覆盖 16kHz mono 16-bit PCM/CAF、中断录音禁止自动上传、文件稳定性双探测、原生播放器可读性、权威时长恢复和失败保留原文件。"
            : "缺少 `npm run smoke:mobile-stability`。",
          nextAction: "后续改 `apps/mobile/App.tsx` 或 Expo Audio 配置时必须运行，并继续做真实 iPhone 锁屏、切后台、来电和 5/30/90 分钟长录音验收。",
        }),
        item({
          id: "mobile-recording-storage-guard-smoke",
          title: "移动端录音存储保护 smoke",
          detail: "验证开始录音前检查设备剩余空间，录音中持续监测，低于安全阈值或达到单场时长上限时只执行一次自动结束，并且只在本地恢复索引写入成功后宣称已保留。",
          status:
            packageScriptExists("smoke:mobile-recording-storage") &&
            fileExists("scripts/smoke-mobile-recording-storage.mjs") &&
            fileExists("apps/mobile/src/recording-storage.ts")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:mobile-recording-storage")
            ? "`npm run smoke:mobile-recording-storage` 已配置，覆盖 PCM 32,000 B/s 与 120 分钟体积预算、默认 256 MiB 上传边界、512 MiB 开始门槛、1 GiB 预警、128 MiB 空间保护、110 分钟会话提醒、原生后台时长上限、暂停计入墙钟上限、完成/编码错误事件状态机、本地文件时长探测和 120 分钟单次自动结束，以及探测失败不删录音和恢复索引先于成功文案。"
            : "缺少移动端录音存储保护 smoke。",
          nextAction: "后续改录音启动、停止、时长上限、本地恢复索引或文件系统时必须运行，并在真实 iPhone 低空间和接近时长上限环境中确认自动结束后可回放。",
        }),
        item({
          id: "mobile-recording-index-durability-smoke",
          title: "移动端录音索引耐久性 smoke",
          detail: "验证本地录音索引采用临时文件提交和安全备份，主索引损坏或提交中断时可恢复，并且并发读改写不会互相覆盖；主索引与备份都损坏时必须失败关闭且保留原文件。",
          status:
            packageScriptExists("smoke:mobile-recording-index") &&
            fileExists("scripts/smoke-mobile-recording-index-durability.mjs") &&
            fileExists("apps/mobile/src/atomic-recording-index.ts")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:mobile-recording-index")
            ? "`npm run smoke:mobile-recording-index` 已配置，覆盖安全备份刷新、损坏主索引恢复、提交中断恢复、双损坏失败关闭和 20 路并发写串行化。"
            : "缺少移动端录音索引耐久性 smoke。",
          nextAction: "后续改本地录音目录、恢复索引、待上传队列或账号删除时必须运行。",
        }),
        item({
          id: "mobile-offline-session-smoke",
          title: "移动端离线冷启动 smoke",
          detail: "验证已在线登录的用户在 24 小时内断网冷启动时仍可进入录音工作台；仅 401/403 清除会话，网络错误和服务端临时故障保留本机会话与录音。",
          status:
            packageScriptExists("smoke:mobile-offline-session") &&
            fileExists("scripts/smoke-mobile-offline-session.mjs") &&
            fileExists("apps/mobile/src/offline-session.ts")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:mobile-offline-session")
            ? "`npm run smoke:mobile-offline-session` 已配置，覆盖 24 小时有效期、服务地址绑定、畸形数据拒绝、401/403 失效、断网/500 保留以及退出和删号清理。"
            : "缺少移动端离线冷启动 smoke。",
          nextAction: "后续改登录恢复、API 地址、退出、删号或离线录音入口时必须运行，并继续在真实 iPhone 上验证断网冷启动。",
        }),
        item({
          id: "mobile-runtime-session-recovery-smoke",
          title: "移动端运行中会话失效恢复 smoke",
          detail: "验证在线会话定时复核；空闲时 401/403 返回登录，录音中则继续本地保存并在结束后要求重登；实时草稿和待同步队列停止无意义重试但不删除原音频。",
          status:
            packageScriptExists("smoke:mobile-runtime-session") &&
            fileExists("scripts/smoke-mobile-runtime-session-recovery.mjs") &&
            fileExists("apps/mobile/src/session-recovery.ts")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:mobile-runtime-session")
            ? "`npm run smoke:mobile-runtime-session` 已配置，动态覆盖 401/403、录音中延迟退出、5xx/网络错误保留，并检查上传队列与实时草稿的录音优先边界。"
            : "缺少移动端运行中会话失效恢复 smoke。",
          nextAction: "后续改鉴权、实时上传、会后续传、退出或录音生命周期时必须运行，并在当前 Release 模拟器中验证失效账号的空闲与录音中路径。",
        }),
        item({
          id: "mobile-realtime-chunks-smoke",
          title: "移动端实时分片接口 smoke",
          detail: "验证移动端 PCM 实时分片能推送到独立草稿接口，格式异常会记录为 rejected_format，并且不会污染会后正式音频 manifest。",
          status:
            packageScriptExists("smoke:mobile-realtime") &&
            fileExists("scripts/smoke-mobile-realtime-chunks.mjs") &&
            fileExists("scripts/smoke-mobile-native-realtime-upload.mjs") &&
            fileExists("src/lib/server/realtime-chunk-request.ts")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:mobile-realtime")
            ? "`npm run smoke:mobile-realtime` 已配置，覆盖浏览器 multipart 与原生 binary PCM、临时文件清理、有效分片、用户级 Provider、pending_protocol、rejected_format、失败隔离、无密钥泄露和正式会议 manifest 不污染。"
            : "缺少 `npm run smoke:mobile-realtime`。",
          nextAction: "后续改实时分片接口、移动端 PCM 推送、弱网重试或 ASR adapter 时必须运行。",
        }),
        item({
          id: "summary-structure-smoke",
          title: "纪要结构化 smoke",
          detail: "验证会后纪要模型返回的 JSON 能稳定归一为摘要、主题、发言人观点、决策、待办、风险、未解决问题和知识点。",
          status: packageScriptExists("smoke:summary") && fileExists("scripts/smoke-summary-structure.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:summary") ? "`npm run smoke:summary` 已配置。" : "缺少 `npm run smoke:summary`。",
          nextAction: "后续改 Ark 总结 prompt、MeetingSummary schema、Markdown 输出或模型 provider 时必须运行。",
        }),
        item({
          id: "summary-production-preflight-smoke",
          title: "纪要模型生产 preflight smoke",
          detail:
            "验证正式纪要模型上线前置脚本会阻止缺少 Ark Key、模型、HTTPS Base URL、JSON-only 策略、幻觉处理策略、重试策略或人工复核策略的配置进入生产。",
          status:
            packageScriptExists("summary:preflight") &&
            packageScriptExists("smoke:summary-preflight") &&
            fileExists("scripts/check-summary-production-env.mjs") &&
            fileExists("scripts/smoke-summary-production-preflight.mjs")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:summary-preflight")
            ? "`npm run smoke:summary-preflight` 已配置，覆盖缺环境、Ark-only、HTTP Base URL 和完整 Ark 配置。"
            : "缺少 `npm run smoke:summary-preflight`。",
          nextAction: "在生产候选环境运行 `npm run summary:preflight`，再用真实中文逐字稿人工比对摘要、决策、待办、风险和 Markdown。",
        }),
        item({
          id: "summary-evidence-smoke",
          title: "纪要质量私有证据检查 smoke",
          detail: "验证真实纪要模型验收私有证据必须覆盖真实中文逐字稿、逐字稿质量、抽样引用、结构化 JSON、字段覆盖、摘要、主题、发言人观点、决策、待办、风险、未解决问题、知识点、低置信处理、无占位/兜底伪装、Markdown、分享页、人工复核、重复生成差异阈值、pending 草稿拒绝和无密钥泄露。",
          status:
            packageScriptExists("summary:acceptance:evidence") &&
            packageScriptExists("smoke:summary-evidence") &&
            fileExists("scripts/check-summary-acceptance-evidence.mjs") &&
            fileExists("scripts/smoke-summary-acceptance-evidence.mjs")
              ? "ready"
              : "blocked",
          evidence:
            packageScriptExists("summary:acceptance:evidence") && packageScriptExists("smoke:summary-evidence")
              ? "`npm run smoke:summary-evidence` 已配置；先运行 `npm run summary:acceptance:evidence:draft` 生成 `.data/acceptance/summary-latest.md` 草稿，草稿必须保持 pending 且正式 checker 会拒绝；填入真实证据后用 `npm run summary:acceptance:evidence` 检查，必须记录逐字稿质量、至少 3 条逐字稿样本、至少 5 条 grounding 样本、低置信处理和重复生成差异阈值。"
              : "缺少纪要质量私有证据检查脚本。",
          nextAction: "先运行 `npm run summary:acceptance:evidence:draft` 生成草稿；真实总结模型验收后，把脱敏证据保存到 `.data/acceptance/summary-latest.md`，运行 `npm run summary:acceptance:evidence`。",
        }),
        item({
          id: "transcript-quality-smoke",
          title: "转写质量诊断 smoke",
          detail: "验证空转写、系统占位转写和过短转写不会被当成可用正式逐字稿，也不会继续调用模型生成看似正式的纪要。",
          status: packageScriptExists("smoke:transcript-quality") && fileExists("scripts/smoke-transcript-quality.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:transcript-quality") ? "`npm run smoke:transcript-quality` 已配置。" : "缺少 `npm run smoke:transcript-quality`。",
          nextAction: "后续改会后 ASR、fallback transcript、Ark 总结或 finalize 流程时必须运行。",
        }),
        item({
          id: "meeting-result-quality-smoke",
          title: "会议结果质量标识 smoke",
          detail: "验证 mock、fallback、占位逐字稿或缺少总结模型时，公开分享页和 Markdown 不能把结果呈现为已验证正式纪要。",
          status: packageScriptExists("smoke:result-quality") && fileExists("scripts/smoke-meeting-result-quality.mjs") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:result-quality") ? "`npm run smoke:result-quality` 已配置。" : "缺少 `npm run smoke:result-quality`。",
          nextAction: "后续改分享页、公开 Markdown、会后结果结构或质量门禁时必须运行。",
        }),
        item({
          id: "finalization-recovery-smoke",
          title: "会后处理恢复与 API 质量确认 smoke",
          detail: "验证会后处理状态持久化、并发请求去重、幂等重试、用量只记一次、会议列表/详情可恢复状态、删除清理，以及未验证纪要不能绕过 API 人工确认直接公开。",
          status:
            packageScriptExists("smoke:finalization-recovery") &&
            fileExists("scripts/smoke-finalization-recovery.mjs") &&
            fileExists("src/lib/server/meeting-finalizer.ts") &&
            fileExists("src/lib/server/meeting-finalization-state.ts")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:finalization-recovery")
            ? "`npm run smoke:finalization-recovery` 已配置，覆盖 processing.json、并发去重、幂等恢复、用量去重、显式未验证分享确认和删除一致性。"
            : "缺少会后处理恢复 smoke。",
          nextAction: "后续改 finalize、会议处理状态、移动端上传恢复、分享 API 质量门禁或用量记录时必须运行。",
        }),
        item({
          id: "finalization-queue-smoke",
          title: "PostgreSQL 会后任务队列 smoke",
          detail: "验证长时间 ASR/总结可以通过 PostgreSQL 持久队列、原子抢占、租约心跳、崩溃回收、有限重试和 Web/iOS 轮询脱离 finalize HTTP 生命周期。",
          status:
            packageScriptExists("smoke:finalization-queue") &&
            packageScriptExists("smoke:finalization-queue-runtime") &&
            fileExists("scripts/smoke-finalization-queue.mjs") &&
            fileExists("scripts/smoke-finalization-queue-runtime.mjs") &&
            fileExists("db/migrations/0008_meeting_finalization_jobs.sql") &&
            fileExists("src/lib/server/finalization-queue.ts") &&
            fileExists("src/instrumentation.ts") &&
            fileExists("docs/finalization-queue-runbook.md")
              ? "ready"
              : "blocked",
          evidence: packageScriptExists("smoke:finalization-queue")
            ? "`smoke:finalization-queue` 与真实临时 PostgreSQL `smoke:finalization-queue-runtime` 已配置，覆盖队列表、SKIP LOCKED、租约心跳、崩溃回收、有限重试、删除取消、202 API 和客户端轮询。"
            : "缺少 PostgreSQL 会后任务队列 smoke。",
          nextAction: "真实 PostgreSQL 到位后，按 runbook 验证双 Worker 抢占、进程崩溃回收、重试耗尽、结果/用量幂等和删除一致性。",
        }),
      ],
    },
    {
      id: "ai",
      title: "模型与识别",
      items: [
        item({
          id: "file-asr",
          title: "会后 ASR",
          detail: "正式纪要依赖完整音频会后识别。",
          status: fileAsrReady ? "ready" : "blocked",
          evidence: fileAsrReady
            ? "Provider diagnostic and ASR production preflight evidence are ready."
            : `会后 ASR 缺少：${fileAsrProduction.missing.join(", ") || providerDiagnostic.missing.join(", ") || "ASR 生产证据"}`,
          nextAction: fileAsrReady
            ? "用真实中文会议录音做准确率抽样，并按 ASR 验收模板保存脱敏证据。"
            : fileAsrRuntimeReady
              ? `ASR 运行时已配置；继续补齐生产验收项：${fileAsrProduction.missing.join("、") || "真实人声会议与质量抽样证据"}。`
              : "补齐 ASR 运行时凭证、HTTPS endpoint、真实音频证据、质量抽样、fallback 和隐私策略。",
        }),
        item({
          id: "realtime-asr",
          title: "实时 ASR",
          detail: "会议中转写应只作为草稿，但仍需要真实实时链路。",
          status: realtimeAsrReady ? "warning" : "blocked",
          evidence: realtimeAsrReady
            ? "Realtime WebSocket protocol is implemented, still needs pressure test."
            : realtimeAsrConfigured
              ? "实时 ASR 字段已配置，但 WebSocket 协议仍未实现和压测，不能视为生产可用。"
              : "当前实时 ASR 协议仍未视为生产可用。",
          nextAction: realtimeAsrConfigured
            ? "实时 WebSocket 协议已实现；继续完成弱网、断线恢复、1-3 分钟真实会议和失败不影响本地录音的验收证据。"
            : "先补齐实时 ASR API Key/Token 和 WebSocket URL，再实现并压测火山实时 WebSocket ASR。",
        }),
        item({
          id: "summary-model",
          title: "纪要总结模型",
          detail: "逐字稿需要稳定生成摘要、决策、待办、风险和 Markdown。",
          status: summaryReady ? "ready" : "blocked",
          evidence: summaryReady
            ? "Provider diagnostic reports summary production guardrails ready."
            : `总结模型缺少：${summaryMissing.join(", ") || "ARK_API_KEY + ARK_CHAT_MODEL + summary guardrails"}`,
          nextAction: summaryReady
            ? "用真实中文逐字稿人工比对摘要、决策、待办、风险和 Obsidian Markdown，并抽样检查幻觉。"
            : "补齐 ARK_API_KEY、ARK_CHAT_MODEL、HTTPS Base URL、JSON-only、幻觉处理、重试和人工复核策略。",
        }),
        item({
          id: "speaker-diarization",
          title: "说话人识别",
          detail: "第一版可以使用 Speaker 1/2 占位，但正式发布必须证明会后说话人分离、人工改名、逐段归属校正和质量抽样流程可用。",
          status: speakerDiarization.ready ? "ready" : "blocked",
          evidence: speakerDiarization.ready
            ? "会后 ASR、说话人分离证据、全局改名、逐段归属校正和质量抽样策略已具备。"
            : `说话人识别缺少：${speakerDiarization.missing.join(", ")}`,
          nextAction: speakerDiarization.ready
            ? "用真实双人/多人会议抽样确认 Speaker 标签、全局改名、逐段归属校正、待办归属和 Markdown/分享页展示一致。"
            : "补齐会后 ASR、双人/多人真实音频证据、Speaker 标签抽样、会后改名/逐段归属校正流程和不承诺 100% 准确的用户提示。",
        }),
      ],
    },
    {
      id: "commercial",
      title: "商业化与账号",
      items: [
        item({
          id: "auth-accounts",
          title: "账号体系",
          detail: "支持注册、邮箱验证、登录、修改密码、找回密码、登录/注册/验证/重置限流、删除账号、数据导出和用户明细后台；公开注册不能获得管理员权限。",
          status: emailDiagnostics.productionReady ? "ready" : "warning",
          evidence: emailDiagnostics.productionReady
            ? "烟测覆盖注册邮箱验证、修改密码、找回密码、登录/注册/验证/重置限流、删除和安全管理员 bootstrap；邮件发送 provider 与强制验证已配置。"
            : `烟测覆盖注册邮箱验证、修改密码、找回密码、登录/注册/验证/重置限流、删除和安全管理员 bootstrap；邮件服务缺少：${emailDiagnostics.missing.join(", ")}`,
          nextAction: emailDiagnostics.productionReady
            ? "在同一公网部署完成真实注册验证与密码重置送达测试，并持续监控退信/投诉。"
            : "配置 Resend、验证发信域名、发件人、公网 App URL 和强制邮箱验证；生产环境不要依赖开发 token。",
        }),
        item({
          id: "admin-metrics",
          title: "后台增长指标",
          detail: "后台可看用户量、Provider 配置、首场会议、付费路径和漏斗。",
          status: "ready",
          evidence: "/api/admin/metrics 和 smoke:admin 已覆盖。",
          nextAction: "接入真实埋点和留存/分享访问统计。",
        }),
        item({
          id: "payments",
          title: "Apple IAP / 订单",
          detail: "App Store 免费下载后，省心额度和会员需要合规购买路径。",
          status: paymentDiagnostics.productionReady ? "warning" : "blocked",
          evidence: paymentDiagnostics.productionReady
            ? "检测到 Apple IAP、商品、根证书、公网通知 URL、交易校验、权益映射、退款、幂等、沙盒生命周期和账本证据，仍需人工复核。"
            : `当前支付 provider=${paymentDiagnostics.provider}；缺少：${paymentDiagnostics.missing.join(", ")}；后台人工发放仅作为 IAP 前的运营过渡。`,
          nextAction: "接入 Apple IAP、服务端票据校验、订单同步、退款和自动权益回收，并补 Plus/Pro 购买、续期、退款、过期/撤销和账本脱敏证据。",
        }),
      ],
    },
    {
      id: "production",
      title: "生产基础设施",
      items: [
        item({
          id: "database",
          title: "生产数据库",
          detail: "账号、会议、用量、Provider 配置和后台指标不能长期放本地 JSON。",
          status: databaseDiagnostics.productionReady ? "warning" : "blocked",
          evidence: databaseDiagnostics.productionReady
            ? "检测到 PostgreSQL、migration、备份和最小权限配置，仍需真实演练。"
            : `当前数据库 provider=${databaseDiagnostics.provider}；缺少：${databaseDiagnostics.missing.join(", ")}`,
          nextAction: "迁移到 PostgreSQL，补 migration、备份、恢复和最小权限账号。",
        }),
        item({
          id: "finalization-queue-runtime",
          title: "会后处理持久队列",
          detail: "长时间 ASR 和总结必须脱离 finalize HTTP 生命周期，并支持多 Worker 原子抢占、崩溃回收和有限重试。",
          status: finalizationQueue.productionReady && finalizationQueue.workerEnabled ? "warning" : "blocked",
          evidence:
            finalizationQueue.productionReady && finalizationQueue.workerEnabled
              ? "检测到 PostgreSQL queue 和 Node Worker 环境，仍需真实双 Worker、崩溃回收、重试耗尽和幂等证据。"
              : `当前 finalization mode=${finalizationQueue.mode}，worker=${finalizationQueue.workerEnabled ? "enabled" : "disabled"}；生产需要 postgres-queue + PostgreSQL auth repository + worker。`,
          nextAction: "在真实 PostgreSQL 和 stateful Node 上启用 postgres-queue，完成双 Worker 抢占、崩溃回收、有限重试、结果/用量幂等和删除一致性验收。",
        }),
        item({
          id: "object-storage",
          title: "音频对象存储",
          detail: "会议音频和分片需要对象存储、生命周期、删除一致性和成本控制。",
          status: storageDiagnostics.productionReady ? "warning" : "blocked",
          evidence: storageDiagnostics.productionReady
            ? `检测到 ${storageDiagnostics.provider} 对象存储配置、PostgreSQL 跨实例写锁、删除 tombstone、私有访问、最小权限、恢复读取、删除证明、生命周期和成本预算声明，仍需真实云端证据。`
            : `当前音频仍落本地 ${storageDiagnostics.localDataDir}；缺少：${storageDiagnostics.missing.join(", ")}`,
          nextAction: "接入 S3/R2/火山对象存储与 PostgreSQL 跨实例会议写锁，并验证并发分片完整、删除不复活、私有访问、最小权限、恢复读取、账号删除和生命周期策略。",
        }),
        item({
          id: "secret-management",
          title: "Vault / 密钥管理",
          detail: "用户 BYOK 密钥必须租户级加密、可轮换、不可回显。",
          status: secretDiagnostics.productionReady ? "warning" : "blocked",
          evidence: secretDiagnostics.productionReady
            ? `检测到 ${secretDiagnostics.provider}、轮换、租户隔离、审计、删除证明、管理员不可见、解密失败审计和备份恢复配置，仍需真实演练。`
            : `当前密钥 provider=${secretDiagnostics.provider}；缺少：${secretDiagnostics.missing.join(", ")}`,
          nextAction: "部署真实 Vault Transit，运行在线 verifier，并补轮换、删除、管理员不可见、解密失败审计和备份恢复演练。",
        }),
      ],
    },
    {
      id: "compliance",
      title: "合规与上架",
      items: [
        item({
          id: "legal-pages",
          title: "隐私/条款/支持页面",
          detail: "App Store 和公开下载需要可访问的隐私政策、服务条款和支持入口。",
          status: legalPagesReady() ? "ready" : "blocked",
          evidence: legalPagesReady()
            ? "`npm run smoke:legal` 已覆盖隐私、条款、支持页面关键说明、法律导航和无密钥泄露。"
            : "缺少合规页面或 `smoke:legal`。",
          nextAction: "正式上架前请用公网 HTTPS URL 发布，并按真实存储、模型 provider、支持联系方式和保留周期更新文本。",
        }),
        item({
          id: "data-deletion",
          title: "数据删除说明",
          detail: "用户必须能理解如何删除单场会议、撤销公开分享、删除账号、处理 BYOK 密钥和第三方导出副本。",
          status: packageScriptExists("smoke:data-deletion") && fileExists("scripts/smoke-data-deletion-page.mjs") && fileExists("src/app/data-deletion/page.tsx") ? "ready" : "blocked",
          evidence: packageScriptExists("smoke:data-deletion")
            ? "`npm run smoke:data-deletion` 已覆盖单场删除、账号删除、分享撤销、BYOK 密钥、生产保留边界和无密钥泄露。"
            : "缺少数据删除页面 smoke。",
          nextAction: "生产环境接入对象存储和备份后，按真实删除证明更新文本和验收证据。",
        }),
        item({
          id: "public-url",
          title: "公网 HTTPS URL",
          detail: "TestFlight/App Store 需要稳定可访问的支持、隐私政策和 API 地址。",
          status: deploymentDiagnostics.productionReady ? "warning" : "blocked",
          evidence: deploymentDiagnostics.productionReady
            ? "检测到公网 HTTPS App/API URL、合规 URL 和健康检查配置，仍需真实访问验证。"
            : `当前部署缺少：${deploymentDiagnostics.missing.join(", ")}`,
          nextAction: "部署到公网 HTTPS，并配置移动端 API base URL。",
        }),
      ],
    },
  ];
  const allItems = groups.flatMap((group) => group.items);
  const blockers = buildBlockers(groups);
  const criticalBlocked = blockers.filter((blocker) => blocker.priority === "critical").length;
  const mvpReady = areItemsReady(allItems, [
    "recording-workbench",
    "mobile-workbench-ui",
    "obsidian-export",
    "app-workspace-smoke",
    "recording-consent-smoke",
    "manual-acceptance-script",
    "manual-acceptance-export",
    "meetings-closed-loop-smoke",
    "share-confirmation-smoke",
    "obsidian-vault-smoke",
    "mobile-ui-smoke",
    "ios-simulator-ui-smoke",
    "mobile-stability-smoke",
    "mobile-realtime-chunks-smoke",
    "transcript-quality-smoke",
    "meeting-result-quality-smoke",
    "legal-pages",
    "data-deletion",
  ]);
  const testflightReady = mvpReady && criticalBlocked === 0;
  const summary = {
    ready: allItems.filter((reportItem) => reportItem.status === "ready").length,
    warning: allItems.filter((reportItem) => reportItem.status === "warning").length,
    blocked: allItems.filter((reportItem) => reportItem.status === "blocked").length,
    criticalBlocked,
    total: allItems.length,
    mvpReady,
    testflightReady,
    commercialReady: allItems.every((reportItem) => reportItem.status === "ready"),
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    groups,
    blockers,
    nextAction: buildNextAction(blockers, allItems),
  };
}

function areItemsReady(items: ReleaseReadinessItem[], requiredIds: string[]) {
  const itemById = new Map(items.map((reportItem) => [reportItem.id, reportItem]));
  return requiredIds.every((id) => itemById.get(id)?.status === "ready");
}

function getIosSimulatorScreenshotEvidence() {
  const screenshotPath = ".data/screenshots/ownminutes-ios-simulator-latest.png";
  const absolutePath = path.join(process.cwd(), screenshotPath);
  const configuredEvidence = "`npm run smoke:ios-simulator-ui` 已配置。";
  const caveat = "该截图来自 Expo Go 预览，可能包含 Expo Go 开发浮层；正式 TestFlight/App Store 包不会显示该浮层，视觉结论需结合人工查看。";

  try {
    if (!fs.existsSync(absolutePath)) {
      return `${configuredEvidence} 尚未发现本地截图证据 ${screenshotPath}；可在模拟器可用时运行 smoke 生成。${caveat}`;
    }

    const stats = fs.statSync(absolutePath);
    const dimensions = readPngDimensions(absolutePath);
    if (!dimensions) {
      return `${configuredEvidence} 已发现 ${screenshotPath}，但无法读取 PNG 尺寸；请重新运行截图 smoke。${caveat}`;
    }

    const sizeKb = Math.round(stats.size / 1024);
    return `${configuredEvidence} 最近截图 ${screenshotPath}：${dimensions.width}x${dimensions.height}，${sizeKb} KB，更新于 ${stats.mtime.toISOString()}。${caveat}`;
  } catch (error) {
    return `${configuredEvidence} 截图证据读取失败：${error instanceof Error ? error.message : "未知错误"}。${caveat}`;
  }
}

function readPngDimensions(filePath: string) {
  const buffer = fs.readFileSync(filePath);
  const pngSignature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== pngSignature) return null;

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function buildBlockers(groups: ReleaseReadinessGroup[]): ReleaseReadinessBlocker[] {
  return groups
    .flatMap((group) =>
      group.items
        .filter((reportItem) => reportItem.status === "blocked")
        .map((reportItem) => ({
          id: reportItem.id,
          groupId: group.id,
          groupTitle: group.title,
          title: reportItem.title,
          detail: reportItem.detail,
          evidence: reportItem.evidence,
          acceptanceEvidence: getBlockerAcceptanceEvidence(reportItem.id),
          nextAction: reportItem.nextAction,
          priority: getBlockerPriority(reportItem.id),
          runbook: reportItem.runbook ?? getDefaultRunbook(reportItem.id),
          verificationCommand: getBlockerVerificationCommand(reportItem.id),
        })),
    )
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
}

function buildNextAction(blockers: ReleaseReadinessBlocker[], items: ReleaseReadinessItem[]): ReleaseReadinessNextAction {
  const blocker = blockers[0];
  if (blocker) {
    return {
      title: blocker.title,
      detail: `${blocker.groupTitle} · ${blocker.detail}`,
      nextAction: blocker.nextAction,
      priority: blocker.priority,
      runbook: blocker.runbook,
    };
  }

  const warning = items.find((reportItem) => reportItem.status === "warning");
  if (warning) {
    return {
      title: warning.title,
      detail: warning.detail,
      nextAction: warning.nextAction,
      priority: "medium",
    };
  }

  return {
    title: "可以进入最终人工验收",
    detail: "当前 readiness 没有 blocked 或 warning 项。",
    nextAction: "安排真实会议录音、真实分享链接和 TestFlight/App Store 上架前人工验收。",
    priority: "none",
  };
}

function getDefaultRunbook(itemId: string): ReleaseReadinessRunbook | undefined {
  const runbooks: Record<string, ReleaseReadinessRunbook> = {
    "file-asr": {
      label: "ASR 运行时接入 Runbook",
      path: "docs/asr-runtime-runbook.md",
    },
    "realtime-asr": {
      label: "ASR 运行时接入 Runbook",
      path: "docs/asr-runtime-runbook.md",
    },
    "summary-model": {
      label: "ASR 运行时接入 Runbook",
      path: "docs/asr-runtime-runbook.md",
    },
    "speaker-diarization": {
      label: "ASR 运行时接入 Runbook",
      path: "docs/asr-runtime-runbook.md",
    },
    database: {
      label: "PostgreSQL 迁移 Runbook",
      path: "docs/postgres-migration-runbook.md",
    },
    "finalization-queue-runtime": {
      label: "会后任务队列 Runbook",
      path: "docs/finalization-queue-runbook.md",
    },
    "object-storage": {
      label: "对象存储 Runbook",
      path: "docs/object-storage-runbook.md",
    },
    "secret-management": {
      label: "密钥管理 Runbook",
      path: "docs/secret-management-runbook.md",
    },
    payments: {
      label: "Apple IAP Sandbox Runbook",
      path: "docs/apple-iap-sandbox-runbook.md",
    },
    "public-url": {
      label: "公网部署 Runbook",
      path: "docs/public-deployment-runbook.md",
    },
  };

  return runbooks[itemId];
}

export function getBlockerVerificationCommand(itemId: string) {
  const commands: Record<string, string> = {
    "file-asr":
      "npm run smoke:asr-preflight && npm run smoke:asr && npm run smoke:settings && npm run smoke:asr-runbook && npm run smoke:provider-closed-loop-script && npm run smoke:asr-acceptance-evidence && npm run smoke:asr-acceptance-collector && npm run smoke:asr-meeting-batch && npm run asr:meeting-batch:collect && npm run asr:meeting-batch:check && npm run asr:acceptance:collect && OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH=.data/acceptance/asr-meeting-batch-latest.json npm run asr:acceptance:evidence",
    "realtime-asr": "npm run smoke:realtime-preflight && npm run smoke:asr && npm run smoke:mobile-realtime && npm run smoke:settings && npm run smoke:asr-runbook",
    "summary-model":
      "npm run smoke:asr && npm run smoke:summary && npm run smoke:summary-preflight && npm run smoke:settings && npm run smoke:asr-runbook && npm run smoke:summary-evidence && npm run summary:acceptance:evidence:draft && OWNMINUTES_SUMMARY_EVIDENCE_PATH=.data/acceptance/summary-latest.md npm run summary:acceptance:evidence",
    "speaker-diarization":
      "npm run smoke:asr && npm run smoke:asr-acceptance && npm run smoke:asr-acceptance-evidence && npm run smoke:asr-acceptance-collector && npm run smoke:asr-meeting-batch && npm run asr:meeting-batch:collect && npm run asr:meeting-batch:check && npm run asr:acceptance:collect && npm run smoke:transcript-quality && npm run smoke:meetings && npm run smoke:asr-runbook && OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH=.data/acceptance/asr-meeting-batch-latest.json npm run asr:acceptance:evidence",
    payments:
      "npm run smoke:iap-preflight && npm run smoke:payments && npm run smoke:iap && npm run smoke:iap-verifier && npm run smoke:iap-runbook && npm run smoke:iap-evidence && npm run iap:acceptance:evidence:draft && OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/apple-iap-latest.md npm run iap:acceptance:evidence",
    database:
      "npm run smoke:production-backup && npm run smoke:production-backup-offsite && npm run production:backup && npm run production:backup:verify && npm run production:backup:replicate && npm run production:restore-drill && npm run production:backup:freshness && npm run smoke:database-preflight && npm run smoke:database-schema && npm run smoke:database-migrate && npm run smoke:database-runbook && npm run smoke:finalization-queue && npm run smoke:meeting-write-coordination && npm run smoke:auth-repository && npm run smoke:database && npm run smoke:database-evidence && npm run database:evidence:draft && OWNMINUTES_POSTGRES_EVIDENCE_PATH=.data/acceptance/postgres-latest.md npm run database:acceptance:evidence",
    "finalization-queue-runtime":
      "npm run smoke:finalization-queue && npm run smoke:database-schema && npm run smoke:database-migrate && npm run database:preflight && OWNMINUTES_POSTGRES_EVIDENCE_PATH=.data/acceptance/postgres-latest.md npm run database:acceptance:evidence",
    "object-storage":
      "npm run smoke:production-backup && npm run smoke:production-backup-offsite && npm run production:backup && npm run production:backup:verify && npm run production:backup:replicate && npm run production:restore-drill && npm run production:backup:freshness && npm run smoke:storage-preflight && npm run smoke:storage && npm run smoke:storage-remote && npm run smoke:meeting-write-coordination && npm run smoke:meeting-write-coordination-runtime && npm run smoke:storage-runbook && npm run smoke:storage-evidence && npm run storage:evidence:draft && OWNMINUTES_OBJECT_STORAGE_EVIDENCE_PATH=.data/acceptance/object-storage-latest.md npm run storage:acceptance:evidence",
    "secret-management":
      "npm run smoke:secret-preflight && npm run smoke:secret-vault-runtime && npm run smoke:secret-vault-repository && npm run smoke:secret-vault-live-verifier && npm run smoke:secrets && npm run smoke:secret-audit && npm run smoke:secret-runbook && npm run smoke:secret-evidence && OWNMINUTES_VAULT_LIVE_VERIFY=1 npm run secret:vault:live:verify && npm run secret:evidence:draft && OWNMINUTES_SECRET_EVIDENCE_PATH=.data/acceptance/secret-management-latest.md OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH=.data/acceptance/vault-transit-live-latest.json npm run secret:acceptance:evidence",
    "public-url":
      "npm run smoke:deployment && npm run smoke:deployment-preflight && npm run smoke:deployment-live && npm run smoke:deployment-runbook && npm run smoke:deployment-evidence && npm run deployment:evidence:draft && OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH=.data/acceptance/public-deployment-latest.md npm run deployment:acceptance:evidence",
  };

  return commands[itemId];
}

function getFileAsrProductionReadiness(runtimeReady: boolean, meetingBatch: { ready: boolean; missing: string[] }) {
  const configuredStrategy = process.env.OWNMINUTES_ASR_FILE_STRATEGY?.trim() || "";
  const strategyValid = configuredStrategy === "" || configuredStrategy === "single" || configuredStrategy === "standard_then_turbo";
  const strategy = configuredStrategy === "standard_then_turbo" ? "standard_then_turbo" : "single";
  const mode = process.env.VOLCANO_ASR_MODE?.trim() || "flash";
  const modeValid = mode === "standard" || mode === "flash";
  const recognizeUrl = process.env.VOLCANO_ASR_RECOGNIZE_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
  const submitUrl = process.env.VOLCANO_ASR_SUBMIT_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
  const queryUrl = process.env.VOLCANO_ASR_QUERY_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
  const primaryResourceId = process.env.VOLCANO_ASR_RESOURCE_ID || (mode === "standard" ? "volc.seedasr.auc" : "volc.bigasr.auc_turbo");
  const fallbackEnabled = process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED?.trim() || "";
  const fallbackEnabledValid = fallbackEnabled === "" || fallbackEnabled === "0" || fallbackEnabled === "1";
  const fallbackRecognizeUrl = process.env.VOLCANO_ASR_TURBO_RECOGNIZE_URL || "";
  const fallbackResourceId = process.env.VOLCANO_ASR_TURBO_RESOURCE_ID || "";
  const fallbackMaxAudioMinutes = process.env.OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES?.trim() || "30";
  const fallbackCapValid = isBoundedAsrFallbackMinutes(fallbackMaxAudioMinutes);
  const standardThenTurbo = strategy === "standard_then_turbo";
  const primaryResourceIsTurbo = isTurboAsrResource(primaryResourceId);
  const turboCostGuardRequired =
    standardThenTurbo || (strategy === "single" && (mode === "flash" || primaryResourceIsTurbo));
  const missing = [
    ...(process.env.TRANSCRIPTION_PROVIDER === "volcano" ? [] : ["TRANSCRIPTION_PROVIDER=volcano"]),
    ...(runtimeReady ? [] : ["VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN"]),
    ...(strategyValid ? [] : ["OWNMINUTES_ASR_FILE_STRATEGY=single|standard_then_turbo"]),
    ...(modeValid ? [] : ["VOLCANO_ASR_MODE=standard|flash"]),
    ...(mode === "flash" && !isOfficialVolcanoRuntimeEndpoint(recognizeUrl)
      ? ["VOLCANO_ASR_RECOGNIZE_URL_OFFICIAL_HTTPS"]
      : []),
    ...(mode === "standard" && !isOfficialVolcanoRuntimeEndpoint(submitUrl)
      ? ["VOLCANO_ASR_SUBMIT_URL_OFFICIAL_HTTPS"]
      : []),
    ...(mode === "standard" && !isOfficialVolcanoRuntimeEndpoint(queryUrl)
      ? ["VOLCANO_ASR_QUERY_URL_OFFICIAL_HTTPS"]
      : []),
    ...(primaryResourceId ? [] : ["VOLCANO_ASR_RESOURCE_ID"]),
    ...(standardThenTurbo && mode !== "standard" ? ["VOLCANO_ASR_MODE=standard"] : []),
    ...(mode === "standard" && primaryResourceIsTurbo ? ["non-Turbo VOLCANO_ASR_RESOURCE_ID"] : []),
    ...(fallbackEnabledValid ? [] : ["OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=0|1"]),
    ...(turboCostGuardRequired && fallbackEnabled !== "1" ? ["OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1"] : []),
    ...(standardThenTurbo && !isOfficialVolcanoRuntimeEndpoint(fallbackRecognizeUrl)
      ? ["VOLCANO_ASR_TURBO_RECOGNIZE_URL_OFFICIAL_HTTPS"]
      : []),
    ...(standardThenTurbo && !isTurboAsrResource(fallbackResourceId) ? ["Turbo VOLCANO_ASR_TURBO_RESOURCE_ID"] : []),
    ...(fallbackCapValid ? [] : ["OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES=1..30"]),
    ...(process.env.OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE ? [] : ["OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE"]),
    ...(process.env.OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY ? [] : ["OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY"]),
    ...(process.env.OWNMINUTES_ASR_FALLBACK_POLICY ? [] : ["OWNMINUTES_ASR_FALLBACK_POLICY"]),
    ...(process.env.OWNMINUTES_ASR_PRIVACY_POLICY ? [] : ["OWNMINUTES_ASR_PRIVACY_POLICY"]),
    ...(meetingBatch.ready ? [] : meetingBatch.missing),
  ];

  return {
    ready: missing.length === 0,
    missing,
  };
}

function isTurboAsrResource(value: string) {
  return value.trim().toLowerCase().includes("turbo");
}

function isBoundedAsrFallbackMinutes(value: string) {
  if (!/^\d+$/.test(value)) return false;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 30;
}

function getProviderClosedLoopEvidence() {
  const evidencePath = path.join(process.cwd(), ".data", "acceptance", "provider-closed-loop-latest.md");
  if (!fs.existsSync(evidencePath)) return { passed: false, checkedAt: "not available" };

  try {
    const contents = fs.readFileSync(evidencePath, "utf8");
    const checkedAt = contents.match(/^- Checked at:\s*(.+)$/m)?.[1]?.trim() || fs.statSync(evidencePath).mtime.toISOString();
    return {
      passed: contents.includes("- Decision: pass") && contents.includes("- adapterIsRealFileAsr: pass") && contents.includes("- accountDeleted: pass"),
      checkedAt,
    };
  } catch {
    return { passed: false, checkedAt: "unreadable" };
  }
}

function getSpeakerDiarizationReadiness(fileAsrReady: boolean, meetingBatch: { ready: boolean; missing: string[] }) {
  const speakerCorrectionWorkflowReady =
    fileExists("src/components/meeting-transcript-speaker-editor.tsx") &&
    fileExists("apps/mobile/App.tsx") &&
    packageScriptExists("smoke:meetings") &&
    packageScriptExists("smoke:mobile-ui");
  const missing = [
    ...(fileAsrReady ? [] : ["file-asr ready"]),
    ...(process.env.OWNMINUTES_SPEAKER_DIARIZATION_REAL_AUDIO_EVIDENCE ? [] : ["OWNMINUTES_SPEAKER_DIARIZATION_REAL_AUDIO_EVIDENCE"]),
    ...(process.env.OWNMINUTES_SPEAKER_DIARIZATION_QUALITY_SAMPLING_POLICY ? [] : ["OWNMINUTES_SPEAKER_DIARIZATION_QUALITY_SAMPLING_POLICY"]),
    ...(process.env.OWNMINUTES_SPEAKER_DIARIZATION_LABEL_REVIEW_POLICY ? [] : ["OWNMINUTES_SPEAKER_DIARIZATION_LABEL_REVIEW_POLICY"]),
    ...(process.env.OWNMINUTES_SPEAKER_RENAME_WORKFLOW ? [] : ["OWNMINUTES_SPEAKER_RENAME_WORKFLOW"]),
    ...(process.env.OWNMINUTES_SPEAKER_ASSIGNMENT_FALLBACK_POLICY ? [] : ["OWNMINUTES_SPEAKER_ASSIGNMENT_FALLBACK_POLICY"]),
    ...(process.env.OWNMINUTES_SPEAKER_LIMITATION_NOTICE ? [] : ["OWNMINUTES_SPEAKER_LIMITATION_NOTICE"]),
    ...(speakerCorrectionWorkflowReady ? [] : ["speaker-segment-correction-workflow"]),
    ...(meetingBatch.ready ? [] : meetingBatch.missing.map((item) => `speaker-${item}`)),
  ];

  return {
    ready: missing.length === 0,
    missing,
  };
}

function getAsrMeetingBatchReadiness() {
  const evidencePath = path.resolve(process.env.OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH || ".data/acceptance/asr-meeting-batch-latest.json");
  const missing = [];
  if (!fs.existsSync(evidencePath)) return { ready: false, missing: ["OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH(valid structured evidence)"] };

  try {
    const stat = fs.statSync(evidencePath);
    if ((stat.mode & 0o077) !== 0) missing.push("ASR_MEETING_BATCH_EVIDENCE_MODE_0600");
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
    const samples = Array.isArray(evidence.samples) ? evidence.samples as Array<Record<string, unknown>> : [];
    const generatedAt = typeof evidence.generatedAt === "string" ? new Date(evidence.generatedAt) : null;
    const ageHours = generatedAt && !Number.isNaN(generatedAt.getTime()) ? (Date.now() - generatedAt.getTime()) / 3_600_000 : Number.POSITIVE_INFINITY;
    const privacy = evidence.privacyReview as Record<string, unknown> | undefined;
    const scenarios = new Set<string>();
    let totalDurationSeconds = 0;

    if (evidence.schemaVersion !== 1) missing.push("ASR_MEETING_BATCH_SCHEMA_V1");
    if (evidence.provider !== "volcano" || evidence.decision !== "pass") missing.push("ASR_MEETING_BATCH_DECISION_PASS");
    if (typeof evidence.tester !== "string" || !evidence.tester.trim() || evidence.tester.trim().toLowerCase() === "pending") missing.push("ASR_MEETING_BATCH_NAMED_TESTER");
    if (ageHours < -1 || ageHours > 24 * 30) missing.push("ASR_MEETING_BATCH_FRESH_WITHIN_30_DAYS");
    if (hasForbiddenAsrEvidenceContent(evidence)) missing.push("ASR_MEETING_BATCH_NO_RAW_TRANSCRIPT_OR_AUDIO");
    if (privacy?.consentProcessDocumented !== true || privacy?.retentionPolicyApplied !== true || privacy?.rawTranscriptExcludedFromEvidence !== true) {
      missing.push("ASR_MEETING_BATCH_PRIVACY_REVIEW");
    }
    if (samples.length < 3) missing.push("ASR_MEETING_BATCH_MIN_3_SAMPLES");

    for (const sample of samples) {
      const automatic = sample.automatic as Record<string, unknown> | undefined;
      const review = sample.manualReview as Record<string, unknown> | undefined;
      const duration = typeof automatic?.durationSeconds === "number" ? automatic.durationSeconds : 0;
      totalDurationSeconds += duration;
      if (Array.isArray(sample.scenarioTags)) sample.scenarioTags.forEach((tag) => typeof tag === "string" && scenarios.add(tag));
      if (sample.sourceKind !== "real_meeting" || !Number.isInteger(Number(sample.participantCount)) || Number(sample.participantCount) < 2 || Number(sample.participantCount) > 4 || sample.consentConfirmed !== true) {
        missing.push("ASR_MEETING_BATCH_REAL_2_TO_4_PERSON_CONSENTED");
      }
      if (duration < 60 || duration > 180 || automatic?.providerStatus !== "transcribed" || Number(automatic?.segmentCount) < 2 || Number(automatic?.speakerCount) < 2 || Number(automatic?.speakerCount) > 4) {
        missing.push("ASR_MEETING_BATCH_TRANSCRIBED_60_TO_180_SECONDS");
      }
      if (!asrBatchAudioBindingReady(sample, automatic)) missing.push("ASR_MEETING_BATCH_AUDIO_HASH_PROVIDER_BINDING");
      if (!asrBatchManualReviewReady(review)) missing.push("ASR_MEETING_BATCH_MANUAL_QUALITY_REVIEW");
    }

    if (totalDurationSeconds < 300) missing.push("ASR_MEETING_BATCH_MIN_300_SECONDS");
    for (const scenario of ["near_field", "far_field", "mild_noise", "accented_speech", "overlap_or_interruption"]) {
      if (!scenarios.has(scenario)) missing.push(`ASR_MEETING_BATCH_SCENARIO_${scenario.toUpperCase()}`);
    }
  } catch {
    missing.push("ASR_MEETING_BATCH_EVIDENCE_READABLE");
  }

  return { ready: missing.length === 0, missing: [...new Set(missing)] };
}

function asrBatchAudioBindingReady(sample: Record<string, unknown>, automatic: Record<string, unknown> | undefined) {
  if (!automatic || typeof sample.audioPath !== "string" || typeof automatic.audioSha256 !== "string" || typeof automatic.providerEvidencePath !== "string") return false;
  if (!fs.existsSync(sample.audioPath) || !fs.existsSync(automatic.providerEvidencePath)) return false;
  try {
    const audio = fs.readFileSync(sample.audioPath);
    const hash = crypto.createHash("sha256").update(audio).digest("hex");
    const providerEvidence = fs.readFileSync(automatic.providerEvidencePath, "utf8");
    return (
      hash === automatic.audioSha256 &&
      audio.byteLength === automatic.audioBytes &&
      providerEvidence.includes("- Result status: transcribed") &&
      providerEvidence.includes(`- Provider request id: ${automatic.providerRequestId}`) &&
      providerEvidence.includes(`- Audio SHA-256: ${automatic.audioSha256}`) &&
      providerEvidence.includes(`- Segment count: ${automatic.segmentCount}`) &&
      providerEvidence.includes(`- Speaker count: ${automatic.speakerCount}`)
    );
  } catch {
    return false;
  }
}

function asrBatchManualReviewReady(review: Record<string, unknown> | undefined) {
  const meaningAccuracy = Number(review?.meaningAccuracyPct);
  const speakerTurnAccuracy = Number(review?.speakerTurnAccuracyPct);
  if (
    !review ||
    review.completed !== true ||
    typeof review.reviewer !== "string" ||
    !review.reviewer.trim() ||
    review.reviewer.trim().toLowerCase() === "pending" ||
    review.transcriptQuality !== "usable" ||
    !Number.isFinite(meaningAccuracy) ||
    meaningAccuracy < 80 ||
    meaningAccuracy > 100 ||
    !Number.isFinite(speakerTurnAccuracy) ||
    speakerTurnAccuracy < 80 ||
    speakerTurnAccuracy > 100
  ) return false;
  return [
    "formalFromFullAudio",
    "realtimeNotPublishedAsFormal",
    "speakerLabelsDistinguishMajorTurns",
    "speakerRenameVerified",
    "speakerSegmentCorrectionVerified",
    "renamedOutputsConsistent",
    "summaryGrounded",
    "actionItemsGrounded",
    "shareVerified",
    "obsidianMarkdownVerified",
    "uncertainOwnerFallbackVerified",
    "noSecretLeak",
  ].every((field) => review[field] === true);
}

function hasForbiddenAsrEvidenceContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenAsrEvidenceContent);
  if (!value || typeof value !== "object") return false;
  const forbiddenKeys = new Set(["raw", "rawtranscript", "transcript", "transcripttext", "transcriptpreview", "audio", "audiobase64", "providerresponse"]);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    return forbiddenKeys.has(normalized) || hasForbiddenAsrEvidenceContent(child);
  });
}

function getBlockerPriority(itemId: string): ReleaseReadinessBlocker["priority"] {
  if (
    [
      "file-asr",
      "realtime-asr",
      "summary-model",
      "speaker-diarization",
      "database",
      "finalization-queue-runtime",
      "object-storage",
      "secret-management",
      "payments",
      "public-url",
    ].includes(itemId)
  ) {
    return "critical";
  }

  if (["auth-accounts", "legal-pages", "data-deletion"].includes(itemId)) return "high";

  return "medium";
}

function getBlockerAcceptanceEvidence(itemId: string) {
  const evidence: Record<string, string> = {
    "file-asr": "保存真实火山 ASR 运行时凭证后，ASR 小音频测试达到 transcribed，并用 1-3 分钟普通话会议生成可读正式逐字稿。",
    "realtime-asr": "真实火山实时 WebSocket 协议完成后，在弱网和正常网络下录音，实时草稿持续返回且失败不影响本地完整录音。",
    "summary-model": "正式逐字稿通过真实总结模型生成结构化摘要、决策、待办、风险和 Obsidian Markdown，并抽样确认没有明显幻觉。",
    "speaker-diarization": "真实双人/多人会议样本显示 Speaker 标签可区分主要发言段，用户可会后改名/校正，待办负责人和 Markdown/分享页发言人展示与校正结果一致。",
    database: "真实 PostgreSQL 执行 migration、导入现有账号数据、切换 runtime writes，并完成备份恢复和最小权限账号验证。",
    "finalization-queue-runtime": "真实 PostgreSQL 与至少两个 Worker 实例完成 202 入队、重复请求去重、原子抢占、处理租约心跳、进程崩溃回收、有限重试、终态失败、结果/用量幂等和删除一致性验证。",
    "object-storage": "真实对象存储完成音频上传、读取、列表、会议删除、账号删除同步删除、私有访问、最小权限、恢复读取、生命周期策略和成本预算验证。",
    "secret-management": "真实 Vault Transit 完成用户 BYOK 加密、不可回显、轮换、删除、租户隔离、审计日志、管理员不可见、解密失败审计和备份恢复验证。",
    payments: "TestFlight 或 Apple sandbox 完成 Plus/Pro 购买、重复交易幂等、续期、退款、过期/撤销通知和权益回收验证。",
    "public-url": "公网 HTTPS App/API/隐私政策/支持 URL 可外部访问，移动端 API Base URL 指向公网，健康检查和分享链接在外网通过。",
  };

  return evidence[itemId] ?? "按对应 runbook 保存可复查的验收证据。";
}

function isOfficialVolcanoRuntimeEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "openspeech.bytedance.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function priorityRank(priority: ReleaseReadinessBlocker["priority"]) {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  return 2;
}

function item(input: ReleaseReadinessItem) {
  return input;
}

function legalPagesExist() {
  return fileExists("src/app/privacy/page.tsx") && fileExists("src/app/terms/page.tsx") && fileExists("src/app/support/page.tsx");
}

function legalPagesReady() {
  return legalPagesExist() && packageScriptExists("smoke:legal") && fileExists("scripts/smoke-legal-pages.mjs");
}

function fileExists(relativePath: string) {
  return fs.existsSync(path.join(process.cwd(), relativePath));
}

function packageScriptExists(scriptName: string) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return typeof packageJson.scripts?.[scriptName] === "string" && Boolean(packageJson.scripts[scriptName]);
  } catch {
    return false;
  }
}
