import { getProviderRuntimeConfig } from "@/lib/server/auth-repository";
import { postArkJson, validateArkBaseUrlStructure } from "@/lib/server/ark-endpoint-security";
import { getVolcanoRealtimeConfiguration, probeVolcanoRealtimeAuthentication } from "@/lib/server/volcano-realtime-asr";
import { getVolcanoFileAsrDiagnostic, probeVolcanoFileAsrSubmit, transcribeWithVolcanoFileAsr } from "@/lib/volcano-asr";

export type ProviderHealthStatus = "not_configured" | "incomplete" | "ready" | "failed";

export type ProviderHealthCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type ProviderHealthResult = {
  providerId: string;
  label: string;
  status: ProviderHealthStatus;
  canUseFor: Array<"file_asr" | "realtime_asr" | "summary">;
  liveChecked: boolean;
  checks: ProviderHealthCheck[];
  missing: string[];
  nextActions: string[];
  updatedAt: string;
};

export type ProviderSetupCapability = {
  id: "file_asr" | "summary";
  label: string;
  providerLabel: string;
  ready: boolean;
  statusLabel: string;
  detail: string;
  missing: string[];
  nextAction: string;
  href: string;
};

export type ProviderSetupReport = {
  score: number;
  readyCount: number;
  requiredCount: number;
  hasFileAsr: boolean;
  hasSummary: boolean;
  headline: string;
  nextAction: string;
  capabilities: ProviderSetupCapability[];
};

export type AsrLiveTestResult = {
  ok: boolean;
  live: boolean;
  mode: "submit" | "transcribe";
  status: "not_configured" | "incomplete" | "preflight_pass" | "submitted" | "transcribed" | "completed_empty" | "failed";
  verificationLevel: "none" | "preflight" | "provider_submit" | "provider_transcript";
  title: string;
  detail: string;
  requestId?: string;
  transcriptPreview?: string;
  missing: string[];
  nextAction: string;
  checkedAt: string;
};

export type RealtimeAsrAuthTestResult = {
  checkedAt: string;
  detail: string;
  endpointHost: string;
  endpointPath: string;
  httpStatus?: number;
  ok: boolean;
  resourceId: string;
  status: "not_configured" | "connected" | "failed";
  title: string;
};

export type ProviderHealthOptions = {
  live?: boolean;
};

export async function getUserProviderHealth(userId: string, options: ProviderHealthOptions = {}): Promise<ProviderHealthResult[]> {
  return [await getVolcanoAsrHealth(userId, options), await getVolcanoArkHealth(userId, options)];
}

export function getProviderSetupReport(health: ProviderHealthResult[]): ProviderSetupReport {
  const fileAsr = health.find((item) => item.canUseFor.includes("file_asr"));
  const summary = health.find((item) => item.canUseFor.includes("summary"));
  const asrHealth = health.find((item) => item.providerId === "volcano-asr");
  const summaryHealth = health.find((item) => item.providerId === "volcano-ark");
  const hasFileAsr = Boolean(fileAsr?.status === "ready");
  const hasSummary = Boolean(summary?.status === "ready");
  const readyCount = Number(hasFileAsr) + Number(hasSummary);
  const requiredCount = 2;
  const capabilities: ProviderSetupCapability[] = [
    {
      id: "file_asr",
      label: "会后识别",
      providerLabel: "火山语音识别",
      ready: hasFileAsr,
      statusLabel: hasFileAsr ? "可用" : asrHealth?.status === "incomplete" ? "待补字段" : "未配置",
      detail: hasFileAsr ? "可以用于会议结束后的完整音频识别。" : "没有可用 ASR 时，正式纪要会退回兜底结果，无法验收真实转写质量。",
      missing: asrHealth?.missing ?? ["provider credential"],
      nextAction: asrHealth?.nextActions[0] ?? "保存 ASR API Key，或保存 AppID + Token。",
      href: "https://console.volcengine.com/",
    },
    {
      id: "summary",
      label: "纪要总结",
      providerLabel: "火山方舟",
      ready: hasSummary,
      statusLabel: hasSummary ? "可用" : summaryHealth?.status === "incomplete" ? "待补字段" : "未配置",
      detail: hasSummary ? "可以用于会后摘要、决策、待办和 Obsidian Markdown。" : "没有可用总结模型时，会议结束后无法稳定生成正式纪要。",
      missing: summaryHealth?.missing ?? ["provider credential"],
      nextAction: summaryHealth?.nextActions[0] ?? "保存 Ark API Key 和模型 / Endpoint ID。",
      href: "https://console.volcengine.com/ark/",
    },
  ];

  return {
    score: Math.round((readyCount / requiredCount) * 100),
    readyCount,
    requiredCount,
    hasFileAsr,
    hasSummary,
    headline:
      readyCount === requiredCount
        ? "模型配置已具备真实会议验收条件。"
        : readyCount === 1
          ? "还差 1 个模型能力，暂不建议做正式验收。"
          : "还不能验收真实会议质量，请先配置 ASR 和总结模型。",
    nextAction: capabilities.find((item) => !item.ready)?.nextAction ?? "去录一段 1 分钟真实会议，验证转写、纪要、分享和 Markdown。",
    capabilities,
  };
}

