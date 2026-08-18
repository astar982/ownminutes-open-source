#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const allowLocal = process.env.OWNMINUTES_DEPLOYMENT_VERIFY_ALLOW_LOCAL === "1";
const internalTestFlightOnly = process.argv.includes("--testflight-internal-only");
const timeoutMs = Number(process.env.OWNMINUTES_DEPLOYMENT_VERIFY_TIMEOUT_MS || 10000);
const evidenceDraftPath = process.env.OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_DRAFT_PATH?.trim() || "";
const adminBearerToken = readAdminBearerToken();
const legalIdentityMissing =
  "OWNMINUTES_LEGAL_OPERATOR_NAME + OWNMINUTES_LEGAL_OPERATOR_ADDRESS + OWNMINUTES_LEGAL_OPERATOR_JURISDICTION";

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

const requiredUrlEntries = Object.entries(config).filter(([key]) => key !== "sampleShareUrl");
const urlChecks = Object.fromEntries(requiredUrlEntries.map(([key, value]) => [key, validatePublicUrl(value)]));
const urlFailures = Object.entries(urlChecks)
  .filter(([, check]) => !check.ok)
  .map(([key, check]) => `${key}:${check.reason}`);
const supportEmailCheck = inspectSupportEmail(supportEmail);
const supportFailures = supportEmailCheck.valid ? [] : [supportEmail ? `supportEmail:${supportEmailCheck.mode}` : "supportEmail:missing"];

const results = [];

if (urlFailures.length === 0 && supportFailures.length === 0) {
  results.push(await checkPage("app", config.appUrl));
  results.push(await checkRedirect("app-login-gate", joinUrl(config.appUrl, "/app"), "/login"));
  results.push(await checkPage("privacy", config.privacyUrl));
  results.push(await checkPage("terms", config.termsUrl));
  results.push(await checkPage("support", config.supportUrl, allowLocal ? "" : `mailto:${supportEmail}`));
  results.push(await checkPage("data-deletion", joinUrl(config.appUrl, "/data-deletion"), allowLocal ? "" : `mailto:${supportEmail}`));
  results.push(await checkHealth(config.healthCheckUrl));
  results.push(await checkReadiness(joinUrl(config.mobileApiBaseUrl, "/api/readyz")));
  results.push(await checkDeploymentDiagnostics(
    joinUrl(config.mobileApiBaseUrl, "/api/deployment/diagnostics"),
    adminBearerToken,
  ));
  results.push(await checkReleaseReadiness(
    joinUrl(config.mobileApiBaseUrl, "/api/release/readiness"),
    adminBearerToken,
  ));

  if (config.sampleShareUrl) {
    const sampleShareValidation = validateSampleShareUrl(config.sampleShareUrl, config.appUrl);
    results.push(
      sampleShareValidation.ok
        ? await checkPage("sample-share", config.sampleShareUrl)
        : {
            id: "sample-share",
            ok: false,
            status: 0,
            detail: `Sample share URL invalid: ${sampleShareValidation.reason}`,
          },
    );
  }
}

const summary = {
  allowLocal,
  verificationScope: internalTestFlightOnly ? "internal-testflight-only" : "production",
  adminVerificationConfigured: Boolean(adminBearerToken),
  checkedAt: new Date().toISOString(),
  productionDeploymentVerified: urlFailures.length === 0 && supportFailures.length === 0 && results.length > 0 && results.every((result) => result.ok),
  internalTestFlightDeploymentVerified:
    internalTestFlightOnly &&
    !allowLocal &&
    urlFailures.length === 0 &&
    supportFailures.length === 0 &&
    results.length > 0 &&
    results.every((result) => result.internalTestFlightOk ?? result.ok),
  urlChecks,
  urlFailures,
  supportEmailConfigured: supportFailures.length === 0,
  supportFailures,
  results,
  leaksSecrets: results.some((result) => result.leaksSecrets),
};

if (evidenceDraftPath) {
  writeEvidenceDraft(evidenceDraftPath, summary);
}

console.log(JSON.stringify(summary, null, 2));

const selectedVerificationPassed = internalTestFlightOnly
  ? summary.internalTestFlightDeploymentVerified
  : summary.productionDeploymentVerified;

