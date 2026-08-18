import type { Metadata } from "next";
import { connection } from "next/server";
import { LegalPage } from "@/components/legal-page";
import { getPublicSupportEmail, supportEmailText } from "@/lib/public-support";

export const metadata: Metadata = {
  title: "数据删除说明 - OwnMinutes",
};

export default async function DataDeletionPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();

  return (
    <LegalPage
      actions={supportEmail ? [{ href: `mailto:${supportEmail}?subject=OwnMinutes%20数据删除请求`, label: "联系删除支持" }] : []}
      eyebrow="OwnMinutes"
      title="数据删除说明"
      updatedAt="2026-07-31"
      intro="你可以在 OwnMinutes 中撤销分享、删除单场会议、导出账号数据或永久删除账号。以下说明每种操作的入口、影响范围和保留边界。"
      sections={[
        {
          title: "撤销公开分享",
          items: [
            "打开会议详情，进入分享设置并撤销分享。撤销后，OwnMinutes 提供的原分享链接和公开 Markdown 下载接口会失效。",
            "逐字稿默认不公开。已经开启时，可以在会议详情关闭逐字稿公开，而不必删除整场会议。",
            "别人已经复制、截图、下载或转存到第三方位置的副本，无法通过撤销 OwnMinutes 分享链接自动删除。",
          ],
        },
        {
          title: "删除单场会议",
          items: [
            "在会议 Tab 打开会议详情，进入底部的危险操作区域，点击删除会议并再次确认。",
            "删除会清理该会议的原始音频、音频分片、实时草稿、正式转写、正式纪要、Markdown、元数据和分享状态。",
            "删除完成后，该会议不会继续出现在会议列表、项目归档、分享链接或账号导出清单中。",
          ],
        },
        {
          title: "导出账号数据",
          items: [
            "在“我的”或账号中心选择“导出账号摘要”，可以获得账号、权益、用量、Provider 掩码摘要和会议清单；该摘要不含逐字稿全文或 Markdown 全文。",
            "选择“导出全部会议内容”会生成便携 NDJSON，包含会议结果、逐字稿全文和 Markdown，方便迁移。两种导出都不包含原始音频、密码或模型密钥原文。",
          ],
        },
        {
          title: "永久删除账号",
          items: [
            "登录后进入“我的”或账号中心，选择删除账号，阅读影响范围并完成二次确认。",
            "删除账号会注销全部会话，删除 Provider 配置、模型密钥引用、权益和用量事件、全部会议、音频、正式结果、Markdown 及公开分享链接，并匿名化必须保留的低敏记录。",
            "删除完成后，原登录会话会失效，原账号不能继续登录。希望再次使用 OwnMinutes 时，需要重新注册并重新配置 Provider。",
          ],
        },
        {
          title: "模型密钥和 BYOK 配置",
          items: [
            "模型密钥由服务端加密保存；当前已经实现的生产托管方案是 HashiCorp Vault Transit。本地 AES-GCM 只用于开发；KMS 标识或其他尚未实现的 Secret Store 不会被当作生产就绪。密钥不会写入手机，也不会在账号导出、分享页、Markdown 或 API 响应中明文返回。",
            "删除单个 Provider 会移除对应密钥引用和参数；删除账号会移除该账号下全部 BYOK 配置。第三方 Provider 侧的 Key 仍建议在供应商控制台主动撤销。",
          ],
        },
        {
          title: "存储范围和保留边界",
          items: [
            "正式服务会将账号与用量写入 PostgreSQL，将原始音频、结果和 Markdown 写入对象存储；本地开发存储不代表生产保留策略。",
            "在线数据会在删除操作完成后停止正常访问。生产备份中的副本可能最多保留 35 天，随后按冷备保留周期和对象生命周期策略轮换删除。",
            "备份中的删除数据只用于灾难恢复和安全审计，不会重新显示在正常账号、会议列表或分享页面中。",
            "导出到 Obsidian、Files、云盘、团队知识库或其他第三方位置后的副本，需要用户自行在相应第三方位置删除。",
          ],
        },
        {
          title: "无法登录时请求删除",
          items: [
            "无法登录时请通过支持页面使用注册邮箱联系，并说明需要删除整个账号还是指定分享链接。为保护账号，我们可能要求完成邮箱所有权验证或提供低敏证据。",
            "不要发送模型 API Key、密码、完整录音或完整逐字稿；支持人员不会索要这些材料。",
            "请勿在公开 Issue 中提交邮箱、分享链接、会议内容、订单信息或其他身份资料。",
            supportEmailText(supportEmail),
          ],
        },
      ]}
    />
  );
}
