export type ApiBaseUrlMode = "empty" | "invalid" | "local-simulator" | "lan-development" | "public-http" | "public-https";

export type ApiBaseUrlInspection = {
  host: string | null;
  mode: ApiBaseUrlMode;
  normalized: string;
  protocol: string | null;
  testflightReady: boolean;
};

const embeddedApiBaseUrl = normalizeApiBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL);

export const DEFAULT_API_BASE_URL = embeddedApiBaseUrl || (__DEV__ ? "http://127.0.0.1:3003" : "");
export const DEFAULT_API_BASE_URL_BUILD_MARKER =
  process.env.EXPO_PUBLIC_API_BASE_URL_MARKER || `ownminutes-api-default:${DEFAULT_API_BASE_URL}`;
export const CUSTOM_API_BASE_URL_EDITING_ENABLED = __DEV__;

export const MEETING_ID_PREFIX = "mobile-meeting";

export const MICROPHONE_NOTICE =
  "开始录音前，请确认参会人已知情并同意。实时转写只是草稿，正式纪要会基于完整音频重新处理。";

export function normalizeApiBaseUrl(value: string | undefined | null) {
  return value?.trim().replace(/\/$/, "") ?? "";
}

export function inspectApiBaseUrl(value: string): ApiBaseUrlInspection {
  const normalized = normalizeApiBaseUrl(value);
  if (!normalized) {
    return {
      host: null,
      mode: "empty",
      normalized,
      protocol: null,
      testflightReady: false,
    };
  }

  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return {
        host: null,
        mode: "invalid",
        normalized,
        protocol: parsed.protocol.replace(":", "") || null,
        testflightReady: false,
      };
    }
    const host = parsed.hostname;
    const protocol = parsed.protocol.replace(":", "");
    const localHost = isLoopbackHost(host);
    const lanHost = isLanHost(host);
    const https = parsed.protocol === "https:";
    const mode: ApiBaseUrlMode = localHost
      ? "local-simulator"
      : lanHost
        ? "lan-development"
        : https
          ? "public-https"
          : "public-http";

    return {
      host,
      mode,
      normalized,
      protocol,
      testflightReady: mode === "public-https",
    };
  } catch {
    return {
      host: null,
      mode: "invalid",
      normalized,
      protocol: null,
      testflightReady: false,
    };
  }
}

export function assertSafeMobileApiUrl(value: string) {
  const inspection = inspectApiBaseUrl(value);
  if (["local-simulator", "lan-development", "public-https"].includes(inspection.mode)) {
    return inspection.normalized;
  }
  if (inspection.mode === "public-http") {
    throw new Error("为保护账号密码、会议内容和模型密钥，公网 OwnMinutes 服务必须使用 HTTPS。");
  }
  throw new Error("OwnMinutes 服务地址为空、格式无效或使用了不支持的协议。");
}

export function getApiBaseUrlGuidance(value: string) {
  const inspection = inspectApiBaseUrl(value);

  if (inspection.mode === "public-https") {
    return {
      detail: `当前 API Base URL 是公网 HTTPS，可用于 TestFlight 外部测试：${inspection.host}`,
      tone: "success" as const,
    };
  }

  if (inspection.mode === "local-simulator") {
    return {
      detail: "当前地址只适合本机模拟器或本地预览。真机局域网调试请改为电脑局域网 IP；TestFlight 外部测试必须改为公网 HTTPS。",
      tone: "warning" as const,
    };
  }

  if (inspection.mode === "lan-development") {
    return {
      detail: "当前地址只适合同一 Wi-Fi 下的开发真机调试，不能用于 TestFlight 外部测试或 App Store 审核。",
      tone: "warning" as const,
    };
  }

  if (inspection.mode === "public-http") {
    return {
      detail: "当前地址是公网 HTTP。TestFlight、App Store、密码重置和 Apple IAP 通知都必须使用 HTTPS。",
      tone: "warning" as const,
    };
  }

  return {
    detail: "API Base URL 为空或格式无效。请填写 http://127.0.0.1:3003、本机局域网地址，或生产公网 HTTPS 地址。",
    tone: "error" as const,
  };
}

function isLoopbackHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

function isLanHost(host: string) {
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
