#!/usr/bin/env node

import fs from "fs";
import path from "path";

const runbookPath = path.join(process.cwd(), "docs/apple-iap-sandbox-runbook.md");
const text = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "";
const sharedStagingCompose =
  "docker compose --env-file deploy/.env.production -f deploy/compose.production.yml -f deploy/compose.public-staging.yml -f deploy/compose.shared-proxy.yml";
const productionCompose = "docker compose --env-file deploy/.env.production -f deploy/compose.production.yml";

const requiredSections = [
  "## Current Boundary",
  "## Required Environment",
  "## Apple Root Certificates",
  "## App Store Connect Setup",
  "## Two-Phase Sandbox Gate",
  "## Preflight",
  "## Sandbox Transaction Verification",
  "## Server Notification Verification",
  "## Database Checks",
  "## Rollback",
  "## Production Verification",
];

const requiredPhrases = [
  "POST /api/payments/apple/transactions",
  "POST /api/payments/apple/notifications",
  "src/lib/apple-iap.ts",
  "billing_orders",
  "entitlement_grants",
  "npm run smoke:iap",
  "npm run smoke:iap-verifier",
  "APPLE_ISSUER_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_PRIVATE_KEY_FILE",
  "OWNMINUTES_APPLE_PRIVATE_KEY_FILE",
  "OWNMINUTES_APPLE_ROOT_CA_G2_FILE",
  "OWNMINUTES_APPLE_ROOT_CA_G3_FILE",
  "APPLE_BUNDLE_ID",
  "APPLE_IAP_ENVIRONMENT=production",
  "APPLE_IAP_ENVIRONMENT=sandbox",
  "OWNMINUTES_IAP_SANDBOX_ACCEPTANCE=1",
  "OWNMINUTES_AUTH_REPOSITORY=postgres",
  "APPLE_IAP_PRODUCT_IDS",
  "APPLE_IAP_FETCH_TIMEOUT_MS",
  "APPLE_ROOT_CERTIFICATES",
  "APPLE_ROOT_CERTIFICATE_PATHS",
  "APPLE_APP_APPLE_ID",
  "APPLE_IAP_ENABLE_ONLINE_CHECKS",
  "OWNMINUTES_IAP_RECEIPT_VERIFICATION",
  "OWNMINUTES_IAP_ENTITLEMENT_MAPPING",
  "OWNMINUTES_IAP_REFUND_HANDLING",
  "OWNMINUTES_ORDER_IDEMPOTENCY",
  "OWNMINUTES_IAP_NOTIFICATION_URL",
  "https://staging.example.com/api/payments/apple/notifications",
  "Sandbox Server URL only",
  "Production Server URL empty",
  "--phase=sandbox-bootstrap --strict",
  "bootstrapReady=true",
  "evidenceReady=false",
  "acceptanceReady=true",
  "productionCandidate=false",
  "deploymentBoundary=sandbox-only",
  "scripts/run-with-secrets.mjs",
  "OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF",
  "OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF",
  "OWNMINUTES_IAP_SANDBOX_REFUND_PROOF",
  "OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF",
  "OWNMINUTES_IAP_DB_LEDGER_PROOF",
  "npm run iap:preflight",
  "npm run smoke:iap-preflight",
  "npm run smoke:iap-lifecycle",
  "npm run smoke:iap-postgres",
  "npm run smoke:production-deployment",
  `${sharedStagingCompose} config --quiet`,
  `${sharedStagingCompose} exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --phase=sandbox-bootstrap --strict`,
  `${sharedStagingCompose} up -d --no-deps --force-recreate app`,
  `${sharedStagingCompose} exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --strict`,
  `${productionCompose} exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --strict`,
  "Never promote this host",
  "Never switch this shared staging",
  "npm run iap:acceptance:evidence:draft",
  "productionReady=true",
  "sandbox purchase/renewal/refund/expiration evidence",
  "ownminutes.plus.monthly",
  "ownminutes.pro.monthly",
  "DID_RENEW",
  "REFUND",
  "EXPIRED",
  "REVOKE",
  "invalid_signed_payload_signature",
  "original_transaction_id",
  "external_transaction_id",
  "OWNMINUTES_ENABLE_SIMULATED_BILLING=0",
  "OWNMINUTES_ENABLE_IAP_MOCK=0",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
];

const unsafeSharedStagingPhrases = [
  `${productionCompose} config --quiet`,
  `${productionCompose} up -d --force-recreate app`,
  `${productionCompose} up -d --no-deps --force-recreate app`,
  `${productionCompose} exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --phase=sandbox-bootstrap --strict`,
];

const missingSections = requiredSections.filter((section) => !text.includes(section));
const missingPhrases = requiredPhrases.filter((phrase) => !text.includes(phrase));
const leakedPhrases = forbiddenPhrases.filter((phrase) => text.includes(phrase));
const unsafePhrases = unsafeSharedStagingPhrases.filter((phrase) => text.includes(phrase));

const summary = {
  exists: fs.existsSync(runbookPath),
  sectionCount: requiredSections.length - missingSections.length,
  phraseCount: requiredPhrases.length - missingPhrases.length,
  missingSections,
  missingPhrases,
  leakedPhrases,
  unsafePhrases,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.exists ||
  missingSections.length > 0 ||
  missingPhrases.length > 0 ||
  leakedPhrases.length > 0 ||
  unsafePhrases.length > 0
) {
  process.exitCode = 1;
}
