#!/usr/bin/env node

const config = {
  appUrl: readUrl("OWNMINUTES_APP_URL", "NEXT_PUBLIC_APP_URL"),
  mobileApiBaseUrl: readUrl("EXPO_PUBLIC_API_BASE_URL", "OWNMINUTES_MOBILE_API_BASE_URL"),
  privacyUrl: readUrl("OWNMINUTES_PRIVACY_URL", "NEXT_PUBLIC_PRIVACY_URL"),
  termsUrl: readUrl("OWNMINUTES_TERMS_URL", "NEXT_PUBLIC_TERMS_URL"),
  supportUrl: readUrl("OWNMINUTES_SUPPORT_URL", "NEXT_PUBLIC_SUPPORT_URL"),
  healthCheckUrl: readUrl("OWNMINUTES_HEALTH_CHECK_URL"),
  sampleShareUrl: readUrl("OWNMINUTES_SAMPLE_SHARE_URL"),
};
const supportEmail = readEmail("OWNMINUTES_SUPPORT_EMAIL", "NEXT_PUBLIC_SUPPORT_EMAIL");
const supportEmailCheck = inspectSupportEmail(supportEmail);

const urlChecks = Object.fromEntries(
  Object.entries(config).map(([key, value]) => [
    key,
    {
      configured: Boolean(value),
      host: inspectUrl(value).host,
      mode: inspectUrl(value).mode,
    },
  ]),
);
const checks = {
  ...urlChecks,
  supportEmail: {
    configured: Boolean(supportEmail),
    host: supportEmailCheck.host,
    mode: supportEmailCheck.mode,
  },
};
const missing = Object.entries(urlChecks)
  .filter(([key]) => key !== "sampleShareUrl")
  .filter(([, check]) => !check.configured)
  .map(([key]) => key)
  .concat(supportEmail ? [] : ["supportEmail"]);
const invalid = Object.entries(urlChecks)
  .filter(([key]) => key !== "sampleShareUrl")
  .filter(([, check]) => check.configured && check.mode !== "public-https")
  .map(([key, check]) => `${key}:${check.mode}`)
  .concat(supportEmail && !supportEmailCheck.valid ? [`supportEmail:${supportEmailCheck.mode}`] : []);
const pathWarnings = [
  pathWarning(config.privacyUrl, "privacy", "privacyUrl should point to /privacy"),
  pathWarning(config.termsUrl, "terms", "termsUrl should point to /terms"),
  pathWarning(config.supportUrl, "support", "supportUrl should point to /support"),
  pathWarning(config.healthCheckUrl, "/api/health", "healthCheckUrl should point to /api/health"),
  optionalPathWarning(config.sampleShareUrl, "/share/", "sampleShareUrl should point to /share/<meetingId>"),
].filter(Boolean);
const originWarnings = [
  originWarning(config.privacyUrl, config.appUrl, "privacyUrl should use the same origin as appUrl"),
  originWarning(config.termsUrl, config.appUrl, "termsUrl should use the same origin as appUrl"),
  originWarning(config.supportUrl, config.appUrl, "supportUrl should use the same origin as appUrl"),
  originWarning(config.healthCheckUrl, config.mobileApiBaseUrl, "healthCheckUrl should use the same origin as mobileApiBaseUrl"),
  optionalOriginWarning(config.sampleShareUrl, config.appUrl, "sampleShareUrl should use the same origin as appUrl"),
].filter(Boolean);
const optionalInvalid = config.sampleShareUrl && checks.sampleShareUrl.mode !== "public-https" ? [`sampleShareUrl:${checks.sampleShareUrl.mode}`] : [];

const summary = {
  checks,
  invalid: [...invalid, ...optionalInvalid],
  missing,
  originWarnings,
  pathWarnings,
  productionDeploymentReady: missing.length === 0 && invalid.length === 0 && optionalInvalid.length === 0 && pathWarnings.length === 0 && originWarnings.length === 0,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.productionDeploymentReady) {
  console.error(
    [
      "Public deployment preflight blocked.",
      "All public deployment URLs must be configured as public HTTPS URLs before production/TestFlight/App Store acceptance.",
      "Required: OWNMINUTES_APP_URL, EXPO_PUBLIC_API_BASE_URL, OWNMINUTES_PRIVACY_URL, OWNMINUTES_TERMS_URL, OWNMINUTES_SUPPORT_URL, OWNMINUTES_SUPPORT_EMAIL, OWNMINUTES_HEALTH_CHECK_URL.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

function readUrl(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim().replace(/\/$/, "");
    if (value) return value;
  }

  return "";
}

function readEmail(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function inspectSupportEmail(value) {
  if (!value) return { valid: false, host: null, mode: "empty" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { valid: false, host: null, mode: "invalid-email" };
  const host = value.split("@")[1].toLowerCase();
  if (/^(example\.(com|net|org)|localhost)$/.test(host) || /\.(test|invalid|localhost)$/.test(host)) {
    return { valid: false, host, mode: "placeholder-email" };
  }
  return { valid: true, host, mode: "public-email" };
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
    const pathname = new URL(value).pathname;
    if (expectedPath === "/api/health") return pathname === expectedPath ? "" : message;
    return pathname === `/${expectedPath}` ? "" : message;
  } catch {
    return "";
  }
}

function optionalPathWarning(value, expectedPathPrefix, message) {
  if (!value) return "";

  try {
    return new URL(value).pathname.startsWith(expectedPathPrefix) ? "" : message;
  } catch {
    return "";
  }
}

function originWarning(value, expectedOrigin, message) {
  if (!value || !expectedOrigin) return "";

  try {
    return new URL(value).origin === new URL(expectedOrigin).origin ? "" : message;
  } catch {
    return "";
  }
}

function optionalOriginWarning(value, expectedOrigin, message) {
  if (!value) return "";
  return originWarning(value, expectedOrigin, message);
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

function isLanHost(host) {
  return /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
