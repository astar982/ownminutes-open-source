import crypto from "crypto";
import fs from "fs";
import { Environment, SignedDataVerifier, VerificationException } from "@apple/app-store-server-library";
import { getPaymentDiagnostics } from "@/lib/payment-diagnostics";
import type { BillingPlanId } from "@/lib/server/auth-repository";

export type AppleIapEnvironment = "production" | "sandbox";
export type AppleIapEnvironmentMode = AppleIapEnvironment | "auto";

export type AppleIapNotificationPreview = {
  appAccountToken?: string;
  autoRenewStatus?: boolean;
  bundleId?: string;
  currency?: string;
  environment?: string;
  expiresDate?: string;
  graceExpiresDate?: string;
  isInBillingRetryPeriod?: boolean;
  isUpgraded?: boolean;
  notificationType?: string;
  offerDiscountType?: string;
  offerIdentifier?: string;
  offerType?: number;
  originalPurchaseDate?: string;
  price?: number;
  subtype?: string;
  purchaseDate?: string;
  revocationDate?: string;
  signedDate?: string;
  status?: number;
  storefront?: string;
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
};

export type AppleIapTransactionCheck = {
  productId?: string;
  transactionId: string;
};

export type AppleIapServerConfig = {
  bundleId: string;
  environment: AppleIapEnvironmentMode;
  issuerId: string;
  keyId: string;
  privateKey: string;
};

export type AppleIapNotificationVerifierConfig = {
  appAppleId?: number;
  bundleId: string;
  enableOnlineChecks: boolean;
  environment: AppleIapEnvironment;
  rootCertificates: Buffer[];
};

export type AppStoreTransactionLookup = {
  environment: AppleIapEnvironment;
  idempotencyKey: string;
  rawStatus: number;
  signedTransactionInfo?: string;
  transaction?: AppleIapNotificationPreview;
};

export type AppleIapLookupOptions = {
  allowLocalMock?: boolean;
  productId?: string;
  userId?: string;
};

const LOCAL_APP_ACCOUNT_TOKEN_SECRET = "ownminutes-local-apple-account-token-v1";

export type AppleIapEntitlementMapping = {
  amountCents: number;
  currency: string;
  plan: BillingPlanId;
  productId: string;
};

export type VerifiedAppleIapNotification = {
  notificationUUID?: string;
  preview: AppleIapNotificationPreview;
  signedDate?: string;
};

export type AppleIapGuardResult =
  | {
      ok: true;
    }
  | {
      code: "apple_iap_not_configured";
      missing: string[];
      ok: false;
      status: number;
    };

export function requireAppleIapReady(options: { allowLocalMock?: boolean; requireNotifications?: boolean; requireRefundHandling?: boolean } = {}): AppleIapGuardResult {
  if (options.allowLocalMock && isAppleIapMockEnabled() && !options.requireNotifications) {
    return { ok: true };
  }

  const diagnostics = getPaymentDiagnostics();
  const notificationRuntimeReady =
    diagnostics.acceptingPurchases &&
    diagnostics.provider === "apple-iap" &&
    diagnostics.configured.receiptVerification &&
    diagnostics.configured.entitlementMapping &&
    diagnostics.configured.idempotency &&
    diagnostics.configured.serverNotificationVerifier &&
    diagnostics.configured.accountBinding &&
    diagnostics.configured.durableBillingRepository;
  const purchaseGate = options.requireNotifications
    ? notificationRuntimeReady
    : diagnostics.acceptingPurchases;
  const notificationReady = !options.requireNotifications || diagnostics.capabilities.supportsServerNotifications;
  const refundReady = !options.requireRefundHandling || diagnostics.capabilities.handlesRefunds;

  if (purchaseGate && notificationReady && refundReady) {
    return { ok: true };
  }

  return {
    ok: false,
    code: "apple_iap_not_configured",
    status: 503,
    missing: diagnostics.missing,
  };
}

