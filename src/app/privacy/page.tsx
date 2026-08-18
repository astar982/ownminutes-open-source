import type { Metadata } from "next";
import { connection } from "next/server";
import { LegalPage } from "@/components/legal-page";
import { getPublicSupportEmail, supportEmailText } from "@/lib/public-support";
import { getPublicLegalIdentity } from "@/lib/public-legal-identity";

export const metadata: Metadata = {
  title: "隐私政策 - OwnMinutes",
};

export default async function PrivacyPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const legalIdentity = getPublicLegalIdentity();

  return (
    <LegalPage
      actions={supportEmail ? [{ href: `mailto:${supportEmail}`, label: "联系隐私支持" }] : []}
      eyebrow="OwnMinutes"
      title="隐私政策"
      updatedAt="2026-07-30"
      intro="OwnMinutes 用于会议录音、实时转写草稿、会后正式转写、会议纪要、分享和 Markdown 导出。本政策说明我们处理哪些数据、为什么处理，以及你可以如何查看、导出或删除这些数据。"
      sections={[
        {
          title: "我们处理的数据",
          items: [
            "账号数据：显示名称、邮箱、邮箱验证状态、登录会话、用户标识、套餐权益和用量记录。密码、邮箱验证和密码重置凭据只以不可逆摘要保存。",
            "会议内容：会议标题、参会人和标签、录音及音频分片、实时转写草稿、会后正式转写、发言人标签、摘要、决策、待办、风险、知识点和 Markdown。",
            "模型配置：你选择的语音识别和总结服务、非密钥配置，以及加密保存的模型密钥。密钥原文不会通过账号导出、分享页或普通 API 响应返回。",
            "购买和用量：Apple 购买记录、订单标识、套餐权益、官方额度和模型用量事件，用于提供权益和处理退款或过期状态。",
            "产品交互与诊断：麦克风授权、音频格式、录音和上传状态、网络恢复状态、Provider 健康检查和低敏错误信息，用于保障录音可靠性和排查故障。",
          ],
        },
        {
          title: "处理目的",
          items: [
            "保存会议音频，生成实时草稿和会后正式结果，并在你的设备或账号中展示、回放、搜索和导出。",
            "生成会议摘要、决策、待办和知识点，并按你的选择创建或撤销分享链接。",
            "验证账号所有权、保护登录和数据访问、恢复账号、执行套餐权益及防止滥用。",
            "监测录音、上传和会后处理是否成功，定位崩溃、格式不兼容、网络中断或模型调用错误。",
          ],
        },
        {
          title: "麦克风与参会人知情",
          items: [
            "只有在你主动授权麦克风并点击开始录音后，OwnMinutes 才会录制会议声音；录音过程中会持续显示明确状态。",
            "你应在录音前告知参会人，并确认录音、转写、总结和分享符合所在地法律、公司制度及会议参与者的约定。",
            "OwnMinutes 不提供电话录音，也不会绕过 iOS、会议软件或其他系统的录音限制。",
          ],
        },
        {
          title: "第三方服务",
          items: [
            "会议内容可能发送到你选择的语音识别或大模型服务，用于完成转写和总结。BYOK 模式下，相关请求由你配置的 Provider 处理。",
            "使用官方额度时，会议内容会发送到 OwnMinutes 配置的模型服务；只发送完成当前功能所需的数据。",
            "账号邮件可能由邮件服务商投递，订阅购买由 Apple 处理，应用托管、数据库和对象存储由基础设施服务商提供。",
            "第三方服务会按其自身条款和隐私政策处理数据。请勿录制或提交不适合交由所选服务处理的敏感内容。",
          ],
        },
        {
          title: "分享与公开范围",
          items: [
            "分享链接默认展示摘要、发言人观点、决策和待办；逐字稿默认隐藏，开启逐字稿公开前需要再次确认。",
            "原始音频默认不公开，也不会默认包含在分享页或账号导出文件中。",
            "撤销分享后，OwnMinutes 提供的原链接会失效；他人已经复制、截图或转存的副本无法由 OwnMinutes 自动删除。",
          ],
        },
        {
          title: "保留、导出与删除",
          items: [
            "账号和会议数据会在提供服务所需期间保留，直到你删除对应会议或账号，或法律要求我们继续保留。",
            "删除会议或账号后，相关内容会从在线服务中移除；加密备份中的副本可能最多保留 35 天，期满后随备份轮换删除，期间不会用于正常产品访问。",
            "账号摘要导出包含账号、用量、会议清单和低敏配置摘要，不包含逐字稿全文、会议 Markdown 全文、密码、模型密钥原文或原始录音。",
            "便携导出包含会议结果、逐字稿全文和会议 Markdown，方便迁移；仍不包含密码、模型密钥原文或原始录音。",
            "导出到 Obsidian、Files、云盘或其他第三方位置后的副本由你自行管理和删除。",
          ],
        },
        {
          title: "你的选择与联系我们",
          items: [
            "你可以拒绝麦克风权限、停止录音、撤销分享、关闭逐字稿公开、删除单场会议、导出账号数据或永久删除账号。",
            "OwnMinutes 不使用会议内容进行跨应用广告追踪，也不出售你的会议录音、逐字稿或模型密钥。",
            supportEmailText(supportEmail),
          ],
        },
        {
          title: "运营主体与适用规则",
          items: legalIdentity
            ? [
                `运营主体：${legalIdentity.operatorName}。`,
                `联系地址：${legalIdentity.operatorAddress}。`,
                `适用法域：${legalIdentity.jurisdiction}。具体法定权利不因本政策而被排除。`,
              ]
            : [
                "当前未配置可公开核验的运营主体名称、联系地址和适用法域，因此正式收费服务保持关闭。",
                "正式收费服务开放前，OwnMinutes 必须在本页公布真实运营主体信息；不会使用占位名称或虚构地址。",
              ],
        },
      ]}
    />
  );
}
