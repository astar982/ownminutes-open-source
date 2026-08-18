import fs from "fs";
import path from "path";
import { hasCompletePublicLegalIdentity } from "@/lib/public-legal-identity";

export type DeploymentCheckStatus = "pass" | "fail" | "manual";

export type DeploymentDiagnosticCheck = {
  id: string;
  title: string;
  status: DeploymentCheckStatus;
  detail: string;
};

export type DeploymentDiagnostics = {
  generatedAt: string;
  productionReady: boolean;
  appUrl: {
    configured: boolean;
    https: boolean;
    publicHost: boolean;
    host: string | null;
  };
  mobileApiBaseUrl: {
    configured: boolean;
    https: boolean;
    publicHost: boolean;
    host: string | null;
  };
  legalPages: {
    localRoutesExist: boolean;
    publicUrlsConfigured: boolean;
    publicUrlsValid: boolean;
    supportEmailConfigured: boolean;
    supportEmailValid: boolean;
    operatorIdentityConfigured: boolean;
  };
  healthCheck: {
    localRouteExists: boolean;
    publicUrlConfigured: boolean;
    publicUrlValid: boolean;
  };
  sampleShareUrl: {
    configured: boolean;
    valid: boolean;
    host: string | null;
  };
  configured: {
    appUrl: boolean;
    mobileApiBaseUrl: boolean;
    privacyUrl: boolean;
    termsUrl: boolean;
    supportUrl: boolean;
    supportEmail: boolean;
    healthCheckUrl: boolean;
    legalOperatorIdentity: boolean;
  };
  capabilities: {
    supportsAppStoreLegalUrls: boolean;
    supportsTestFlightApi: boolean;
    avoidsLocalhostForMobile: boolean;
    hasPublicHttpsOrigin: boolean;
  };
  missing: string[];
  checks: DeploymentDiagnosticCheck[];
  notes: string[];
};