export function assertAppleIapRuntimeEnvironmentAllowed(environment?: string) {
  if (process.env.NODE_ENV !== "production") return;
  const normalized = environment?.trim().toLowerCase();
  const sandboxAcceptanceMode = process.env.OWNMINUTES_IAP_SANDBOX_ACCEPTANCE === "1";
  const expected: AppleIapEnvironment = sandboxAcceptanceMode ? "sandbox" : "production";
  if (normalized !== expected) {
    throw new AppleIapInputError(
      "apple_iap_environment_not_allowed",
      sandboxAcceptanceMode
        ? "当前是隔离 Sandbox/TestFlight 验收部署，只接受 Sandbox 交易和通知。"
        : "正式部署只接受 Production 交易和通知。",
    );
  }
}

export function getAppleIapServerConfig(): AppleIapServerConfig | null {
  const issuerId = process.env.APPLE_ISSUER_ID?.trim();
  const keyId = process.env.APPLE_KEY_ID?.trim();
  const privateKey = normalizePrivateKey(process.env.APPLE_PRIVATE_KEY);
  const bundleId = process.env.APPLE_BUNDLE_ID?.trim();

  if (!issuerId || !keyId || !privateKey || !bundleId) return null;

  return {
    bundleId,
    environment: getAppleIapEnvironment(),
    issuerId,
    keyId,
    privateKey,
  };
}

export function getAppleIapNotificationVerifierConfig(environment: AppleIapEnvironment = defaultVerifierEnvironment()): AppleIapNotificationVerifierConfig | null {
  const bundleId = process.env.APPLE_BUNDLE_ID?.trim();
  const rootCertificates = getAppleRootCertificates();
  if (!bundleId || rootCertificates.length === 0) return null;

  const appAppleId = parseAppleAppAppleId(process.env.APPLE_APP_APPLE_ID);
  if (environment === "production" && !appAppleId) return null;

  return {
    appAppleId,
    bundleId,
    enableOnlineChecks: process.env.APPLE_IAP_ENABLE_ONLINE_CHECKS === "1",
    environment,
    rootCertificates,
  };
}

export async function fetchAppStoreTransactionInfo(transactionId: string, input: AppleIapLookupOptions = {}): Promise<AppStoreTransactionLookup> {
  if (input.allowLocalMock && isAppleIapMockEnabled()) {
    return createLocalMockTransactionLookup(transactionId, input);
  }

  const config = getAppleIapServerConfig();
  if (!config) {
    throw new AppleIapInputError("apple_iap_config_missing", "缺少 App Store Server API 配置。");
  }

  const environments = transactionLookupEnvironments(config.environment);
  for (const [index, environment] of environments.entries()) {
    const response = await fetchAppStoreTransactionResponse(config, environment, transactionId);
    const payload = await readJsonObject(response);
    if (!response.ok) {
      if (config.environment === "auto" && index === 0 && environment === "production" && isTransactionNotFound(payload)) {
        continue;
      }
      throw new AppleIapInputError("app_store_server_api_error", `App Store Server API 返回 HTTP ${response.status}。`);
    }

    const signedTransactionInfo = stringValue(payload.signedTransactionInfo);
    if (!signedTransactionInfo) {
      throw new AppleIapInputError("missing_signed_transaction", "App Store Server API 未返回 signedTransactionInfo，不能发放权益。");
    }

    const transaction = await verifyAppleTransactionSignedInfo(signedTransactionInfo, environment);
    assertAppleTransactionEligible(transaction, {
      appAccountToken: getAppleIapAccountTokenCandidates(input.userId || ""),
      bundleId: config.bundleId,
      environment,
      productId: input.productId,
      transactionId,
    });

    return {
      environment,
      rawStatus: response.status,
      signedTransactionInfo,
      transaction,
      idempotencyKey: makeAppleIapIdempotencyKey({
        originalTransactionId: transaction?.originalTransactionId,
        productId: transaction?.productId || input.productId,
        transactionId,
        userId: input.userId,
      }),
    };
  }

  throw new AppleIapInputError("app_store_server_api_error", "App Store Server API 在 production 与 sandbox 均未找到该交易。");
}

export function isLocalAppleIapMockRequest(request: Request, transactionId: string) {
  if (!isAppleIapMockEnabled()) return false;
  if (!/^(mock|smoke)[A-Za-z0-9._:-]{4,128}$/.test(transactionId)) return false;
  return isExactLoopbackUrl(request.url);
}

