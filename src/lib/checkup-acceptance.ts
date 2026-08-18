import type { ReleaseReadinessBlocker, ReleaseReadinessReport } from "@/lib/release-readiness";

export type ManualAcceptanceItem = {
  title: string;
  action: string;
  pass: string;
  evidence: string;
};

export type GoNoGoDecision = {
  allowedScope: string;
  detail: string;
  requiredEvidence: string[];
  status: "GO" | "NO-GO" | "CONDITIONAL";
  title: string;
};

export type ReadinessStage = {
  detail: string;
  id: "commercial" | "testflight" | "mvp" | "foundation";
  label: string;
  tone: "done" | "pending" | "blocked";
};

export type LaunchReadinessPack = {
  id: string;
  title: string;
  purpose: string;
  externalMaterials: string[];
  blockers: ReleaseReadinessBlocker[];
};

export type CriticalBlockerEvidenceTemplate = {
  id: string;
  title: string;
  owner: string;
  evidenceLocation: string;
  requiredFields: string[];
  acceptanceEvidence: string;
  verificationCommand: string;
  runbookPath: string;
};

export const manualAcceptanceItems: ManualAcceptanceItem[] = [
  {
    title: "1. 注册或登录测试账号",
    action: "用手机宽度打开 /login 或 /register，确认一屏内能完成账号进入工作台。",
    pass: "进入 /app 后能看到录音工作台、底部导航和账号入口。",
    evidence: "记录测试账号、设备型号、浏览器或 App 版本，以及进入 /app 后的截图。",
  },
  {
    title: "2. 配置模型或确认 BYOK 路径",
    action: "打开 /settings，保存会后 ASR 和纪要模型配置；没有真实 Key 时至少确认首要阻塞和配置入口清晰。",
    pass: "页面不回显密钥原文，Provider health 能说明可用能力或缺失项。",
    evidence: "记录 Provider health 状态、缺失项、ASR 小音频测试结果；不要保存任何密钥原文。",
  },
  {
    title: "3. 验收 iPhone / TestFlight 长录音",
    action: "在真实 iPhone 安装候选版本，依次完成 5、30、90 分钟录音，并覆盖锁屏、切后台、来电、耳机断开、弱网和断网恢复。",
    pass: "每场原始音频可回放且时长合理，App 不崩溃，待上传分片可恢复，结束后能进入会后处理；实时识别失败不得导致音频丢失。",
    evidence: "记录 App build、iPhone/iOS 版本、每场时长与文件大小、分片成功/失败/重试数、中断时间线、崩溃日志和录音证据路径；不提交真实音频。",
  },
  {
    title: "4. 录制真人多人会议",
    action: "用 2-4 位真人录制 1-3 分钟普通话会议，包含自我介绍、明确决策和待办，并至少覆盖远近场、打断、噪声或口音中的两种情况。",
    pass: "实时草稿可读，会后正式逐字稿优于草稿，主要内容没有被静音占位替代；说话人数量和轮次基本正确，错误标签可会后改名修正。",
    evidence: "记录样本场景、说话人数、实时延迟、正式转写可用率、关键短语命中、说话人错误和会后改名结果；证据脱敏且不保存密钥。",
  },
  {
    title: "5. 检查会后纪要质量",
    action: "在会议纪要 Tab 检查摘要、关键决策、待办、风险和逐字稿；必要时重新生成。",
    pass: "纪要内容与录音基本一致，待办能看出负责人/事项/时间，未配置真实 ASR 时必须明确显示诊断警告。",
    evidence: "记录摘要、决策、待办是否来自录音内容；如有幻觉、漏听或说话人错误，写清样例。",
  },
  {
    title: "6. 发布分享并导出知识库",
    action: "发布分享链接，打开分享页；进入会议详情页点击“保存到 Obsidian”，或复制/下载 Markdown 后放入 Obsidian Vault。",
    pass: "分享页默认隐藏逐字稿和原始音频；Obsidian 写入成功时显示 Vault 内相对路径，Markdown 结构适合沉淀到项目知识库。",
    evidence: "记录分享链接、逐字稿是否隐藏、Vault 内相对路径、Markdown 文件名和项目目录。",
  },
  {
    title: "7. 做最终上线判断",
    action: "回到 /checkup，确认账号链路、自动化验收和上线阻塞列表。",
    pass: "若仍有关键 blocker，不能进入公开商用；只能作为本地 MVP 或受控测试版本继续试用。",
    evidence: "记录 release readiness 的 Ready/Warning/Blocked/Critical Blocked 数量和最终结论。",
  },
];

