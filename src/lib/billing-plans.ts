export type BillingPlan = {
  id: "free" | "plus" | "pro";
  name: string;
  price: string;
  caption: string;
  minutes: string;
  highlight?: boolean;
  features: string[];
};

export const billingPlans: BillingPlan[] = [
  {
    id: "free",
    name: "Free",
    price: "免费",
    caption: "注册即可开始，BYOK 永久可用",
    minutes: "一次性 60 分钟官方体验额度",
    features: ["自带模型 Key 免费使用", "基础会议纪要", "Obsidian Markdown 导出", "7 天分享链接"],
  },
  {
    id: "plus",
    name: "Plus",
    price: "US$7.99/月",
    caption: "适合低频但希望省心的个人用户",
    minutes: "每月 600 分钟官方额度",
    highlight: true,
    features: ["每月 600 分钟官方处理", "无需配置模型即可使用", "BYOK 仍可随时使用", "会议纪要、分享与导出"],
  },
  {
    id: "pro",
    name: "Pro",
    price: "US$19.99/月",
    caption: "适合更高月度会议量的重度用户",
    minutes: "每月 1800 分钟官方额度",
    features: ["每月 1800 分钟官方处理", "无需配置模型即可使用", "BYOK 仍可随时使用", "会议纪要、分享与导出"],
  },
];

export const usageMetrics = [
  { label: "BYOK 自带模型", value: "模型费用直接走你的供应商账号，OwnMinutes 只提供记录、分享和导出体验。" },
  { label: "一次性体验额度", value: "新账号可获得一次性 60 分钟官方体验额度，不按月重复赠送。" },
  { label: "Plus / Pro 会员", value: "不想配置模型时可按月订阅官方额度，并根据会议用量选择合适方案。" },
];