export function isLocalAppleIapNotificationMockRequest(request: Request, preview: AppleIapNotificationPreview) {
  if (!isAppleIapMockEnabled()) return false;
  if (!preview.transactionId || !/^(mock|smoke)[A-Za-z0-9._:-]{4,128}$/.test(preview.transactionId)) return false;
  return isExactLoopbackUrl(request.url);
}

export function createAppStoreServerApiToken(config: AppleIapServerConfig, now = Math.floor(Date.now() / 1000)) {
  const header = {
    alg: "ES256",
    kid: config.keyId,
    typ: "JWT",
  };
  const payload = {
    iss: config.issuerId,
    iat: now,
    exp: now + 20 * 60,
    aud: "appstoreconnect-v1",
    bid: config.bundleId,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${signature.toString("base64url")}`;
}

export function previewAppleNotificationSignedPayload(signedPayload: string): AppleIapNotificationPreview {
  const payload = decodeJwsPayload(signedPayload);
  const data = typeof payload.data === "object" && payload.data !== null ? (payload.data as Record<string, unknown>) : {};
  const signedTransactionInfo = typeof data.signedTransactionInfo === "string" ? data.signedTransactionInfo : "";
  const signedRenewalInfo = typeof data.signedRenewalInfo === "string" ? data.signedRenewalInfo : "";
  const transaction = signedTransactionInfo ? decodeJwsPayload(signedTransactionInfo) : {};
  const renewal = signedRenewalInfo ? decodeJwsPayload(signedRenewalInfo) : {};
  const renewalPreview = decodeAppleRenewalPreview(renewal);

  return {
    ...renewalPreview,
    appAccountToken: stringValue(transaction.appAccountToken) || renewalPreview.appAccountToken,
    currency: stringValue(transaction.currency) || renewalPreview.currency,
    notificationType: stringValue(payload.notificationType),
    subtype: stringValue(payload.subtype),
    environment: stringValue(data.environment),
    bundleId: stringValue(data.bundleId),
    isUpgraded: booleanValue(transaction.isUpgraded),
    offerDiscountType: stringValue(transaction.offerDiscountType),
    offerIdentifier: stringValue(transaction.offerIdentifier),
    offerType: numberValue(transaction.offerType),
    transactionId: stringValue(transaction.transactionId),
    originalTransactionId: stringValue(transaction.originalTransactionId),
    productId: stringValue(transaction.productId),
    price: numberValue(transaction.price),
    purchaseDate: appleDateValue(transaction.purchaseDate),
    originalPurchaseDate: appleDateValue(transaction.originalPurchaseDate),
    expiresDate: appleDateValue(transaction.expiresDate),
    revocationDate: appleDateValue(transaction.revocationDate),
    signedDate: appleDateValue(payload.signedDate),
    status: numberValue(data.status),
    storefront: stringValue(transaction.storefront),
  };
}

export function assertAppleTransactionEligible(
  transaction: AppleIapNotificationPreview,
  expected: { appAccountToken?: string | string[]; bundleId: string; environment: AppleIapEnvironment; productId?: string; transactionId: string },
  now = Date.now(),
) {
  if (!transaction.transactionId || transaction.transactionId !== expected.transactionId) {
    throw new AppleIapInputError("transaction_id_mismatch", "App Store 返回的 transactionId 与客户端交易不一致。");
  }
  if (!transaction.productId) {
    throw new AppleIapInputError("missing_product_id", "App Store 交易缺少 productId，不能发放权益。");
  }
  if (expected.productId && transaction.productId !== expected.productId) {
    throw new AppleIapInputError("product_id_mismatch", "App Store 返回的商品与客户端购买商品不一致。");
  }
  if (!transaction.bundleId || transaction.bundleId !== expected.bundleId) {
    throw new AppleIapInputError("bundle_id_mismatch", "App Store 返回的 bundleId 与当前应用不一致。");
  }
  const allowedAccountTokens = Array.isArray(expected.appAccountToken)
    ? expected.appAccountToken.map((value) => value.toLowerCase())
    : expected.appAccountToken
      ? [expected.appAccountToken.toLowerCase()]
      : [];
  if (allowedAccountTokens.length > 0 && !allowedAccountTokens.includes(transaction.appAccountToken?.toLowerCase() || "")) {
    throw new AppleIapInputError("app_account_token_mismatch", "该 Apple 交易不属于当前 OwnMinutes 账号。");
  }
  if (transaction.isUpgraded) {
    throw new AppleIapInputError("transaction_superseded", "该 Apple 交易已被升级交易替代，不能作为当前订阅发放权益。");
  }

  const normalizedEnvironment = transaction.environment?.trim().toLowerCase();
  if (normalizedEnvironment && normalizedEnvironment !== "localmock" && normalizedEnvironment !== expected.environment) {
    throw new AppleIapInputError("environment_mismatch", "App Store 交易环境与服务端配置不一致。");
  }
  if (transaction.revocationDate) {
    throw new AppleIapInputError("transaction_revoked", "该 Apple 交易已退款或撤销，不能发放权益。");
  }
  if (transaction.expiresDate) {
    const expiresAt = Date.parse(transaction.expiresDate);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new AppleIapInputError("subscription_expired", "该 Apple 订阅已过期，不能发放权益。");
    }
  }
}

export async function verifyAppleNotificationSignedPayload(signedPayload: string): Promise<VerifiedAppleIapNotification> {
  const environments = verificationEnvironments();
  let hasVerifierConfig = false;
  let lastVerificationError: unknown;

  for (const environment of environments) {
    const config = getAppleIapNotificationVerifierConfig(environment);
    if (!config) continue;
    hasVerifierConfig = true;

    try {
      const verifier = createSignedDataVerifier(config);
      const notification = await verifier.verifyAndDecodeNotification(signedPayload);
      const transaction = notification.data?.signedTransactionInfo
        ? await verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo)
        : undefined;
      const renewal = notification.data?.signedRenewalInfo
        ? await verifier.verifyAndDecodeRenewalInfo(notification.data.signedRenewalInfo)
        : undefined;
      const data = notification.data;
      const transactionPreview = decodeAppleTransactionPreview(transaction);
      const renewalPreview = decodeAppleRenewalPreview(renewal);

      return {
        notificationUUID: notification.notificationUUID,
        signedDate: appleDateValue(notification.signedDate),
        preview: {
          ...transactionPreview,
          ...renewalPreview,
          appAccountToken: transactionPreview.appAccountToken || renewalPreview.appAccountToken,
          currency: transactionPreview.currency || renewalPreview.currency,
          notificationType: stringValue(notification.notificationType),
          subtype: stringValue(notification.subtype),
          signedDate: appleDateValue(notification.signedDate),
          status: numberValue(data?.status),
          environment: stringValue(data?.environment) || transactionPreview.environment,
          bundleId: stringValue(data?.bundleId) || transactionPreview.bundleId,
        },
      };
    } catch (error) {
      lastVerificationError = error;
    }
  }

  if (!hasVerifierConfig) {
    throw new AppleIapInputError(
      "apple_iap_notification_verifier_missing_config",
      "缺少 Apple 通知校验配置。请配置 APPLE_BUNDLE_ID 和 APPLE_ROOT_CERTIFICATES；production/auto 环境还需要 APPLE_APP_APPLE_ID。",
    );
  }
  if (lastVerificationError instanceof VerificationException) {
    throw new AppleIapInputError("invalid_signed_payload_signature", `Apple signedPayload 校验失败，状态=${lastVerificationError.status}。`);
  }
  throw new AppleIapInputError("invalid_signed_payload_signature", "Apple signedPayload 校验失败。");
}

export function previewSignedTransactionInfo(signedTransactionInfo: string): AppleIapNotificationPreview {
  return decodeAppleTransactionPreview(decodeJwsPayload(signedTransactionInfo));
}

function createLocalMockTransactionLookup(transactionId: string, input: AppleIapLookupOptions): AppStoreTransactionLookup {
  const now = new Date();
  const requestedProductId = input.productId || (transactionId.includes("pro") ? "ownminutes.pro.monthly" : "ownminutes.plus.monthly");
  const productId = transactionId.includes("mismatch")
    ? requestedProductId === "ownminutes.plus.monthly"
      ? "ownminutes.pro.monthly"
      : "ownminutes.plus.monthly"
    : requestedProductId;
  const transaction = {
    appAccountToken: createAppleIapAccountToken(input.userId || "local-mock-user", { allowLocalMock: true }),
    bundleId: process.env.APPLE_BUNDLE_ID || "com.ownminutes.app",
    currency: "USD",
    environment: "LocalMock",
    expiresDate: new Date(now.getTime() + (transactionId.includes("expired") ? -1 : 30 * 24 * 60 * 60 * 1000)).toISOString(),
    ...(transactionId.includes("upgraded") ? { isUpgraded: true } : {}),
    originalPurchaseDate: now.toISOString(),
    originalTransactionId: `original_${transactionId}`,
    price: productId === "ownminutes.pro.monthly" ? 19_990 : 7_990,
    productId,
    purchaseDate: now.toISOString(),
    ...(transactionId.includes("revoked") ? { revocationDate: now.toISOString() } : {}),
    storefront: "CHN",
    transactionId,
  };

  assertAppleTransactionEligible(transaction, {
    appAccountToken: createAppleIapAccountToken(input.userId || "local-mock-user", { allowLocalMock: true }),
    bundleId: transaction.bundleId,
    environment: "sandbox",
    productId: input.productId,
    transactionId,
  });

  return {
    environment: "sandbox",
    idempotencyKey: makeAppleIapIdempotencyKey({
      originalTransactionId: transaction.originalTransactionId,
      productId,
      transactionId,
      userId: input.userId,
    }),
    rawStatus: 200,
    signedTransactionInfo: makeUnsignedLocalJws(transaction),
    transaction,
  };
}

export async function verifyAppleTransactionSignedInfo(
  signedTransactionInfo: string,
  expectedEnvironment?: AppleIapEnvironment,
): Promise<AppleIapNotificationPreview> {
  const environments = expectedEnvironment ? [expectedEnvironment] : verificationEnvironments();
  let hasVerifierConfig = false;
  let lastVerificationError: unknown;

  for (const environment of environments) {
    const config = getAppleIapNotificationVerifierConfig(environment);
    if (!config) continue;
    hasVerifierConfig = true;
    try {
      const verifier = createSignedDataVerifier(config);
      return decodeAppleTransactionPreview(await verifier.verifyAndDecodeTransaction(signedTransactionInfo));
    } catch (error) {
      lastVerificationError = error;
    }
  }

  if (!hasVerifierConfig) {
    throw new AppleIapInputError(
      "apple_iap_transaction_verifier_missing_config",
      "缺少 Apple 交易 JWS 校验配置。请配置 APPLE_BUNDLE_ID 和 Apple Root Certificates。",
    );
  }
  if (lastVerificationError instanceof VerificationException) {
    throw new AppleIapInputError("invalid_signed_transaction_signature", `Apple signedTransactionInfo 校验失败，状态=${lastVerificationError.status}。`);
  }
  throw new AppleIapInputError("invalid_signed_transaction_signature", "Apple signedTransactionInfo 校验失败。");
}

export function createAppleIapAccountToken(
  userId: string,
  options: { allowLocalMock?: boolean; keyVersion?: string; secret?: string } = {},
) {
  if (!userId.trim()) throw new AppleIapInputError("missing_user_id", "缺少用于 Apple 交易绑定的用户标识。");
  const secret = options.secret || getAppleIapAccountTokenSecret(options.allowLocalMock);
  const keyVersion = options.keyVersion || getAppleIapAccountTokenKeyVersion();
  const bytes = crypto.createHmac("sha256", secret).update(`apple-iap-account:${keyVersion}:${userId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getAppleIapAccountTokenKeyVersion() {
  const value = process.env.OWNMINUTES_APP_SECRET_VERSION?.trim() || "v1";
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(value)) {
    throw new AppleIapInputError("apple_iap_account_binding_invalid_version", "OWNMINUTES_APP_SECRET_VERSION 格式无效。");
  }
  return value;
}

function getAppleIapAccountTokenCandidates(userId: string) {
  const candidates = [createAppleIapAccountToken(userId, { allowLocalMock: false })];
  const raw = process.env.OWNMINUTES_PREVIOUS_APP_SECRETS_JSON?.trim();
  if (!raw) return candidates;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppleIapInputError("apple_iap_account_binding_invalid_previous_secrets", "OWNMINUTES_PREVIOUS_APP_SECRETS_JSON 必须是 keyVersion 到旧密钥的 JSON 对象。");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppleIapInputError("apple_iap_account_binding_invalid_previous_secrets", "OWNMINUTES_PREVIOUS_APP_SECRETS_JSON 格式无效。");
  }
  for (const [keyVersion, secret] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9._-]{1,32}$/.test(keyVersion) || typeof secret !== "string" || secret.length < 32) {
      throw new AppleIapInputError("apple_iap_account_binding_invalid_previous_secrets", "旧 app secret 版本或长度无效。");
    }
    candidates.push(createAppleIapAccountToken(userId, { keyVersion, secret }));
  }
  return [...new Set(candidates)];
}