export type CheckupAcceptanceMarkdownInput = {
  generatedAt: string;
  user: {
    email: string;
    plan: string;
  };
  counts: {
    blocked: number;
    completedMeetings: number;
    meetings: number;
    officialMinutesRemaining: number;
    projects: number;
    sharedMeetings: number;
  };
  provider: {
    credentialCount: number;
    fileAsrReady: boolean;
    summaryProductionGateDetail: string;
    summaryProductionReady: boolean;
    summaryReady: boolean;
  };
  releaseReadiness: ReleaseReadinessReport;
};

export function buildCheckupAcceptanceMarkdown(input: CheckupAcceptanceMarkdownInput) {
  const blockers = input.releaseReadiness.blockers;
  const criticalBlockers = blockers.filter((item) => item.priority === "critical");
  const goNoGo = buildGoNoGoDecision(input.releaseReadiness);
  const readinessStage = getReadinessStage(input.releaseReadiness.summary);
  const launchPacks = buildLaunchReadinessPacks(input.releaseReadiness);
  const evidenceTemplates = buildCriticalBlockerEvidenceTemplates(input.releaseReadiness);
  const summaryModelBlocker = input.releaseReadiness.blockers.find((item) => item.id === "summary-model");

  return [
    "# OwnMinutes MVP 验收单",
    "",
    `生成时间：${input.generatedAt}`,
    `账号：${input.user.email}`,
    `方案：${input.user.plan.toUpperCase()}`,
    "",
    "## 当前账号状态",
    "",
    `- 会议数：${input.counts.meetings}`,
    `- 已生成纪要：${input.counts.completedMeetings}`,
    `- 已发布分享：${input.counts.sharedMeetings}`,
    `- 项目目录：${input.counts.projects}`,
    `- 剩余官方额度：${input.counts.officialMinutesRemaining} 分钟`,
    `- Provider 配置数：${input.provider.credentialCount}`,
    `- 会后 ASR 可用：${input.provider.fileAsrReady ? "是" : "否"}`,
    `- 账号级总结模型可用：${input.provider.summaryReady ? "是" : "否"}`,
    `- 总结模型生产门禁：${input.provider.summaryProductionReady ? "已通过" : "未通过"}`,
    `- 总结模型生产缺口：${input.provider.summaryProductionGateDetail}`,
    "- 口径说明：账号级可用不等于生产就绪；公开商用和正式上架必须以 release readiness 的 summary-model 门禁为准。",
    summaryModelBlocker ? `- summary-model 下一步：${summaryModelBlocker.nextAction}` : "- summary-model 下一步：无",
    "",
    "## Go/No-Go 判定",
    "",
    `- 当前结论：${goNoGo.status}`,
    `- 当前阶段：${readinessStage.label}`,
    `- 判定标题：${goNoGo.title}`,
    `- 判定说明：${goNoGo.detail}`,
    `- 允许范围：${goNoGo.allowedScope}`,
    "- 必须补齐的证据：",
    ...goNoGo.requiredEvidence.map((item) => `  - ${item}`),
    "",
    "## 人工验收脚本",
    "",
    "验收人：",
    "验收设备：",
    "验收环境：",
    "验收开始时间：",
    "验收结束时间：",
    "",
    ...manualAcceptanceItems.flatMap((item) => [
      `### ${item.title}`,
      "",
      `- 操作：${item.action}`,
      `- 通过标准：${item.pass}`,
      `- 证据建议：${item.evidence}`,
      "- 结果：待验收",
      "- 证据链接或截图：",
      "- 备注：",
      "",
    ]),
    "## 自动化验收证据",
    "",
    ...buildAutomationEvidenceSection(input.releaseReadiness),
    "## 上线准备包",
    "",
    ...buildLaunchReadinessPackSection(launchPacks),
    "## 最终上线总验收包",
    "",
    "总验收包用于汇总所有关键 evidence pack，不替代单项 checker。只有每个关键包都已人工复核、标记 `Decision: pass` 且 `Secrets leaked: no`，才能作为最终 launch gate 通过。",
    "",
    "- 草稿生成：`npm run launch:acceptance:evidence:draft`",
    "- 正式检查：`OWNMINUTES_LAUNCH_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/launch-latest.md npm run launch:acceptance:evidence`",
    "- Checker smoke：`npm run smoke:launch-evidence`",
    "- Runbook：`docs/launch-acceptance-runbook.md`",
    "- 私有证据文件：`.data/acceptance/launch-latest.md`，不得提交 GitHub。",
    "",
    "## 关键阻塞证据采集模板",
    "",
    ...buildCriticalBlockerEvidenceTemplateSection(evidenceTemplates),
    "## 关键上线阻塞",
    "",
    criticalBlockers.length
      ? criticalBlockers
          .map((item, index) =>
            [
              `${index + 1}. ${item.title}`,
              `   - 分组：${item.groupTitle}`,
              `   - 优先级：${item.priority}`,
              `   - 下一步：${item.nextAction}`,
              `   - 验收证据：${item.acceptanceEvidence}`,
              `   - 本地验证命令：${item.verificationCommand ?? "npm run smoke:release"}`,
              `   - Runbook：${item.runbook?.path ?? "未配置"}`,
            ].join("\n"),
          )
          .join("\n")
      : "当前没有关键阻塞。",
    "",
    "## Release Readiness",
    "",
    `- Ready：${input.releaseReadiness.summary.ready}`,
    `- Warning：${input.releaseReadiness.summary.warning}`,
    `- Blocked：${input.releaseReadiness.summary.blocked}`,
    `- Critical Blocked：${input.releaseReadiness.summary.criticalBlocked}`,
    `- MVP Ready：${input.releaseReadiness.summary.mvpReady ? "是" : "否"}`,
    `- TestFlight Ready：${input.releaseReadiness.summary.testflightReady ? "是" : "否"}`,
    `- Commercial Ready：${input.releaseReadiness.summary.commercialReady ? "是" : "否"}`,
    "",
    "## 最终结论",
    "",
    input.releaseReadiness.summary.criticalBlocked > 0
      ? "当前仍有关键阻塞，不允许进入公开商用或 App Store 正式上架。"
      : "关键阻塞已清零，可以进入最终人工验收和上线审批。",
    "",
  ].join("\n");
}