export async function getUserProviderHealthById(userId: string, providerId: string, options: ProviderHealthOptions = {}): Promise<ProviderHealthResult> {
  if (providerId === "volcano-asr") return getVolcanoAsrHealth(userId, options);
  if (providerId === "volcano-ark") return getVolcanoArkHealth(userId, options);

  return {
    providerId,
    label: providerId,
    status: "not_configured",
    canUseFor: [],
    liveChecked: false,
    checks: [
      {
        id: "provider_supported",
        label: "Provider 支持",
        ok: false,
        detail: "当前健康检查只覆盖火山 ASR 和火山方舟。",
      },
    ],
    missing: ["supported provider"],
    nextActions: ["请选择火山 ASR 或火山方舟进行配置。"],
    updatedAt: new Date().toISOString(),
  };
}

export async function runVolcanoAsrLiveTest(
  userId: string,
  options: {
    audioBase64?: string;
    durationMs?: number;
    fileName?: string;
    live?: boolean;
    mimeType?: string;
    mode?: "submit" | "transcribe";
  } = {},
): Promise<AsrLiveTestResult> {
  const runtime = await getProviderRuntimeConfig(userId, "volcano-asr");
  const checkedAt = new Date().toISOString();
  const mode = options.mode === "transcribe" ? "transcribe" : "submit";
  if (!runtime) {
    return {
      ok: false,
      live: Boolean(options.live),
      mode,
      status: "not_configured",
      verificationLevel: "none",
      title: "还没有保存火山语音识别配置",
      detail: "请先保存 ASR API Key，或保存 AppID + Token。",
      missing: ["provider credential"],
      nextAction: "保存 ASR API Key，或保存 AppID + Token。",
      checkedAt,
    };
  }

  const config = {
    apiKey: runtime.secrets.VOLCANO_ASR_API_KEY,
    appId: runtime.fields.VOLCANO_ASR_APP_ID,
    token: runtime.secrets.VOLCANO_ASR_TOKEN,
    mode: runtime.fields.VOLCANO_ASR_MODE === "standard" ? "standard" as const : "flash" as const,
    recognizeUrl: runtime.fields.VOLCANO_ASR_RECOGNIZE_URL,
    submitUrl: runtime.fields.VOLCANO_ASR_SUBMIT_URL,
    queryUrl: runtime.fields.VOLCANO_ASR_QUERY_URL,
    resourceId: runtime.fields.VOLCANO_ASR_RESOURCE_ID,
    model: runtime.fields.VOLCANO_ASR_MODEL,
    vadSegmentDuration: runtime.fields.VOLCANO_ASR_VAD_SEGMENT_DURATION,
  };
  const diagnostic = getVolcanoFileAsrDiagnostic(config);

  if (!diagnostic.ready) {
    return {
      ok: false,
      live: Boolean(options.live),
      mode,
      status: "incomplete",
      verificationLevel: "none",
      title: "ASR 配置还不完整",
      detail: `缺少 ${diagnostic.missing.join(", ")}。`,
      missing: diagnostic.missing,
      nextAction: "补齐缺失字段后再次运行 ASR 小音频测试。",
      checkedAt,
    };
  }

  if (!options.live) {
    return {
      ok: true,
      live: false,
      mode,
      status: "preflight_pass",
      verificationLevel: "preflight",
      title: "ASR 小音频测试预检通过",
      detail:
        mode === "transcribe"
          ? "已具备发起完整识别测试的最小配置。真实执行会等待火山返回逐字稿。"
          : "已具备发起火山文件 ASR 测试的最小配置。点击真实测试会提交一段极短 WAV 到火山服务。",
      missing: [],
      nextAction: mode === "transcribe" ? "提交一段真实中文语音样本，确认能拿到可读逐字稿。" : "执行真实提交测试，确认火山接受请求并返回 request id。",
      checkedAt,
    };
  }

  if (mode === "transcribe" && !options.audioBase64) {
    return {
      ok: false,
      live: true,
      mode,
      status: "failed",
      verificationLevel: "none",
      title: "缺少完整识别测试音频",
      detail: "完整识别测试必须上传一段真实中文语音样本，不能使用静音占位音频。",
      missing: ["audio sample"],
      nextAction: "上传 5-30 秒普通话 WAV/M4A/MP3 样本后重新测试。",
      checkedAt,
    };
  }

  if (mode === "transcribe" && options.audioBase64) {
    const sampleValidation = validateAsrTranscribeSample(options);
    if (!sampleValidation.ok) {
      return {
        ok: false,
        live: true,
        mode,
        status: "failed",
        verificationLevel: "none",
        title: "ASR 完整识别测试样本不合格",
        detail: sampleValidation.detail,
        missing: sampleValidation.missing,
        nextAction: "上传 3-30 秒、音量清晰的普通话 WAV/M4A/MP3/WebM 样本后重新测试。",
        checkedAt,
      };
    }
  }

  try {
    const audio = buildAsrTestAudio(options);

    if (mode === "transcribe") {
      const result = await transcribeWithVolcanoFileAsr({
        meetingId: `asr-live-test-${Date.now()}`,
        buffer: audio.buffer,
        mimeType: audio.mimeType,
        fileName: audio.fileName,
        durationMs: audio.durationMs,
        config,
      });
      const transcriptPreview = result.text.slice(0, 180);
      const hasReadableText = Boolean(result.text.trim()) && !result.text.includes("没有可解析的逐字稿文本");

      return {
        ok: hasReadableText,
        live: true,
        mode,
        status: hasReadableText ? "transcribed" : "completed_empty",
        verificationLevel: "provider_transcript",
        title: hasReadableText ? "ASR 完整识别测试成功" : "ASR 已完成但没有可读文本",
        detail: hasReadableText
          ? "火山文件 ASR 已返回可读逐字稿。正式验收仍需录 1-3 分钟真实中文短会检查准确率。"
          : "火山文件 ASR 返回完成状态，但测试音频没有产生可读文本。请使用真实中文语音样本重试。",
        requestId: result.requestId,
        transcriptPreview: transcriptPreview || undefined,
        missing: [],
        nextAction: hasReadableText ? "继续录 1-3 分钟真实中文短会，检查摘要、决策和待办质量。" : "换成真实中文语音样本，并确认音频格式、音量和账号额度。",
        checkedAt,
      };
    }

    const submitted = await probeVolcanoFileAsrSubmit({
      meetingId: `asr-live-test-${Date.now()}`,
      buffer: audio.buffer,
      mimeType: audio.mimeType,
      fileName: audio.fileName,
      durationMs: audio.durationMs,
      config,
    });

    return {
      ok: true,
      live: true,
      mode,
      status: "submitted",
      verificationLevel: "provider_submit",
      title: "ASR 小音频真实提交成功",
      detail: "火山文件 ASR 已接受测试音频。该测试只证明 provider 接受请求，不证明识别文本质量。",
      requestId: submitted.requestId,
      missing: [],
      nextAction: "继续执行完整识别测试或录 1-3 分钟真实中文短会，确认逐字稿可读。",
      checkedAt,
    };
  } catch (error) {
    return {
      ok: false,
      live: true,
      mode,
      status: "failed",
      verificationLevel: "none",
      title: "ASR 小音频真实测试失败",
      detail: sanitizeProviderError(error),
      missing: [],
      nextAction: "检查 ASR Key、Endpoint、Resource ID、账号额度、音频格式和网络连通性。",
      checkedAt,
    };
  }
}