function getAppleIapAccountTokenSecret(allowLocalMock?: boolean) {
  const secret = getConfiguredAppleIapAccountTokenSecret();
  if (secret) return secret;
  if (allowLocalMock && isAppleIapMockEnabled()) return LOCAL_APP_ACCOUNT_TOKEN_SECRET;
  throw new AppleIapInputError("apple_iap_account_binding_missing", "缺少 OWNMINUTES_APP_SECRET，不能安全绑定 Apple 交易账号。");
}

function getConfiguredAppleIapAccountTokenSecret() {
  const secret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  return secret && secret.length >= 32 ? secret : "";
}

function makeUnsignedLocalJws(payload: Record<string, unknown>) {
  return [base64UrlJson({ alg: "none", kid: "local-mock" }), base64UrlJson(payload), "local-mock"].join(".");
}

export function resolveAppleIapEntitlement(productId?: string): AppleIapEntitlementMapping {
  if (!productId) {
    throw new AppleIapInputError("missing_product_id", "Apple 交易缺少 productId，不能发放权益。");
  }

  const mapping = findAppleIapEntitlement(productId);
  if (!mapping) {
    throw new AppleIapInputError("unknown_product_id", `未配置 Apple 商品 ${productId} 的权益映射。`);
  }

  return mapping;
}