export function getDeploymentDiagnostics(): DeploymentDiagnostics {
  const appUrlValue = getEnv("OWNMINUTES_APP_URL", "NEXT_PUBLIC_APP_URL");
  const mobileApiBaseUrlValue = getEnv("EXPO_PUBLIC_API_BASE_URL", "OWNMINUTES_MOBILE_API_BASE_URL");
  const privacyUrl = getEnv("OWNMINUTES_PRIVACY_URL", "NEXT_PUBLIC_PRIVACY_URL");
  const termsUrl = getEnv("OWNMINUTES_TERMS_URL", "NEXT_PUBLIC_TERMS_URL");
  const supportUrl = getEnv("OWNMINUTES_SUPPORT_URL", "NEXT_PUBLIC_SUPPORT_URL");
  const supportEmail = getEnv("OWNMINUTES_SUPPORT_EMAIL", "NEXT_PUBLIC_SUPPORT_EMAIL");
  const healthCheckUrl = getEnv("OWNMINUTES_HEALTH_CHECK_URL");
  const sampleShareUrlValue = getEnv("OWNMINUTES_SAMPLE_SHARE_URL");
  const legalOperatorIdentity = hasCompletePublicLegalIdentity();
  const appUrl = inspectUrl(appUrlValue);
  const mobileApiBaseUrl = inspectUrl(mobileApiBaseUrlValue);
  const privacy = inspectUrl(privacyUrl);
  const terms = inspectUrl(termsUrl);
  const support = inspectUrl(supportUrl);
  const health = inspectUrl(healthCheckUrl);
  const sampleShareUrl = inspectUrl(sampleShareUrlValue);
  const legalRoutesExist = localLegalRoutesExist();
  const healthRouteExists = fileExists("src/app/api/health/route.ts");
  const publicUrlsConfigured = Boolean(privacyUrl && termsUrl && supportUrl);
  const publicUrlsValid =
    publicUrlsConfigured &&
    urlSharesOrigin(privacyUrl, appUrlValue) &&
    urlSharesOrigin(termsUrl, appUrlValue) &&
    urlSharesOrigin(supportUrl, appUrlValue) &&
    hasExactPath(privacyUrl, "/privacy") &&
    hasExactPath(termsUrl, "/terms") &&
    hasExactPath(supportUrl, "/support");
  const supportEmailValid = isPublicSupportEmail(supportEmail);
  const healthCheckUrlValid = Boolean(healthCheckUrl) && urlSharesOrigin(healthCheckUrl, mobileApiBaseUrlValue) && hasExactPath(healthCheckUrl, "/api/health");
  const sampleShareUrlValid =
    !sampleShareUrlValue ||
    (sampleShareUrl.https && sampleShareUrl.publicHost && urlSharesOrigin(sampleShareUrlValue, appUrlValue) && hasPathPrefix(sampleShareUrlValue, "/share/"));
  const productionReady =
    appUrl.https &&
    appUrl.publicHost &&
    mobileApiBaseUrl.https &&
    mobileApiBaseUrl.publicHost &&
    publicUrlsValid &&
    legalOperatorIdentity &&
    supportEmailValid &&
    healthCheckUrlValid &&
    sampleShareUrlValid;
  const missing = getMissingConfig({
    appUrl,
    healthCheckUrlValid,
    mobileApiBaseUrl,
    publicUrlsConfigured,
    publicUrlsValid,
    supportEmailConfigured: Boolean(supportEmail),
    supportEmailValid,
    healthCheckUrl: Boolean(healthCheckUrl),
    sampleShareUrlConfigured: Boolean(sampleShareUrlValue),
    sampleShareUrlValid,
    legalOperatorIdentity,
  });

  return {
    generatedAt: new Date().toISOString(),
    productionReady,
    appUrl,
    mobileApiBaseUrl,
    legalPages: {
      localRoutesExist: legalRoutesExist,
      publicUrlsConfigured,
      publicUrlsValid,
      supportEmailConfigured: Boolean(supportEmail),
      supportEmailValid,
      operatorIdentityConfigured: legalOperatorIdentity,
    },
    healthCheck: {
      localRouteExists: healthRouteExists,
      publicUrlConfigured: Boolean(healthCheckUrl),
      publicUrlValid: healthCheckUrlValid,
    },
    sampleShareUrl: {
      configured: Boolean(sampleShareUrlValue),
      host: sampleShareUrl.host,
      valid: sampleShareUrlValid,
    },
    configured: {
      appUrl: Boolean(appUrlValue),
      mobileApiBaseUrl: Boolean(mobileApiBaseUrlValue),
      privacyUrl: Boolean(privacyUrl),
      termsUrl: Boolean(termsUrl),
      supportUrl: Boolean(supportUrl),
      supportEmail: Boolean(supportEmail),
      healthCheckUrl: Boolean(healthCheckUrl),
      legalOperatorIdentity,
    },
    capabilities: {
      supportsAppStoreLegalUrls:
        publicUrlsValid &&
        legalOperatorIdentity &&
        supportEmailValid &&
        appUrl.https &&
        appUrl.publicHost,
      supportsTestFlightApi: mobileApiBaseUrl.https && mobileApiBaseUrl.publicHost && healthCheckUrlValid,
      avoidsLocalhostForMobile: mobileApiBaseUrl.configured && mobileApiBaseUrl.publicHost,
      hasPublicHttpsOrigin: appUrl.https && appUrl.publicHost,
    },
    missing,
    checks: [
      {
        id: "public-app-url",
        title: "公网 App URL",
        status: appUrl.https && appUrl.publicHost ? "pass" : "fail",
        detail: appUrl.configured ? describeUrlCheck(appUrl, "App URL") : "缺少 OWNMINUTES_APP_URL 或 NEXT_PUBLIC_APP_URL。",
      },
      {
        id: "mobile-api-base-url",
        title: "移动端 API Base URL",
        status: mobileApiBaseUrl.https && mobileApiBaseUrl.publicHost ? "pass" : "fail",
        detail: mobileApiBaseUrl.configured ? describeUrlCheck(mobileApiBaseUrl, "移动端 API Base URL") : "缺少 EXPO_PUBLIC_API_BASE_URL 或 OWNMINUTES_MOBILE_API_BASE_URL。",
      },
      {
        id: "local-legal-routes",
        title: "本地合规页面",
        status: legalRoutesExist ? "pass" : "fail",
        detail: legalRoutesExist ? "/privacy、/terms、/support、/data-deletion 本地路由存在。" : "缺少 privacy、terms、support 或 data-deletion 页面。",
      },
      {
        id: "public-legal-urls",
        title: "公网合规 URL",
        status: publicUrlsValid ? "manual" : "fail",
        detail: publicUrlsValid
          ? "已声明同源 /privacy、/terms、/support 公网 URL，仍需逐页打开验证。"
          : publicUrlsConfigured
            ? "隐私政策、服务条款或支持 URL 必须与 App URL 同源，且路径分别为 /privacy、/terms、/support。"
            : "缺少 App Store 可填写的隐私政策、服务条款或支持公网 URL。",
      },
      {
        id: "public-legal-operator",
        title: "公开运营主体",
        status: legalOperatorIdentity ? "pass" : "fail",
        detail: legalOperatorIdentity
          ? "已配置公开运营主体名称、联系地址和适用司法管辖区。"
          : "缺少真实运营主体、联系地址或适用司法管辖区，公开发布门禁保持关闭。",
      },
      {
        id: "public-support-email",
        title: "公开支持邮箱",
        status: supportEmailValid ? "pass" : "fail",
        detail: supportEmailValid
          ? `支持邮箱已配置，域名为 ${supportEmail.split("@")[1]}。`
          : supportEmail
            ? "OWNMINUTES_SUPPORT_EMAIL 格式无效或仍使用占位域名。"
            : "缺少 OWNMINUTES_SUPPORT_EMAIL，支持和删除页面没有私密联系渠道。",
      },
      {
        id: "health-check-url",
        title: "公网健康检查",
        status: healthCheckUrlValid ? "manual" : "fail",
        detail: healthCheckUrlValid
          ? "已声明与移动端 API 同源的 /api/health 公网健康检查 URL，仍需部署侧监控验证。"
          : healthCheckUrl
            ? "健康检查 URL 必须与移动端 API Base URL 同源，且路径为 /api/health。"
            : "缺少可用于上线监控的公网健康检查 URL。",
      },
      {
        id: "local-health-route",
        title: "本地健康检查 API",
        status: healthRouteExists ? "pass" : "fail",
        detail: healthRouteExists ? "`/api/health` 本地路由存在，可作为公网监控目标。" : "缺少 `/api/health` 本地路由。",
      },
      {
        id: "no-localhost-release",
        title: "禁止本地地址上架",
        status:
          !usesLocalhost(appUrl.host) &&
          !usesLocalhost(mobileApiBaseUrl.host) &&
          !usesLocalhost(privacy.host) &&
          !usesLocalhost(terms.host) &&
          !usesLocalhost(support.host) &&
          !usesLocalhost(health.host) &&
          !usesLocalhost(sampleShareUrl.host)
            ? "pass"
            : "fail",
        detail: "App Store/TestFlight 外部测试不能依赖 localhost、127.0.0.1、0.0.0.0 或局域网 IP。",
      },
      {
        id: "sample-share-url",
        title: "示例分享链接",
        status: sampleShareUrlValue ? (sampleShareUrlValid ? "manual" : "fail") : "manual",
        detail: sampleShareUrlValue
          ? sampleShareUrlValid
            ? "已声明同源 /share/<meetingId> 示例链接，仍需外网打开验证。"
            : "示例分享链接必须是 App URL 同源公网 HTTPS，路径为 /share/<meetingId>。"
          : "可选但建议配置 OWNMINUTES_SAMPLE_SHARE_URL，作为 TestFlight/审核前公开分享链路验证目标。",
      },
    ],
    notes: [
      "诊断只输出域名级状态，不主动请求公网 URL。",
      "productionReady=true 只表示部署 URL 条件基本齐备；仍需要真实 HTTPS 访问、证书、CORS、移动端真机和监控验证。",
    ],
  };
}

