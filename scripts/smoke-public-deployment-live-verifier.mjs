#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const script = "scripts/verify-public-deployment-live.mjs";
const draftPath = ".data/smoke/public-deployment-live-draft.md";
const fetchFixturePath = resolve(".data/smoke/public-deployment-live-fetch-fixture.mjs");

rmSync(draftPath, { force: true });
mkdirSync(dirname(fetchFixturePath), { recursive: true });
writeFileSync(fetchFixturePath, `
const legalIdentityMissing = "OWNMINUTES_LEGAL_OPERATOR_NAME + OWNMINUTES_LEGAL_OPERATOR_ADDRESS + OWNMINUTES_LEGAL_OPERATOR_JURISDICTION";
const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json", ...headers },
});
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  const authorization = new Headers(options.headers || {}).get("authorization") || "";
  const protectedRoute = url.pathname === "/api/deployment/diagnostics" || url.pathname === "/api/release/readiness";
  if (protectedRoute && !authorization && process.env.OWNMINUTES_SMOKE_UNPROTECTED_ADMIN !== "1") {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (url.pathname === "/app") return new Response(null, { status: 302, headers: { location: url.origin + "/login" } });
  if (["/", "/privacy", "/terms", "/support", "/data-deletion"].includes(url.pathname)) {
    return new Response("<html><a href=\\"mailto:support@ownminutes.app\\">support</a></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }
  if (url.pathname === "/api/health") return json({ ok: true, service: "ownminutes" });
  if (url.pathname === "/api/readyz") return json({
    ok: process.env.OWNMINUTES_SMOKE_READY_FALSE !== "1",
    releaseReady: process.env.OWNMINUTES_SMOKE_READY_FALSE !== "1",
    service: "ownminutes",
    status: process.env.OWNMINUTES_SMOKE_READY_FALSE === "1" ? "blocked" : "ready",
  }, process.env.OWNMINUTES_SMOKE_READY_FALSE === "1" ? 503 : 200);
  if (url.pathname === "/api/deployment/diagnostics") {
    const missing = [legalIdentityMissing];
    if (process.env.OWNMINUTES_SMOKE_EXTRA_MISSING === "1") missing.push("OWNMINUTES_SUPPORT_EMAIL");
    return json({ ok: true, diagnostics: {
      productionReady: false,
      appUrl: { configured: true, https: true, publicHost: true, host: "test.ownminutes.app" },
      mobileApiBaseUrl: { configured: true, https: true, publicHost: true, host: "test.ownminutes.app" },
      legalPages: {
        localRoutesExist: true,
        publicUrlsConfigured: true,
        publicUrlsValid: true,
        supportEmailConfigured: true,
        supportEmailValid: true,
        operatorIdentityConfigured: false,
      },
      healthCheck: { localRouteExists: true, publicUrlConfigured: true, publicUrlValid: true },
      capabilities: { supportsTestFlightApi: true },
      missing,
    } });
  }
  if (url.pathname === "/api/release/readiness") return json({
    ok: true,
    summary: { mvpReady: false, testflightReady: false, commercialReady: false, criticalBlocked: 1 },
    blockers: [{ id: "public-url" }],
    nextAction: { title: "Complete production identity", nextAction: "Provide verified legal identity." },
  });
  return json({ ok: false }, 404);
};
`, { mode: 0o600 });

const rejectedLocal = runVerifier({
  NODE_OPTIONS: `--import=${fetchFixturePath}`,
  EXPO_PUBLIC_API_BASE_URL: baseUrl,
  OWNMINUTES_APP_URL: baseUrl,
  OWNMINUTES_HEALTH_CHECK_URL: `${baseUrl}/api/health`,
  OWNMINUTES_PRIVACY_URL: `${baseUrl}/privacy`,
  OWNMINUTES_SUPPORT_URL: `${baseUrl}/support`,
  OWNMINUTES_SUPPORT_EMAIL: "support@ownminutes.app",
  OWNMINUTES_TERMS_URL: `${baseUrl}/terms`,
});