export async function runVolcanoRealtimeAuthTest(userId: string): Promise<RealtimeAsrAuthTestResult> {
  const runtime = await getProviderRuntimeConfig(userId, "volcano-asr");
  const checkedAt = new Date().toISOString();
  if (!runtime) {
    return {
      checkedAt,
      detail: "请先保存 ASR API Key，或保存 AppID + Token。",
      endpointHost: "",
      endpointPath: "",
      ok: false,
      resourceId: "",
      status: "not_configured",
      title: "还没有保存实时识别配置",
    };
  }

  const result = await probeVolcanoRealtimeAuthentication(runtime);
  return {
    checkedAt,
    detail: result.diagnostic,
    endpointHost: result.endpointHost,
    endpointPath: result.endpointPath,
    httpStatus: result.httpStatus,
    ok: result.ok,
    resourceId: result.resourceId,
    status: result.ok ? "connected" : "failed",
    title: result.ok ? "实时识别连接成功" : "实时识别连接失败",
  };
}

export function validateAsrTranscribeSample(options: {
  audioBase64?: string;
  durationMs?: number;
  fileName?: string;
  mimeType?: string;
}) {
  const mimeType = String(options.mimeType || "").toLowerCase();
  const fileName = String(options.fileName || "").toLowerCase();
  const supported = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/m4a", "audio/aac", "audio/webm", "audio/ogg"].some(
    (type) => mimeType.includes(type),
  ) || [".wav", ".mp3", ".m4a", ".aac", ".webm", ".ogg"].some((extension) => fileName.endsWith(extension));

  if (!supported) {
    return {
      ok: false,
      detail: "完整识别测试只接受 WAV、M4A、MP3、WebM 或 OGG 等音频样本。",
      missing: ["supported audio sample"],
    };
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(options.audioBase64 || "", "base64");
  } catch {
    return {
      ok: false,
      detail: "音频样本不是有效的 base64 内容。",
      missing: ["valid audio sample"],
    };
  }

  if (buffer.byteLength < 2048) {
    return {
      ok: false,
      detail: "音频样本太小，无法判断真实识别质量。",
      missing: ["non-empty audio sample"],
    };
  }

  const durationMs = Number(options.durationMs || 0);
  if (durationMs > 0 && durationMs < 3000) {
    return {
      ok: false,
      detail: "完整识别测试样本太短，建议至少 3 秒，最好 5-30 秒清晰普通话。",
      missing: ["audio duration >= 3000ms"],
    };
  }

  return {
    ok: true,
    detail: "",
    missing: [],
  };
}

