#!/usr/bin/env node

import { readFileSync } from "node:fs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const forbiddenPublicCopy = [
  "当前 MVP",
  "MVP 预览",
  "localhost",
  "127.0.0.1",
  "192.168.x.x",
  ".data",
  "本地 JSON",
  "仅模拟方案选择",
  "正式公开上架前仍需要",
  "生产环境上线前",
  "TestFlight 阶段建议",
];

const pages = [
  {
    path: "/privacy",
    title: "隐私政策",
    updatedAt: "2026-07-30",
    source: "src/app/privacy/page.tsx",
    navPaths: ["/support", "/privacy", "/terms", "/data-deletion"],
    required: [
      "麦克风与参会人知情",
      "第三方服务",
      "BYOK 模式",
      "逐字稿默认隐藏",
      "原始音频默认不公开",
      "最多保留 35 天",
      "不使用会议内容进行跨应用广告追踪",
      "不出售你的会议录音、逐字稿或模型密钥",
      "便携导出包含会议结果、逐字稿全文和会议 Markdown",
      "正式收费服务保持关闭",
    ],
  },
  {
    path: "/terms",
    title: "服务条款",
    updatedAt: "2026-07-30",
    source: "src/app/terms/page.tsx",
    navPaths: ["/support", "/privacy", "/terms", "/data-deletion"],
    required: [
      "参会人知情",
      "BYOK 模式",
      "实时转写仅作为草稿",
      "购买、订阅与退款",
      "Apple App Store",
      "公开逐字稿前需要额外确认",
      "导出到 Obsidian",
      "保留作者和出处说明",
      "便携导出会包含会议结果、逐字稿和 Markdown",
      "正式收费服务保持关闭",
    ],
  },
  {
    path: "/support",
    title: "支持与帮助",
    updatedAt: "2026-07-30",
    source: "src/app/support/page.tsx",
    navPaths: ["/support", "/privacy", "/terms", "/data-deletion"],
    required: [
      "录音无法开始",
      "设备本地保留音频",
      "实时转写只是会议中的草稿",
      "恢复购买",
      "删除账号",
      "不要发送密码、验证码、模型密钥",
      "https://github.com/astar982/ownminutes-open-source/issues",
    ],
  },
  {
    path: "/data-deletion",
    title: "数据删除说明",
    updatedAt: "2026-07-31",
    source: "src/app/data-deletion/page.tsx",
    navPaths: ["/support", "/privacy", "/terms", "/data-deletion"],
    required: [
      "撤销公开分享",
      "删除单场会议",
      "导出账号数据",
      "永久删除账号",
      "最多保留 35 天",
      "无法登录时请求删除",
      "请勿在公开 Issue 中提交邮箱",
      "导出全部会议内容",
      "当前已经实现的生产托管方案是 HashiCorp Vault Transit",
      "KMS 标识或其他尚未实现的 Secret Store 不会被当作生产就绪",
    ],
  },
  {
    path: "/en/privacy",
    title: "Privacy Policy",
    updatedAt: "2026-07-30",
    source: "src/app/en/privacy/page.tsx",
    navPaths: ["/en/support", "/en/privacy", "/en/terms", "/en/data-deletion"],
    required: [
      "Microphone use and participant consent",
      "Model providers and other third parties",
      "Purchase and usage data",
      "35 days",
      "does not cancel an Apple subscription",
      "does not use meeting content for cross-app advertising tracking",
      "does not sell your recordings, transcripts, or model keys",
      "portable export contains meeting results, full transcripts, and meeting Markdown",
      "paid service remains closed",
    ],
  },
  {
    path: "/en/terms",
    title: "Terms of Service",
    updatedAt: "2026-07-30",
    source: "src/app/en/terms/page.tsx",
    navPaths: ["/en/support", "/en/privacy", "/en/terms", "/en/data-deletion"],
    required: [
      "participant",
      "BYOK mode",
      "Live transcription is a draft",
      "Apple purchases, auto-renewal, and refunds",
      "Apple In-App Purchase",
      "Restore Purchases",
      "does not cancel the subscription",
      "Obsidian",
      "portable export includes meeting results, transcripts, and Markdown",
      "paid service remains closed",
    ],
  },
  {
    path: "/en/support",
    title: "Support and Help",
    updatedAt: "2026-07-30",
    source: "src/app/en/support/page.tsx",
    navPaths: ["/en/support", "/en/privacy", "/en/terms", "/en/data-deletion"],
    required: [
      "Recording does not start",
      "retaining audio on the device",
      "Live transcription is only a draft",
      "Apple purchase, renewal, or restore",
      "Restore Purchases",
      "Account and data",
      "Do not send passwords, verification codes, model keys",
      "https://github.com/astar982/ownminutes-open-source/issues",
    ],
  },
  {
    path: "/en/data-deletion",
    title: "Data Deletion",
    updatedAt: "2026-07-31",
    source: "src/app/en/data-deletion/page.tsx",
    navPaths: ["/en/support", "/en/privacy", "/en/terms", "/en/data-deletion"],
    required: [
      "Revoke a public share",
      "Delete one meeting",
      "Export account data",
      "Cancel Apple billing before account deletion",
      "Permanently delete your account",
      "35 days",
      "Request deletion when you cannot sign in",
      "Do not post an email address",
      "Export All Meeting Content",
      "The currently implemented managed production option is HashiCorp Vault Transit",
      "a KMS identifier or another unimplemented Secret Store is not treated as production-ready",
    ],
  },
  {
    path: "/zh-Hant/privacy",
    title: "隱私權政策",
    updatedAt: "2026-07-30",
    source: "src/app/zh-Hant/privacy/page.tsx",
    navPaths: ["/zh-Hant/support", "/zh-Hant/privacy", "/zh-Hant/terms", "/zh-Hant/data-deletion"],
    required: [
      "麥克風使用與與會者同意",
      "模型供應商與其他第三方",
      "購買與使用資料",
      "最多 35 天",
      "不會取消 Apple 訂閱",
      "不會將會議內容用於跨應用程式廣告追蹤",
      "不會出售你的錄音、逐字稿或模型金鑰",
      "可攜式匯出包含會議結果、完整逐字稿與會議 Markdown",
      "付費服務維持關閉",
    ],
  },
  {
    path: "/zh-Hant/terms",
    title: "服務條款",
    updatedAt: "2026-07-30",
    source: "src/app/zh-Hant/terms/page.tsx",
    navPaths: ["/zh-Hant/support", "/zh-Hant/privacy", "/zh-Hant/terms", "/zh-Hant/data-deletion"],
    required: [
      "與會者已知情",
      "BYOK 模式",
      "即時轉寫只是草稿",
      "Apple 購買、自動續訂與退款",
      "Apple App 內購買",
      "恢復購買",
      "不會取消訂閱",
      "Obsidian",
      "可攜式匯出會包含會議結果、逐字稿與 Markdown",
      "付費服務維持關閉",
    ],
  },
  {
    path: "/zh-Hant/support",
    title: "支援與說明",
    updatedAt: "2026-07-30",
    source: "src/app/zh-Hant/support/page.tsx",
    navPaths: ["/zh-Hant/support", "/zh-Hant/privacy", "/zh-Hant/terms", "/zh-Hant/data-deletion"],
    required: [
      "無法開始錄音",
      "優先在裝置上保留音訊",
      "即時轉寫只是一份草稿",
      "Apple 購買、續訂或恢復購買",
      "恢復購買",
      "帳號與資料",
      "請勿傳送密碼、驗證碼、模型金鑰",
      "https://github.com/astar982/ownminutes-open-source/issues",
    ],
  },
  {
    path: "/zh-Hant/data-deletion",
    title: "資料刪除",
    updatedAt: "2026-07-31",
    source: "src/app/zh-Hant/data-deletion/page.tsx",
    navPaths: ["/zh-Hant/support", "/zh-Hant/privacy", "/zh-Hant/terms", "/zh-Hant/data-deletion"],
    required: [
      "撤銷公開分享",
      "刪除單一會議",
      "匯出帳號資料",
      "刪除帳號前先取消 Apple 計費",
      "永久刪除帳號",
      "最多 35 天",
      "無法登入時請求刪除",
      "請勿在公開 Issue 中發佈電子郵件地址",
      "匯出全部會議內容",
      "目前已實作的正式環境託管方案是 HashiCorp Vault Transit",
      "KMS 識別碼或其他尚未實作的 Secret Store 不會被視為已達正式環境就緒",
    ],
  },
];

