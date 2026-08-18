import { hasCompletePublicLegalIdentity } from "@/lib/public-legal-identity";

export type PaymentProvider = "simulated" | "apple-iap" | "external-billing";
export type PaymentCheckStatus = "pass" | "fail" | "manual";

export type PaymentDiagnosticCheck = {
  id: string;
  title: string;
  status: PaymentCheckStatus;
  detail: string;
};

export type PaymentDiagnostics = {
  acceptingPurchases: boolean;
  generatedAt: string;
  provider: PaymentProvider;
  productionReady: boolean;
  configured: {
    appleIssuerId: boolean;
    appleKeyId: boolean;
    applePrivateKey: boolean;
    bundleId: boolean;
    iapEnvironment: "auto" | "production" | "sandbox";
    simulatedBillingEnabled: boolean;
    productIds: boolean;
    serverNotificationSecret: boolean;
    serverNotificationVerifier: boolean;
    receiptVerification: boolean;
    entitlementMapping: boolean;
    refundHandling: boolean;
    idempotency: boolean;
    notificationUrl: boolean;
    appAppleId: boolean;
    accountBinding: boolean;
    sandboxPurchaseProof: boolean;
    sandboxRenewalProof: boolean;
    sandboxRefundProof: boolean;
    sandboxExpirationProof: boolean;
    dbLedgerProof: boolean;
    sandboxAcceptanceMode: boolean;
    durableBillingRepository: boolean;
    legalIdentity: boolean;
  };
  capabilities: {
    hasServerEndpoints: boolean;
    verifiesTransactions: boolean;
    grantsOfficialQuota: boolean;
    handlesRefunds: boolean;
    supportsServerNotifications: boolean;
    usesSimulatedPlanSwitching: boolean;
    hasSandboxPurchaseEvidence: boolean;
    hasSandboxLifecycleEvidence: boolean;
    hasLedgerEvidence: boolean;
  };
  missing: string[];
  checks: PaymentDiagnosticCheck[];
  notes: string[];
};