function buildAsrTestAudio(options: {
  audioBase64?: string;
  durationMs?: number;
  fileName?: string;
  mimeType?: string;
}) {
  if (options.audioBase64) {
    return {
      buffer: Buffer.from(options.audioBase64, "base64"),
      durationMs: Math.max(1, Number(options.durationMs || 1000)),
      fileName: options.fileName || "ownminutes-asr-sample.wav",
      mimeType: options.mimeType || "audio/wav",
    };
  }

  return {
    buffer: createSilentWavBuffer({ durationMs: 800, sampleRate: 16000 }),
    durationMs: 800,
    fileName: "ownminutes-asr-live-test.wav",
    mimeType: "audio/wav",
  };
}

async function getVolcanoAsrHealth(userId: string, options: ProviderHealthOptions = {}): Promise<ProviderHealthResult> {
  const runtime = await getProviderRuntimeConfig(userId, "volcano-asr");
  if (!runtime) return notConfigured("volcano-asr", "火山语音识别", "保存 ASR API Key，或保存 AppID + Token。");

  const diagnostic = getVolcanoFileAsrDiagnostic({
    apiKey: runtime.secrets.VOLCANO_ASR_API_KEY,
    appId: runtime.fields.VOLCANO_ASR_APP_ID,
    token: runtime.secrets.VOLCANO_ASR_TOKEN,
    submitUrl: runtime.fields.VOLCANO_ASR_SUBMIT_URL,
    queryUrl: runtime.fields.VOLCANO_ASR_QUERY_URL,
    resourceId: runtime.fields.VOLCANO_ASR_RESOURCE_ID,
    model: runtime.fields.VOLCANO_ASR_MODEL,
    vadSegmentDuration: runtime.fields.VOLCANO_ASR_VAD_SEGMENT_DURATION,
  });
  const realtimeConfiguration = getVolcanoRealtimeConfiguration(runtime);
  const realtimeConfigured = realtimeConfiguration.configured;
  const realtimeProtocolReady = true;
  const liveProbe = options.live && diagnostic.ready
    ? await runVolcanoAsrLiveTest(userId, { live: true, mode: "submit" })
    : null;
  const liveChecked = Boolean(liveProbe);
  const liveOk = liveProbe?.ok === true;

  const checks: ProviderHealthCheck[] = [
    {
      id: "credential",
      label: "识别密钥",
      ok: diagnostic.ready,
      detail: diagnostic.ready ? "已具备文件识别运行时密钥。" : `缺少 ${diagnostic.missing.join(", ")}。`,
    },
    {
      id: "submit_endpoint",
      label: "提交地址",
      ok: diagnostic.present.VOLCANO_ASR_SUBMIT_URL,
      detail: diagnostic.present.VOLCANO_ASR_SUBMIT_URL ? "文件识别提交地址已配置或使用默认值。" : "缺少文件识别提交地址。",
    },
    {
      id: "query_endpoint",
      label: "查询地址",
      ok: diagnostic.present.VOLCANO_ASR_QUERY_URL,
      detail: diagnostic.present.VOLCANO_ASR_QUERY_URL ? "文件识别查询地址已配置或使用默认值。" : "缺少文件识别查询地址。",
    },
    {
      id: "realtime_ws",
      label: "实时 WebSocket",
      ok: realtimeConfigured && realtimeProtocolReady,
      detail: realtimeConfigured
        ? "实时 WebSocket 参数已配置；请运行实时识别连接测试确认 Key 已开通对应流式资源。"
        : "如需会议中实时草稿，请保存 ASR API Key 或 AppID + Token；WebSocket 和实时 Resource ID 可使用官方默认值。",
    },
    ...(liveProbe
      ? [{
          id: "live_file_asr_submit",
          label: "真实连通",
          ok: liveOk,
          detail: liveProbe.detail,
        }]
      : []),
  ];

  const status: ProviderHealthStatus = !diagnostic.ready ? "incomplete" : liveChecked && !liveOk ? "failed" : "ready";

  return {
    providerId: "volcano-asr",
    label: "火山语音识别",
    status,
    canUseFor: [...(status === "ready" ? ["file_asr" as const] : []), ...(status === "ready" && realtimeConfigured && realtimeProtocolReady ? ["realtime_asr" as const] : [])],
    liveChecked,
    checks,
    missing: [...diagnostic.missing, ...(realtimeConfigured ? [] : ["realtime ASR runtime credential"])],
    nextActions: status === "failed"
      ? ["真实 ASR 提交未通过，请检查 API Key、Resource ID、Endpoint、账号权限和余额后重试。"]
      : diagnostic.ready
      ? [
          realtimeConfigured
            ? "可用于会后完整音频识别和会议中实时草稿；下一步完成真实会议弱网与说话人验收。"
            : "可用于会后完整音频识别；如需会议中实时草稿，请补齐实时运行时凭据。",
        ]
      : ["保存 VOLCANO_ASR_API_KEY，或保存 VOLCANO_ASR_APP_ID + VOLCANO_ASR_TOKEN。"],
    updatedAt: new Date().toISOString(),
  };
}