export function findAppleIapEntitlement(productId?: string): AppleIapEntitlementMapping | undefined {
  if (!productId) return undefined;
  const configuredMapping = process.env.OWNMINUTES_IAP_ENTITLEMENT_MAPPING;
  const customMapping = parseEntitlementMapping(configuredMapping);
  if (configuredMapping?.trim() && customMapping.size === 0) {
    throw new AppleIapInputError("invalid_entitlement_mapping", "OWNMINUTES_IAP_ENTITLEMENT_MAPPING 不是有效的商品权益 JSON，拒绝回退默认配置。");
  }
  return (configuredMapping?.trim() ? customMapping : defaultEntitlementMapping()).get(productId);
}

export function getAppleIapProductIds() {
  return getAppleIapProductCatalog().map((item) => item.productId);
}

export function getAppleIapProductCatalog() {
  const configuredMapping = process.env.OWNMINUTES_IAP_ENTITLEMENT_MAPPING;
  const customMapping = parseEntitlementMapping(configuredMapping);
  if (configuredMapping?.trim() && customMapping.size === 0) {
    throw new AppleIapInputError("invalid_entitlement_mapping", "OWNMINUTES_IAP_ENTITLEMENT_MAPPING 不是有效的商品权益 JSON，拒绝回退默认配置。");
  }
  const mapping = configuredMapping?.trim() ? customMapping : defaultEntitlementMapping();
  return Array.from(mapping.values());
}