if (!selectedVerificationPassed || summary.leaksSecrets) {
  console.error(
    [
      internalTestFlightOnly
        ? "Internal TestFlight deployment verification failed."
        : "Public deployment live verification failed.",
      allowLocal
        ? "Local verification mode is only for smoke tests and must not be used as production/TestFlight/App Store evidence."
        : internalTestFlightOnly
          ? "Internal-only verification requires public HTTPS runtime checks, protected administrator diagnostics, and no missing deployment configuration except the explicitly reported legal identity."
          : "Set public HTTPS deployment URLs and a short-lived OWNMINUTES_DEPLOYMENT_VERIFY_ADMIN_BEARER_TOKEN, then rerun deployment:verify from a network that can reach the deployment.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

async function checkPage(id, url, requiredText = "") {
  const response = await fetchWithTimeout(url, { redirect: "follow" });
  const text = await response.text();
  const requiredTextPresent = !requiredText || text.includes(requiredText);
  return {
    id,
    ok: response.ok && requiredTextPresent && !leaksSecrets(text),
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    detail: response.ok && requiredTextPresent ? "Reachable." : response.ok ? "Required public contact is missing." : `Unexpected HTTP ${response.status}.`,
    leaksSecrets: leaksSecrets(text),
  };
}

async function checkRedirect(id, url, expectedLocation) {
  const response = await fetchWithTimeout(url, { redirect: "manual" });
  const location = response.headers.get("location") || "";
  const ok = [301, 302, 303, 307, 308].includes(response.status) && location.includes(expectedLocation);
  return {
    id,
    ok,
    status: response.status,
    detail: ok ? `Redirects to ${location}.` : `Expected redirect to ${expectedLocation}, got ${response.status} ${location || "(no location)"}.`,
    leaksSecrets: leaksSecrets(location),
  };
}

async function checkHealth(url) {
  const response = await fetchWithTimeout(url, { redirect: "follow" });
  const payload = await readJson(response, "health");
  const text = JSON.stringify(payload);
  return {
    id: "health",
    ok: response.ok && payload.ok === true && payload.service === "ownminutes" && !leaksSecrets(text),
    status: response.status,
    detail: payload.ok === true ? "Health API returned ok=true." : "Health API did not return ok=true.",
    leaksSecrets: leaksSecrets(text),
  };
}

async function checkReadiness(url) {
  const response = await fetchWithTimeout(url, { redirect: "follow" });
  const payload = await readJson(response, "readiness");
  const text = JSON.stringify(payload);
  return {
    id: "readiness",
    ok:
      response.ok &&
      payload.ok === true &&
      payload.releaseReady === true &&
      payload.service === "ownminutes" &&
      payload.status === "ready" &&
      !leaksSecrets(text),
    status: response.status,
    detail:
      response.ok && payload.ok === true && payload.releaseReady === true && payload.status === "ready"
        ? "Readiness API confirms traffic and release gates are ready."
        : `Readiness API is not release-ready (HTTP ${response.status}, releaseReady=${String(payload.releaseReady)}).`,
    leaksSecrets: leaksSecrets(text),
  };
}

async function checkDeploymentDiagnostics(url, bearerToken) {
  const protection = internalTestFlightOnly
    ? await checkAdminRouteProtection(url, "deployment diagnostics")
    : null;
  const response = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: adminAuthorizationHeaders(bearerToken),
  });
  const payload = await readJson(response, "deployment diagnostics");
  const text = JSON.stringify(payload);
  const protectedResponse = response.status === 401 || response.status === 403;
  if (protectedResponse) {
    return {
      id: "deployment-diagnostics",
      ok: allowLocal && !bearerToken && !leaksSecrets(text),
      status: response.status,
      adminProtected: true,
      authenticated: false,
      detail: bearerToken
        ? "Deployment diagnostics rejected the supplied administrator session."
        : "Deployment diagnostics are administrator-protected; authenticated production evidence remains pending.",
      leaksSecrets: leaksSecrets(text),
    };
  }
  const diagnostics = payload.diagnostics;
  const authenticated = Boolean(bearerToken) && response.ok;
  const productionOk =
    authenticated &&
    response.ok &&
    payload.ok === true &&
    diagnostics?.productionReady === true &&
    diagnostics?.appUrl?.https === true &&
    diagnostics?.appUrl?.publicHost === true &&
    diagnostics?.mobileApiBaseUrl?.https === true &&
    diagnostics?.mobileApiBaseUrl?.publicHost === true &&
    !leaksSecrets(text);
  const missing = Array.isArray(diagnostics?.missing) ? diagnostics.missing : [];
  const onlyAllowedInternalMissing =
    missing.length === 0 || (missing.length === 1 && missing[0] === legalIdentityMissing);
  const internalTestFlightOk =
    internalTestFlightOnly &&
    protection?.ok === true &&
    authenticated &&
    response.ok &&
    payload.ok === true &&
    diagnostics?.productionReady === (missing.length === 0) &&
    diagnostics?.appUrl?.https === true &&
    diagnostics?.appUrl?.publicHost === true &&
    diagnostics?.mobileApiBaseUrl?.https === true &&
    diagnostics?.mobileApiBaseUrl?.publicHost === true &&
    diagnostics?.legalPages?.publicUrlsConfigured === true &&
    diagnostics?.legalPages?.publicUrlsValid === true &&
    diagnostics?.legalPages?.supportEmailConfigured === true &&
    diagnostics?.legalPages?.supportEmailValid === true &&
    diagnostics?.healthCheck?.publicUrlConfigured === true &&
    diagnostics?.healthCheck?.publicUrlValid === true &&
    diagnostics?.capabilities?.supportsTestFlightApi === true &&
    onlyAllowedInternalMissing &&
    !leaksSecrets(text) &&
    protection.leaksSecrets !== true;
  return {
    id: "deployment-diagnostics",
    ok: allowLocal ? authenticated && response.ok && payload.ok === true && !leaksSecrets(text) : productionOk,
    productionOk,
    internalTestFlightOk,
    status: response.status,
    adminProtected: protection?.ok ?? false,
    unauthenticatedStatus: protection?.status ?? null,
    authenticated,
    detail:
      !bearerToken && response.ok
        ? "Deployment diagnostics were exposed without administrator authentication."
        : diagnostics?.productionReady === true
        ? "Deployment diagnostics report productionReady=true."
        : allowLocal
          ? "Deployment diagnostics route is reachable; local smoke mode does not require productionReady=true."
        : `Deployment diagnostics not ready: ${(diagnostics?.missing || []).join(", ") || "unknown"}.`,
    leaksSecrets: leaksSecrets(text),
  };
}

async function checkReleaseReadiness(url, bearerToken) {
  const protection = internalTestFlightOnly
    ? await checkAdminRouteProtection(url, "release readiness")
    : null;
  const response = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: adminAuthorizationHeaders(bearerToken),
  });
  const payload = await readJson(response, "release readiness");
  const text = JSON.stringify(payload);
  const protectedResponse = response.status === 401 || response.status === 403;
  if (protectedResponse) {
    return {
      id: "release-public-url",
      ok: allowLocal && !bearerToken && !leaksSecrets(text),
      status: response.status,
      adminProtected: true,
      authenticated: false,
      detail: bearerToken
        ? "Release readiness rejected the supplied administrator session."
        : "Release readiness is administrator-protected; top-level release evidence remains pending.",
      readiness: {
        hasTopLevelReadiness: false,
      },
      leaksSecrets: leaksSecrets(text),
    };
  }
  const summary = payload.summary || payload.report?.summary;
  const blockers = payload.blockers || payload.report?.blockers || [];
  const nextAction = payload.nextAction || payload.report?.nextAction;
  const hasTopLevelReadiness = Boolean(payload.summary && payload.blockers && payload.nextAction);
  const publicUrlBlocked = Array.isArray(blockers) && blockers.some((blocker) => blocker.id === "public-url");
  const authenticated = Boolean(bearerToken) && response.ok;
  const structurallyValid =
    authenticated &&
    response.ok &&
    hasTopLevelReadiness &&
    typeof summary?.mvpReady === "boolean" &&
    typeof summary?.testflightReady === "boolean" &&
    typeof summary?.commercialReady === "boolean" &&
    typeof summary?.criticalBlocked === "number" &&
    Boolean(nextAction?.title && nextAction?.nextAction) &&
    !leaksSecrets(text);
  const productionOk = structurallyValid && !publicUrlBlocked;
  const internalTestFlightOk =
    internalTestFlightOnly &&
    protection?.ok === true &&
    structurallyValid &&
    protection.leaksSecrets !== true;
  return {
    id: "release-public-url",
    ok: allowLocal ? structurallyValid : productionOk,
    productionOk,
    internalTestFlightOk,
    status: response.status,
    adminProtected: protection?.ok ?? false,
    unauthenticatedStatus: protection?.status ?? null,
    authenticated,
    detail: !bearerToken && response.ok
      ? "Release readiness was exposed without administrator authentication."
      : publicUrlBlocked
        ? allowLocal
          ? `Authenticated release readiness is reachable; local smoke still has public-url blocker. TestFlight=${summary?.testflightReady ? "ready" : "blocked"}, commercial=${summary?.commercialReady ? "ready" : "blocked"}.`
          : "Release readiness still contains public-url blocker."
        : `Release readiness no longer blocks public-url. TestFlight=${summary?.testflightReady ? "ready" : "blocked"}, commercial=${summary?.commercialReady ? "ready" : "blocked"}.`,
    readiness: {
      blockerCount: Array.isArray(blockers) ? blockers.length : 0,
      commercialReady: Boolean(summary?.commercialReady),
      criticalBlocked: Number(summary?.criticalBlocked ?? 0),
      hasTopLevelReadiness,
      mvpReady: Boolean(summary?.mvpReady),
      nextAction: nextAction?.title || "",
      publicUrlBlocked,
      testflightReady: Boolean(summary?.testflightReady),
    },
    leaksSecrets: leaksSecrets(text),
  };
}

