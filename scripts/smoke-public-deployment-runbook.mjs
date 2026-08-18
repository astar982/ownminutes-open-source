#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const runbookPath = path.join(process.cwd(), "docs", "public-deployment-runbook.md");
const text = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "";
const stagingScriptPath = path.join(process.cwd(), "scripts", "https-staging.mjs");
const stopScriptPath = path.join(process.cwd(), "scripts", "stop-preview-screen.mjs");
const packagePath = path.join(process.cwd(), "package.json");
const packageJson = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, "utf8")) : {};

const requiredSections = [
  "## Current Boundary",
  "## Temporary HTTPS Staging",
  "## Required Environment",
  "## Preflight",
  "## Deploy",
  "## Public URL Verification",
  "## Deployment Diagnostics Verification",
  "## Mobile API Verification",
  "## Email And Password Reset Verification",
  "## Apple IAP Notification Verification",
  "## Share Link Verification",
  "## Evidence Template",
  "## Failure Criteria",
  "## Rollback",
  "## Production Verification",
];

const requiredPhrases = [
  "OWNMINUTES_APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "EXPO_PUBLIC_API_BASE_URL",
  "OWNMINUTES_MOBILE_API_BASE_URL",
  "OWNMINUTES_PRIVACY_URL",
  "OWNMINUTES_TERMS_URL",
  "OWNMINUTES_SUPPORT_URL",
  "OWNMINUTES_HEALTH_CHECK_URL",
  "OWNMINUTES_SAMPLE_SHARE_URL",
  "npm run smoke:deployment",
  "npm run deployment:preflight",
  "npm run deployment:verify",
  "npm run staging:https:up",
  "npm run staging:https:status",
  "npm run staging:https:verify",
  "npm run staging:https:down",
  "npm run deployment:evidence:draft",
  "npm run smoke:deployment-preflight",
  "npm run smoke:deployment-live",
  "npm run smoke:release",
  "npm run smoke:email",
  "npm run smoke:auth",
  "npm run smoke:iap",
  "npm run smoke:iap-verifier",
  "npm run smoke:iap-runbook",
  "/api/health",
  "/api/deployment/diagnostics",
  "/api/release/readiness",
  "/api/payments/apple/notifications",
  "/share/<meetingId>",
  "public-url",
  "supportsTestFlightApi=true",
  "capabilities.hasPublicHttpsOrigin=true",
  "legalPages.publicUrlsValid=true",
  "healthCheck.publicUrlValid=true",
  "sampleShareUrl.valid=true",
  "Mobile API Base URL",
  "same origin",
  "Secrets leaked: no/yes",
  "productionDeploymentVerified=true",
  "release-public-url.readiness",
  "mvpReady",
  "testflightReady",
  "commercialReady",
  "criticalBlocked",
  "blockerCount",
  "publicUrlBlocked",
  "nextAction",
  "readiness.testflightReady=false",
  "readiness.commercialReady=false",
  "readiness.criticalBlocked > 0",
  "summary.testflightReady",
  "summary.commercialReady",
  "summary.criticalBlocked",
  "blockers.length",
  "OWNMINUTES_DEPLOYMENT_VERIFY_ALLOW_LOCAL=1",
  "OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_DRAFT_PATH",
  ".data/acceptance/public-deployment-latest.md",
  "pending",
  "localhost",
  "LAN IP",
  "temporary testing infrastructure only",
  "no uptime guarantee",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
];

const missingSections = requiredSections.filter((section) => !text.includes(section));
const missingPhrases = requiredPhrases.filter((phrase) => !text.includes(phrase));
const leakedPhrases = forbiddenPhrases.filter((phrase) => text.includes(phrase));
const expectedScripts = {
  "preview:stop": "node scripts/stop-preview-screen.mjs",
  "staging:https:up": "node scripts/https-staging.mjs up",
  "staging:https:status": "node scripts/https-staging.mjs status",
  "staging:https:verify": "node scripts/https-staging.mjs verify",
  "staging:https:down": "node scripts/https-staging.mjs down",
};
const invalidPackageScripts = Object.entries(expectedScripts)
  .filter(([name, command]) => packageJson.scripts?.[name] !== command)
  .map(([name]) => name);

const summary = {
  exists: fs.existsSync(runbookPath),
  stagingScriptExists: fs.existsSync(stagingScriptPath),
  stopScriptExists: fs.existsSync(stopScriptPath),
  sectionCount: requiredSections.length - missingSections.length,
  phraseCount: requiredPhrases.length - missingPhrases.length,
  missingSections,
  missingPhrases,
  leakedPhrases,
  invalidPackageScripts,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.exists ||
  !summary.stagingScriptExists ||
  !summary.stopScriptExists ||
  missingSections.length > 0 ||
  missingPhrases.length > 0 ||
  leakedPhrases.length > 0 ||
  invalidPackageScripts.length > 0
) {
  process.exitCode = 1;
}