export function buildCriticalBlockerEvidenceTemplates(releaseReadiness: ReleaseReadinessReport): CriticalBlockerEvidenceTemplate[] {
  return releaseReadiness.blockers
    .filter((item) => item.priority === "critical")
    .map((item) => ({
      id: item.id,
      title: item.title,
      owner: evidenceOwnerForBlocker(item.id),
      evidenceLocation: evidenceLocationForBlocker(item.id),
      requiredFields: evidenceFieldsForBlocker(item.id),
      acceptanceEvidence: item.acceptanceEvidence,
      verificationCommand: item.verificationCommand ?? "npm run smoke:release",
      runbookPath: item.runbook?.path ?? "未配置",
    }));
}

export function getReadinessStage(summary: ReleaseReadinessReport["summary"]): ReadinessStage {
  if (summary.commercialReady) {
    return {
      detail: "所有 readiness 项均已 ready，可以进入公开商用和 App Store 正式上架前的最终人工审批。",
      id: "commercial",
      label: "公开商用准备",
      tone: "done",
    };
  }

  if (summary.testflightReady) {
    return {
      detail: "关键阻塞已清零，可以进入受控 TestFlight 验收；公开商用前仍需处理 warning 和最终人工验收。",
      id: "testflight",
      label: "TestFlight 准备",
      tone: "pending",
    };
  }

  if (summary.mvpReady) {
    return {
      detail: "核心录音、转写草稿、会后纪要、分享、Obsidian、账号和自动化验收链路已可本地/内部试用，但生产外部依赖尚未齐全。",
      id: "mvp",
      label: "本地 MVP 可测",
      tone: "pending",
    };
  }

  return {
    detail: "核心本地试用链路仍不完整，应先补齐录音工作台、账号、导出、合规和自动化验收。",
    id: "foundation",
    label: "基础能力未完成",
    tone: "blocked",
  };
}