export function validateAppleTransactionInput(input: unknown): AppleIapTransactionCheck {
  const body = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const transactionId = stringValue(body.transactionId)?.trim();
  const productId = stringValue(body.productId)?.trim();

  if (!transactionId) {
    throw new AppleIapInputError("missing_transaction_id", "缺少 Apple transactionId。");
  }

  if (!/^[A-Za-z0-9._:-]{6,128}$/.test(transactionId)) {
    throw new AppleIapInputError("invalid_transaction_id", "Apple transactionId 格式不合法。");
  }

  return { transactionId, productId };
}

export function makeAppleIapIdempotencyKey(input: { originalTransactionId?: string; productId?: string; transactionId: string; userId?: string }) {
  const source = [input.userId || "server", input.transactionId, input.productId || "unknown"].join(":");
  return `apple-iap:${crypto.createHash("sha256").update(source).digest("hex")}`;
}

export class AppleIapInputError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function decodeJwsPayload(jws: string): Record<string, unknown> {
  const parts = jws.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new AppleIapInputError("invalid_signed_payload", "signedPayload 不是有效的 JWS 格式。");
  }

  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(decoded);
    return typeof payload === "object" && payload !== null ? payload : {};
  } catch {
    throw new AppleIapInputError("invalid_signed_payload", "signedPayload 无法解析。");
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};

  try {
    const payload = JSON.parse(text);
    return typeof payload === "object" && payload !== null ? payload : {};
  } catch {
    if (!response.ok) {
      throw new AppleIapInputError("app_store_server_api_error", `App Store Server API 返回 HTTP ${response.status}。`);
    }
    throw new AppleIapInputError("app_store_server_api_invalid_json", "App Store Server API 返回了无法解析的 JSON。");
  }
}

