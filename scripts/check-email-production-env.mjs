#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const diagnosticsPath = path.join(repoRoot, "src", "lib", "email-diagnostics.ts");
const deliveryPath = path.join(repoRoot, "src", "lib", "email-delivery.ts");
const resetRoutePath = path.join(repoRoot, "src", "app", "api", "auth", "password-reset", "request", "route.ts");
const verificationRequestPath = path.join(repoRoot, "src", "app", "api", "auth", "email-verification", "request", "route.ts");
const verificationConfirmPath = path.join(repoRoot, "src", "app", "api", "auth", "email-verification", "confirm", "route.ts");
const tokenExposurePath = path.join(repoRoot, "src", "lib", "server", "auth-token-exposure.ts");
const runbookPath = path.join(repoRoot, "docs", "public-deployment-runbook.md");
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_EMAIL_PREFLIGHT_STRICT === "1";

const requiredEnv = [
  "RESEND_API_KEY or OWNMINUTES_RESEND_API_KEY",
  "OWNMINUTES_EMAIL_FROM or EMAIL_FROM",
  "OWNMINUTES_APP_URL or NEXT_PUBLIC_APP_URL",
  "OWNMINUTES_EMAIL_DOMAIN_VERIFIED=1",
  "OWNMINUTES_EMAIL_BOUNCE_POLICY",
  "OWNMINUTES_EMAIL_COMPLAINT_POLICY",
  "OWNMINUTES_REQUIRE_EMAIL_VERIFICATION=1",
  "OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE must not be 1",
  "OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE must not be 1",
];

