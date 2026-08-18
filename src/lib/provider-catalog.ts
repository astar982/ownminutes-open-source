import type { ProviderDiagnostic } from "@/lib/transcription-adapter";

export type ProviderField = {
  name: string;
  label: string;
  required: boolean;
  secret: boolean;
  description: string;
  placeholder?: string;
};

export type ProviderCatalogItem = {
  id: string;
  name: string;
  category: "speech" | "summary" | "fallback";
  recommended?: boolean;
  description: string;
  commercialUse: string;
  links: { label: string; href: string }[];
  fields: ProviderField[];
  envTemplate: string[];
  notes: string[];
};

export const providerCatalog: ProviderCatalogItem[] = [
  {
    id: "volcano-asr",
    name: "火山引擎语音识别",
    category: "speech",
    recommended: true,
    description: "负责会议实时转写草稿和会后完整音频识别，是 OwnMinutes当前优先接入的中文 ASR 服务。",
    commercialUse: "商用版建议把这类密钥按租户加密保存，并允许企业选择平台统一额度或自带账号。",
    links: [
      { label: "火山引擎控制台", href: "https://console.volcengine.com/" },
      { label: "语音技术产品", href: "https://www.volcengine.com/product/voice-tech" },
    ],
    fields: [
      {
        name: "TRANSCRIPTION_PROVIDER",
        label: "转写 Provider",
        required: true,
        secret: false,
        description: "设为 volcano 后，后端会走火山适配器和诊断逻辑。",
        placeholder: "volcano",
      },
      {
        name: "VOLCANO_ASR_API_KEY",
        label: "ASR API Key",
        required: true,
        secret: true,
        description: "会后录音文件识别可使用的运行时 Key；也可用 AppID + Token 替代。",
      },
      {
        name: "VOLCANO_ASR_APP_ID",
        label: "ASR AppID",
        required: false,
        secret: false,
        description: "当不使用 ASR API Key 时，和 VOLCANO_ASR_TOKEN 组合使用。",
      },
      {
        name: "VOLCANO_ASR_TOKEN",
        label: "ASR Token",
        required: false,
        secret: true,
        description: "语音识别产品控制台里的运行时 Token，不是账号级 Secret Access Key。",
      },
      {
        name: "VOLCANO_ASR_CLUSTER",
        label: "ASR Cluster",
        required: false,
        secret: false,
        description: "部分火山语音产品需要指定集群或资源。",
      },
      {
        name: "VOLCANO_ASR_SUBMIT_URL",
        label: "文件识别提交地址",
        required: false,
        secret: false,
        description: "会后录音文件识别的提交 endpoint。",
      },
      {
        name: "VOLCANO_ASR_QUERY_URL",
        label: "文件识别查询地址",
        required: false,
        secret: false,
        description: "会后录音文件识别的查询 endpoint。",
      },
      {
        name: "VOLCANO_ASR_WS_URL",
        label: "实时 ASR WebSocket",
        required: false,
        secret: false,
        description: "实时转写所需的 WebSocket endpoint；默认使用官方优化双向流式接口。",
      },
      {
        name: "VOLCANO_REALTIME_ASR_RESOURCE_ID",
        label: "实时 ASR Resource ID",
        required: false,
        secret: false,
        description: "实时流式识别资源 ID，与会后极速文件识别的 volc.bigasr.auc_turbo 分开配置。",
      },
    ],
    envTemplate: [
      "TRANSCRIPTION_PROVIDER=volcano",
      "VOLCANO_ASR_API_KEY=",
      "VOLCANO_ASR_APP_ID=",
      "VOLCANO_ASR_TOKEN=",
      "VOLCANO_ASR_CLUSTER=",
      "VOLCANO_ASR_SUBMIT_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
      "VOLCANO_ASR_QUERY_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
      "VOLCANO_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
      "VOLCANO_REALTIME_ASR_RESOURCE_ID=volc.seedasr.sauc.duration",
    ],
    notes: [
      "账号 AK/SK 不能直接替代语音识别运行时 Key 或 Token。",
      "实时转写只作为会议中草稿，正式纪要应使用完整音频会后重处理。",
      "说话人识别第一版不要承诺 100% 准确，应保留会后改名和校正能力。",
    ],
  },
  {
    id: "volcano-ark",
    name: "火山方舟 / 豆包大模型",
    category: "summary",
    recommended: true,
    description: "负责把正式逐字稿整理为摘要、决策、待办、风险、未解决问题和 Obsidian Markdown。",
    commercialUse: "商用版需要记录每次总结的模型、成本、输入输出 token 和失败重试，避免成本失控。",
    links: [
      { label: "方舟控制台", href: "https://console.volcengine.com/ark/" },
      { label: "火山方舟产品", href: "https://www.volcengine.com/product/ark" },
    ],
    fields: [
      {
        name: "ARK_API_KEY",
        label: "Ark API Key",
        required: true,
        secret: true,
        description: "调用方舟 Chat Completions 的 Key。",
      },
      {
        name: "ARK_CHAT_MODEL",
        label: "Ark 模型 / Endpoint ID",
        required: true,
        secret: false,
        description: "已创建的方舟 Endpoint 或可调用模型 ID。",
      },
      {
        name: "ARK_BASE_URL",
        label: "Ark Base URL",
        required: false,
        secret: false,
        description: "默认使用北京区域 API 地址。",
        placeholder: "https://ark.cn-beijing.volces.com/api/v3",
      },
    ],
    envTemplate: ["ARK_API_KEY=", "ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3", "ARK_CHAT_MODEL="],
    notes: ["总结模型不能弥补低质量转写，ASR 质量会直接决定纪要质量。", "正式输出必须基于逐字稿证据，不确定内容要显式标注。"],
  },
  {
    id: "openai",
    name: "OpenAI 备选 Provider",
    category: "summary",
    description: "保留为后续国际化或多 provider 备用入口，当前项目还没有启用完整 OpenAI 实时转写链路。",
    commercialUse: "商用版可以作为高质量备选模型，但需要单独处理境内外网络、合规和成本。",
    links: [{ label: "OpenAI API Keys", href: "https://platform.openai.com/api-keys" }],
    fields: [
      {
        name: "OPENAI_API_KEY",
        label: "OpenAI API Key",
        required: true,
        secret: true,
        description: "OpenAI Provider 需要的 API Key；当前代码只保留适配器占位。",
      },
    ],
    envTemplate: ["TRANSCRIPTION_PROVIDER=openai", "OPENAI_API_KEY="],
    notes: ["当前不建议把它作为第一版商用主链路，先跑通火山中文会议场景更实际。"],
  },
  {
    id: "mock",
    name: "Mock 本地开发",
    category: "fallback",
    description: "不调用外部服务，只用于开发、演示 UI 和闭环烟测。",
    commercialUse: "不能用于真实商用，只能作为无密钥环境的降级和测试模式。",
    links: [],
    fields: [
      {
        name: "TRANSCRIPTION_PROVIDER",
        label: "转写 Provider",
        required: true,
        secret: false,
        description: "设为 mock 后不调用任何真实 ASR 或大模型。",
        placeholder: "mock",
      },
    ],
    envTemplate: ["TRANSCRIPTION_PROVIDER=mock"],
    notes: ["Mock 模式不会识别真实语音，不能用于验证转写质量。"],
  },
];

export function getProviderFieldPresence(fieldName: string, diagnostic: ProviderDiagnostic) {
  if (fieldName === "TRANSCRIPTION_PROVIDER") {
    return true;
  }

  if (fieldName === "ARK_BASE_URL") {
    return Boolean(process.env.ARK_BASE_URL);
  }

  if (Object.prototype.hasOwnProperty.call(diagnostic.present, fieldName)) {
    return Boolean(diagnostic.present[fieldName]);
  }

  return Boolean(process.env[fieldName]);
}

export function buildCommercialProviderChecklist() {
  return [
    "租户与管理员权限：谁能修改模型配置，谁能查看调用状态。",
    "密钥加密保存：不能把用户密钥明文存数据库，也不能返回到浏览器。",
    "Provider 健康检查：保存前验证 Key、模型、余额和权限是否可用。",
    "成本控制：按会议记录 ASR、总结、存储和分享页消耗。",
    "审计日志：记录谁在什么时候修改了哪类配置，但不记录密钥原文。",
    "默认平台额度 + BYOK：同时支持官方统一额度和用户自带 Key。",
  ];
}