function createSilentWavBuffer(input: { durationMs: number; sampleRate: number }) {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.floor((input.sampleRate * input.durationMs) / 1000));
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(input.sampleRate, 24);
  buffer.writeUInt32LE(input.sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function sanitizeProviderError(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  return message
    .replace(/AKL[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 260);
}

async function getVolcanoArkHealth(userId: string, options: ProviderHealthOptions = {}): Promise<ProviderHealthResult> {
  const runtime = await getProviderRuntimeConfig(userId, "volcano-ark");
  if (!runtime) return notConfigured("volcano-ark", "火山方舟", "保存 Ark API Key 和模型 / Endpoint ID。");

  const apiKey = runtime.secrets.ARK_API_KEY;
  const model = runtime.fields.ARK_CHAT_MODEL;
  const baseUrl = runtime.fields.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
  const baseUrlValidation = validateArkBaseUrlStructure(baseUrl);
  const checks: ProviderHealthCheck[] = [
    {
      id: "api_key",
      label: "Ark API Key",
      ok: Boolean(apiKey),
      detail: apiKey ? "Ark API Key 已加密保存。" : "缺少 Ark API Key。",
    },
    {
      id: "model",
      label: "模型 / Endpoint",
      ok: Boolean(model),
      detail: model ? "模型 / Endpoint ID 已配置。" : "缺少模型 / Endpoint ID。",
    },
    {
      id: "base_url",
      label: "Base URL",
      ok: baseUrlValidation.ok,
      detail: baseUrlValidation.ok
        ? "将使用火山方舟官方 HTTPS API 地址。"
        : "Base URL 不符合官方 HTTPS allowlist。",
    },
  ];
  const missing = [
    ...(!apiKey ? ["ARK_API_KEY"] : []),
    ...(!model ? ["ARK_CHAT_MODEL"] : []),
    ...(!baseUrlValidation.ok ? ["ARK_BASE_URL_OFFICIAL_HTTPS"] : []),
  ];
  let liveChecked = false;
  let liveOk = false;
  let liveDetail = "未执行真实连通测试。";

  if (options.live && missing.length === 0) {
    liveChecked = true;
    const probe = await probeArkChatCompletion({ apiKey, model, baseUrl });
    liveOk = probe.ok;
    liveDetail = probe.detail;
    checks.push({
      id: "live_chat_completion",
      label: "真实连通",
      ok: probe.ok,
      detail: probe.detail,
    });
  }

  const status = missing.length ? "incomplete" : liveChecked && !liveOk ? "failed" : "ready";

  return {
    providerId: "volcano-ark",
    label: "火山方舟",
    status,
    canUseFor: status === "ready" ? ["summary"] : [],
    liveChecked,
    checks,
    missing,
    nextActions: missing.length
      ? ["保存 ARK_API_KEY 和 ARK_CHAT_MODEL 后，会议结束才能生成正式纪要。"]
      : liveChecked
        ? [liveOk ? "真实连通测试通过，可用于会后正式纪要总结。" : `${liveDetail} 请检查 Ark API Key、模型 Endpoint、区域 Base URL 和账号额度。`]
        : ["可用于会后正式纪要总结；如需确认 Key 和模型权限，请手动执行真实测试。"],
    updatedAt: new Date().toISOString(),
  };
}

async function probeArkChatCompletion(input: { apiKey: string; model: string; baseUrl: string }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await postArkJson({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      body: {
        model: input.model,
        messages: [
          { role: "system", content: "Reply with ok." },
          { role: "user", content: "ping" },
        ],
        max_tokens: 1,
        temperature: 0,
      },
      maxResponseBytes: 64 * 1024,
      signal: controller.signal,
    });
    const text = response.bodyText;

    if (!response.ok) {
      return {
        ok: false,
        detail: `Ark 返回 HTTP ${response.status}：${summarizeProviderBody(text)}`,
      };
    }

    return {
      ok: true,
      detail: "Ark Chat Completions 轻量请求成功。",
    };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "请求超时" : error instanceof Error ? error.message : "未知错误";
    return {
      ok: false,
      detail: `Ark 真实连通失败：${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeProviderBody(text: string) {
  if (!text.trim()) return "无响应内容";

  try {
    const body = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return body.error?.message || body.message || text.slice(0, 160);
  } catch {
    return text.slice(0, 160);
  }
}

function notConfigured(providerId: string, label: string, action: string): ProviderHealthResult {
  return {
    providerId,
    label,
    status: "not_configured",
    canUseFor: [],
    liveChecked: false,
    checks: [
      {
        id: "credential",
        label: "用户级配置",
        ok: false,
        detail: "还没有保存用户级 Provider 配置。",
      },
    ],
    missing: ["provider credential"],
    nextActions: [action],
    updatedAt: new Date().toISOString(),
  };
}