function main() {
  const diagnosticsSource = readFile(diagnosticsPath);
  const deliverySource = readFile(deliveryPath);
  const routeSource = readFile(resetRoutePath);
  const verificationRequestSource = readFile(verificationRequestPath);
  const verificationConfirmSource = readFile(verificationConfirmPath);
  const tokenExposureSource = readFile(tokenExposurePath);
  const appUrl = getEnv("OWNMINUTES_APP_URL", "NEXT_PUBLIC_APP_URL");
  const from = getEnv("OWNMINUTES_EMAIL_FROM", "EMAIL_FROM");
  const checks = [
    check(
      "email-verification-required",
      process.env.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION === "1",
      "Production registration requires email verification.",
      "Missing OWNMINUTES_REQUIRE_EMAIL_VERIFICATION=1.",
    ),
    check(
      "resend-api-key",
      Boolean(getEnv("RESEND_API_KEY", "OWNMINUTES_RESEND_API_KEY")),
      "Resend API key reference is configured.",
      "Missing RESEND_API_KEY or OWNMINUTES_RESEND_API_KEY.",
    ),
    check(
      "sender",
      Boolean(from) && looksLikeSender(from),
      "Sender identity is configured.",
      "Missing or invalid OWNMINUTES_EMAIL_FROM / EMAIL_FROM.",
    ),
    check(
      "public-app-url",
      isPublicHttpsUrl(appUrl),
      "OWNMINUTES_APP_URL is a public HTTPS URL.",
      appUrl ? "OWNMINUTES_APP_URL must be public HTTPS, not localhost/LAN/HTTP." : "Missing OWNMINUTES_APP_URL or NEXT_PUBLIC_APP_URL.",
    ),
    check(
      "domain-verified",
      process.env.OWNMINUTES_EMAIL_DOMAIN_VERIFIED === "1",
      "Email sending domain is marked verified.",
      "Missing OWNMINUTES_EMAIL_DOMAIN_VERIFIED=1 after DNS/domain verification.",
    ),
    check(
      "bounce-policy",
      Boolean(process.env.OWNMINUTES_EMAIL_BOUNCE_POLICY),
      "Bounce handling policy is declared.",
      "Missing OWNMINUTES_EMAIL_BOUNCE_POLICY.",
    ),
    check(
      "complaint-policy",
      Boolean(process.env.OWNMINUTES_EMAIL_COMPLAINT_POLICY),
      "Complaint/unsubscribe handling policy is declared.",
      "Missing OWNMINUTES_EMAIL_COMPLAINT_POLICY.",
    ),
    check(
      "no-dev-token-response",
      process.env.OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE !== "1" &&
        process.env.OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE !== "1",
      "Development auth token responses are disabled.",
      "Local auth token response flags are not allowed for production.",
    ),
    check(
      "diagnostics-runtime",
      diagnosticsSource.includes("productionReady") &&
        diagnosticsSource.includes("RESEND_API_KEY") &&
        diagnosticsSource.includes("isPublicHttpsUrl"),
      "Email diagnostics runtime is present.",
      "Email diagnostics runtime is missing production readiness checks.",
    ),
    check(
      "delivery-runtime",
      deliverySource.includes("https://api.resend.com/emails") &&
        deliverySource.includes("reset-password#token=") &&
        deliverySource.includes("verify-email#token=") &&
        !deliverySource.includes("reset-password?token=") &&
        !deliverySource.includes("verify-email?token=") &&
        deliverySource.includes("Authorization"),
      "Password reset and verification email delivery runtimes are present.",
      "Email delivery runtime is incomplete.",
    ),
    check(
      "verification-runtime",
      verificationRequestSource.includes("sendEmailVerificationEmail") &&
        verificationConfirmSource.includes("verifyEmailWithToken") &&
        verificationConfirmSource.includes("createSession"),
      "Email verification request and confirmation runtimes are present.",
      "Email verification runtime is incomplete.",
    ),
    check(
      "route-token-guard",
      routeSource.includes("canExposeResetToken") &&
        routeSource.includes('OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE === "1"') &&
        tokenExposureSource.includes('OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE === "1"') &&
        tokenExposureSource.includes('host.startsWith("127.0.0.1")') &&
        routeSource.includes("resetToken: exposeResetToken ? result.resetToken : undefined"),
      "Password reset route gates development token responses.",
      "Password reset route does not clearly gate development reset token responses.",
    ),
    check("runbook", fs.existsSync(runbookPath), "Public deployment runbook exists.", "Missing docs/public-deployment-runbook.md."),
  ];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const summary = {
    ok: missing.length === 0,
    strict,
    provider: getEnv("RESEND_API_KEY", "OWNMINUTES_RESEND_API_KEY") ? "resend" : "none",
    productionCandidate: missing.length === 0,
    requiredEnv,
    configured: {
      resendApiKey: Boolean(getEnv("RESEND_API_KEY", "OWNMINUTES_RESEND_API_KEY")),
      sender: Boolean(from),
      appUrl: Boolean(appUrl),
      domainVerified: process.env.OWNMINUTES_EMAIL_DOMAIN_VERIFIED === "1",
      bouncePolicy: Boolean(process.env.OWNMINUTES_EMAIL_BOUNCE_POLICY),
      complaintPolicy: Boolean(process.env.OWNMINUTES_EMAIL_COMPLAINT_POLICY),
      emailVerificationRequired: process.env.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION === "1",
      devTokenResponse: process.env.OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE === "1",
      localAuthTokenResponse: process.env.OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE === "1",
    },
    missing,
    checks,
    nextAction:
      missing.length === 0
        ? "Run real registration verification and password reset in the same public HTTPS deployment; confirm both links arrive without exposing tokens in API JSON."
        : "Set the missing email production environment and rerun npm run email:preflight.",
    leaksSecrets: leaksSecrets(JSON.stringify({ checks, missing, requiredEnv })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (summary.leaksSecrets || (strict && !summary.ok)) {
    process.exitCode = 1;
  }
}

function check(id, passed, passDetail, failDetail) {
  return {
    id,
    status: passed ? "pass" : "fail",
    detail: passed ? passDetail : failDetail,
  };
}

function readFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function getEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function isPublicHttpsUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    const blockedHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
    const isLan =
      /^10\./.test(url.hostname) ||
      /^192\.168\./.test(url.hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname);
    return url.protocol === "https:" && !blockedHosts.has(url.hostname) && !isLan;
  } catch {
    return false;
  }
}

function looksLikeSender(value) {
  return /<[^@\s]+@[^@\s]+\.[^@\s]+>$/.test(value) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE") ||
    text.includes("re_") ||
    text.includes("resend_live_key") ||
    text.includes("RESEND_API_KEY=")
  );
}

main();
