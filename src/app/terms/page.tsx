import type { Metadata } from "next";
import { connection } from "next/server";
import { LegalPage } from "@/components/legal-page";
import { getPublicSupportEmail, supportEmailText } from "@/lib/public-support";
import { getPublicLegalIdentity } from "@/lib/public-legal-identity";

export const metadata: Metadata = {
  title: "服务条款 - OwnMinutes",
};

export default async function TermsPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const legalIdentity = getPublicLegalIdentity();

  return (
    <LegalPage
      actions={supportEmail ? [{ href: `mailto:${supportEmail}`, label: "联系支持" }] : []}
      eyebrow="OwnMinutes"
      title="服务条款"
      updatedAt="2026-07-30"
      intro="使用 OwnMinutes 即表示你同意遵守这些条款。请在开始录音、向模型服务发送会议内容或发布分享链接前，确认你有权进行相应操作。"
      sections={[
        {
          title: "账号与使用资格",
          items: [
            "你需要使用真实可接收邮件的邮箱注册，并负责保护账号、密码和已登录设备。不得转让账号或利用他人账号访问未经授权的数据。",
            "你应保证提交的信息准确，并在发现账号被盗用、异常登录或数据泄露风险时及时修改密码并联系支持。",
            "我们可以对滥用、攻击、欺诈、侵犯他人权益或严重违反这些条款的账号限制功能或停止服务。",
          ],
        },
        {
          title: "录音与内容责任",
          items: [
            "OwnMinutes 不是电话录音工具，也不会绕过 iOS、会议软件或其他系统的录音限制。",
            "你应在开始录音前确保参会人知情，并遵守所在地关于录音、隐私、商业秘密和数据保护的法律及组织制度。",
            "你不得使用本产品处理违法、侵权、未经授权取得或不适合交由第三方模型处理的内容。",
            "你保留对自己会议内容的合法权利，同时授予 OwnMinutes 为提供录音、转写、总结、存储、分享和导出功能所必需的处理权限。",
          ],
        },
        {
          title: "模型服务与结果校对",
          items: [
            "BYOK 模式下，模型调用费用由你的 Provider 账号承担，你需要遵守相应服务商的条款、额度和数据政策。",
            "使用官方额度时，OwnMinutes 会选择已配置的模型服务完成转写或总结，并按应用显示的规则扣减额度。",
            "实时转写仅作为草稿；会后转写、发言人区分和总结仍可能存在错误。对外分享、分配任务或沉淀到知识库前，你应人工核对。",
            "模型输出不构成法律、医疗、财务、人事或其他专业意见，也不应作为高风险决策的唯一依据。",
          ],
        },
        {
          title: "购买、订阅与退款",
          items: [
            "如应用提供分钟包或会员，iOS 内购买由 Apple App Store 处理，价格、周期和权益以购买页面及 Apple 确认界面为准。",
            "订阅会按 Apple 显示的规则续期，可在 Apple ID 的订阅设置中管理或取消。退款由 Apple 的政策和审核流程决定。",
            "购买恢复、续期、退款、撤销或过期后，OwnMinutes 会根据 Apple 返回的有效交易状态更新对应权益。",
            "BYOK 产生的第三方模型费用不属于 App Store 购买，由用户与相应 Provider 直接结算。",
          ],
        },
        {
          title: "分享、导出与第三方位置",
          items: [
            "发布分享链接前，请确认摘要、发言人观点、决策和待办可以被链接访问者查看；公开逐字稿前需要额外确认。",
            "账号摘要导出不包含逐字稿全文或会议 Markdown 全文；便携导出会包含会议结果、逐字稿和 Markdown。两种导出均不包含密码、模型密钥原文或原始录音。",
            "导出到 Obsidian、Files、云盘、团队知识库或其他第三方位置后，副本的权限、保留和删除由你自行负责。",
            "请勿在反馈、公开 Issue、截图或评论中提交模型密钥、密码、完整录音、客户隐私或可访问的私密分享链接。",
          ],
        },
        {
          title: "服务可用性与责任边界",
          items: [
            "服务可能因设备权限、网络、系统限制、模型供应商、Apple 服务或用户配置而延迟或失败。重要会议应保留必要的人工记录和复核流程。",
            "在法律允许的范围内，OwnMinutes 不对用户未取得录音授权、错误依赖模型结果、错误配置第三方服务或不当公开内容造成的损失承担责任。",
            "我们可能为安全、合规或产品改进调整功能和条款；重大变化会通过应用、网站或注册邮箱提供通知。",
          ],
        },
        {
          title: "开源版本与联系",
          items: [
            "开源代码允许在许可证范围内商用和二次开发，并需要按许可证保留作者和出处说明。二次开发者应为自己的版本提供独立条款和隐私政策。",
            "官方托管服务的账号、用户数据、密钥和会话不得被开源版本或二次开发者未经授权使用。",
            supportEmailText(supportEmail),
          ],
        },
        {
          title: "合同运营主体与适用法域",
          items: legalIdentity
            ? [
                `运营主体：${legalIdentity.operatorName}。`,
                `联系地址：${legalIdentity.operatorAddress}。`,
                `适用法域：${legalIdentity.jurisdiction}。你依法享有的强制性消费者权利不受本条款排除。`,
              ]
            : [
                "当前未配置可公开核验的合同运营主体、联系地址和适用法域，因此正式收费服务保持关闭。",
                "正式收费服务开放前，必须公布真实合同主体信息并完成适用地区的专业法律审查。",
              ],
        },
      ]}
    />
  );
}
