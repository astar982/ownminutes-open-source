#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const evidencePath = process.env.OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH || ".data/acceptance/public-deployment-latest.md";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";

const requiredMetadata = [
  "Date:",
  "Commit:",
  "Deployment provider:",
  "Public app URL:",
  "Mobile API base URL:",
  "Privacy URL:",
  "Terms URL:",
  "Support URL:",
  "Health check URL:",
  "Sample share URL:",
  "Readiness mvpReady:",
  "Readiness testflightReady:",
  "Readiness commercialReady:",
  "Readiness criticalBlocked:",
  "Readiness blockerCount:",
  "Readiness publicUrlBlocked:",
  "Readiness nextAction:",
];

const requiredPassChecks = [
  "/api/health:",
  "/api/readyz:",
  "/api/deployment/diagnostics:",
  "/api/release/readiness top-level summary:",
  "Mobile login:",
  "Short meeting:",
  "Share link:",
  "Password reset URL:",
  "Apple notification URL configured:",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "DATABASE_URL=",
  "OWNMINUTES_APP_SECRET=",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "Bearer ",
  "session=",
];

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const missingPassChecks = requiredPassChecks.filter((phrase) => !lineHasValue(phrase, "pass"));
const failedChecks = requiredPassChecks.filter((phrase) => lineHasValue(phrase, "fail"));
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));

const urls = {
  app: readLineValue("Public app URL:"),
  mobileApi: readLineValue("Mobile API base URL:"),
  privacy: readLineValue("Privacy URL:"),
  terms: readLineValue("Terms URL:"),
  support: readLineValue("Support URL:"),
  health: readLineValue("Health check URL:"),
  sampleShare: readLineValue("Sample share URL:"),
};

const urlChecks = {
  app: validatePublicUrl(urls.app),
  mobileApi: validatePublicUrl(urls.mobileApi),
  privacy: validatePublicUrl(urls.privacy),
  terms: validatePublicUrl(urls.terms),
  support: validatePublicUrl(urls.support),
  health: validatePublicUrl(urls.health),
  sampleShare: validatePublicUrl(urls.sampleShare),
};

const urlFailures = Object.entries(urlChecks)
  .filter(([, check]) => !check.ok)
  .map(([key, check]) => `${key}:${check.reason}`);
const pathFailures = [
  pathFailure("privacy", urls.privacy, "/privacy"),
  pathFailure("terms", urls.terms, "/terms"),
  pathFailure("support", urls.support, "/support"),
  pathFailure("health", urls.health, "/api/health"),
  sampleSharePathFailure(urls.sampleShare),
].filter(Boolean);
const originFailures = [
  originFailure("privacy", urls.privacy, urls.app),
  originFailure("terms", urls.terms, urls.app),
  originFailure("support", urls.support, urls.app),
  originFailure("health", urls.health, urls.mobileApi),
  originFailure("sampleShare", urls.sampleShare, urls.app),
].filter(Boolean);

const readiness = {
  mvpReady: readLineValue("Readiness mvpReady:"),
  testflightReady: readLineValue("Readiness testflightReady:"),
  commercialReady: readLineValue("Readiness commercialReady:"),
  criticalBlocked: readLineValue("Readiness criticalBlocked:"),
  blockerCount: readLineValue("Readiness blockerCount:"),
  publicUrlBlocked: readLineValue("Readiness publicUrlBlocked:"),
  nextAction: readLineValue("Readiness nextAction:"),
};

const readinessFailures = [
  readiness.mvpReady.toLowerCase() === "true" ? "" : "mvpReady-not-true",
  isBooleanText(readiness.testflightReady) ? "" : "testflightReady-not-boolean",
  isBooleanText(readiness.commercialReady) ? "" : "commercialReady-not-boolean",
  isNonNegativeInteger(readiness.criticalBlocked) ? "" : "criticalBlocked-not-number",
  isNonNegativeInteger(readiness.blockerCount) ? "" : "blockerCount-not-number",
  ["no", "false"].includes(readiness.publicUrlBlocked.toLowerCase()) ? "" : "publicUrlBlocked-not-cleared",
  readiness.nextAction.length > 0 ? "" : "nextAction-missing",
].filter(Boolean);

const decisionPass = lineHasValue("Decision:", "pass");
const decisionFail = lineHasValue("Decision:", "fail");
const secretsLeakedNo = lineHasValue("Secrets leaked:", "no");
const secretsLeakedYes = lineHasValue("Secrets leaked:", "yes");

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  missingMetadata,
  missingPassChecks,
  failedChecks,
  urlFailures,
  pathFailures,
  originFailures,
  readinessFailures,
  decisionPass,
  decisionFail,
  secretsLeakedNo,
  secretsLeakedYes,
  leakedPhrases,
  evidenceReady:
    Boolean(evidence) &&
    missingMetadata.length === 0 &&
    missingPassChecks.length === 0 &&
    failedChecks.length === 0 &&
    urlFailures.length === 0 &&
    pathFailures.length === 0 &&
    originFailures.length === 0 &&
    readinessFailures.length === 0 &&
    decisionPass &&
    !decisionFail &&
    secretsLeakedNo &&
    !secretsLeakedYes &&
    leakedPhrases.length === 0,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.evidenceReady) {
  process.exitCode = 1;
}

function readLineValue(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = evidence.match(new RegExp(`^${escaped}\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function lineHasValue(label, value) {
  return readLineValue(label).toLowerCase() === value.toLowerCase();
}

function validatePublicUrl(value) {
  if (!value) return { ok: false, reason: "missing" };

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return { ok: false, reason: "not-https" };
    if (usesLocalHost(parsed.hostname)) return { ok: false, reason: "local-or-lan-host" };
    return { ok: true, reason: "public-https" };
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
}

function pathFailure(label, value, expectedPath) {
  try {
    return new URL(value).pathname === expectedPath ? "" : `${label}:wrong-path`;
  } catch {
    return "";
  }
}

function sampleSharePathFailure(value) {
  try {
    return new URL(value).pathname.startsWith("/share/") ? "" : "sampleShare:wrong-path";
  } catch {
    return "";
  }
}

function originFailure(label, value, expectedOrigin) {
  if (!value || !expectedOrigin) return "";

  try {
    return new URL(value).origin === new URL(expectedOrigin).origin ? "" : `${label}:wrong-origin`;
  } catch {
    return "";
  }
}

function isBooleanText(value) {
  return ["true", "false"].includes(value.toLowerCase());
}

function isNonNegativeInteger(value) {
  return /^\d+$/.test(value);
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
