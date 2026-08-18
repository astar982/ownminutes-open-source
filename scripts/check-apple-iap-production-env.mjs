#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const runbookPath = path.join(repoRoot, "docs", "apple-iap-sandbox-runbook.md");
const appleIapPath = path.join(repoRoot, "src", "lib", "apple-iap.ts");
const secretRunnerPath = path.join(repoRoot, "scripts", "run-with-secrets.mjs");
const transactionRoutePath = path.join(repoRoot, "src", "app", "api", "payments", "apple", "transactions", "route.ts");
const notificationRoutePath = path.join(repoRoot, "src", "app", "api", "payments", "apple", "notifications", "route.ts");
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_IAP_PREFLIGHT_STRICT === "1";
const configuredPhase = resolvePhase();
const allowedPhases = new Set(["release", "sandbox-bootstrap"]);
const phase = allowedPhases.has(configuredPhase) ? configuredPhase : configuredPhase || "release";
const configuredEnvironment = process.env.APPLE_IAP_ENVIRONMENT?.trim();
const allowedEnvironments = new Set(["auto", "production", "sandbox"]);
const environment = allowedEnvironments.has(configuredEnvironment) ? configuredEnvironment : configuredEnvironment || "auto";

const bootstrapRequiredEnv = [
  "OWNMINUTES_IAP_PREFLIGHT_PHASE=release|sandbox-bootstrap (or --phase=...)",
  "APPLE_IAP_ENVIRONMENT=auto|production|sandbox",
  "OWNMINUTES_IAP_SANDBOX_ACCEPTANCE=0|1 (1 only on isolated TestFlight staging)",
  "OWNMINUTES_AUTH_REPOSITORY=postgres + DATABASE_URL/POSTGRES_URL",
  "APPLE_ISSUER_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_FILE",
  "APPLE_BUNDLE_ID",
  "OWNMINUTES_APP_SECRET or OWNMINUTES_APP_SECRET_FILE (at least 32 characters)",
  "APPLE_IAP_PRODUCT_IDS or OWNMINUTES_IAP_PRODUCT_IDS",
  "APPLE_ROOT_CERTIFICATES or readable APPLE_ROOT_CERTIFICATE_PATHS",
  "OWNMINUTES_IAP_RECEIPT_VERIFICATION",
  "OWNMINUTES_IAP_ENTITLEMENT_MAPPING",
  "OWNMINUTES_IAP_REFUND_HANDLING",
  "OWNMINUTES_ORDER_IDEMPOTENCY",
  "OWNMINUTES_IAP_NOTIFICATION_URL",
  "OWNMINUTES_ENABLE_SIMULATED_BILLING=0",
  "OWNMINUTES_ENABLE_IAP_MOCK=0",
];
const postBootstrapEvidenceEnv = [
  "OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF",
  "OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF",
  "OWNMINUTES_IAP_SANDBOX_REFUND_PROOF",
  "OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF",
  "OWNMINUTES_IAP_DB_LEDGER_PROOF",
];
const requiredEnv = phase === "sandbox-bootstrap" ? bootstrapRequiredEnv : [...bootstrapRequiredEnv, ...postBootstrapEvidenceEnv];

