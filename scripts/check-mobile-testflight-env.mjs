#!/usr/bin/env node

const apiBaseUrl = normalize(process.env.EXPO_PUBLIC_API_BASE_URL || process.env.OWNMINUTES_MOBILE_API_BASE_URL || "");
const appUrl = normalize(process.env.OWNMINUTES_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "");
const privacyUrl = normalize(process.env.OWNMINUTES_PRIVACY_URL || process.env.NEXT_PUBLIC_PRIVACY_URL || "");
const termsUrl = normalize(process.env.OWNMINUTES_TERMS_URL || process.env.NEXT_PUBLIC_TERMS_URL || "");
const supportUrl = normalize(process.env.OWNMINUTES_SUPPORT_URL || process.env.NEXT_PUBLIC_SUPPORT_URL || "");
const healthCheckUrl = normalize(process.env.OWNMINUTES_HEALTH_CHECK_URL || "");
const supportEmail = (process.env.OWNMINUTES_SUPPORT_EMAIL || process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "").trim();
const supportEmailCheck = inspectSupportEmail(supportEmail);

const requiredUrls = {
  apiBaseUrl,
  appUrl,
  privacyUrl,
  termsUrl,
  supportUrl,
  healthCheckUrl,
};
const inspected = Object.fromEntries(Object.entries(requiredUrls).map(([key, value]) => [key, inspectUrl(value)]));
const missing = Object.entries(requiredUrls)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (!supportEmail) missing.push("supportEmail");
const invalid = Object.entries(inspected)
  .filter(([, value]) => value.mode !== "public-https")
  .map(([key, value]) => `${key}:${value.mode}`);
if (supportEmail && !supportEmailCheck.valid) invalid.push(`supportEmail:${supportEmailCheck.mode}`);
const pathWarnings = [
  pathWarning(privacyUrl, "/privacy", "privacyUrl should point to /privacy"),
  pathWarning(termsUrl, "/terms", "termsUrl should point to /terms"),
  pathWarning(supportUrl, "/support", "supportUrl should point to /support"),
  pathWarning(healthCheckUrl, "/api/health", "healthCheckUrl should point to /api/health"),
].filter(Boolean);

const summary = {
  urls: Object.fromEntries(
    Object.entries(requiredUrls).map(([key, value]) => [
      key,
      {
        configured: Boolean(value),
        host: inspected[key].host,
        mode: inspected[key].mode,
      },
    ]),
  ),
  missing,
  invalid,
  pathWarnings,
  supportEmail: {
    configured: Boolean(supportEmail),
    valid: supportEmailCheck.valid,
  },
  testflightReady: missing.length === 0 && invalid.length === 0 && pathWarnings.length === 0,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.testflightReady) {
  console.error(
    [
      "TestFlight build blocked: EXPO_PUBLIC_API_BASE_URL must be a public HTTPS origin.",
      "External TestFlight/App Store builds also require public HTTPS app, privacy, terms, support and health-check URLs, plus a valid public support email.",
      "Do not build external TestFlight/App Store packages with localhost, 127.0.0.1, LAN IP, invalid URL, public HTTP, or missing legal URLs.",
      "Required: EXPO_PUBLIC_API_BASE_URL, OWNMINUTES_APP_URL, OWNMINUTES_PRIVACY_URL, OWNMINUTES_TERMS_URL, OWNMINUTES_SUPPORT_URL, OWNMINUTES_SUPPORT_EMAIL, OWNMINUTES_HEALTH_CHECK_URL.",
      "Example: EXPO_PUBLIC_API_BASE_URL=https://app.example.com OWNMINUTES_APP_URL=https://app.example.com OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy OWNMINUTES_TERMS_URL=https://app.example.com/terms OWNMINUTES_SUPPORT_URL=https://app.example.com/support OWNMINUTES_SUPPORT_EMAIL=support@example.com OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health npm run mobile:testflight:build",
    ].join("\n"),
  );
  process.exitCode = 1;
}

function normalize(value) {
  return value.trim().replace(/\/$/, "");
}

function inspectSupportEmail(value) {
  if (!value) return { valid: false, mode: "empty" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { valid: false, mode: "invalid-email" };
  const host = value.split("@")[1].toLowerCase();
  if (/^(example\.(com|net|org)|localhost)$/.test(host) || /\.(test|invalid|localhost)$/.test(host)) {
    return { valid: false, mode: "placeholder-email" };
  }
  return { valid: true, mode: "public-email" };
}

function inspectUrl(value) {
  if (!value) return { host: null, mode: "empty" };

  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    if (isLoopbackHost(host)) return { host, mode: "local-simulator" };
    if (isLanHost(host)) return { host, mode: "lan-development" };
    if (parsed.protocol !== "https:") return { host, mode: "public-http" };
    return { host, mode: "public-https" };
  } catch {
    return { host: null, mode: "invalid" };
  }
}

function pathWarning(value, expectedPath, message) {
  if (!value) return "";

  try {
    return new URL(value).pathname.includes(expectedPath) ? "" : message;
  } catch {
    return "";
  }
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

function isLanHost(host) {
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