const allowedLocal = runVerifier({
  NODE_OPTIONS: `--import=${fetchFixturePath}`,
  EXPO_PUBLIC_API_BASE_URL: baseUrl,
  OWNMINUTES_APP_URL: baseUrl,
  OWNMINUTES_DEPLOYMENT_VERIFY_ALLOW_LOCAL: "1",
  OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_DRAFT_PATH: draftPath,
  OWNMINUTES_HEALTH_CHECK_URL: `${baseUrl}/api/health`,
  OWNMINUTES_PRIVACY_URL: `${baseUrl}/privacy`,
  OWNMINUTES_SUPPORT_URL: `${baseUrl}/support`,
  OWNMINUTES_SUPPORT_EMAIL: "support@ownminutes.app",
  OWNMINUTES_TERMS_URL: `${baseUrl}/terms`,
});

const rejectedSummary = parseSummary(rejectedLocal.stdout);
const allowedSummary = parseSummary(allowedLocal.stdout);
const releaseReadinessResult = allowedSummary?.results?.find((result) => result.id === "release-public-url");
const deploymentDiagnosticsResult = allowedSummary?.results?.find((result) => result.id === "deployment-diagnostics");
const draft = existsSync(draftPath) ? readFileSync(draftPath, "utf8") : "";
const draftAcceptance = runAcceptanceChecker(draftPath);
const fixtureBaseEnv = {
  NODE_OPTIONS: `--import=${fetchFixturePath}`,
  EXPO_PUBLIC_API_BASE_URL: "https://test.ownminutes.app",
  OWNMINUTES_APP_URL: "https://test.ownminutes.app",
  OWNMINUTES_DEPLOYMENT_VERIFY_ADMIN_BEARER_TOKEN: "smoke-admin-bearer-token",
  OWNMINUTES_HEALTH_CHECK_URL: "https://test.ownminutes.app/api/health",
  OWNMINUTES_PRIVACY_URL: "https://test.ownminutes.app/privacy",
  OWNMINUTES_SUPPORT_URL: "https://test.ownminutes.app/support",
  OWNMINUTES_SUPPORT_EMAIL: "support@ownminutes.app",
  OWNMINUTES_TERMS_URL: "https://test.ownminutes.app/terms",
};
const strictLegalIdentityGate = runVerifier(fixtureBaseEnv);
const internalOnly = runVerifier(fixtureBaseEnv, ["--testflight-internal-only"]);
const internalOnlySummary = parseSummary(internalOnly.stdout);
const internalDiagnostics = internalOnlySummary?.results?.find((result) => result.id === "deployment-diagnostics");
const internalReadiness = internalOnlySummary?.results?.find((result) => result.id === "release-public-url");
const internalExtraMissing = runVerifier(
  { ...fixtureBaseEnv, OWNMINUTES_SMOKE_EXTRA_MISSING: "1" },
  ["--testflight-internal-only"],
);
const internalUnprotectedAdmin = runVerifier(
  { ...fixtureBaseEnv, OWNMINUTES_SMOKE_UNPROTECTED_ADMIN: "1" },
  ["--testflight-internal-only"],
);
const internalNotReady = runVerifier(
  { ...fixtureBaseEnv, OWNMINUTES_SMOKE_READY_FALSE: "1" },
  ["--testflight-internal-only"],
);
const internalLocalOverride = runVerifier(
  {
    EXPO_PUBLIC_API_BASE_URL: baseUrl,
    OWNMINUTES_APP_URL: baseUrl,
    OWNMINUTES_DEPLOYMENT_VERIFY_ALLOW_LOCAL: "1",
    OWNMINUTES_HEALTH_CHECK_URL: `${baseUrl}/api/health`,
    OWNMINUTES_PRIVACY_URL: `${baseUrl}/privacy`,
    OWNMINUTES_SUPPORT_URL: `${baseUrl}/support`,
    OWNMINUTES_SUPPORT_EMAIL: "support@ownminutes.app",
    OWNMINUTES_TERMS_URL: `${baseUrl}/terms`,
  },
  ["--testflight-internal-only"],
);
const checks = {
  rejectsLocalWithoutOverride: rejectedLocal.status !== 0 && rejectedSummary?.urlFailures?.length > 0,
  allowsLocalOnlyForSmoke: allowedLocal.status === 0 && allowedSummary?.allowLocal === true,
  verifiesLiveRoutes: allowedSummary?.results?.some((result) => result.id === "health" && result.ok === true) === true,
  verifiesTrafficReadiness:
    allowedSummary?.results?.some((result) => result.id === "readiness" && result.ok === true) === true,
  verifiesDataDeletion: allowedSummary?.results?.some((result) => result.id === "data-deletion" && result.ok === true) === true,
  verifiesLoginGate: allowedSummary?.results?.some((result) => result.id === "app-login-gate" && result.ok === true) === true,
  verifiesAdminRoutesProtected:
    releaseReadinessResult?.ok === true &&
    releaseReadinessResult?.adminProtected === true &&
    releaseReadinessResult?.authenticated === false &&
    deploymentDiagnosticsResult?.ok === true &&
    deploymentDiagnosticsResult?.adminProtected === true &&
    deploymentDiagnosticsResult?.authenticated === false,
  doesNotExposeAdminReadinessPublicly:
    releaseReadinessResult?.readiness?.hasTopLevelReadiness === false &&
    releaseReadinessResult?.readiness?.mvpReady === undefined &&
    releaseReadinessResult?.detail?.includes("administrator-protected"),
  writesEvidenceDraft:
    draft.includes("# Public Deployment Acceptance Evidence") &&
    draft.includes("This file is an automated draft from `npm run deployment:verify`.") &&
    draft.includes("Public app URL:") &&
    draft.includes("Support email configured: yes") &&
    draft.includes("/api/health: pass") &&
    draft.includes("/api/readyz: pass") &&
    draft.includes("/api/deployment/diagnostics: pending") &&
    draft.includes("/api/release/readiness top-level summary: pending") &&
    draft.includes("Readiness mvpReady: pending") &&
    draft.includes("Mobile login: pending") &&
    draft.includes("Short meeting: pending") &&
    draft.includes("Password reset URL: pending") &&
    draft.includes("Apple notification URL configured: pending") &&
    draft.includes("Decision: fail") &&
    draft.includes("local smoke draft only"),
  evidenceDraftDoesNotPassAcceptance:
    draftAcceptance.status !== 0 &&
    draftAcceptance.payload?.evidenceReady === false &&
    draftAcceptance.payload?.missingPassChecks?.includes("Mobile login:") &&
    draftAcceptance.payload?.missingPassChecks?.includes("/api/release/readiness top-level summary:") &&
    draftAcceptance.payload?.readinessFailures?.includes("mvpReady-not-true"),
  noSecretLeaks: !leaksSecrets(rejectedLocal.output) && !leaksSecrets(allowedLocal.output) && allowedSummary?.leaksSecrets === false,
  strictProductionStillRejectsMissingLegalIdentity:
    strictLegalIdentityGate.status !== 0 &&
    parseSummary(strictLegalIdentityGate.stdout)?.productionDeploymentVerified === false,
  internalOnlyAcceptsOnlyLegalIdentityGap:
    internalOnly.status === 0 &&
    internalOnlySummary?.verificationScope === "internal-testflight-only" &&
    internalOnlySummary?.productionDeploymentVerified === false &&
    internalOnlySummary?.internalTestFlightDeploymentVerified === true,
  internalOnlyVerifiesAdminProtection:
    internalDiagnostics?.adminProtected === true &&
    internalDiagnostics?.unauthenticatedStatus === 401 &&
    internalDiagnostics?.authenticated === true &&
    internalDiagnostics?.internalTestFlightOk === true &&
    internalReadiness?.adminProtected === true &&
    internalReadiness?.unauthenticatedStatus === 401 &&
    internalReadiness?.authenticated === true &&
    internalReadiness?.internalTestFlightOk === true,
  internalOnlyRejectsAdditionalMissingConfig: internalExtraMissing.status !== 0,
  internalOnlyRejectsUnprotectedAdminRoutes: internalUnprotectedAdmin.status !== 0,
  internalOnlyRequiresReleaseReady: internalNotReady.status !== 0,
  internalOnlyCannotUseLocalOverride: internalLocalOverride.status !== 0,
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) {
  console.error("Public deployment live verifier smoke failed.");
  process.exitCode = 1;
}

function runVerifier(env, args = []) {
  const result = spawnSync("node", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...env,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function parseSummary(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function runAcceptanceChecker(path) {
  const result = spawnSync("node", ["scripts/check-public-deployment-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    payload: parseSummary(result.stdout),
  };
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