function main() {
  const appleIapSource = readFile(appleIapPath);
  const secretRunnerSource = readFile(secretRunnerPath);
  const transactionRouteSource = readFile(transactionRoutePath);
  const notificationRouteSource = readFile(notificationRoutePath);
  const privateKeyInline = getEnv("APPLE_PRIVATE_KEY");
  const privateKeyPaths = uniqueValues([getEnv("APPLE_PRIVATE_KEY_FILE", "OWNMINUTES_APPLE_PRIVATE_KEY_FILE")]);
  const privateKeyFileReady = privateKeyPaths.some(isReadableNonEmptyFile);
  const privateKeyReady = Boolean(privateKeyInline) || privateKeyFileReady;
  const rootCertificatesInline = getEnv("APPLE_ROOT_CERTIFICATES", "APP_STORE_SERVER_NOTIFICATION_ROOT_CERTIFICATES");
  const rootCertificateSourceValues = [process.env.OWNMINUTES_APPLE_ROOT_CA_G2_FILE, process.env.OWNMINUTES_APPLE_ROOT_CA_G3_FILE];
  const hasRootCertificateSourceConfig = rootCertificateSourceValues.some((value) => Boolean(value?.trim()));
  const hasCompleteRootCertificateSourceConfig = rootCertificateSourceValues.every((value) => Boolean(value?.trim()));
  const rootCertificateSourcePaths = uniqueValues(rootCertificateSourceValues);
  const rootCertificateRuntimePaths = parseDelimitedValues(process.env.APPLE_ROOT_CERTIFICATE_PATHS);
  const rootCertificatePaths = rootCertificateSourcePaths.length > 0 ? rootCertificateSourcePaths : rootCertificateRuntimePaths;
  const rootCertificateFilesReady =
    rootCertificatePaths.length > 0 &&
    (!hasRootCertificateSourceConfig || hasCompleteRootCertificateSourceConfig) &&
    rootCertificatePaths.every(isReadableNonEmptyFile);
  const rootCertificatesReady = Boolean(rootCertificatesInline) || rootCertificateFilesReady;
  const accountBindingSecret = getEnv("OWNMINUTES_APP_SECRET", "AUTH_SECRET") || readFirstFileValue([process.env.OWNMINUTES_APP_SECRET_FILE]);
  const productIds = getEnv("APPLE_IAP_PRODUCT_IDS", "OWNMINUTES_IAP_PRODUCT_IDS");
  const declaredProductIds = parseDelimitedValues(productIds);
  const appAppleIdRequired = environment !== "sandbox";
  const sandboxAcceptanceMode = process.env.OWNMINUTES_IAP_SANDBOX_ACCEPTANCE === "1";
  const durableBillingRepository =
    process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const notificationUrl = resolveNotificationUrl();
  const evidenceReady = postBootstrapEvidenceEnv.every(hasEnv);
  const commonChecks = [
    check(
      "preflight-phase",
      allowedPhases.has(configuredPhase),
      phase === "sandbox-bootstrap"
        ? "当前门禁仅验证首次 TestFlight Sandbox 交易前的可验证配置。"
        : "当前门禁验证完整验收证据和正式发布配置。",
      "未知 Apple IAP preflight phase；仅允许 release 或 sandbox-bootstrap。",
    ),
    check(
      "environment-mode",
      allowedEnvironments.has(configuredEnvironment) && environmentMatchesPhase(phase, environment, sandboxAcceptanceMode),
      environment === "sandbox"
        ? "隔离 TestFlight staging 仅接受 Sandbox，且永远不是 production candidate。"
        : "正式发布环境仅接受 Production。",
      phase === "sandbox-bootstrap"
        ? "Sandbox bootstrap 必须 APPLE_IAP_ENVIRONMENT=sandbox 且 OWNMINUTES_IAP_SANDBOX_ACCEPTANCE=1。"
        : "完整验收只允许 production+acceptance=0 或隔离 sandbox+acceptance=1；auto 不可作为发布候选。",
    ),
    check(
      "durable-billing-repository",
      durableBillingRepository,
      "Apple IAP 使用 PostgreSQL 持久账本。",
      "真实 Apple IAP 必须配置 OWNMINUTES_AUTH_REPOSITORY=postgres 和 DATABASE_URL/POSTGRES_URL。",
    ),
    check("issuer-id", hasEnv("APPLE_ISSUER_ID"), "APPLE_ISSUER_ID 已配置。", "缺少 APPLE_ISSUER_ID。"),
    check("key-id", hasEnv("APPLE_KEY_ID"), "APPLE_KEY_ID 已配置。", "缺少 APPLE_KEY_ID。"),
    check(
      "private-key",
      privateKeyReady,
      privateKeyFileReady ? "Apple IAP private key file 已配置且可读。" : "APPLE_PRIVATE_KEY 已配置。",
      "缺少 APPLE_PRIVATE_KEY，或 APPLE_PRIVATE_KEY_FILE/OWNMINUTES_APPLE_PRIVATE_KEY_FILE 不可读。",
    ),
    check("bundle-id", hasEnv("APPLE_BUNDLE_ID"), "APPLE_BUNDLE_ID 已配置。", "缺少 APPLE_BUNDLE_ID。"),
    check(
      "account-binding-secret",
      accountBindingSecret.length >= 32,
      "Apple appAccountToken 账号绑定密钥已配置。",
      "缺少至少 32 位 OWNMINUTES_APP_SECRET/AUTH_SECRET，或 OWNMINUTES_APP_SECRET_FILE 不可读。",
    ),
    check("product-ids", Boolean(productIds), "IAP 商品 ID 已配置。", "缺少 APPLE_IAP_PRODUCT_IDS 或 OWNMINUTES_IAP_PRODUCT_IDS。"),
    check(
      "root-certificates",
      rootCertificatesReady,
      rootCertificateFilesReady ? "Apple Root Certificate files 已配置且可读。" : "Apple Root Certificates 已配置。",
      "缺少 APPLE_ROOT_CERTIFICATES，或 Apple root certificate paths 不可读。",
    ),
    check(
      "receipt-verification",
      hasEnv("OWNMINUTES_IAP_RECEIPT_VERIFICATION"),
      "OWNMINUTES_IAP_RECEIPT_VERIFICATION 已声明。",
      "缺少 OWNMINUTES_IAP_RECEIPT_VERIFICATION。",
    ),
    check(
      "entitlement-mapping",
      hasValidEntitlementMapping(process.env.OWNMINUTES_IAP_ENTITLEMENT_MAPPING, declaredProductIds),
      "OWNMINUTES_IAP_ENTITLEMENT_MAPPING 与海外首发目录完全一致：Plus 799 USD cents，Pro 1999 USD cents。",
      "OWNMINUTES_IAP_ENTITLEMENT_MAPPING 必须且只能包含 ownminutes.plus.monthly=799 USD/plus 与 ownminutes.pro.monthly=1999 USD/pro。",
    ),
    check(
      "refund-handling",
      hasEnv("OWNMINUTES_IAP_REFUND_HANDLING"),
      "OWNMINUTES_IAP_REFUND_HANDLING 已声明。",
      "缺少 OWNMINUTES_IAP_REFUND_HANDLING。",
    ),
    check(
      "idempotency",
      hasEnv("OWNMINUTES_ORDER_IDEMPOTENCY"),
      "OWNMINUTES_ORDER_IDEMPOTENCY 已声明。",
      "缺少 OWNMINUTES_ORDER_IDEMPOTENCY。",
    ),
    check(
      "notification-url",
      isHttpsUrl(notificationUrl),
      "OWNMINUTES_IAP_NOTIFICATION_URL 是公网 HTTPS URL。",
      "缺少公网 HTTPS OWNMINUTES_IAP_NOTIFICATION_URL。",
    ),
    check(
      "production-app-apple-id",
      !appAppleIdRequired || hasEnv("APPLE_APP_APPLE_ID"),
      appAppleIdRequired ? `${environment} 环境 APPLE_APP_APPLE_ID 已配置。` : "sandbox 环境不强制 APPLE_APP_APPLE_ID。",
      `${environment} 环境包含 production 校验但缺少 APPLE_APP_APPLE_ID。`,
    ),
    check(
      "simulated-billing-disabled",
      process.env.OWNMINUTES_ENABLE_SIMULATED_BILLING === "0",
      "模拟计费已显式关闭。",
      "真实 Sandbox/Production IAP 必须显式设置 OWNMINUTES_ENABLE_SIMULATED_BILLING=0。",
    ),
    check(
      "iap-mock-disabled",
      process.env.OWNMINUTES_ENABLE_IAP_MOCK === "0",
      "IAP mock 已显式关闭。",
      "真实 Sandbox/Production IAP 必须显式设置 OWNMINUTES_ENABLE_IAP_MOCK=0。",
    ),
    check("runbook", fs.existsSync(runbookPath), "Apple IAP sandbox runbook 存在。", "缺少 docs/apple-iap-sandbox-runbook.md。"),
    check(
      "file-secret-runtime",
      secretRunnerSource.includes('fileVariable: "APPLE_PRIVATE_KEY_FILE"') &&
        secretRunnerSource.includes("APPLE_ROOT_CERTIFICATE_PATHS") &&
        secretRunnerSource.includes("APPLE_ROOT_CERTIFICATES = JSON.stringify(certificates)"),
      "Apple private key 和 root certificate file secrets 会在降权前加载。",
      "scripts/run-with-secrets.mjs 尚未完整支持 Apple IAP file secrets。",
    ),
    check(
      "verifier-runtime",
      appleIapSource.includes("SignedDataVerifier") &&
        appleIapSource.includes("verifyAndDecodeNotification") &&
        appleIapSource.includes("verifyAndDecodeTransaction") &&
        appleIapSource.includes("verifyAppleTransactionSignedInfo") &&
        appleIapSource.includes("createAppleIapAccountToken") &&
        appleIapSource.includes("APPLE_ROOT_CERTIFICATES"),
      "Apple signedPayload verifier runtime 已实现。",
      "Apple signedPayload verifier runtime 缺失或不完整。",
    ),
    check(
      "transaction-runtime",
      transactionRouteSource.includes("fetchAppStoreTransactionInfo") &&
        transactionRouteSource.includes("recordAppleIapPurchase") &&
        transactionRouteSource.includes("requireAppleIapReady"),
      "Apple transaction endpoint runtime 已实现。",
      "Apple transaction endpoint runtime 缺失或不完整。",
    ),
    check(
      "notification-runtime",
      notificationRouteSource.includes("verifyAppleNotificationSignedPayload") &&
        notificationRouteSource.includes("recordAppleIapNotification") &&
        appleIapSource.includes("invalid_signed_payload_signature"),
      "Apple notification endpoint runtime 已实现。",
      "Apple notification endpoint runtime 缺失或不完整。",
    ),
  ];
  const evidenceChecks = [
    check(
      "sandbox-purchase-proof",
      hasEnv("OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF"),
      "沙盒购买证据已声明。",
      "缺少 OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF。",
    ),
    check(
      "sandbox-renewal-proof",
      hasEnv("OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF"),
      "沙盒续期证据已声明。",
      "缺少 OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF。",
    ),
    check(
      "sandbox-refund-proof",
      hasEnv("OWNMINUTES_IAP_SANDBOX_REFUND_PROOF"),
      "沙盒退款证据已声明。",
      "缺少 OWNMINUTES_IAP_SANDBOX_REFUND_PROOF。",
    ),
    check(
      "sandbox-expiration-proof",
      hasEnv("OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF"),
      "沙盒过期/撤销证据已声明。",
      "缺少 OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF。",
    ),
    check(
      "db-ledger-proof",
      hasEnv("OWNMINUTES_IAP_DB_LEDGER_PROOF"),
      "billing_orders 和 entitlement_grants 账本证据已声明。",
      "缺少 OWNMINUTES_IAP_DB_LEDGER_PROOF。",
    ),
  ];
  const checks = phase === "sandbox-bootstrap" ? commonChecks : [...commonChecks, ...evidenceChecks];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const bootstrapReady = phase === "sandbox-bootstrap" && missing.length === 0;
  const acceptanceReady = phase === "release" && missing.length === 0;
  const productionCandidate = acceptanceReady && environment === "production" && !sandboxAcceptanceMode;
  const summary = {
    ok: missing.length === 0,
    strict,
    phase,
    provider: hasAppleCredentials(privateKeyReady) ? "apple-iap" : "simulated",
    environment,
    deploymentBoundary: environment === "sandbox" || sandboxAcceptanceMode ? "sandbox-only" : "production",
    bootstrapReady,
    acceptanceReady,
    evidenceReady,
    productionCandidate,
    requiredEnv,
    postBootstrapEvidenceEnv,
    configured: {
      environmentMode: allowedEnvironments.has(configuredEnvironment),
      appleIssuerId: hasEnv("APPLE_ISSUER_ID"),
      appleKeyId: hasEnv("APPLE_KEY_ID"),
      applePrivateKey: privateKeyReady,
      applePrivateKeyFile: privateKeyFileReady,
      bundleId: hasEnv("APPLE_BUNDLE_ID"),
      productIds: Boolean(productIds),
      rootCertificates: rootCertificatesReady,
      rootCertificateFiles: rootCertificateFilesReady,
      notificationUrl: isHttpsUrl(notificationUrl),
      durableBillingRepository,
      sandboxAcceptanceMode,
      appAppleId: hasEnv("APPLE_APP_APPLE_ID"),
      sandboxEvidence: [
        "OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF",
        "OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF",
        "OWNMINUTES_IAP_SANDBOX_REFUND_PROOF",
        "OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF",
        "OWNMINUTES_IAP_DB_LEDGER_PROOF",
      ].every(hasEnv),
    },
    missing,
    checks,
    nextAction: resolveNextAction({ acceptanceReady, bootstrapReady, environment, missing, productionCandidate }),
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

function resolvePhase() {
  const inline = process.argv.find((argument) => argument.startsWith("--phase="));
  if (inline) return inline.slice("--phase=".length).trim();
  const index = process.argv.indexOf("--phase");
  if (index >= 0) return String(process.argv[index + 1] || "").trim();
  return process.env.OWNMINUTES_IAP_PREFLIGHT_PHASE?.trim() || "release";
}

function environmentMatchesPhase(currentPhase, currentEnvironment, sandboxAcceptanceMode) {
  if (currentPhase === "sandbox-bootstrap") {
    return currentEnvironment === "sandbox" && sandboxAcceptanceMode;
  }
  return (
    (currentEnvironment === "production" && !sandboxAcceptanceMode) ||
    (currentEnvironment === "sandbox" && sandboxAcceptanceMode)
  );
}

function resolveNextAction({ acceptanceReady, bootstrapReady, environment, missing, productionCandidate }) {
  if (missing.length > 0) {
    return "Set the missing Apple IAP settings for the selected phase and rerun the strict preflight. Never fill evidence variables before the matching real Sandbox/TestFlight scenario passes.";
  }
  if (bootstrapReady) {
    return "Run the first TestFlight Sandbox transaction on this sandbox-only deployment, collect redacted lifecycle and ledger evidence, then rerun the full strict preflight without the sandbox-bootstrap phase.";
  }
  if (acceptanceReady && environment === "sandbox") {
    return "Sandbox acceptance is complete. Do not promote this deployment in place; provision a separate production domain, database, object storage, and secrets, then rerun the full strict preflight there.";
  }
  if (productionCandidate) {
    return "The separate production deployment is an Apple IAP production candidate; complete the remaining App Store release gates before submission.";
  }
  return "Apple IAP preflight passed, but this deployment is not a production candidate.";
}

function readFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function getEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  return "";
}

function hasEnv(name) {
  return Boolean(process.env[name]?.trim());
}

function hasAppleCredentials(privateKeyReady) {
  return hasEnv("APPLE_ISSUER_ID") && hasEnv("APPLE_KEY_ID") && privateKeyReady && hasEnv("APPLE_BUNDLE_ID");
}

function resolveNotificationUrl() {
  const configured = process.env.OWNMINUTES_IAP_NOTIFICATION_URL?.trim();
  if (configured) return configured;
  const domain = process.env.OWNMINUTES_DOMAIN?.trim();
  return domain ? `https://${domain}/api/payments/apple/notifications` : "";
}

function parseDelimitedValues(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set(values.flatMap(parseDelimitedValues))];
}

function isReadableNonEmptyFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function readFirstFileValue(paths) {
  for (const filePath of uniqueValues(paths)) {
    if (!isReadableNonEmptyFile(filePath)) continue;
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (value) return value;
  }
  return "";
}

function isHttpsUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function hasValidEntitlementMapping(value, productIds) {
  const expected = {
    "ownminutes.plus.monthly": { amountCents: 799, currency: "USD", plan: "plus" },
    "ownminutes.pro.monthly": { amountCents: 1999, currency: "USD", plan: "pro" },
  };
  const expectedProductIds = Object.keys(expected);
  if (
    !value?.trim() ||
    productIds.length !== expectedProductIds.length ||
    expectedProductIds.some((productId) => !productIds.includes(productId))
  ) return false;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    return Object.keys(parsed).length === expectedProductIds.length && expectedProductIds.every((productId) => {
      const entry = parsed[productId];
      const launch = expected[productId];
      return (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry.plan === launch.plan &&
        entry.amountCents === launch.amountCents &&
        entry.currency === launch.currency
      );
    });
  } catch {
    return false;
  }
}

function leaksSecrets(text) {
  return (
    text.includes("-----BEGIN PRIVATE KEY-----") ||
    text.includes("APPLE_PRIVATE_KEY=") ||
    text.includes("signedPayload=") ||
    text.includes("real-signed-payload") ||
    text.includes("real-transaction-id") ||
    text.includes("sharedSecret") ||
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE")
  );
}

main();