async function checkAdminRouteProtection(url, label) {
  const response = await fetchWithTimeout(url, { redirect: "follow" });
  const text = await response.text();
  const protectedStatus = response.status === 401 || response.status === 403;
  return {
    ok: protectedStatus && !leaksSecrets(text),
    status: response.status,
    detail: protectedStatus
      ? `${label} rejects unauthenticated requests.`
      : `${label} returned HTTP ${response.status} without administrator authentication.`,
    leaksSecrets: leaksSecrets(text),
  };
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${label}: ${error.message}\n${text.slice(0, 500)}`);
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
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

function readAdminBearerToken() {
  const token = process.env.OWNMINUTES_DEPLOYMENT_VERIFY_ADMIN_BEARER_TOKEN?.trim() || "";
  if (!token) return "";
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) {
    throw new Error("OWNMINUTES_DEPLOYMENT_VERIFY_ADMIN_BEARER_TOKEN has an invalid format.");
  }
  return token;
}

function adminAuthorizationHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
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

function validatePublicUrl(value) {
  if (!value) return { ok: false, reason: "missing" };

  try {
    const parsed = new URL(value);
    if (allowLocal && usesLocalHost(parsed.hostname)) return { ok: true, reason: "local-smoke" };
    if (parsed.protocol !== "https:") return { ok: false, reason: "not-https" };
    if (usesLocalHost(parsed.hostname)) return { ok: false, reason: "local-or-lan-host" };
    return { ok: true, reason: "public-https" };
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
}

function validateSampleShareUrl(value, appUrl) {
  const publicValidation = validatePublicUrl(value);
  if (!publicValidation.ok) return publicValidation;

  try {
    const parsed = new URL(value);
    const app = new URL(appUrl);
    if (parsed.origin !== app.origin) return { ok: false, reason: "wrong-origin" };
    if (!parsed.pathname.startsWith("/share/")) return { ok: false, reason: "wrong-share-path" };
    return { ok: true, reason: publicValidation.reason };
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
}

function joinUrl(origin, pathname) {
  return `${origin.replace(/\/$/, "")}${pathname}`;
}

function usesLocalHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE") ||
    text.includes("DATABASE_URL=") ||
    text.includes("OWNMINUTES_APP_SECRET=") ||
    text.includes("-----BEGIN PRIVATE KEY-----") ||
    text.includes("-----BEGIN EC PRIVATE KEY-----")
  );
}

function writeEvidenceDraft(outputPath, summary) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buildEvidenceDraft(summary));
}

function buildEvidenceDraft(summary) {
  const health = resultById("health", summary);
  const readinessGate = resultById("readiness", summary);
  const diagnostics = resultById("deployment-diagnostics", summary);
  const readiness = resultById("release-public-url", summary);
  const sampleShare = resultById("sample-share", summary);
  const publicUrlBlocked = readiness?.readiness?.publicUrlBlocked === true ? "yes" : readiness?.readiness?.publicUrlBlocked === false ? "no" : "pending";
  const automatedChecksPass =
    summary.productionDeploymentVerified &&
    health?.ok === true &&
    readinessGate?.ok === true &&
    diagnostics?.ok === true &&
    diagnostics?.authenticated === true &&
    readiness?.ok === true &&
    readiness?.authenticated === true &&
    !summary.leaksSecrets;
  const decision = automatedChecksPass && !summary.allowLocal ? "pending" : "fail";

  return [
    "# Public Deployment Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run deployment:verify`.",
    "Manual meeting, login, password reset, Apple notification, and final Go/No-Go fields must be reviewed before this can pass acceptance.",
    "",
    `Date: ${summary.checkedAt}`,
    `Commit: ${process.env.OWNMINUTES_DEPLOYMENT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "pending"}`,
    `Deployment provider: ${process.env.OWNMINUTES_DEPLOYMENT_PROVIDER || "pending"}`,
    `Public app URL: ${config.appUrl || "pending"}`,
    `Mobile API base URL: ${config.mobileApiBaseUrl || "pending"}`,
    `Privacy URL: ${config.privacyUrl || "pending"}`,
    `Terms URL: ${config.termsUrl || "pending"}`,
    `Support URL: ${config.supportUrl || "pending"}`,
    `Support email configured: ${summary.supportEmailConfigured ? "yes" : "no"}`,
    `Health check URL: ${config.healthCheckUrl || "pending"}`,
    `Sample share URL: ${config.sampleShareUrl || "pending"}`,
    `/api/health: ${passFail(health)}`,
    `/api/readyz: ${passFail(readinessGate)}`,
    `/api/deployment/diagnostics: ${authenticatedPassFail(diagnostics)}`,
    `/api/release/readiness top-level summary: ${authenticatedPassFail(readiness)}`,
    `Readiness mvpReady: ${booleanOrPending(readiness?.readiness?.mvpReady)}`,
    `Readiness testflightReady: ${booleanOrPending(readiness?.readiness?.testflightReady)}`,
    `Readiness commercialReady: ${booleanOrPending(readiness?.readiness?.commercialReady)}`,
    `Readiness criticalBlocked: ${numberOrPending(readiness?.readiness?.criticalBlocked)}`,
    `Readiness blockerCount: ${numberOrPending(readiness?.readiness?.blockerCount)}`,
    `Readiness publicUrlBlocked: ${publicUrlBlocked}`,
    `Readiness nextAction: ${readiness?.readiness?.nextAction || "pending"}`,
    "Mobile login: pending",
    "Short meeting: pending",
    `Share link: ${config.sampleShareUrl ? passFail(sampleShare) : "pending"}`,
    "Password reset URL: pending",
    "Apple notification URL configured: pending",
    `Secrets leaked: ${summary.leaksSecrets ? "yes" : "no"}`,
    `Decision: ${decision}`,
    `Known issues: ${summary.allowLocal ? "local smoke draft only; not production evidence" : "manual checks still pending"}`,
    "",
  ].join("\n");
}

function resultById(id, summary) {
  return summary.results.find((result) => result.id === id);
}

function passFail(result) {
  if (!result) return "pending";
  return result.ok ? "pass" : "fail";
}

function authenticatedPassFail(result) {
  if (!result) return "pending";
  if (result.adminProtected === true && result.authenticated !== true) return "pending";
  return result.ok ? "pass" : "fail";
}

function booleanOrPending(value) {
  return typeof value === "boolean" ? String(value) : "pending";
}

function numberOrPending(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "pending";
}