async function main() {
  const results = [];

  for (const page of pages) {
    const response = await fetch(`${baseUrl}${page.path}`);
    const html = await response.text();
    const source = readFileSync(page.source, "utf8");
    const missing = page.required.filter((phrase) => !html.includes(phrase));
    const forbidden = forbiddenPublicCopy.filter((phrase) => html.includes(phrase));

    results.push({
      path: page.path,
      status: response.status,
      hasTitle: html.includes(page.title),
      hasUpdatedDate: html.includes(page.updatedAt),
      hasLegalNav: page.navPaths.every((path) => html.includes(`href="${path}"`)),
      missing,
      forbidden,
      sourceUsesRuntimeSupportContact:
        source.includes("getPublicSupportEmail") &&
        (source.includes("supportEmailText") || source.includes("supportText")) &&
        source.includes("mailto:"),
      sourceMentionsNoSecrets:
        source.includes("模型密钥") ||
        source.includes("云访问密钥") ||
        source.includes("不要发送") ||
        source.includes("密码") ||
        source.includes("模型金鑰") ||
        source.includes("請勿傳送") ||
        source.includes("密碼") ||
        source.includes("password") ||
        source.includes("model key") ||
        source.includes("Do not send"),
      leaksSecrets: leaksSecrets(html) || leaksSecrets(source),
    });
  }

  const legalLayouts = [
    readFileSync("src/components/legal-page.tsx", "utf8"),
    readFileSync("src/app/en/_components/english-legal-page.tsx", "utf8"),
    readFileSync("src/app/zh-Hant/_components/traditional-legal-page.tsx", "utf8"),
  ];
  const summary = {
    baseUrl,
    pageCount: results.length,
    allStatusOk: results.every((result) => result.status === 200),
    allTitlesOk: results.every((result) => result.hasTitle),
    allUpdated: results.every((result) => result.hasUpdatedDate),
    allLegalNavOk: results.every((result) => result.hasLegalNav),
    allRequiredCopyPresent: results.every((result) => result.missing.length === 0),
    noInternalReleaseCopy: results.every((result) => result.forbidden.length === 0),
    runtimeSupportContactCovered: results.every((result) => result.sourceUsesRuntimeSupportContact),
    mobileDocumentLayout: legalLayouts.every(
      (layout) =>
        layout.includes("max-w-[760px]") &&
        layout.includes("min-h-11") &&
        !layout.includes("tracking-[") &&
        !layout.includes("shadow-sm"),
    ),
    noSecretLeaks: results.every((result) => !result.leaksSecrets),
    sourceMentionsNoSecrets: results.every((result) => result.sourceMentionsNoSecrets),
    results,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (Object.values(summary).some((value) => value === false)) process.exitCode = 1;
}

function leaksSecrets(text) {
  return /AKL[A-Za-z0-9]+|sk-proj-|WVRCaE1EZ3p/i.test(text);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