export function getPaymentDiagnostics(): PaymentDiagnostics {
  const simulatedBillingEnabled = isSimulatedBillingEnabled();
  const appleIssuerId = hasEnv("APPLE_ISSUER_ID");
  const appleKeyId = hasEnv("APPLE_KEY_ID");
  const applePrivateKey = hasEnv("APPLE_PRIVATE_KEY");
  const bundleId = hasEnv("APPLE_BUNDLE_ID");
  const iapEnvironment = parseAppleIapEnvironment();
  const declaredProductIds = parseDelimitedValues(process.env.APPLE_IAP_PRODUCT_IDS || process.env.OWNMINUTES_IAP_PRODUCT_IDS);
  const productIds = declaredProductIds.length > 0;
  const serverNotificationSecret = hasEnv("APPLE_IAP_NOTIFICATION_SECRET") || hasEnv("APP_STORE_SERVER_NOTIFICATION_SECRET");
  const serverNotificationVerifier =
    hasEnv("APPLE_ROOT_CERTIFICATES") || hasEnv("APP_STORE_SERVER_NOTIFICATION_ROOT_CERTIFICATES") || hasEnv("APPLE_ROOT_CERTIFICATE_PATHS");
  const receiptVerification = hasEnv("OWNMINUTES_IAP_RECEIPT_VERIFICATION");
  const entitlementMapping = hasValidEntitlementMapping(process.env.OWNMINUTES_IAP_ENTITLEMENT_MAPPING, declaredProductIds);
  const refundHandling = hasEnv("OWNMINUTES_IAP_REFUND_HANDLING");
  const idempotency = hasEnv("OWNMINUTES_ORDER_IDEMPOTENCY");
  const notificationUrl = isHttpsUrl(process.env.OWNMINUTES_IAP_NOTIFICATION_URL);
  const appAppleId = hasEnv("APPLE_APP_APPLE_ID");
  const accountBinding = hasStrongAppSecret();
  const sandboxPurchaseProof = hasEnv("OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF");
  const sandboxRenewalProof = hasEnv("OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF");
  const sandboxRefundProof = hasEnv("OWNMINUTES_IAP_SANDBOX_REFUND_PROOF");
  const sandboxExpirationProof = hasEnv("OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF");
  const dbLedgerProof = hasEnv("OWNMINUTES_IAP_DB_LEDGER_PROOF");
  const sandboxAcceptanceMode = process.env.OWNMINUTES_IAP_SANDBOX_ACCEPTANCE === "1";
  const durableBillingRepository =
    process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" && Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const legalIdentity = hasCompletePublicLegalIdentity();
  const sandboxLifecycleEvidence = sandboxPurchaseProof && sandboxRenewalProof && sandboxRefundProof && sandboxExpirationProof;
  const appleConfigured = appleIssuerId && appleKeyId && applePrivateKey && bundleId;
  const externalBilling = hasEnv("OWNMINUTES_EXTERNAL_BILLING_PROVIDER");
  const provider = appleConfigured ? "apple-iap" : externalBilling ? "external-billing" : "simulated";
  const runtimeReady =
    provider === "apple-iap" &&
    productIds &&
    serverNotificationVerifier &&
    receiptVerification &&
    entitlementMapping &&
    refundHandling &&
    idempotency &&
    accountBinding &&
    notificationUrl &&
    durableBillingRepository &&
    legalIdentity &&
    (iapEnvironment === "sandbox" || appAppleId);
  const productionReady =
    runtimeReady &&
    iapEnvironment === "production" &&
    !sandboxAcceptanceMode &&
    sandboxLifecycleEvidence &&
    dbLedgerProof;
  const acceptingPurchases = runtimeReady && (process.env.NODE_ENV !== "production" || productionReady || sandboxAcceptanceMode);
  const missing = getMissingConfig({
    appleConfigured,
    appAppleIdRequired: iapEnvironment !== "sandbox",
    appAppleId,
    accountBinding,
    productIds,
    serverNotificationVerifier,
    receiptVerification,
    entitlementMapping,
    refundHandling,
    idempotency,
    notificationUrl,
    sandboxPurchaseProof,
    sandboxRenewalProof,
    sandboxRefundProof,
    sandboxExpirationProof,
    dbLedgerProof,
    durableBillingRepository,
    legalIdentity,
  });

  return {
    acceptingPurchases,
    generatedAt: new Date().toISOString(),
    provider,
    productionReady,
    configured: {
      appleIssuerId,
      appleKeyId,
      applePrivateKey,
      bundleId,
      iapEnvironment,
      simulatedBillingEnabled,
      productIds,
      serverNotificationSecret,
      serverNotificationVerifier,
      receiptVerification,
      entitlementMapping,
      refundHandling,
      idempotency,
      notificationUrl,
      appAppleId,
      accountBinding,
      sandboxPurchaseProof,
      sandboxRenewalProof,
      sandboxRefundProof,
      sandboxExpirationProof,
      dbLedgerProof,
      sandboxAcceptanceMode,
      durableBillingRepository,
      legalIdentity,
    },
    capabilities: {
      hasServerEndpoints: true,
      verifiesTransactions: provider === "apple-iap" && receiptVerification,
      grantsOfficialQuota: provider === "apple-iap" && entitlementMapping,
      handlesRefunds: provider === "apple-iap" && refundHandling,
      supportsServerNotifications: provider === "apple-iap" && serverNotificationVerifier && notificationUrl,
      usesSimulatedPlanSwitching: provider === "simulated" && simulatedBillingEnabled,
      hasSandboxPurchaseEvidence: sandboxPurchaseProof,
      hasSandboxLifecycleEvidence: sandboxLifecycleEvidence,
      hasLedgerEvidence: dbLedgerProof,
    },
    missing,
    checks: [
      {
        id: "apple-server-endpoints",
        title: "IAP 服务端入口",
        status: "pass",
        detail: "已提供客户端交易校验入口和 App Store Server Notifications 入口；未配置 Apple IAP 时会拒绝发放权益。",
      },
      {
        id: "purchase-opening-gate",
        title: "真实购买开放门槛",
        status: acceptingPurchases ? "pass" : "fail",
        detail: acceptingPurchases
          ? `当前运行环境允许 Apple IAP 购买，Apple 环境=${iapEnvironment}。`
          : process.env.NODE_ENV === "production"
            ? "生产运行时只有 productionReady=true 才开放真实购买。"
            : "非生产运行时仍缺少完整 Apple IAP 运行配置。",
      },
      {
        id: "apple-api-credentials",
        title: "Apple API 凭证",
        status: appleConfigured ? "pass" : "fail",
        detail: appleConfigured ? `已检测到 App Store Server API 凭证入口，当前环境=${iapEnvironment}。` : "缺少 APPLE_ISSUER_ID、APPLE_KEY_ID、APPLE_PRIVATE_KEY 或 APPLE_BUNDLE_ID。",
      },
      {
        id: "iap-products",
        title: "IAP 商品 ID",
        status: productIds ? "pass" : "fail",
        detail: productIds ? "已声明 Plus / Pro 会员商品 ID。" : "缺少 Plus、Pro 对应的 Apple IAP 商品 ID 声明。",
      },
      {
        id: "server-notifications",
        title: "服务端通知",
        status: serverNotificationVerifier && notificationUrl ? "manual" : "fail",
        detail:
          serverNotificationVerifier && notificationUrl
            ? "已声明 Apple 根证书和公网 HTTPS 通知 URL，可用官方 SignedDataVerifier 校验 signedPayload，仍需真实通知测试。"
            : serverNotificationVerifier
              ? "已声明 Apple 根证书，但缺少公网 HTTPS 通知 URL。"
              : "缺少 Apple Root Certificates 配置，不能校验 App Store Server Notifications signedPayload。",
      },
      {
        id: "production-app-apple-id",
        title: "生产 App Apple ID",
        status: iapEnvironment !== "sandbox" && !appAppleId ? "fail" : "pass",
        detail:
          iapEnvironment !== "sandbox"
            ? appAppleId
              ? `${iapEnvironment} 环境已声明 APPLE_APP_APPLE_ID。`
              : `${iapEnvironment} 环境包含 production 校验，缺少 APPLE_APP_APPLE_ID。`
            : "sandbox 环境不强制 APPLE_APP_APPLE_ID。",
      },
      {
        id: "account-binding",
        title: "Apple 交易账号绑定",
        status: accountBinding ? "pass" : "fail",
        detail: accountBinding ? "已使用应用密钥派生稳定 UUID，将 StoreKit 交易绑定到 OwnMinutes 账号。" : "缺少至少 32 位 OWNMINUTES_APP_SECRET 或 AUTH_SECRET，交易可能无法安全归属账号。",
      },
      {
        id: "durable-billing-repository",
        title: "生产账本存储",
        status: durableBillingRepository ? "pass" : "fail",
        detail: durableBillingRepository
          ? "Apple IAP 订单、权益和通知状态使用 PostgreSQL 持久化。"
          : "真实 Apple IAP 必须使用 OWNMINUTES_AUTH_REPOSITORY=postgres 和 PostgreSQL；本地文件仅允许开发 mock。",
      },
      {
        id: "legal-operator-identity",
        title: "公开运营主体",
        status: legalIdentity ? "pass" : "fail",
        detail: legalIdentity
          ? "已配置公开运营主体名称、联系地址和适用法域。"
          : "缺少真实的运营主体名称、联系地址或适用法域；生产购买保持关闭，不能用占位信息代替。",
      },
      {
        id: "receipt-verification",
        title: "票据/交易校验",
        status: receiptVerification ? "manual" : "fail",
        detail: receiptVerification ? "已声明交易校验策略，仍需沙盒和生产环境验收。" : "缺少服务端交易校验策略，不能只相信客户端套餐切换。",
      },
      {
        id: "entitlement-mapping",
        title: "权益发放映射",
        status: entitlementMapping ? "manual" : "fail",
        detail: entitlementMapping ? "已声明商品到官方额度/会员权益的映射策略。" : "缺少 IAP 商品到 Plus、Pro 和官方额度的映射策略。",
      },
      {
        id: "refund-revocation",
        title: "退款与撤销",
        status: refundHandling ? "manual" : "fail",
        detail: refundHandling ? "已声明退款、撤销和订阅过期处理策略。" : "缺少退款、撤销、订阅过期后的权益回收策略。",
      },
      {
        id: "idempotency",
        title: "订单幂等",
        status: idempotency ? "manual" : "fail",
        detail: idempotency ? "已声明订单幂等键和重复通知处理策略。" : "缺少订单幂等和重复通知处理策略。",
      },
      {
        id: "sandbox-purchase-proof",
        title: "沙盒购买证据",
        status: sandboxPurchaseProof ? "manual" : "fail",
        detail: sandboxPurchaseProof ? "已声明 Plus/Pro 沙盒购买脱敏证据。" : "缺少 OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF。",
      },
      {
        id: "sandbox-renewal-proof",
        title: "沙盒续期证据",
        status: sandboxRenewalProof ? "manual" : "fail",
        detail: sandboxRenewalProof ? "已声明 DID_RENEW 脱敏证据。" : "缺少 OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF。",
      },
      {
        id: "sandbox-refund-proof",
        title: "沙盒退款证据",
        status: sandboxRefundProof ? "manual" : "fail",
        detail: sandboxRefundProof ? "已声明 REFUND 脱敏证据。" : "缺少 OWNMINUTES_IAP_SANDBOX_REFUND_PROOF。",
      },
      {
        id: "sandbox-expiration-proof",
        title: "沙盒过期/撤销证据",
        status: sandboxExpirationProof ? "manual" : "fail",
        detail: sandboxExpirationProof ? "已声明 EXPIRED 或 REVOKE 脱敏证据。" : "缺少 OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF。",
      },
      {
        id: "db-ledger-proof",
        title: "账本落库证据",
        status: dbLedgerProof ? "manual" : "fail",
        detail: dbLedgerProof ? "已声明 billing_orders 和 entitlement_grants 脱敏账本证据。" : "缺少 OWNMINUTES_IAP_DB_LEDGER_PROOF。",
      },
      {
        id: "simulated-plan-switching",
        title: "MVP 模拟方案切换",
        status: provider === "simulated" ? "fail" : "pass",
        detail:
          provider === "simulated"
            ? simulatedBillingEnabled
              ? "当前已显式启用模拟套餐切换，仅可用于开发或验收，不应视为真实付费。"
              : "当前为模拟支付 provider，且 /api/account/plan 默认阻断模拟套餐切换。"
            : "已脱离纯模拟支付路径。",
      },
    ],
    notes: [
      "诊断只输出配置存在性，不输出 Apple private key、通知密钥、订单号或用户购买记录。",
      "productionReady=true 要求同一环境已具备 Apple IAP 配置、公网通知 URL、沙盒购买/续期/退款/过期证据和数据库账本证据；仍需人工复核脱敏证据。",
    ],
  };
}

