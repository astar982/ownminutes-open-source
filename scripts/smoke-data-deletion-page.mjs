#!/usr/bin/env node

import { readFileSync } from "node:fs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";

async function main() {
  const response = await fetch(`${baseUrl}/data-deletion`);
  const html = await response.text();
  const source = readFileSync("src/app/data-deletion/page.tsx", "utf8");
  const englishSource = readFileSync(
    "src/app/en/data-deletion/page.tsx",
    "utf8",
  );
  const traditionalSource = readFileSync(
    "src/app/zh-Hant/data-deletion/page.tsx",
    "utf8",
  );

  const summary = {
    status: response.status,
    hasTitle: html.includes("数据删除说明"),
    hasUpdatedDate: html.includes("2026-07-31"),
    coversSingleMeetingDelete:
      html.includes("删除单场会议") &&
      html.includes("原始音频") &&
      html.includes("音频分片") &&
      html.includes("正式纪要") &&
      html.includes("公开 Markdown 下载接口"),
    coversShareRevocation:
      html.includes("撤销公开分享") &&
      html.includes("逐字稿默认不公开") &&
      html.includes("关闭逐字稿公开") &&
      html.includes("复制、截图、下载或转存"),
    coversAccountDeletion:
      html.includes("删除账号") &&
      html.includes("Provider 配置") &&
      html.includes("用量事件") &&
      html.includes("原登录会话会失效"),
    coversDataExport:
      html.includes("导出账号数据") &&
      html.includes("Provider 掩码摘要") &&
      html.includes("不包含原始音频") &&
      html.includes("模型密钥原文") &&
      html.includes("导出全部会议内容") &&
      html.includes("逐字稿全文") &&
      html.includes("Markdown"),
    coversByokSecrets:
      html.includes("模型密钥和 BYOK 配置") &&
      html.includes("不会在账号导出、分享页、Markdown 或 API 响应中明文返回") &&
      html.includes("模型密钥由服务端加密保存") &&
      html.includes("当前已经实现的生产托管方案是 HashiCorp Vault Transit") &&
      html.includes("本地 AES-GCM 只用于开发") &&
      html.includes("KMS 标识或其他尚未实现的 Secret Store 不会被当作生产就绪"),
    threeLocalesDescribeCurrentSecretRuntime:
      source.includes("当前已经实现的生产托管方案是 HashiCorp Vault Transit") &&
      source.includes("本地 AES-GCM 只用于开发") &&
      englishSource.includes(
        "The currently implemented managed production option is HashiCorp Vault Transit",
      ) &&
      englishSource.includes("Local AES-GCM is development-only") &&
      englishSource.includes(
        "a KMS identifier or another unimplemented Secret Store is not treated as production-ready",
      ) &&
      traditionalSource.includes(
        "目前已實作的正式環境託管方案是 HashiCorp Vault Transit",
      ) &&
      traditionalSource.includes("本機 AES-GCM 僅供開發使用") &&
      traditionalSource.includes(
        "KMS 識別碼或其他尚未實作的 Secret Store 不會被視為已達正式環境就緒",
      ) &&
      !source.includes("生產部署可配置託管 Secret Store 或 KMS") &&
      !source.includes("生产部署可配置托管 Secret Store 或 KMS") &&
      !englishSource.includes(
        "production deployments can configure a managed Secret Store or KMS",
      ),
    coversProductionRetention:
      html.includes("存储范围和保留边界") &&
      html.includes("PostgreSQL") &&
      html.includes("对象存储") &&
      html.includes("冷备保留周期") &&
      html.includes("生命周期策略") &&
      html.includes("生产备份"),
    coversThirdPartyExportBoundary:
      html.includes("Obsidian") &&
      html.includes("Files") &&
      html.includes("第三方位置") &&
      html.includes("用户自行"),
    coversSupportRequest:
      html.includes("无法登录时请求删除") &&
      html.includes("支持页面") &&
      html.includes("不要发送模型 API Key、密码、完整录音") &&
      html.includes("低敏证据"),
    hasLegalNav:
      html.includes('href="/support"') &&
      html.includes('href="/privacy"') &&
      html.includes('href="/terms"') &&
      html.includes('href="/data-deletion"'),
    sourceMentionsNoSecretLeak:
      source.includes("不要发送模型 API Key、密码、完整录音") &&
      !source.includes("AKL") &&
      !source.includes("Secret Access Key") &&
      !source.includes("sk-proj"),
    htmlLeaksSecrets: leaksSecrets(html),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    summary.status !== 200 ||
    !summary.hasTitle ||
    !summary.hasUpdatedDate ||
    !summary.coversSingleMeetingDelete ||
    !summary.coversShareRevocation ||
    !summary.coversAccountDeletion ||
    !summary.coversDataExport ||
    !summary.coversByokSecrets ||
    !summary.threeLocalesDescribeCurrentSecretRuntime ||
    !summary.coversProductionRetention ||
    !summary.coversThirdPartyExportBoundary ||
    !summary.coversSupportRequest ||
    !summary.hasLegalNav ||
    !summary.sourceMentionsNoSecretLeak ||
    summary.htmlLeaksSecrets
  ) {
    process.exitCode = 1;
  }
}

function leaksSecrets(text) {
  return /AKL[A-Za-z0-9]+|Secret Access Key|sk-proj-|WVRCaE1EZ3p/i.test(text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