export function buildLaunchReadinessPacks(releaseReadiness: ReleaseReadinessReport): LaunchReadinessPack[] {
  const blockerById = new Map(releaseReadiness.blockers.map((item) => [item.id, item]));

  return [
    {
      id: "ai-provider",
      title: "模型与识别准备包",
      purpose: "解决真实会议质量，证明会后转写、实时草稿和纪要总结不是 mock 或兜底内容。",
      externalMaterials: [
        "火山 ASR 运行时凭证",
        "火山实时 ASR WebSocket 配置",
        "方舟 Ark 总结模型 Key 和模型名",
        "summary:preflight 结果",
        "JSON-only、幻觉处理、重试和人工复核策略",
        "1-3 分钟普通话真实会议样本",
        "ASR 和纪要质量抽样记录",
      ],
      blockers: ["file-asr", "realtime-asr", "summary-model"].map((id) => blockerById.get(id)).filter(Boolean) as ReleaseReadinessBlocker[],
    },
    {
      id: "production-foundation",
      title: "生产基础设施准备包",
      purpose: "解决多用户公开使用的可靠性、删除一致性和密钥安全，避免继续依赖本地 JSON 或本地文件。",
      externalMaterials: [
        "PostgreSQL DATABASE_URL 和最小权限账号",
        "每日 AES-256-GCM .ombak 备份与异地复制记录",
        "独立主机数据库/对象恢复演练证据",
        "S3/R2/火山 TOS 对象存储 bucket 和 version-aware lifecycle 策略",
        "KMS 或托管 secret store",
        "备份密钥独立托管、租户隔离、轮换、删除和审计记录",
      ],
      blockers: ["database", "object-storage", "secret-management"].map((id) => blockerById.get(id)).filter(Boolean) as ReleaseReadinessBlocker[],
    },
    {
      id: "commercial-release",
      title: "商业化与上架准备包",
      purpose: "解决 App Store 下载、会员/额度购买、公网访问和外部用户支持路径。",
      externalMaterials: ["公网 HTTPS App/API URL", "隐私政策、条款、支持页公网 URL", "Apple Developer / App Store Connect / IAP 商品", "TestFlight 沙盒购买、退款、续期、过期证据", "外网健康检查和分享链接访问证据"],
      blockers: ["payments", "public-url"].map((id) => blockerById.get(id)).filter(Boolean) as ReleaseReadinessBlocker[],
    },
  ];
}

export function buildGoNoGoDecision(releaseReadiness: ReleaseReadinessReport): GoNoGoDecision {
  if (releaseReadiness.summary.commercialReady) {
    return {
      allowedScope: "可以进入公开商用、App Store 正式上架前的最终人工审批。",
      detail: "当前 release readiness 没有阻塞项，仍需要人工复核真实录音质量、隐私文案和上线配置。",
      requiredEvidence: [
        "最终人工验收单全部通过。",
        "真实 iPhone/TestFlight 录音、分享、Obsidian 导出和账号删除证据齐全。",
        "生产监控、回滚和支持入口已经确认。",
      ],
      status: "GO",
      title: "可以进入最终上线审批",
    };
  }

  if (releaseReadiness.summary.criticalBlocked > 0) {
    return {
      allowedScope: "只允许本地 MVP、内部试用或受控 TestFlight 准备；禁止公开商用、App Store 正式上架和大规模用户开放。",
      detail: `当前仍有 ${releaseReadiness.summary.criticalBlocked} 个关键阻塞和 ${releaseReadiness.summary.blocked} 个总阻塞，不能把产品描述为生产可用。`,
      requiredEvidence: [
        "真实 ASR 和总结模型完成生产 preflight、summary:preflight、短会验收和质量抽样。",
        "公网 HTTPS App/API、隐私政策、服务条款、支持页和健康检查 URL 可外部访问。",
        "生产数据库、对象存储、KMS/Secret、备份恢复和删除证明完成真实演练。",
        "Apple IAP/TestFlight 沙盒购买、退款、续期、过期和权益回收证据齐全。",
      ],
      status: "NO-GO",
      title: "禁止公开商用或正式上架",
    };
  }

  return {
    allowedScope: "可以进入小范围受控测试，但公开商用前仍要处理 warning 项和最终人工验收。",
    detail: `关键阻塞已清零，但仍有 ${releaseReadiness.summary.warning} 个 warning 项，需要补充真实运行证据。`,
    requiredEvidence: [
      "warning 项逐项完成复核或明确接受风险。",
      "最终人工验收单全部通过。",
      "真实用户支持、数据删除和回滚路径可执行。",
    ],
    status: "CONDITIONAL",
    title: "可以进入受控测试",
  };
}

function buildAutomationEvidenceSection(releaseReadiness: ReleaseReadinessReport) {
  const automationGroup = releaseReadiness.groups.find((group) => group.id === "acceptance");
  if (!automationGroup || automationGroup.items.length === 0) {
    return ["当前没有自动化验收分组。", ""];
  }

  return [
    `分组：${automationGroup.title}`,
    "",
    ...automationGroup.items.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `   - 状态：${statusLabel(item.status)}`,
      `   - 说明：${item.detail}`,
      `   - 证据：${item.evidence}`,
      `   - 下一步：${item.nextAction}`,
      "",
    ]),
  ];
}