export function isSimulatedBillingEnabled() {
  return process.env.OWNMINUTES_ENABLE_SIMULATED_BILLING === "1";
}

function parseAppleIapEnvironment(): "auto" | "production" | "sandbox" {
  if (process.env.APPLE_IAP_ENVIRONMENT === "production") return "production";
  if (process.env.APPLE_IAP_ENVIRONMENT === "auto") return "auto";
  return "sandbox";
}

function getMissingConfig(input: {
  appleConfigured: boolean;
  appAppleIdRequired: boolean;
  appAppleId: boolean;
  accountBinding: boolean;
  productIds: boolean;
  serverNotificationVerifier: boolean;
  receiptVerification: boolean;
  entitlementMapping: boolean;
  refundHandling: boolean;
  idempotency: boolean;
  notificationUrl: boolean;
  sandboxPurchaseProof: boolean;
  sandboxRenewalProof: boolean;
  sandboxRefundProof: boolean;
  sandboxExpirationProof: boolean;
  dbLedgerProof: boolean;
  durableBillingRepository: boolean;
  legalIdentity: boolean;
}) {
  const missing: string[] = [];
  if (!input.appleConfigured) missing.push("APPLE_ISSUER_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY + APPLE_BUNDLE_ID");
  if (input.appAppleIdRequired && !input.appAppleId) missing.push("APPLE_APP_APPLE_ID");
  if (!input.accountBinding) missing.push("OWNMINUTES_APP_SECRET or AUTH_SECRET (at least 32 characters)");
  if (!input.productIds) missing.push("APPLE_IAP_PRODUCT_IDS or OWNMINUTES_IAP_PRODUCT_IDS");
  if (!input.serverNotificationVerifier) missing.push("APPLE_ROOT_CERTIFICATES or APP_STORE_SERVER_NOTIFICATION_ROOT_CERTIFICATES");
  if (!input.receiptVerification) missing.push("OWNMINUTES_IAP_RECEIPT_VERIFICATION");
  if (!input.entitlementMapping) missing.push("OWNMINUTES_IAP_ENTITLEMENT_MAPPING");
  if (!input.refundHandling) missing.push("OWNMINUTES_IAP_REFUND_HANDLING");
  if (!input.idempotency) missing.push("OWNMINUTES_ORDER_IDEMPOTENCY");
  if (!input.notificationUrl) missing.push("OWNMINUTES_IAP_NOTIFICATION_URL");
  if (!input.sandboxPurchaseProof) missing.push("OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF");
  if (!input.sandboxRenewalProof) missing.push("OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF");
  if (!input.sandboxRefundProof) missing.push("OWNMINUTES_IAP_SANDBOX_REFUND_PROOF");
  if (!input.sandboxExpirationProof) missing.push("OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF");
  if (!input.dbLedgerProof) missing.push("OWNMINUTES_IAP_DB_LEDGER_PROOF");
  if (!input.durableBillingRepository) missing.push("OWNMINUTES_AUTH_REPOSITORY=postgres + DATABASE_URL/POSTGRES_URL");
  if (!input.legalIdentity) {
    missing.push("OWNMINUTES_LEGAL_OPERATOR_NAME + OWNMINUTES_LEGAL_OPERATOR_ADDRESS + OWNMINUTES_LEGAL_OPERATOR_JURISDICTION");
  }
  return missing;
}

function hasEnv(name: string) {
  return Boolean(process.env[name]);
}

function hasStrongAppSecret() {
  const secret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  return Boolean(secret && secret.length >= 32);
}

function parseDelimitedValues(value?: string) {
  return value
    ?.split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean) || [];
}

function hasValidEntitlementMapping(value: string | undefined, productIds: string[]) {
  const expected = {
    "ownminutes.plus.monthly": { amountCents: 799, currency: "USD", plan: "plus" },
    "ownminutes.pro.monthly": { amountCents: 1999, currency: "USD", plan: "pro" },
  } as const;
  const expectedProductIds = Object.keys(expected) as Array<keyof typeof expected>;
  if (
    !value?.trim() ||
    productIds.length !== expectedProductIds.length ||
    expectedProductIds.some((productId) => !productIds.includes(productId))
  ) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const mapping = parsed as Record<string, unknown>;
    return Object.keys(mapping).length === expectedProductIds.length && expectedProductIds.every((productId) => {
      const entry = mapping[productId];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      const launch = expected[productId];
      return record.plan === launch.plan && record.amountCents === launch.amountCents && record.currency === launch.currency;
    });
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