async function fetchAppStoreTransactionResponse(config: AppleIapServerConfig, environment: AppleIapEnvironment, transactionId: string) {
  const token = createAppStoreServerApiToken(config);
  try {
    return await fetch(`${getAppStoreServerApiBaseUrl(environment)}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(getAppleIapFetchTimeoutMs()),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new AppleIapInputError("app_store_server_api_timeout", "App Store Server API 交易查询超时，当前不会发放权益。");
    }
    throw error;
  }
}

function getAppleIapEnvironment(): AppleIapEnvironmentMode {
  if (process.env.APPLE_IAP_ENVIRONMENT === "production") return "production";
  if (process.env.APPLE_IAP_ENVIRONMENT === "auto") return "auto";
  return "sandbox";
}

function defaultVerifierEnvironment(): AppleIapEnvironment {
  return getAppleIapEnvironment() === "sandbox" ? "sandbox" : "production";
}

function transactionLookupEnvironments(environment: AppleIapEnvironmentMode): AppleIapEnvironment[] {
  return environment === "auto" ? ["production", "sandbox"] : [environment];
}

function verificationEnvironments(): AppleIapEnvironment[] {
  return transactionLookupEnvironments(getAppleIapEnvironment());
}

function createSignedDataVerifier(config: AppleIapNotificationVerifierConfig) {
  return new SignedDataVerifier(
    config.rootCertificates,
    config.enableOnlineChecks,
    toAppleLibraryEnvironment(config.environment),
    config.bundleId,
    config.appAppleId,
  );
}

function toAppleLibraryEnvironment(environment: AppleIapEnvironment) {
  return environment === "production" ? Environment.PRODUCTION : Environment.SANDBOX;
}

function getAppStoreServerApiBaseUrl(environment: AppleIapEnvironment) {
  return environment === "production" ? "https://api.storekit.apple.com" : "https://api.storekit-sandbox.apple.com";
}

function getAppleIapFetchTimeoutMs() {
  const parsed = Number(process.env.APPLE_IAP_FETCH_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return 10_000;
  return Math.min(30_000, Math.max(1_000, Math.round(parsed)));
}

function isTransactionNotFound(payload: Record<string, unknown>) {
  return payload.errorCode === 4040010 || payload.errorCode === "4040010";
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isAppleIapMockEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.OWNMINUTES_ENABLE_IAP_MOCK === "1";
}

function isExactLoopbackUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function defaultEntitlementMapping() {
  return new Map<string, AppleIapEntitlementMapping>([
    ["ownminutes.plus.monthly", { productId: "ownminutes.plus.monthly", plan: "plus", amountCents: 799, currency: "USD" }],
    ["ownminutes.pro.monthly", { productId: "ownminutes.pro.monthly", plan: "pro", amountCents: 1999, currency: "USD" }],
  ]);
}

function parseEntitlementMapping(value?: string) {
  const map = new Map<string, AppleIapEntitlementMapping>();
  if (!value?.trim()) return map;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return map;

    for (const [productId, rawConfig] of Object.entries(parsed)) {
      if (typeof rawConfig !== "object" || rawConfig === null) continue;
      const config = rawConfig as Record<string, unknown>;
      const plan = config.plan === "plus" || config.plan === "pro" || config.plan === "free" ? config.plan : undefined;
      if (!plan) continue;
      map.set(productId, {
        productId,
        plan,
        amountCents: typeof config.amountCents === "number" && config.amountCents >= 0 ? Math.round(config.amountCents) : 0,
        currency: typeof config.currency === "string" && config.currency.trim() ? config.currency.trim().toUpperCase() : "CNY",
      });
    }
  } catch {
    return map;
  }

  return map;
}

function normalizePrivateKey(value?: string) {
  return value?.trim().replace(/\\n/g, "\n");
}

function getAppleRootCertificates() {
  const certificates: Buffer[] = [];
  for (const value of readCertificateValues(process.env.APPLE_ROOT_CERTIFICATES || process.env.APP_STORE_SERVER_NOTIFICATION_ROOT_CERTIFICATES)) {
    const parsed = parseCertificateBuffer(value);
    if (parsed) certificates.push(parsed);
  }

  for (const filePath of parseDelimitedValues(process.env.APPLE_ROOT_CERTIFICATE_PATHS)) {
    try {
      const raw = fs.readFileSync(filePath);
      const parsed = parseCertificateBuffer(raw);
      if (parsed) certificates.push(parsed);
    } catch {
      continue;
    }
  }

  return certificates;
}

function readCertificateValues(value?: string) {
  const normalized = value?.trim().replace(/\\n/g, "\n");
  if (!normalized) return [];

  if (normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    } catch {
      return [];
    }
  }

  if (normalized.includes("-----BEGIN CERTIFICATE-----")) {
    return normalized.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  }

  return parseDelimitedValues(normalized);
}

function parseCertificateBuffer(value: string | Buffer) {
  try {
    const certificate = new crypto.X509Certificate(value);
    return Buffer.from(certificate.raw);
  } catch {
    if (typeof value !== "string") return null;
    try {
      const certificate = new crypto.X509Certificate(Buffer.from(value.trim(), "base64"));
      return Buffer.from(certificate.raw);
    } catch {
      return null;
    }
  }
}

function parseDelimitedValues(value?: string) {
  return value
    ?.split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean) || [];
}

function parseAppleAppAppleId(value?: string) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function decodeAppleTransactionPreview(value: unknown): AppleIapNotificationPreview {
  const transaction = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    appAccountToken: stringValue(transaction.appAccountToken),
    bundleId: stringValue(transaction.bundleId),
    currency: stringValue(transaction.currency),
    environment: stringValue(transaction.environment),
    expiresDate: appleDateValue(transaction.expiresDate),
    isUpgraded: booleanValue(transaction.isUpgraded),
    offerDiscountType: stringValue(transaction.offerDiscountType),
    offerIdentifier: stringValue(transaction.offerIdentifier),
    offerType: numberValue(transaction.offerType),
    originalPurchaseDate: appleDateValue(transaction.originalPurchaseDate),
    originalTransactionId: stringValue(transaction.originalTransactionId),
    price: numberValue(transaction.price),
    productId: stringValue(transaction.productId),
    purchaseDate: appleDateValue(transaction.purchaseDate),
    revocationDate: appleDateValue(transaction.revocationDate),
    signedDate: appleDateValue(transaction.signedDate),
    storefront: stringValue(transaction.storefront),
    transactionId: stringValue(transaction.transactionId),
  };
}

function decodeAppleRenewalPreview(value: unknown): AppleIapNotificationPreview {
  const renewal = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const autoRenewStatus = numberValue(renewal.autoRenewStatus);
  return {
    appAccountToken: stringValue(renewal.appAccountToken),
    autoRenewStatus: autoRenewStatus === undefined ? undefined : autoRenewStatus === 1,
    currency: stringValue(renewal.currency),
    environment: stringValue(renewal.environment),
    graceExpiresDate: appleDateValue(renewal.gracePeriodExpiresDate),
    isInBillingRetryPeriod: booleanValue(renewal.isInBillingRetryPeriod),
    offerDiscountType: stringValue(renewal.offerDiscountType),
    offerIdentifier: stringValue(renewal.offerIdentifier),
    offerType: numberValue(renewal.offerType),
    originalTransactionId: stringValue(renewal.originalTransactionId),
    productId: stringValue(renewal.productId),
    signedDate: appleDateValue(renewal.signedDate),
  };
}

function appleDateValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}