function buildLaunchReadinessPackSection(packs: LaunchReadinessPack[]) {
  return packs.flatMap((pack) => [
    `### ${pack.title}`,
    "",
    `- 目的：${pack.purpose}`,
    "- 需要准备：",
    ...pack.externalMaterials.map((item) => `  - ${item}`),
    "- 关联阻塞：",
    ...(pack.blockers.length
      ? pack.blockers.flatMap((item) => [
          `  - ${item.title}`,
          `    - 下一步：${item.nextAction}`,
          `    - 验收证据：${item.acceptanceEvidence}`,
          `    - 本地验证命令：${item.verificationCommand ?? "npm run smoke:release"}`,
          `    - Runbook：${item.runbook?.path ?? "未配置"}`,
        ])
      : ["  - 当前没有关联阻塞。"]),
    "",
  ]);
}

function buildCriticalBlockerEvidenceTemplateSection(templates: CriticalBlockerEvidenceTemplate[]) {
  if (templates.length === 0) {
    return ["当前没有 critical blocker 证据模板。", ""];
  }

  return templates.flatMap((template, index) => [
    `### ${index + 1}. ${template.title}`,
    "",
    `- 负责人：${template.owner}`,
    `- 建议存放：${template.evidenceLocation}`,
    `- Runbook：${template.runbookPath}`,
    `- 本地验证命令：${template.verificationCommand}`,
    `- 通过证据：${template.acceptanceEvidence}`,
    "- 必填字段：",
    ...template.requiredFields.map((field) => `  - ${field}：`),
    "- 结论：待验收",
    "- 证据链接或截图：",
    "- 备注：",
    "",
  ]);
}

function evidenceOwnerForBlocker(id: string) {
  if (["file-asr", "realtime-asr", "summary-model"].includes(id)) return "模型/识别负责人";
  if (["database", "object-storage", "secret-management"].includes(id)) return "后端/基础设施负责人";
  if (id === "payments") return "iOS / 商业化负责人";
  if (id === "public-url") return "部署/运维负责人";
  return "项目负责人";
}

function evidenceLocationForBlocker(id: string) {
  if (["file-asr", "realtime-asr", "summary-model"].includes(id)) return "私有 Obsidian 验收记录或私有 GitHub issue；禁止提交真实音频和密钥。";
  if (["database", "object-storage", "secret-management"].includes(id)) return "私有运维验收记录；只记录掩码配置、演练结果和截图，不记录 secret 原文。";
  if (id === "payments") return "私有 Apple IAP sandbox 验收 issue；记录商品、交易状态、退款/续期/过期结果，不记录 sandbox 账号密码。";
  if (id === "public-url") return "公网部署验收记录；记录外网 URL、健康检查、分享链接和合规页面访问截图。";
  return "项目验收记录。";
}

function evidenceFieldsForBlocker(id: string) {
  const common = ["验收日期", "环境", "执行人", "风险结论"];
  const fields: Record<string, string[]> = {
    "file-asr": ["Provider", "ASR Key 类型", "小音频测试状态", "1-3 分钟短会转写质量", "错误样例或口音/噪声说明"],
    "realtime-asr": ["Provider", "WebSocket URL", "正常网络延迟", "弱网/断线表现", "本地录音是否完整保留"],
    "summary-model": ["模型", "逐字稿样本来源", "summary:preflight 结果", "JSON-only 策略", "幻觉处理策略", "重试策略", "人工复核策略", "摘要/决策/待办一致性", "幻觉检查结果", "Obsidian Markdown 检查"],
    database: ["PostgreSQL provider", "Migration 版本", "导入账号数量", "写入切换结果", ".ombak artifact 时间/大小/哈希", "独立主机恢复演练结果", "备份 freshness 监控", "最小权限账号验证"],
    "object-storage": ["对象存储 provider", "Bucket/区域", "上传/读取/列表/删除结果", "账号删除级联删除结果", "当前版本备份/恢复结果", "删除与非当前版本恢复策略", "异地副本与生命周期策略"],
    "secret-management": ["Vault/Secret provider", "Vault live evidence 时间与提交", "最小权限拒绝结果", "租户隔离方式", "密钥保存/读取掩码结果", "轮换结果", "删除结果", "Vault 备份恢复位置", "审计日志位置"],
    payments: ["Apple 环境", "商品 ID", "购买结果", "重复交易幂等", "续期/退款/过期通知", "权益回收结果"],
    "public-url": ["App URL", "API URL", "隐私/条款/支持 URL", "健康检查结果", "移动端 API Base URL", "外网分享链接结果"],
  };

  return [...common, ...(fields[id] ?? ["验收输入", "验收输出", "失败处理"])];
}

function statusLabel(status: "ready" | "warning" | "blocked") {
  if (status === "ready") return "Ready";
  if (status === "warning") return "Warning";
  return "Blocked";
}
