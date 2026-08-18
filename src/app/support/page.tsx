import type { Metadata } from "next";
import { connection } from "next/server";
import { LegalPage } from "@/components/legal-page";
import { getPublicSupportEmail, supportEmailText } from "@/lib/public-support";

export const metadata: Metadata = {
  title: "支持 - OwnMinutes",
};

export default async function SupportPage() {
  await connection();
  const supportEmail = getPublicSupportEmail();
  const actions = [
    ...(supportEmail ? [{ href: `mailto:${supportEmail}`, label: "发送支持邮件" }] : []),
    {
      href: "https://github.com/astar982/ownminutes-open-source/issues",
      label: "提交公开问题",
      type: "external" as const,
    },
  ];

  return (
    <LegalPage
      actions={actions}
      eyebrow="OwnMinutes"
      title="支持与帮助"
      updatedAt="2026-07-30"
      intro="遇到录音、转写、模型配置、分享、导出或账号问题时，可以先按下面的步骤排查。涉及账号和数据删除的请求请使用支持邮箱，不要提交到公开 Issue。"
      sections={[
        {
          title: "录音无法开始",
          items: [
            "打开 iPhone 设置，确认 OwnMinutes 已获得麦克风权限；返回应用后重新进入记录页。",
            "确认没有其他应用独占麦克风，并检查蓝牙耳机或外接麦克风是否仍连接。",
            "开始录音后应看到明确的录音状态、计时和音量变化。录音状态没有变化时，不要继续会议，请先重新授权或重启应用。",
          ],
        },
        {
          title: "上传或转写没有完成",
          items: [
            "OwnMinutes 会优先在设备本地保留音频。网络中断时请保持会议记录，不要删除应用；恢复网络后可继续同步待上传分片。",
            "实时转写只是会议中的草稿。正式结果以结束会议后使用完整音频生成的转写和纪要为准。",
            "在设置页运行服务连接和 Provider 健康检查。使用 BYOK 时，请确认 Provider、模型、Endpoint、Key、账号额度和网络区域配置正确。",
            "如果会后处理失败，请保留本地音频并重试，不要为了重新转写而删除原会议。",
          ],
        },
        {
          title: "说话人、纪要和待办不准确",
          items: [
            "单设备混合录音无法保证 100% 准确区分发言人。请在会后把 Speaker 标签改为真实姓名，并检查发言段归属。",
            "核对决策、待办负责人、截止时间、风险和未解决问题；没有逐字稿依据的内容应删除或标记为不确定。",
            "对外分享前再次检查逐字稿开关。分享链接默认不包含原始音频，逐字稿默认隐藏。",
          ],
        },
        {
          title: "账号、购买与数据",
          items: [
            "忘记密码时可在登录页申请重置邮件；没有收到邮件时请检查垃圾邮件，并确认注册邮箱拼写正确。",
            "Apple 购买未生效时，先确认使用了购买时的 Apple ID，再在应用内执行恢复购买。请勿公开订单号或完整交易凭据。",
            "账号页可以导出数据、查看数据删除说明或永久删除账号；会议详情可以撤销分享和删除单场会议。",
          ],
        },
        {
          title: "反馈问题需要提供什么",
          items: [
            "请提供设备型号、iOS 版本、OwnMinutes 版本、会议时长、网络状态、是否使用耳机或 BYOK、错误出现的大概时间和复现步骤。",
            "分享问题可以提供会议标题或分享链接末尾的低敏标识；Provider 问题可以提供服务商名称、错误码和掩码后的 Key 标识。",
            "不要发送密码、验证码、模型密钥、云访问密钥、完整录音、完整逐字稿、客户名单或未脱敏的会议截图。",
          ],
        },
        {
          title: "联系渠道",
          items: [
            supportEmailText(supportEmail),
            "GitHub Issues 只用于不包含账号、会议或客户隐私的公开缺陷和功能建议。涉及登录、购买、删除请求或私密内容时，请使用支持邮箱。",
          ],
        },
      ]}
    />
  );
}
