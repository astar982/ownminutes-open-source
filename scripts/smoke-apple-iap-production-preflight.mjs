#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "ownminutes-iap-preflight-"));
const privateKeyFile = join(scratch, "AuthKey_test.p8");
const rootCaG2File = join(scratch, "AppleRootCA-G2.cer");
const rootCaG3File = join(scratch, "AppleRootCA-G3.cer");
const appSecretFile = join(scratch, "app-secret");

writeFileSync(privateKeyFile, "file-private-key-fixture\n", { mode: 0o600 });
writeFileSync(rootCaG2File, "file-root-ca-g2-fixture\n", { mode: 0o600 });
writeFileSync(rootCaG3File, "file-root-ca-g3-fixture\n", { mode: 0o600 });
writeFileSync(appSecretFile, "file-account-binding-secret-redacted-1234567890\n", { mode: 0o600 });

try {
  main();
} finally {
  rmSync(scratch, { force: true, recursive: true });
}

function main() {
  const diagnosticsSource = readFileSync("src/lib/payment-diagnostics.ts", "utf8");
  const commonRuntimeEnv = {
    OWNMINUTES_AUTH_REPOSITORY: "postgres",
    DATABASE_URL: "postgresql://iap-smoke.invalid/ownminutes",
    APPLE_ISSUER_ID: "issuer-id-redacted",
    APPLE_KEY_ID: "key-id-redacted",
    APPLE_BUNDLE_ID: "app.ownminutes.mobile",
    APPLE_IAP_PRODUCT_IDS: "ownminutes.plus.monthly,ownminutes.pro.monthly",
    OWNMINUTES_IAP_RECEIPT_VERIFICATION: "server transaction lookup and signed transaction verification required",
    OWNMINUTES_IAP_ENTITLEMENT_MAPPING: JSON.stringify({
      "ownminutes.plus.monthly": { amountCents: 799, currency: "USD", plan: "plus" },
      "ownminutes.pro.monthly": { amountCents: 1999, currency: "USD", plan: "pro" },
    }),
    OWNMINUTES_IAP_REFUND_HANDLING: "refund revoke expire events reclaim grants",
    OWNMINUTES_ORDER_IDEMPOTENCY: "originalTransactionId plus productId plus period idempotency",
    OWNMINUTES_IAP_NOTIFICATION_URL: "https://app.example.com/api/payments/apple/notifications",
    OWNMINUTES_LEGAL_OPERATOR_NAME: "OwnMinutes Test Operator",
    OWNMINUTES_LEGAL_OPERATOR_ADDRESS: "1 Test Street, Test City",
    OWNMINUTES_LEGAL_OPERATOR_JURISDICTION: "Test Jurisdiction",
    OWNMINUTES_ENABLE_SIMULATED_BILLING: "0",
    OWNMINUTES_ENABLE_IAP_MOCK: "0",
  };
  const evidenceEnv = {
    OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF: "redacted sandbox plus/pro purchase evidence archived",
    OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF: "redacted DID_RENEW evidence archived",
    OWNMINUTES_IAP_SANDBOX_REFUND_PROOF: "redacted REFUND evidence archived",
    OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF: "redacted EXPIRED or REVOKE evidence archived",
    OWNMINUTES_IAP_DB_LEDGER_PROOF: "redacted billing_orders and entitlement_grants evidence archived",
  };
  const commonEvidenceEnv = { ...commonRuntimeEnv, ...evidenceEnv };
  const inlineSecrets = {
    APPLE_PRIVATE_KEY: "private-key-redacted",
    APPLE_ROOT_CERTIFICATES: "root-certificates-redacted",
    OWNMINUTES_APP_SECRET: "account-binding-secret-redacted-1234567890",
  };
  const fileSecrets = {
    OWNMINUTES_APPLE_PRIVATE_KEY_FILE: privateKeyFile,
    OWNMINUTES_APPLE_ROOT_CA_G2_FILE: rootCaG2File,
    OWNMINUTES_APPLE_ROOT_CA_G3_FILE: rootCaG3File,
    OWNMINUTES_APP_SECRET_FILE: appSecretFile,
  };

  const cases = [
    {
      name: "missing-env",
      expectOk: false,
      env: {},
      expectedProvider: "simulated",
      expectedEnvironment: "auto",
    },
    {
      name: "credentials-only",
      expectOk: false,
      env: {
        APPLE_ISSUER_ID: "issuer-id-redacted",
        APPLE_KEY_ID: "key-id-redacted",
        APPLE_PRIVATE_KEY: "private-key-redacted",
        APPLE_BUNDLE_ID: "app.ownminutes.mobile",
      },
      expectedProvider: "apple-iap",
      expectedEnvironment: "auto",
    },
    {
      name: "sandbox-bootstrap-without-evidence",
      expectOk: true,
      env: {
        ...commonRuntimeEnv,
        ...inlineSecrets,
        APPLE_IAP_ENVIRONMENT: "sandbox",
        OWNMINUTES_IAP_SANDBOX_ACCEPTANCE: "1",
      },
      args: ["--phase=sandbox-bootstrap"],
      expectedProvider: "apple-iap",
      expectedEnvironment: "sandbox",
      expectedPhase: "sandbox-bootstrap",
      expectedBootstrapReady: true,
      expectedEvidenceReady: false,
      expectEvidenceChecks: false,
    },
    {
      name: "sandbox-bootstrap-rejects-production",
      expectOk: false,
      env: {
        ...commonRuntimeEnv,
        ...inlineSecrets,
        APPLE_IAP_ENVIRONMENT: "production",
        APPLE_APP_APPLE_ID: "1234567890",
        OWNMINUTES_IAP_SANDBOX_ACCEPTANCE: "0",
      },
      args: ["--phase=sandbox-bootstrap"],
      expectedProvider: "apple-iap",
      expectedEnvironment: "production",
      expectedPhase: "sandbox-bootstrap",
      expectedBootstrapReady: false,
      expectedEvidenceReady: false,
      expectEvidenceChecks: false,
    },
    {
      name: "stale-launch-pricing-rejected",
      expectOk: false,
      env: {
        ...commonRuntimeEnv,
        ...inlineSecrets,
        APPLE_IAP_ENVIRONMENT: "sandbox",
        OWNMINUTES_IAP_SANDBOX_ACCEPTANCE: "1",
        OWNMINUTES_IAP_ENTITLEMENT_MAPPING: JSON.stringify({
          "ownminutes.plus.monthly": { amountCents: 990, currency: "CNY", plan: "plus" },
          "ownminutes.pro.monthly": { amountCents: 2900, currency: "CNY", plan: "pro" },
        }),
      },
      args: ["--phase=sandbox-bootstrap"],
      expectedProvider: "apple-iap",
      expectedEnvironment: "sandbox",
      expectedPhase: "sandbox-bootstrap",
      expectedBootstrapReady: false,
      expectedEvidenceReady: false,
      expectEvidenceChecks: false,
    },
    {
      name: "complete-sandbox-acceptance",
      expectOk: true,
      env: {
        ...commonEvidenceEnv,
        ...inlineSecrets,
        APPLE_IAP_ENVIRONMENT: "sandbox",
        OWNMINUTES_IAP_SANDBOX_ACCEPTANCE: "1",
      },
      expectedProvider: "apple-iap",
      expectedEnvironment: "sandbox",
      expectedEvidenceReady: true,
    },
    {
      name: "production-missing-app-id",
      expectOk: false,
      env: {
        ...commonEvidenceEnv,
        ...inlineSecrets,
        APPLE_IAP_ENVIRONMENT: "production",
        OWNMINUTES_IAP_SANDBOX_ACCEPTANCE: "0",
      },
      expectedProvider: "apple-iap",
      expectedEnvironment: "production",
      expectedEvidenceReady: true,
    },
    {
      name: "incomplete-root-file-set",
      expectOk: false,
      env: {
        ...commonEvidenceEnv,
        OWNMINUTES_APPLE_PRIVATE_KEY_FILE: privateKeyFile,
        OWNMINUTES_APPLE_ROOT_CA_G2_FILE: rootCaG2File,
        OWNMINUTES_APP_SECRET_FILE: appSecretFile,
        APPLE_IAP_ENVIRONMENT: "auto",
        APPLE_APP_APPLE_ID: "1234567890",
      },
      expectedProvider: "apple-iap",
      expectedEnvironment: "auto",
      expectedEvidenceReady: true,
    },
    {
      name: "complete-production",
      expectOk: true,
      env: {
        ...commonEvidenceEnv,
        ...inlineSecrets,
        APPLE_IAP_ENVIRONMENT: "production",
        APPLE_APP_APPLE_ID: "1234567890",
        OWNMINUTES_IAP_SANDBOX_ACCEPTANCE: "0",
      },
      expectedProvider: "apple-iap",
      expectedEnvironment: "production",
      expectedProductionCandidate: true,
      expectedEvidenceReady: true,
    },
    {
      name: "complete-auto-file-secrets",
      expectOk: false,
      env: {
        ...commonEvidenceEnv,
        ...fileSecrets,
        APPLE_IAP_ENVIRONMENT: "auto",
        APPLE_APP_APPLE_ID: "1234567890",
      },
      expectedProvider: "apple-iap",
      expectedEnvironment: "auto",
      expectFileSecrets: true,
      expectedEvidenceReady: true,
    },
  ];

  const results = cases.map((testCase) => {
    const output = runCase(testCase.env, testCase.args);
    const payload = parseJson(output.stdout);
    const evidenceCheckIds = [
      "sandbox-purchase-proof",
      "sandbox-renewal-proof",
      "sandbox-refund-proof",
      "sandbox-expiration-proof",
      "db-ledger-proof",
    ];
    const hasEvidenceChecks = evidenceCheckIds.every((id) => payload?.checks?.some((check) => check.id === id));
    return {
      name: testCase.name,
      expected: testCase.expectOk,
      status: output.status,
      ok: payload?.ok,
      productionCandidate: payload?.productionCandidate,
      provider: payload?.provider,
      providerMatches: payload?.provider === testCase.expectedProvider,
      environment: payload?.environment,
      environmentMatches: payload?.environment === testCase.expectedEnvironment,
      phase: payload?.phase,
      phaseMatches: payload?.phase === (testCase.expectedPhase || "release"),
      bootstrapReady: payload?.bootstrapReady,
      bootstrapReadyMatches: payload?.bootstrapReady === (testCase.expectedBootstrapReady || false),
      evidenceReady: payload?.evidenceReady,
      evidenceReadyMatches: payload?.evidenceReady === (testCase.expectedEvidenceReady || false),
      productionCandidateMatches: payload?.productionCandidate === (testCase.expectedProductionCandidate || false),
      sandboxBoundary: payload?.environment !== "sandbox" || payload?.deploymentBoundary === "sandbox-only",
      missing: payload?.missing ?? [],
      hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 23,
      hasRequiredEnv:
        Array.isArray(payload?.requiredEnv) &&
        payload.requiredEnv.includes("OWNMINUTES_IAP_PREFLIGHT_PHASE=release|sandbox-bootstrap (or --phase=...)") &&
        payload.requiredEnv.includes("APPLE_IAP_ENVIRONMENT=auto|production|sandbox") &&
        payload.requiredEnv.includes("APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_FILE") &&
        payload.requiredEnv.includes("OWNMINUTES_ENABLE_SIMULATED_BILLING=0") &&
        payload.requiredEnv.includes("OWNMINUTES_ENABLE_IAP_MOCK=0") &&
        (payload.phase === "sandbox-bootstrap"
          ? !payload.requiredEnv.includes("OWNMINUTES_IAP_DB_LEDGER_PROOF")
          : payload.requiredEnv.includes("OWNMINUTES_IAP_DB_LEDGER_PROOF")),
      hasPostBootstrapEvidenceCatalog:
        Array.isArray(payload?.postBootstrapEvidenceEnv) &&
        evidenceCheckIds.length === payload.postBootstrapEvidenceEnv.length &&
        payload.postBootstrapEvidenceEnv.includes("OWNMINUTES_IAP_DB_LEDGER_PROOF"),
      hasEnvironmentGate: payload?.checks?.some((check) => check.id === "environment-mode"),
      hasPhaseGate: payload?.checks?.some((check) => check.id === "preflight-phase"),
      hasDurableBillingGate: payload?.checks?.some((check) => check.id === "durable-billing-repository"),
      hasFileSecretRuntimeGate: payload?.checks?.some((check) => check.id === "file-secret-runtime"),
      fileSecretsDetected:
        !testCase.expectFileSecrets ||
        (payload?.configured?.applePrivateKeyFile === true &&
          payload?.configured?.rootCertificateFiles === true &&
          payload?.configured?.applePrivateKey === true &&
          payload?.configured?.rootCertificates === true),
      hasNotificationUrlGate: payload?.checks?.some((check) => check.id === "notification-url"),
      hasSandboxPurchaseGate: payload?.checks?.some((check) => check.id === "sandbox-purchase-proof"),
      hasRenewalGate: payload?.checks?.some((check) => check.id === "sandbox-renewal-proof"),
      hasRefundGate: payload?.checks?.some((check) => check.id === "sandbox-refund-proof"),
      hasExpirationGate: payload?.checks?.some((check) => check.id === "sandbox-expiration-proof"),
      hasDbLedgerGate: payload?.checks?.some((check) => check.id === "db-ledger-proof"),
      evidenceChecksMatch: hasEvidenceChecks === (testCase.expectEvidenceChecks ?? true),
      noSecretLeaks:
        !output.combined.includes("private-key-redacted") &&
        !output.combined.includes("root-certificates-redacted") &&
        !output.combined.includes("account-binding-secret-redacted") &&
        !output.combined.includes("file-private-key-fixture") &&
        !output.combined.includes("file-root-ca-g2-fixture") &&
        !output.combined.includes("file-root-ca-g3-fixture") &&
        !output.combined.includes("file-account-binding-secret-redacted") &&
        !output.combined.includes("real-signed-payload") &&
        !output.combined.includes("real-transaction-id") &&
        !output.combined.includes("AKL") &&
        !output.combined.includes("sk-proj"),
    };
  });

  const summary = {
    allExpected: results.every((result) => result.ok === result.expected),
    strictFailsWhenMissing: results.find((result) => result.name === "missing-env")?.status === 1,
    strictFailsWithCredentialsOnly: results.find((result) => result.name === "credentials-only")?.status === 1,
    strictPassesSandboxBootstrapWithoutEvidence:
      results.find((result) => result.name === "sandbox-bootstrap-without-evidence")?.status === 0,
    strictRejectsBootstrapProductionMode:
      results.find((result) => result.name === "sandbox-bootstrap-rejects-production")?.status === 1,
    strictRejectsStaleLaunchPricing:
      results.find((result) => result.name === "stale-launch-pricing-rejected")?.status === 1 &&
      results.find((result) => result.name === "stale-launch-pricing-rejected")?.missing.includes("entitlement-mapping"),
    strictFailsProductionWithoutAppId: results.find((result) => result.name === "production-missing-app-id")?.status === 1,
    strictFailsIncompleteRootFileSet: results.find((result) => result.name === "incomplete-root-file-set")?.status === 1,
    strictPassesWithCompleteProviders: results
      .filter((result) => ["complete-sandbox-acceptance", "complete-production"].includes(result.name))
      .every((result) => result.status === 0),
    strictRejectsAutoForLaunch: results.find((result) => result.name === "complete-auto-file-secrets")?.status === 1,
    diagnosticsUsesExactLaunchPricing:
      diagnosticsSource.includes('"ownminutes.plus.monthly": { amountCents: 799, currency: "USD", plan: "plus" }') &&
      diagnosticsSource.includes('"ownminutes.pro.monthly": { amountCents: 1999, currency: "USD", plan: "pro" }'),
    allProvidersDetected: results.every((result) => result.providerMatches),
    allEnvironmentsDetected: results.every((result) => result.environmentMatches),
    allPhasesDetected: results.every((result) => result.phaseMatches),
    allBootstrapStatesCorrect: results.every((result) => result.bootstrapReadyMatches),
    allEvidenceStatesCorrect: results.every((result) => result.evidenceReadyMatches),
    productionCandidatesCorrect: results.every((result) => result.productionCandidateMatches),
    sandboxDeploymentsRemainSandboxOnly: results.every((result) => result.sandboxBoundary),
    allHaveChecks: results.every((result) => result.hasChecks),
    allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
    allHavePostBootstrapEvidenceCatalog: results.every((result) => result.hasPostBootstrapEvidenceCatalog),
    allHavePhaseGate: results.every((result) => result.hasPhaseGate),
    allHaveEnvironmentGate: results.every((result) => result.hasEnvironmentGate),
    allHaveDurableBillingGate: results.every((result) => result.hasDurableBillingGate),
    allHaveFileSecretRuntimeGate: results.every((result) => result.hasFileSecretRuntimeGate),
    fileSecretsDetected: results.every((result) => result.fileSecretsDetected),
    allHaveNotificationUrlGate: results.every((result) => result.hasNotificationUrlGate),
    evidenceChecksMatchSelectedPhase: results.every((result) => result.evidenceChecksMatch),
    noSecretLeaks: results.every((result) => result.noSecretLeaks),
    results,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.allExpected ||
    !summary.strictFailsWhenMissing ||
    !summary.strictFailsWithCredentialsOnly ||
    !summary.strictPassesSandboxBootstrapWithoutEvidence ||
    !summary.strictRejectsBootstrapProductionMode ||
    !summary.strictRejectsStaleLaunchPricing ||
    !summary.strictFailsProductionWithoutAppId ||
    !summary.strictFailsIncompleteRootFileSet ||
    !summary.strictPassesWithCompleteProviders ||
    !summary.strictRejectsAutoForLaunch ||
    !summary.diagnosticsUsesExactLaunchPricing ||
    !summary.allProvidersDetected ||
    !summary.allEnvironmentsDetected ||
    !summary.allPhasesDetected ||
    !summary.allBootstrapStatesCorrect ||
    !summary.allEvidenceStatesCorrect ||
    !summary.productionCandidatesCorrect ||
    !summary.sandboxDeploymentsRemainSandboxOnly ||
    !summary.allHaveChecks ||
    !summary.allHaveRequiredEnv ||
    !summary.allHavePostBootstrapEvidenceCatalog ||
    !summary.allHavePhaseGate ||
    !summary.allHaveEnvironmentGate ||
    !summary.allHaveDurableBillingGate ||
    !summary.allHaveFileSecretRuntimeGate ||
    !summary.fileSecretsDetected ||
    !summary.allHaveNotificationUrlGate ||
    !summary.evidenceChecksMatchSelectedPhase ||
    !summary.noSecretLeaks
  ) {
    process.exitCode = 1;
  }
}

function runCase(env, args = []) {
  const result = spawnSync(process.execPath, ["scripts/check-apple-iap-production-env.mjs", ...args, "--strict"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      ...env,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid Apple IAP preflight JSON: ${error.message}\n${stdout}`);
  }
}
