const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getPublicSupportEmail() {
  const value = (process.env.OWNMINUTES_SUPPORT_EMAIL || process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "").trim();
  return emailPattern.test(value) ? value : "";
}

export function supportEmailText(email: string) {
  return email
    ? `支持邮箱：${email}。请勿在邮件中发送密码、模型密钥、完整录音或未脱敏的会议内容。`
    : "账号和数据请求请优先使用 App 内的导出、撤销分享、删除会议和删除账号功能。正式服务启用前必须配置公开支持邮箱。";
}