function isPublicSupportEmail(value: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  const host = value.split("@")[1].toLowerCase();
  return !/^(example\.(com|net|org)|localhost)$/.test(host) && !/\.(test|invalid|localhost)$/.test(host);
}

function inspectUrl(value: string) {
  if (!value) {
    return {
      configured: false,
      https: false,
      publicHost: false,
      host: null,
    };
  }

  try {
    const parsed = new URL(value);
    return {
      configured: true,
      https: parsed.protocol === "https:",
      publicHost: !usesLocalhost(parsed.hostname),
      host: parsed.hostname,
    };
  } catch {
    return {
      configured: true,
      https: false,
      publicHost: false,
      host: null,
    };
  }
}

function describeUrlCheck(url: ReturnType<typeof inspectUrl>, label: string) {
  if (!url.host) return `${label} 格式无效。`;
  if (!url.https && !url.publicHost) return `${label} 不是 HTTPS，且仍是本地/局域网地址。`;
  if (!url.https) return `${label} 不是 HTTPS。`;
  if (!url.publicHost) return `${label} 仍是本地/局域网地址。`;
  return `${label} 已配置为公网 HTTPS 域名：${url.host}`;
}

function getMissingConfig(input: {
  appUrl: ReturnType<typeof inspectUrl>;
  healthCheckUrlValid: boolean;
  mobileApiBaseUrl: ReturnType<typeof inspectUrl>;
  publicUrlsConfigured: boolean;
  publicUrlsValid: boolean;
  supportEmailConfigured: boolean;
  supportEmailValid: boolean;
  healthCheckUrl: boolean;
  sampleShareUrlConfigured: boolean;
  sampleShareUrlValid: boolean;
  legalOperatorIdentity: boolean;
}) {
  const missing: string[] = [];
  if (!input.appUrl.configured) missing.push("OWNMINUTES_APP_URL or NEXT_PUBLIC_APP_URL");
  if (input.appUrl.configured && !input.appUrl.https) missing.push("HTTPS app URL");
  if (input.appUrl.configured && !input.appUrl.publicHost) missing.push("public app host");
  if (!input.mobileApiBaseUrl.configured) missing.push("EXPO_PUBLIC_API_BASE_URL or OWNMINUTES_MOBILE_API_BASE_URL");
  if (input.mobileApiBaseUrl.configured && !input.mobileApiBaseUrl.https) missing.push("HTTPS mobile API base URL");
  if (input.mobileApiBaseUrl.configured && !input.mobileApiBaseUrl.publicHost) missing.push("public mobile API host");
  if (!input.publicUrlsConfigured) missing.push("OWNMINUTES_PRIVACY_URL + OWNMINUTES_TERMS_URL + OWNMINUTES_SUPPORT_URL");
  if (input.publicUrlsConfigured && !input.publicUrlsValid) missing.push("same-origin /privacy + /terms + /support URLs");
  if (!input.legalOperatorIdentity) {
    missing.push("OWNMINUTES_LEGAL_OPERATOR_NAME + OWNMINUTES_LEGAL_OPERATOR_ADDRESS + OWNMINUTES_LEGAL_OPERATOR_JURISDICTION");
  }
  if (!input.supportEmailConfigured) missing.push("OWNMINUTES_SUPPORT_EMAIL");
  if (input.supportEmailConfigured && !input.supportEmailValid) missing.push("valid public support email");
  if (!input.healthCheckUrl) missing.push("OWNMINUTES_HEALTH_CHECK_URL");
  if (input.healthCheckUrl && !input.healthCheckUrlValid) missing.push("same-origin /api/health URL");
  if (input.sampleShareUrlConfigured && !input.sampleShareUrlValid) missing.push("same-origin /share/<meetingId> sample URL");
  return missing;
}

function hasExactPath(value: string, expectedPath: string) {
  try {
    return new URL(value).pathname === expectedPath;
  } catch {
    return false;
  }
}

function hasPathPrefix(value: string, expectedPrefix: string) {
  try {
    return new URL(value).pathname.startsWith(expectedPrefix);
  } catch {
    return false;
  }
}

function urlSharesOrigin(value: string, expectedOriginValue: string) {
  try {
    return new URL(value).origin === new URL(expectedOriginValue).origin;
  } catch {
    return false;
  }
}

function localLegalRoutesExist() {
  return fileExists("src/app/privacy/page.tsx") && fileExists("src/app/terms/page.tsx") && fileExists("src/app/support/page.tsx") && fileExists("src/app/data-deletion/page.tsx");
}

function fileExists(relativePath: string) {
  return fs.existsSync(path.join(process.cwd(), relativePath));
}

function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  return "";
}

function usesLocalhost(host: string | null) {
  if (!host) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}
