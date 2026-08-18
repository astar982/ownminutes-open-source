import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  assertSecretAuditOutboxPayloadSafe,
  assertSecretAuditSinkWritable,
  createSecretAuditEvent,
  deliverSecretAuditEvent,
  getSecretAuditOutboxLeaseMs,
  getSecretAuditOutboxMaxPendingAgeMs,
  getSecretAuditOutboxRetryDelayMs,
  type SecretAuditEvent,
  type SecretAuditOutboxFlushResult,
  type SecretAuditOutboxInfo,
} from "@/lib/server/secret-audit";
import { decryptProviderSecret, deleteProviderSecretReference, encryptProviderSecret } from "@/lib/server/secret-provider";
import { roleForPublicRegistration } from "@/lib/server/registration-policy";
import { isEmailVerificationRequired } from "@/lib/server/email-verification-policy";
import {
  buildMeetingUsageNote,
  calculateMeetingUsage,
  DEFAULT_MEETING_RESERVATION_LEASE_MS,
  getByokCoverage,
  meetingProviderStageKey,
  normalizeProviderStepLeaseMs,
  parseMeetingUsage,
  type ClaimMeetingProviderStepInput,
  type CompleteMeetingProviderStepInput,
  type MeetingProcessingReservation,
  type MeetingProcessingRoute,
  type UserProcessingMode,
  type MeetingProviderStep,
  type MeetingProviderStepClaimResult,
  type MeetingProviderStepTransitionResult,
  type RealtimeQuotaClaim,
  type ReconcileMeetingProviderStepInput,
  type RejectMeetingProviderStepInput,
  type ReleaseMeetingProcessingReservationInput,
  type ReleaseMeetingProviderStepInput,
  type ReserveFinalizationQuotaInput,
  type ReserveRealtimeQuotaInput,
  type StartMeetingProviderStepInput,
} from "@/lib/processing-route";

export const SESSION_COOKIE_NAME = "ownminutes_session";

const DATA_DIR = process.env.OWNMINUTES_AUTH_DATA_DIR
  ? path.resolve(process.env.OWNMINUTES_AUTH_DATA_DIR)
  : path.join(process.cwd(), ".data", "auth");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const SECRET_PATH = path.join(DATA_DIR, "local-secret");
const QUOTA_LOCK_PATH = path.join(DATA_DIR, "quota.lock");
const SECRET_AUDIT_OUTBOX_LOCK_PATH = path.join(DATA_DIR, "secret-audit-outbox.lock");
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const APPLE_EXPIRY_RECONCILIATION_REASON = "Apple subscription period expired; reconciled from signed expiry";
const FREE_TRIAL_MINUTES = 60;
const FREE_TRIAL_SOURCE = "free_trial";
const EMAIL_VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_VERIFICATION_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_VERIFICATION_MAX_FAILED_ATTEMPTS = 5;
const PASSWORD_RESET_RESEND_COOLDOWN_MS = 60 * 1000;

export type UserRole = "admin" | "user";
export type BillingPlanId = "free" | "plus" | "pro";

export type SafeUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  plan: BillingPlanId;
  createdAt: string;
  emailVerifiedAt?: string;
  officialMinutesTotal: number;
  officialMinutesUsed: number;
  processingMode: UserProcessingMode;
};

type UserRecord = SafeUser & {
  emailVerificationPending?: boolean;
  freeTrialGrantedAt?: string;
  freeTrialMinutesTotal?: number;
  freeTrialMinutesUsed?: number;
  officialMinutesBillingOrderId?: string;
  officialMinutesPeriodEndAt?: string;
  officialMinutesPeriodSource?: string;
  officialMinutesPeriodStartAt?: string;
  passwordSalt: string;
  passwordHash: string;
  deletedAt?: string;
};

type EmailVerificationTokenRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  credentialKind?: "link" | "otp";
  failedAttempts?: number;
  lockedAt?: string;
  usedAt?: string;
};

type SessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

type PasswordResetTokenRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
};

type ProviderCredentialRecord = {
  id: string;
  userId: string;
  providerId: string;
  label: string;
  fields: Record<string, string>;
  encryptedSecrets: Record<string, string>;
  secretPreviews: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

type SecretAuditOutboxRecord = {
  attemptCount: number;
  availableAt: string;
  createdAt: string;
  eventId: string;
  lastErrorCode?: string;
  leaseExpiresAt?: string;
  lockedBy?: string;
  claimToken?: string;
  payload: SecretAuditEvent;
};

type UsageEventRecord = {
  id: string;
  userId: string;
  type: "register_bonus" | "meeting_finalize" | "manual_adjustment";
  minutes: number;
  createdAt: string;
  note: string;
  processingReservationId?: string;
};

type MeetingProcessingReservationRecord = MeetingProcessingReservation & {
  userId: string;
  quotaPeriodSource?: string;
  quotaPeriodStartAt?: string;
  quotaBillingOrderId?: string;
  resultGeneratedAt?: string;
  finalizedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type MeetingProviderStepRecord = MeetingProviderStep & {
  userId: string;
  claimTokenHash: string;
  createdAt: string;
  updatedAt: string;
};

type GrowthEventRecord = {
  id: string;
  userId: string;
  type: "register";
  source: "direct" | "share";
  shareId?: string;
  createdAt: string;
};

export type EntitlementGrantSource = "admin_manual" | "apple_iap" | "manual_order";
export type EntitlementGrantStatus = "active" | "revoked" | "refunded";
export type BillingOrderProvider = "admin_manual" | "apple_iap" | "external_billing";
export type BillingOrderStatus = "paid" | "refunded" | "voided";

type EntitlementGrantRecord = {
  id: string;
  userId: string;
  billingOrderId?: string;
  grantedByUserId?: string;
  source: EntitlementGrantSource;
  status: EntitlementGrantStatus;
  statusChangedByUserId?: string;
  statusReason?: string;
  statusUpdatedAt?: string;
  previousPlan: BillingPlanId;
  plan: BillingPlanId;
  officialMinutesTotal: number;
  reason: string;
  startsAt?: string;
  expiresAt?: string;
  createdAt: string;
};

type BillingOrderRecord = {
  id: string;
  userId: string;
  createdByUserId?: string;
  provider: BillingOrderProvider;
  status: BillingOrderStatus;
  plan: BillingPlanId;
  amountCents?: number;
  priceMilliunits?: number;
  currency: string;
  environment?: string;
  productId?: string;
  storefront?: string;
  offerType?: number;
  offerIdentifier?: string;
  appAccountToken?: string;
  signedDate?: string;
  statusSignedDate?: string;
  externalTransactionId?: string;
  originalTransactionId?: string;
  idempotencyKey: string;
  periodStartAt?: string;
  periodEndAt?: string;
  entitlementGrantId?: string;
  note: string;
  statusReason?: string;
  statusUpdatedAt?: string;
  createdAt: string;
};

type AppleIapAccountBindingRecord = {
  appAccountToken: string;
  userId: string;
  keyVersion: string;
  createdAt: string;
  lastSeenAt: string;
};

type AppleSubscriptionRecord = {
  originalTransactionId: string;
  userId: string;
  currentTransactionId: string;
  productId: string;
  environment: string;
  status: "active" | "grace" | "billing_retry" | "expired" | "revoked";
  expiresAt?: string;
  graceExpiresAt?: string;
  autoRenewStatus?: boolean;
  isUpgraded?: boolean;
  lastSignedDate?: string;
  lastNotificationUUID?: string;
  createdAt: string;
  updatedAt: string;
};

type AppleNotificationEventRecord = {
  notificationUUID: string;
  environment?: string;
  notificationType: string;
  subtype?: string;
  signedDate?: string;
  transactionId?: string;
  originalTransactionId?: string;
  payloadSha256: string;
  processingStatus: "received" | "processed" | "ignored" | "failed";
  resultAction?: string;
  errorCode?: string;
  receivedAt: string;
  processedAt?: string;
};

type AuthStore = {
  users: UserRecord[];
  sessions: SessionRecord[];
  emailVerificationTokens: EmailVerificationTokenRecord[];
  passwordResetTokens: PasswordResetTokenRecord[];
  providerCredentials: ProviderCredentialRecord[];
  secretAuditOutbox: SecretAuditOutboxRecord[];
  meetingProcessingReservations: MeetingProcessingReservationRecord[];
  meetingProviderSteps: MeetingProviderStepRecord[];
  usageEvents: UsageEventRecord[];
  growthEvents: GrowthEventRecord[];
  entitlementGrants: EntitlementGrantRecord[];
  billingOrders: BillingOrderRecord[];
  appleIapAccountBindings: AppleIapAccountBindingRecord[];
  appleSubscriptions: AppleSubscriptionRecord[];
  appleNotificationEvents: AppleNotificationEventRecord[];
};

export type RegisterAttributionInput = {
  shareId?: string;
  source?: string;
};

export type AdminGrowthMetrics = {
  directRegistrations: number;
  shareAttributedActivatedUsers: number;
  shareAttributedPayingUsers: number;
  shareAttributedProviderUsers: number;
  shareAttributedRegistrations: number;
  shareConversionRates: {
    activation: number;
    paid: number;
    providerSetup: number;
  };
  totalTrackedRegistrations: number;
  topShareRegistrations: Array<{
    shareId: string;
    registrations: number;
  }>;
};

export type ProviderCredentialInput = {
  providerId: string;
  label?: string;
  fields?: Record<string, string>;
  secrets?: Record<string, string>;
  removeSecrets?: string[];
};

export type ProviderCredentialSummary = {
  id: string;
  providerId: string;
  label: string;
  configuredFields: string[];
  configuredSecrets: string[];
  secretPreviews: Record<string, string>;
  updatedAt: string;
};

export type ProviderRuntimeConfig = {
  providerId: string;
  fields: Record<string, string>;
  secrets: Record<string, string>;
};

export type AdminMetrics = {
  totalUsers: number;
  activeUsers: number;
  totalProviderCredentials: number;
  officialMinutesUsed: number;
  officialMinutesTotal: number;
};

export type AdminCommercialMetrics = {
  activeUsers: number;
  configuredProviderUsers: number;
  activatedUsers: number;
  payingUsers: number;
  byokOnlyUsers: number;
  officialOnlyUsers: number;
  hybridUsers: number;
  freeUsers: number;
  plusUsers: number;
  proUsers: number;
  officialMinutesRemaining: number;
  conversionRates: {
    providerSetup: number;
    activation: number;
    paid: number;
  };
};

export type AdminUserSummary = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  plan: BillingPlanId;
  status: "active" | "deleted";
  createdAt: string;
  emailVerifiedAt?: string;
  lastSeenAt?: string;
  providerCredentialCount: number;
  meetingFinalizeCount: number;
  officialMinutesTotal: number;
  officialMinutesUsed: number;
  officialMinutesRemaining: number;
};

export type EntitlementGrantSummary = {
  id: string;
  userId: string;
  billingOrderId?: string;
  userEmail: string;
  userName: string;
  grantedByUserId?: string;
  grantedByEmail?: string;
  grantedByName?: string;
  source: EntitlementGrantSource;
  status: EntitlementGrantStatus;
  statusChangedByUserId?: string;
  statusChangedByEmail?: string;
  statusChangedByName?: string;
  statusReason?: string;
  statusUpdatedAt?: string;
  previousPlan: BillingPlanId;
  plan: BillingPlanId;
  officialMinutesTotal: number;
  reason: string;
  createdAt: string;
};

export type BillingOrderSummary = {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  createdByUserId?: string;
  createdByEmail?: string;
  createdByName?: string;
  provider: BillingOrderProvider;
  status: BillingOrderStatus;
  plan: BillingPlanId;
  amountCents?: number;
  priceMilliunits?: string;
  currency: string;
  environment?: string;
  productId?: string;
  storefront?: string;
  offerType?: number;
  offerIdentifier?: string;
  signedDate?: string;
  statusSignedDate?: string;
  externalTransactionId?: string;
  originalTransactionId?: string;
  idempotencyKey: string;
  periodStartAt?: string;
  periodEndAt?: string;
  entitlementGrantId?: string;
  note: string;
  statusReason?: string;
  statusUpdatedAt?: string;
  createdAt: string;
};

export type AppleIapPurchaseInput = {
  amountCents?: number;
  appAccountToken?: string;
  currency: string;
  environment: string;
  externalTransactionId: string;
  idempotencyKey: string;
  originalTransactionId?: string;
  periodEndAt?: string;
  periodStartAt?: string;
  priceMilliunits?: number;
  plan: BillingPlanId;
  productId: string;
  storefront?: string;
  offerType?: number;
  offerIdentifier?: string;
  signedDate?: string;
  userId: string;
};

export type AppleIapPurchaseResult = {
  duplicate: boolean;
  order: BillingOrderSummary;
  user: SafeUser;
};

export type AppleIapNotificationAction = "billing_retry" | "expired" | "extended" | "grace" | "ignored" | "purchased" | "refunded" | "renewal_status" | "renewed" | "restored" | "revoked";

export type AppleIapNotificationInput = {
  amountCents?: number;
  appAccountToken?: string;
  autoRenewStatus?: boolean;
  currency?: string;
  environment?: string;
  expiresDate?: string;
  graceExpiresDate?: string;
  idempotencyKey?: string;
  isUpgraded?: boolean;
  notificationUUID?: string;
  notificationType?: string;
  offerIdentifier?: string;
  offerType?: number;
  originalTransactionId?: string;
  payloadSha256?: string;
  priceMilliunits?: number;
  productId?: string;
  purchaseDate?: string;
  reason: string;
  signedDate?: string;
  status?: number;
  storefront?: string;
  subtype?: string;
  transactionId?: string;
  plan?: BillingPlanId;
};

export type AppleIapNotificationResult = {
  action: AppleIapNotificationAction;
  duplicate: boolean;
  grant?: EntitlementGrantSummary;
  order?: BillingOrderSummary;
  user?: SafeUser;
};

export type UsageEventSummary = {
  id: string;
  type: UsageEventRecord["type"];
  minutes: number;
  createdAt: string;
  note: string;
  processingRoute?: MeetingProcessingRoute;
  processedMinutes?: number;
  officialMinutesCharged?: number;
};

export type UserUsageSummary = {
  plan: BillingPlanId;
  officialMinutesTotal: number;
  officialMinutesUsed: number;
  officialMinutesRemaining: number;
  events: UsageEventSummary[];
  costControl: {
    mode: "byok" | "official_quota" | "hybrid";
    selectedMode: UserProcessingMode;
    providerCredentialCount: number;
    currentPlanPrice: string;
    officialMinuteUnitPrice: string;
    recommendation: string;
  };
};

export type AdminPlanGrantInput = {
  grantedByUserId: string;
  plan: BillingPlanId;
  reason?: string;
  userId: string;
};

export type AdminEntitlementGrantStatusInput = {
  changedByUserId: string;
  grantId: string;
  reason?: string;
  status: Exclude<EntitlementGrantStatus, "active">;
};

export type ChangePasswordInput = {
  currentPassword: string;
  currentSessionToken?: string | null;
  newPassword: string;
};

export type PasswordResetRequestInput = {
  allowTokenInResponse?: boolean;
  email: string;
};

export type PasswordResetRequestResult = {
  emailSent: boolean;
  expiresAt?: string;
  resetToken?: string;
};

export type PasswordResetConfirmInput = {
  newPassword: string;
  token: string;
};

export type EmailVerificationRequestResult = {
  emailSent: boolean;
  expiresAt?: string;
  codeExpiresAt?: string;
  resendAvailableAt?: string;
  retryAfterSeconds?: number;
  verificationCode?: string;
  verificationToken?: string;
};

export type EmailVerificationCodeConfirmInput = {
  code: string;
  email: string;
};

export function registerUser(input: { attribution?: RegisterAttributionInput; email: string; name: string; password: string }) {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();

  if (!isValidEmail(email)) {
    throw new AuthError("请输入有效邮箱。", 400);
  }

  if (name.length < 2) {
    throw new AuthError("姓名或团队名至少需要 2 个字符。", 400);
  }

  if (input.password.length < 8) {
    throw new AuthError("密码至少需要 8 位。", 400);
  }

  const store = readStore();
  if (store.users.some((user) => !user.deletedAt && user.email === email)) {
    throw new AuthError("该邮箱已经注册，请直接登录。", 409);
  }

  const now = new Date().toISOString();
  const password = hashPassword(input.password);
  const activeUserCount = store.users.filter((user) => !user.deletedAt).length;
  const verificationRequired = isEmailVerificationRequired();
  const user: UserRecord = {
    id: createId("user"),
    email,
    name,
    role: roleForPublicRegistration(activeUserCount),
    plan: "free",
    processingMode: "official_quota",
    officialMinutesTotal: verificationRequired ? 0 : FREE_TRIAL_MINUTES,
    officialMinutesUsed: 0,
    freeTrialGrantedAt: verificationRequired ? undefined : now,
    freeTrialMinutesTotal: verificationRequired ? 0 : FREE_TRIAL_MINUTES,
    freeTrialMinutesUsed: 0,
    officialMinutesPeriodStartAt: verificationRequired ? undefined : now,
    officialMinutesPeriodSource: verificationRequired ? undefined : FREE_TRIAL_SOURCE,
    createdAt: now,
    emailVerifiedAt: verificationRequired ? undefined : now,
    emailVerificationPending: verificationRequired,
    passwordSalt: password.salt,
    passwordHash: password.hash,
  };

  store.users.push(user);
  if (!verificationRequired) grantLocalRegistrationBonus(store, user, now);
  store.growthEvents.push({
    id: createId("growth"),
    userId: user.id,
    type: "register",
    source: normalizeRegisterSource(input.attribution?.source),
    shareId: normalizeShareAttributionId(input.attribution?.shareId),
    createdAt: now,
  });
  writeStore(store);

  return toSafeUser(user);
}

export function loginUser(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email);
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.email === email);

  if (!user || !verifyPassword(input.password, user.passwordSalt, user.passwordHash)) {
    throw new AuthError("邮箱或密码不正确。", 401);
  }
  if (isEmailVerificationRequired() && !user.emailVerifiedAt) {
    throw new AuthError("请先完成邮箱验证。", 403, "email_verification_required");
  }

  return toSafeUser(user);
}

export function requestEmailVerification(input: { email: string }): EmailVerificationRequestResult {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { emailSent: true };

  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.email === email);
  if (!user || user.emailVerifiedAt) return { emailSent: true };

  const now = new Date();
  const latestOtp = store.emailVerificationTokens
    .filter((token) => token.userId === user.id && (token.credentialKind || "link") === "otp")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (latestOtp) {
    const resendAvailableAtMs = new Date(latestOtp.createdAt).getTime() + EMAIL_VERIFICATION_RESEND_COOLDOWN_MS;
    if (resendAvailableAtMs > now.getTime()) {
      return {
        emailSent: true,
        resendAvailableAt: new Date(resendAvailableAtMs).toISOString(),
        retryAfterSeconds: Math.max(1, Math.ceil((resendAvailableAtMs - now.getTime()) / 1000)),
      };
    }
  }

  const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_LINK_TTL_MS).toISOString();
  const codeExpiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_CODE_TTL_MS).toISOString();
  const resendAvailableAt = new Date(now.getTime() + EMAIL_VERIFICATION_RESEND_COOLDOWN_MS).toISOString();
  const verificationToken = crypto.randomBytes(32).toString("base64url");
  const verificationCode = createEmailVerificationCode();
  const linkId = createId("verify");
  const otpId = createId("verify_otp");
  store.emailVerificationTokens = store.emailVerificationTokens.filter(
    (token) => token.userId !== user.id && new Date(token.expiresAt).getTime() > now.getTime() && !token.usedAt,
  );
  store.emailVerificationTokens.push({
    id: linkId,
    userId: user.id,
    tokenHash: hashToken(verificationToken),
    createdAt: now.toISOString(),
    expiresAt,
    credentialKind: "link",
    failedAttempts: 0,
  });
  store.emailVerificationTokens.push({
    id: otpId,
    userId: user.id,
    tokenHash: hashEmailVerificationCode({ code: verificationCode, tokenId: otpId, userId: user.id }),
    createdAt: now.toISOString(),
    expiresAt: codeExpiresAt,
    credentialKind: "otp",
    failedAttempts: 0,
  });
  writeStore(store);
  return {
    emailSent: true,
    expiresAt,
    codeExpiresAt,
    resendAvailableAt,
    retryAfterSeconds: Math.ceil(EMAIL_VERIFICATION_RESEND_COOLDOWN_MS / 1000),
    verificationCode,
    verificationToken,
  };
}

export function verifyEmailWithToken(token: string) {
  if (!token || token.length < 24) throw new AuthError("邮箱验证链接无效或已过期。", 400, "invalid_email_verification_token");
  const store = readStore();
  const now = new Date();
  const record = store.emailVerificationTokens.find(
    (item) => (item.credentialKind || "link") === "link" && item.tokenHash === hashToken(token) && !item.usedAt,
  );
  if (!record || new Date(record.expiresAt).getTime() <= now.getTime()) {
    throw new AuthError("邮箱验证链接无效或已过期。", 400, "invalid_email_verification_token");
  }
  const user = store.users.find((item) => !item.deletedAt && item.id === record.userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  const verifiedAt = now.toISOString();
  const firstVerification = !user.emailVerifiedAt;
  user.emailVerifiedAt = user.emailVerifiedAt || verifiedAt;
  user.emailVerificationPending = false;
  record.usedAt = verifiedAt;
  if (firstVerification) grantLocalRegistrationBonus(store, user, verifiedAt);
  store.emailVerificationTokens = store.emailVerificationTokens.filter((item) => item.userId !== user.id || item.id === record.id);
  writeStore(store);
  return toSafeUser(user);
}

export function verifyEmailWithCode(input: EmailVerificationCodeConfirmInput) {
  const email = normalizeEmail(input.email);
  const code = input.code.trim();
  const store = readStore();
  const now = new Date();
  const user = store.users.find((item) => !item.deletedAt && item.email === email);
  if (!user || !/^\d{6}$/.test(code)) {
    consumeDummyEmailVerificationCode(code);
    throw invalidEmailVerificationCodeError();
  }
  if (user.emailVerifiedAt) throw invalidEmailVerificationCodeError();

  const record = store.emailVerificationTokens
    .filter((item) => item.userId === user.id && (item.credentialKind || "link") === "otp" && !item.usedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!record) throw invalidEmailVerificationCodeError();
  if (record.lockedAt || (record.failedAttempts || 0) >= EMAIL_VERIFICATION_MAX_FAILED_ATTEMPTS) {
    throw new AuthError("验证码尝试次数过多，请重新获取。", 400, "email_verification_code_locked");
  }
  if (new Date(record.expiresAt).getTime() <= now.getTime()) {
    throw new AuthError("验证码已过期，请重新获取。", 400, "email_verification_code_expired");
  }

  const expectedHash = hashEmailVerificationCode({ code, tokenId: record.id, userId: user.id });
  if (!safeDigestEqual(expectedHash, record.tokenHash)) {
    record.failedAttempts = (record.failedAttempts || 0) + 1;
    if (record.failedAttempts >= EMAIL_VERIFICATION_MAX_FAILED_ATTEMPTS) record.lockedAt = now.toISOString();
    writeStore(store);
    if (record.lockedAt) {
      throw new AuthError("验证码尝试次数过多，请重新获取。", 400, "email_verification_code_locked");
    }
    throw invalidEmailVerificationCodeError();
  }

  const verifiedAt = now.toISOString();
  user.emailVerifiedAt = verifiedAt;
  user.emailVerificationPending = false;
  record.usedAt = verifiedAt;
  grantLocalRegistrationBonus(store, user, verifiedAt);
  store.emailVerificationTokens = store.emailVerificationTokens.filter((item) => item.userId !== user.id || item.id === record.id);
  writeStore(store);
  return toSafeUser(user);
}

export function changePassword(userId: string, input: ChangePasswordInput) {
  if (input.newPassword.length < 8) throw new AuthError("新密码至少需要 8 位。", 400);
  if (input.currentPassword === input.newPassword) throw new AuthError("新密码不能和当前密码相同。", 400);

  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  if (!verifyPassword(input.currentPassword, user.passwordSalt, user.passwordHash)) {
    throw new AuthError("当前密码不正确。", 401);
  }

  const nextPassword = hashPassword(input.newPassword);
  user.passwordSalt = nextPassword.salt;
  user.passwordHash = nextPassword.hash;

  const currentTokenHash = input.currentSessionToken ? hashToken(input.currentSessionToken) : null;
  store.sessions = store.sessions.filter((session) => session.userId !== userId || (currentTokenHash && session.tokenHash === currentTokenHash));
  writeStore(store);

  return toSafeUser(user);
}

export function requestPasswordReset(input: PasswordResetRequestInput): PasswordResetRequestResult {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return { emailSent: true };
  }

  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.email === email);
  if (!user) {
    return { emailSent: true };
  }

  const now = new Date();
  const latestReset = store.passwordResetTokens
    .filter((token) => token.userId === user.id && !token.usedAt)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
  if (latestReset && new Date(latestReset.createdAt).getTime() + PASSWORD_RESET_RESEND_COOLDOWN_MS > now.getTime()) {
    return { emailSent: true };
  }
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const resetToken = crypto.randomBytes(32).toString("base64url");

  store.passwordResetTokens = store.passwordResetTokens.filter((token) => {
    return token.userId !== user.id && new Date(token.expiresAt).getTime() > now.getTime() && !token.usedAt;
  });
  store.passwordResetTokens.push({
    id: createId("reset"),
    userId: user.id,
    tokenHash: hashToken(resetToken),
    createdAt: now.toISOString(),
    expiresAt,
  });
  writeStore(store);

  return {
    emailSent: true,
    expiresAt,
    resetToken,
  };
}

export function resetPasswordWithToken(input: PasswordResetConfirmInput) {
  if (input.newPassword.length < 8) throw new AuthError("新密码至少需要 8 位。", 400);
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(input.token)) throw new AuthError("重置链接无效或已过期。", 400);

  const store = readStore();
  const now = new Date();
  const tokenHash = hashToken(input.token);
  const resetToken = store.passwordResetTokens.find((item) => item.tokenHash === tokenHash && !item.usedAt);
  if (!resetToken || new Date(resetToken.expiresAt).getTime() <= now.getTime()) {
    throw new AuthError("重置链接无效或已过期。", 400);
  }

  const user = store.users.find((item) => !item.deletedAt && item.id === resetToken.userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);

  const nextPassword = hashPassword(input.newPassword);
  user.passwordSalt = nextPassword.salt;
  user.passwordHash = nextPassword.hash;
  resetToken.usedAt = now.toISOString();
  store.sessions = store.sessions.filter((session) => session.userId !== user.id);
  writeStore(store);

  return toSafeUser(user);
}

export function createSession(userId: string) {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 401);

  const now = new Date();
  const token = crypto.randomBytes(32).toString("base64url");
  const session: SessionRecord = {
    id: createId("session"),
    userId,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
  };

  store.sessions = store.sessions.filter((item) => new Date(item.expiresAt).getTime() > now.getTime());
  store.sessions.push(session);
  writeStore(store);

  return { token, maxAge: SESSION_MAX_AGE_SECONDS };
}

export function getUserBySessionToken(token?: string | null) {
  if (!token) return null;

  const store = readStore();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const session = store.sessions.find((item) => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > now);
  if (!session) return null;

  const user = store.users.find((item) => !item.deletedAt && item.id === session.userId);
  if (!user) return null;

  refreshLocalUserEntitlements(store, user);
  session.lastSeenAt = new Date().toISOString();
  writeStore(store);
  return toSafeUser(user);
}

export function getUserById(userId: string) {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (user && refreshLocalUserEntitlements(store, user)) writeStore(store);
  return user ? toSafeUser(user) : null;
}

export function destroySession(token?: string | null) {
  if (!token) return;
  const store = readStore();
  const tokenHash = hashToken(token);
  store.sessions = store.sessions.filter((session) => session.tokenHash !== tokenHash);
  writeStore(store);
}

export function deleteAccount(userId: string) {
  const store = readStore();
  const now = new Date().toISOString();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  const deletedProviderCredentials = store.providerCredentials.filter((credential) => credential.userId === userId);
  if (deletedProviderCredentials.length > 0) assertSecretAuditSinkWritable();
  const secretAuditEvents = deletedProviderCredentials.map((credential) =>
    createSecretAuditEvent({
      eventType: "provider_secret_delete",
      userId,
      providerId: credential.providerId,
      secretNames: Object.keys(credential.encryptedSecrets),
      reason: "account_delete",
    }),
  );

  const deletedPassword = hashPassword(crypto.randomBytes(32).toString("base64url"));
  user.email = `deleted-${user.id}@ownminutes.local`;
  user.name = "Deleted User";
  user.deletedAt = now;
  user.passwordSalt = deletedPassword.salt;
  user.passwordHash = deletedPassword.hash;
  user.plan = "free";
  user.officialMinutesTotal = 0;
  user.officialMinutesUsed = 0;
  user.officialMinutesPeriodStartAt = undefined;
  user.officialMinutesPeriodEndAt = undefined;
  user.officialMinutesPeriodSource = "deleted";
  user.officialMinutesBillingOrderId = undefined;
  store.sessions = store.sessions.filter((session) => session.userId !== userId);
  store.emailVerificationTokens = store.emailVerificationTokens.filter((token) => token.userId !== userId);
  store.passwordResetTokens = store.passwordResetTokens.filter((token) => token.userId !== userId);
  store.growthEvents = store.growthEvents.filter((event) => event.userId !== userId);
  store.providerCredentials = store.providerCredentials.filter((credential) => credential.userId !== userId);
  for (const step of store.meetingProviderSteps) {
    if (step.userId === userId && step.status === "claimed") {
      step.status = "released";
      step.releasedAt = now;
      step.updatedAt = now;
    }
  }
  const hasStartedProviderStep = store.meetingProviderSteps.some((step) => step.userId === userId && step.status === "started");
  if (!hasStartedProviderStep) {
    store.meetingProcessingReservations = store.meetingProcessingReservations.filter((reservation) => reservation.userId !== userId);
    store.meetingProviderSteps = store.meetingProviderSteps.filter((step) => step.userId !== userId);
  }
  store.usageEvents = store.usageEvents.filter((event) => event.userId !== userId);
  // Keep the minimum Apple billing ledger and account binding after PII deletion.
  // App Store subscriptions are managed by Apple and can continue sending renewal,
  // refund, or revocation events after the OwnMinutes account is deleted.
  enqueueLocalSecretAuditEvents(store, secretAuditEvents);
  writeStore(store);
  flushLocalSecretAuditOutboxOnce();
}

export function reconcileLocalAccountDeletionProcessing(userId: string) {
  const store = readStore();
  const user = store.users.find((item) => item.id === userId);
  if (!user) return { active: false, pending: false };
  if (!user.deletedAt) return { active: true, pending: false };
  const now = new Date().toISOString();
  for (const step of store.meetingProviderSteps) {
    if (step.userId === userId && step.status === "claimed") {
      step.status = "released";
      step.releasedAt = now;
      step.updatedAt = now;
    }
  }
  // The deleted account is already fenced from publishing late provider
  // output. Keeping a `started` local step would make deletion pending forever;
  // remove the private processing ledger and let any late callback fail closed.
  store.meetingProcessingReservations = store.meetingProcessingReservations.filter((reservation) => reservation.userId !== userId);
  store.meetingProviderSteps = store.meetingProviderSteps.filter((step) => step.userId !== userId);
  writeStore(store);
  return { active: false, pending: false };
}

export function purgeMeetingProcessingLedger(userId: string, meetingId: string) {
  const store = readStore();
  const reservationIds = new Set(
    store.meetingProcessingReservations
      .filter((reservation) => reservation.userId === userId && reservation.meetingId === meetingId)
      .map((reservation) => reservation.id),
  );
  const usagePrefix = `Finalized meeting:${meetingId} `;
  for (const event of store.usageEvents) {
    if (
      event.userId === userId &&
      event.type === "meeting_finalize" &&
      (
        event.note.startsWith(usagePrefix) ||
        Boolean(event.processingReservationId && reservationIds.has(event.processingReservationId))
      )
    ) {
      event.note = "Deleted meeting usage retained without meeting identity.";
      event.processingReservationId = undefined;
    }
  }
  store.meetingProviderSteps = store.meetingProviderSteps.filter(
    (step) => !reservationIds.has(step.reservationId),
  );
  store.meetingProcessingReservations = store.meetingProcessingReservations.filter(
    (reservation) => !(reservation.userId === userId && reservation.meetingId === meetingId),
  );
  writeStore(store);
}

export function bindAppleIapAccount(userId: string, appAccountToken: string, keyVersion = "v1") {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  const existingForToken = store.appleIapAccountBindings.find((item) => item.appAccountToken === appAccountToken);
  if (existingForToken && existingForToken.userId !== userId) {
    throw new AuthError("Apple 交易账号令牌已绑定到其他账号。", 409);
  }
  const now = new Date().toISOString();
  const existing = existingForToken || store.appleIapAccountBindings.find((item) => item.userId === userId && item.keyVersion === keyVersion);
  if (existing) {
    existing.appAccountToken = appAccountToken;
    existing.lastSeenAt = now;
  } else {
    store.appleIapAccountBindings.push({ appAccountToken, userId, keyVersion, createdAt: now, lastSeenAt: now });
  }
  writeStore(store);
}

export function getUserUsage(userId: string): UserUsageSummary {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  if (refreshLocalUserEntitlements(store, user)) writeStore(store);

  return {
    plan: user.plan,
    officialMinutesTotal: user.officialMinutesTotal,
    officialMinutesUsed: user.officialMinutesUsed,
    officialMinutesRemaining: Math.max(0, user.officialMinutesTotal - user.officialMinutesUsed),
    costControl: buildCostControlSummary(store, user),
    events: store.usageEvents
      .filter((event) => event.userId === userId)
      .slice(-20)
      .reverse()
      .map(toUsageEventSummary),
  };
}

export function updateUserPlan(userId: string, plan: BillingPlanId) {
  return applyUserPlanChange(userId, plan, `Changed plan to ${plan}`);
}

export function adminGrantUserPlan(input: AdminPlanGrantInput) {
  const reason = input.reason?.trim();
  return applyUserPlanChange(
    input.userId,
    input.plan,
    `Admin ${input.grantedByUserId} granted ${input.plan}${reason ? `: ${reason}` : ""}`,
    {
      grantedByUserId: input.grantedByUserId,
      reason: reason || "Admin manual grant",
      source: "admin_manual",
    },
  );
}

export function recordAppleIapPurchase(input: AppleIapPurchaseInput): AppleIapPurchaseResult {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === input.userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);

  const existingOrder = store.billingOrders.find(
    (order) =>
      order.idempotencyKey === input.idempotencyKey ||
      (order.provider === "apple_iap" && order.externalTransactionId === input.externalTransactionId),
  );
  if (existingOrder) {
    if (existingOrder.userId !== input.userId) {
      throw new AuthError("该 Apple 交易已绑定到其他 OwnMinutes 账号。", 409);
    }
    return {
      duplicate: true,
      order: summarizeBillingOrder(existingOrder, store),
      user: toSafeUser(user),
    };
  }

  const existingSubscription = input.originalTransactionId
    ? store.appleSubscriptions.find((item) => item.originalTransactionId === input.originalTransactionId)
    : undefined;
  if (existingSubscription && existingSubscription.userId !== input.userId) {
    throw new AuthError("该 Apple 订阅已绑定到其他 OwnMinutes 账号。", 409, "apple_iap_subscription_owner_conflict");
  }
  const currentSubscriptionOrder = existingSubscription
    ? store.billingOrders.find(
        (order) => order.provider === "apple_iap" && order.externalTransactionId === existingSubscription.currentTransactionId,
      )
    : undefined;
  if (
    existingSubscription &&
    existingSubscription.currentTransactionId !== input.externalTransactionId &&
    isAppleLifecycleUpdateStale({
      currentExpiresDate: existingSubscription.expiresAt,
      currentPeriodStartDate: currentSubscriptionOrder?.periodStartAt,
      currentSignedDate: existingSubscription.lastSignedDate,
      incomingExpiresDate: input.periodEndAt,
      incomingPeriodStartDate: input.periodStartAt,
      incomingSignedDate: input.signedDate,
    })
  ) {
    if (!currentSubscriptionOrder) throw new AuthError("Apple 订阅当前账期订单缺失，拒绝应用乱序交易。", 409, "apple_iap_stale_transaction");
    return { duplicate: true, order: summarizeBillingOrder(currentSubscriptionOrder, store), user: toSafeUser(user) };
  }

  const previousPlan = getPlanOutsideAppleSubscriptionFamily(store, user.id, input.originalTransactionId, user.plan);
  const now = new Date().toISOString();
  const billingOrderId = createId("order");
  const entitlementGrantId = createId("grant");
  const officialMinutesTotal = getPlanMinutes(input.plan);
  const note = [
    `Apple IAP ${input.productId}`,
    `environment=${input.environment}`,
    input.originalTransactionId ? `originalTransactionId=${input.originalTransactionId}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  if (input.originalTransactionId) {
    supersedeAppleSubscriptionFamily(store, input.originalTransactionId, input.externalTransactionId, now);
  }

  captureLocalFreeTrialUsage(user);
  user.plan = input.plan;
  user.officialMinutesTotal = officialMinutesTotal;
  user.officialMinutesUsed = 0;
  user.officialMinutesPeriodStartAt = input.periodStartAt || now;
  user.officialMinutesPeriodEndAt = input.periodEndAt;
  user.officialMinutesPeriodSource = "apple_iap";
  user.officialMinutesBillingOrderId = billingOrderId;
  store.billingOrders.push({
    id: billingOrderId,
    userId: input.userId,
    provider: "apple_iap",
    status: "paid",
    plan: input.plan,
    amountCents: input.amountCents,
    priceMilliunits: input.priceMilliunits,
    currency: input.currency,
    environment: input.environment,
    productId: input.productId,
    storefront: input.storefront,
    offerType: input.offerType,
    offerIdentifier: input.offerIdentifier,
    appAccountToken: input.appAccountToken,
    signedDate: input.signedDate,
    statusSignedDate: input.signedDate,
    externalTransactionId: input.externalTransactionId,
    originalTransactionId: input.originalTransactionId,
    idempotencyKey: input.idempotencyKey,
    periodStartAt: input.periodStartAt,
    periodEndAt: input.periodEndAt,
    entitlementGrantId,
    note,
    createdAt: now,
  });
  if (input.originalTransactionId) {
    const nextSubscription: AppleSubscriptionRecord = {
      originalTransactionId: input.originalTransactionId,
      userId: input.userId,
      currentTransactionId: input.externalTransactionId,
      productId: input.productId,
      environment: input.environment,
      status: "active",
      expiresAt: input.periodEndAt,
      graceExpiresAt: undefined,
      lastSignedDate: input.signedDate,
      createdAt: existingSubscription?.createdAt || now,
      updatedAt: now,
    };
    if (existingSubscription) Object.assign(existingSubscription, nextSubscription);
    else store.appleSubscriptions.push(nextSubscription);
  }
  store.entitlementGrants.push({
    id: entitlementGrantId,
    userId: input.userId,
    billingOrderId,
    source: "apple_iap",
    status: "active",
    previousPlan,
    plan: input.plan,
    officialMinutesTotal,
    reason: note,
    startsAt: input.periodStartAt || now,
    expiresAt: input.periodEndAt,
    createdAt: now,
  });
  store.usageEvents.push({
    id: createId("usage"),
    userId: input.userId,
    type: "manual_adjustment",
    minutes: 0,
    createdAt: now,
    note: `Apple IAP entitlement granted: ${input.productId}`,
  });
  writeStore(store);

  const order = store.billingOrders.find((item) => item.id === billingOrderId)!;
  return {
    duplicate: false,
    order: summarizeBillingOrder(order, store),
    user: toSafeUser(user),
  };
}

export function recordAppleIapNotification(input: AppleIapNotificationInput): AppleIapNotificationResult {
  const action = getAppleIapNotificationAction(input.notificationType, input.subtype, input.status);
  const store = readStore();
  const notificationUUID = input.notificationUUID || makeLegacyAppleNotificationId(input);
  const existingEvent = store.appleNotificationEvents.find((item) => item.notificationUUID === notificationUUID);
  const payloadSha256 = input.payloadSha256 || crypto.createHash("sha256").update(input.reason).digest("hex");
  if (existingEvent && existingEvent.payloadSha256 !== payloadSha256) {
    throw new AuthError("Apple notificationUUID 对应的 payload hash 不一致。", 409, "apple_notification_payload_mismatch");
  }
  if (existingEvent && ["processed", "ignored"].includes(existingEvent.processingStatus)) return { action, duplicate: true };
  const now = new Date().toISOString();
  const event: AppleNotificationEventRecord = existingEvent || {
    notificationUUID,
    notificationType: input.notificationType || "UNKNOWN",
    payloadSha256,
    processingStatus: "received",
    receivedAt: now,
  };
  Object.assign(event, {
    environment: input.environment,
    notificationType: input.notificationType || "UNKNOWN",
    subtype: input.subtype,
    signedDate: input.signedDate,
    transactionId: input.transactionId,
    originalTransactionId: input.originalTransactionId,
    processingStatus: "received",
    errorCode: undefined,
    receivedAt: now,
  });
  const markEvent = (status: AppleNotificationEventRecord["processingStatus"]) => {
    event.processingStatus = status;
    event.resultAction = action;
    event.processedAt = new Date().toISOString();
  };
  if (!existingEvent) store.appleNotificationEvents.push(event);
  writeStore(store);
  if (action === "ignored") {
    event.processingStatus = "ignored";
    event.resultAction = action;
    event.processedAt = now;
    writeStore(store);
    return {
      action,
      duplicate: false,
    };
  }

  if (!input.transactionId) {
    event.processingStatus = "failed";
    event.errorCode = "missing_transaction_id";
    event.processedAt = now;
    writeStore(store);
    throw new AuthError("Apple notification 缺少 transactionId。", 400);
  }

  if (action === "renewed" || action === "purchased") {
    const existingOrder = store.billingOrders.find((item) => item.provider === "apple_iap" && item.externalTransactionId === input.transactionId);
    if (existingOrder) {
      const existingUser = store.users.find((item) => !item.deletedAt && item.id === existingOrder.userId);
      completeLocalAppleNotificationEvent(notificationUUID, action);
      return {
        action,
        duplicate: true,
        order: summarizeBillingOrder(existingOrder, store),
        user: existingUser ? toSafeUser(existingUser) : undefined,
      };
    }

    const previousOrder = input.originalTransactionId
      ? store.billingOrders.find((item) => item.provider === "apple_iap" && item.originalTransactionId === input.originalTransactionId)
      : undefined;
    const binding = !previousOrder && input.appAccountToken
      ? store.appleIapAccountBindings.find((item) => item.appAccountToken === input.appAccountToken?.toLowerCase())
      : undefined;
    if (!previousOrder && !binding) throw new AuthError("Apple IAP 通知无法关联 OwnMinutes 账号，等待客户端恢复购买或对账。", 404);
    const entitlementPlan = input.plan || previousOrder?.plan;
    if (!entitlementPlan || !input.productId || !input.idempotencyKey) throw new AuthError("Apple 续期通知缺少权益映射。", 400);

    const purchase = recordAppleIapPurchase({
        amountCents: input.amountCents,
        appAccountToken: input.appAccountToken,
        currency: input.currency || "XXX",
        environment: input.environment || "unknown",
        externalTransactionId: input.transactionId,
        idempotencyKey: input.idempotencyKey,
        originalTransactionId: input.originalTransactionId,
        periodStartAt: input.purchaseDate,
        periodEndAt: input.expiresDate,
        priceMilliunits: input.priceMilliunits,
        offerIdentifier: input.offerIdentifier,
        offerType: input.offerType,
        plan: entitlementPlan,
        productId: input.productId,
        storefront: input.storefront,
        signedDate: input.signedDate,
        userId: previousOrder?.userId || binding!.userId,
      });
    completeLocalAppleNotificationEvent(notificationUUID, action);
    return { action, ...purchase };
  }

  if (action === "grace" || action === "billing_retry" || action === "extended" || action === "renewal_status") {
    const subscription = input.originalTransactionId
      ? store.appleSubscriptions.find((item) => item.originalTransactionId === input.originalTransactionId)
      : store.appleSubscriptions.find((item) => item.currentTransactionId === input.transactionId);
    if (!subscription) throw new AuthError("Apple IAP 订阅状态通知找不到原始订单。", 404);
    if (input.signedDate && subscription.lastSignedDate && input.signedDate < subscription.lastSignedDate) {
      event.processingStatus = "ignored";
      event.resultAction = action;
      event.processedAt = now;
      writeStore(store);
      return { action, duplicate: true };
    }
    if (action !== "renewal_status") {
      subscription.status = action === "grace" ? "grace" : action === "billing_retry" ? "billing_retry" : "active";
    }
    subscription.expiresAt = input.expiresDate || subscription.expiresAt;
    if (input.graceExpiresDate !== undefined) subscription.graceExpiresAt = input.graceExpiresDate;
    else if (action === "billing_retry") subscription.graceExpiresAt = undefined;
    subscription.autoRenewStatus = input.autoRenewStatus ?? subscription.autoRenewStatus;
    subscription.lastSignedDate = input.signedDate || subscription.lastSignedDate;
    subscription.lastNotificationUUID = notificationUUID;
    subscription.updatedAt = now;
    const order =
      store.billingOrders.find(
        (item) => item.provider === "apple_iap" && item.externalTransactionId === subscription.currentTransactionId,
      ) ||
      store.billingOrders
        .filter((item) => item.provider === "apple_iap" && item.originalTransactionId === subscription.originalTransactionId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!order) throw new AuthError("Apple IAP 订阅状态通知找不到原始订单。", 404);
    const user = store.users.find((item) => item.id === order.userId);
    if (!user) throw new AuthError("Apple IAP 订单账号不存在。", 404);
    const grant = order.entitlementGrantId
      ? store.entitlementGrants.find((item) => item.id === order.entitlementGrantId)
      : undefined;
    if (action === "extended" && input.expiresDate) {
      order.periodEndAt = input.expiresDate;
      if (user.officialMinutesBillingOrderId === order.id) user.officialMinutesPeriodEndAt = input.expiresDate;
      if (grant) grant.statusReason = input.reason;
    }
    const recoveryUntil = action === "grace" ? input.graceExpiresDate : action === "extended" ? input.expiresDate : undefined;
    if (
      !user.deletedAt &&
      grant?.status === "revoked" &&
      grant.statusReason === APPLE_EXPIRY_RECONCILIATION_REASON &&
      recoveryUntil &&
      Date.parse(recoveryUntil) > Date.now()
    ) {
      grant.status = "active";
      grant.statusReason = `${input.reason}; restored after delayed Apple lifecycle notification`;
      grant.statusUpdatedAt = now;
      if (action === "extended" && input.expiresDate) grant.expiresAt = input.expiresDate;
      user.plan = grant.plan;
      user.officialMinutesTotal = grant.officialMinutesTotal;
      user.officialMinutesUsed = Math.min(user.officialMinutesUsed, user.officialMinutesTotal);
      user.officialMinutesPeriodStartAt = grant.startsAt || order.periodStartAt;
      user.officialMinutesPeriodEndAt = action === "grace" ? input.graceExpiresDate : input.expiresDate;
      user.officialMinutesPeriodSource = "apple_iap";
      user.officialMinutesBillingOrderId = order.id;
    }
    event.processingStatus = "processed";
    event.resultAction = action;
    event.processedAt = now;
    writeStore(store);
    return { action, duplicate: false, order: summarizeBillingOrder(order, store), user: toSafeUser(user) };
  }

  const order = store.billingOrders.find((item) => item.provider === "apple_iap" && item.externalTransactionId === input.transactionId);
  if (!order) {
    throw new AuthError("Apple IAP 订单不存在。", 404);
  }
  const grant = order.entitlementGrantId ? store.entitlementGrants.find((item) => item.id === order.entitlementGrantId) : undefined;
  if (!grant) {
    throw new AuthError("Apple IAP 权益记录不存在。", 404);
  }
  const subscription = order.originalTransactionId
    ? store.appleSubscriptions.find((item) => item.originalTransactionId === order.originalTransactionId)
    : undefined;
  const targetsCurrentSubscription = Boolean(
    subscription && subscription.currentTransactionId === order.externalTransactionId,
  );
  if (
    isAppleStatusUpdateStale(input.signedDate, order.statusSignedDate) ||
    (targetsCurrentSubscription &&
      isAppleLifecycleUpdateStale({
        currentExpiresDate: subscription?.expiresAt,
        currentSignedDate: subscription?.lastSignedDate,
        incomingExpiresDate: input.expiresDate,
        incomingSignedDate: input.signedDate,
      }))
  ) {
    event.processingStatus = "ignored";
    event.resultAction = action;
    event.processedAt = now;
    writeStore(store);
    const staleUser = store.users.find((item) => !item.deletedAt && item.id === order.userId);
    return {
      action,
      duplicate: true,
      grant: summarizeEntitlementGrant(grant, store),
      order: summarizeBillingOrder(order, store),
      user: staleUser ? toSafeUser(staleUser) : undefined,
    };
  }
  const user = store.users.find((item) => !item.deletedAt && item.id === order.userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);

  if (action === "restored") {
    if (grant.status === "active" && order.status === "paid") {
      order.statusSignedDate = input.signedDate || order.statusSignedDate;
      if (targetsCurrentSubscription && subscription) {
        subscription.status = "active";
        subscription.lastSignedDate = input.signedDate || subscription.lastSignedDate;
        subscription.lastNotificationUUID = notificationUUID;
        subscription.updatedAt = now;
      }
      markEvent("processed");
      writeStore(store);
      return {
        action,
        duplicate: true,
        grant: summarizeEntitlementGrant(grant, store),
        order: summarizeBillingOrder(order, store),
        user: toSafeUser(user),
      };
    }
    const activeFamilyGrant = order.originalTransactionId
      ? store.billingOrders
          .filter((item) => item.provider === "apple_iap" && item.originalTransactionId === order.originalTransactionId && item.id !== order.id)
          .map((item) => (item.entitlementGrantId ? store.entitlementGrants.find((candidate) => candidate.id === item.entitlementGrantId) : undefined))
          .find((candidate) => candidate?.status === "active")
      : undefined;
    if (activeFamilyGrant) {
      order.status = "paid";
      order.statusReason = input.reason;
      order.statusUpdatedAt = now;
      order.statusSignedDate = input.signedDate || order.statusSignedDate;
      if (grant.status === "refunded") grant.status = "revoked";
      grant.statusReason = `${input.reason}; historical period restored without replacing current entitlement`;
      grant.statusUpdatedAt = now;
      markEvent("processed");
      writeStore(store);
      return {
        action,
        duplicate: false,
        grant: summarizeEntitlementGrant(grant, store),
        order: summarizeBillingOrder(order, store),
        user: toSafeUser(user),
      };
    }
    const previousPlan = getPlanOutsideAppleSubscriptionFamily(store, user.id, order.originalTransactionId, user.plan);
    if (order.originalTransactionId) {
      supersedeAppleSubscriptionFamily(store, order.originalTransactionId, order.externalTransactionId || input.transactionId, now);
    }
    grant.status = "active";
    grant.previousPlan = previousPlan;
    grant.statusReason = input.reason;
    grant.statusUpdatedAt = now;
    order.status = "paid";
    order.statusReason = input.reason;
    order.statusUpdatedAt = now;
    order.statusSignedDate = input.signedDate || order.statusSignedDate;
    if (targetsCurrentSubscription && subscription) {
      subscription.status = "active";
      subscription.lastSignedDate = input.signedDate || subscription.lastSignedDate;
      subscription.lastNotificationUUID = notificationUUID;
      subscription.updatedAt = now;
    }
    user.plan = grant.plan;
    user.officialMinutesTotal = grant.officialMinutesTotal;
    user.officialMinutesUsed = Math.min(user.officialMinutesUsed, user.officialMinutesTotal);
    user.officialMinutesPeriodStartAt = grant.startsAt || order.periodStartAt;
    user.officialMinutesPeriodEndAt = grant.expiresAt || order.periodEndAt;
    user.officialMinutesPeriodSource = "apple_iap";
    user.officialMinutesBillingOrderId = order.id;
    store.usageEvents.push({
      id: createId("usage"),
      userId: user.id,
      type: "manual_adjustment",
      minutes: 0,
      createdAt: now,
      note: `Apple IAP notification ${input.notificationType}: ${input.reason}`,
    });
    markEvent("processed");
    writeStore(store);
    return {
      action,
      duplicate: false,
      grant: summarizeEntitlementGrant(grant, store),
      order: summarizeBillingOrder(order, store),
      user: toSafeUser(user),
    };
  }

  if (grant.status !== "active") {
    const expectedOrderStatus = getAppleBillingOrderStatus(action, order.status);
    if (order.status !== expectedOrderStatus) {
      const now = new Date().toISOString();
      order.status = expectedOrderStatus;
      order.statusReason = input.reason;
      order.statusUpdatedAt = now;
      order.statusSignedDate = input.signedDate || order.statusSignedDate;
      store.usageEvents.push({
        id: createId("usage"),
        userId: user.id,
        type: "manual_adjustment",
        minutes: 0,
        createdAt: now,
        note: `Apple IAP historical notification ${input.notificationType}: ${input.reason}`,
      });
      markEvent("processed");
      writeStore(store);
      return {
        action,
        duplicate: false,
        grant: summarizeEntitlementGrant(grant, store),
        order: summarizeBillingOrder(order, store),
        user: toSafeUser(user),
      };
    }
    order.statusSignedDate = input.signedDate || order.statusSignedDate;
    markEvent("processed");
    writeStore(store);
    return {
      action,
      duplicate: true,
      grant: summarizeEntitlementGrant(grant, store),
      order: summarizeBillingOrder(order, store),
      user: toSafeUser(user),
    };
  }

  const nextGrantStatus: EntitlementGrantStatus = action === "refunded" ? "refunded" : "revoked";
  const familyOrders = order.originalTransactionId
    ? store.billingOrders.filter((item) => item.provider === "apple_iap" && item.originalTransactionId === order.originalTransactionId)
    : [order];
  for (const familyOrder of familyOrders) {
    const familyGrant = familyOrder.entitlementGrantId
      ? store.entitlementGrants.find((item) => item.id === familyOrder.entitlementGrantId)
      : undefined;
    if (familyGrant?.status === "active") {
      familyGrant.status = familyOrder.id === order.id ? nextGrantStatus : "revoked";
      familyGrant.statusReason = input.reason;
      familyGrant.statusUpdatedAt = now;
    }
  }
  order.status = getAppleBillingOrderStatus(action, order.status);
  order.statusReason = input.reason;
  order.statusUpdatedAt = now;
  order.statusSignedDate = input.signedDate || order.statusSignedDate;
  if (targetsCurrentSubscription && subscription) {
    subscription.status = action === "expired" ? "expired" : "revoked";
    subscription.lastSignedDate = input.signedDate || subscription.lastSignedDate;
    subscription.lastNotificationUUID = notificationUUID;
    subscription.updatedAt = now;
  }

  const fallbackGrant = store.entitlementGrants
    .filter((item) => item.userId === user.id && item.status === "active")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  user.plan = fallbackGrant?.plan || "free";
  if (user.plan === "free") {
    restoreLocalFreeTrial(user);
  } else {
    user.officialMinutesTotal = getPlanMinutes(user.plan);
    user.officialMinutesUsed = Math.min(user.officialMinutesUsed, user.officialMinutesTotal);
  }

  store.usageEvents.push({
    id: createId("usage"),
    userId: user.id,
    type: "manual_adjustment",
    minutes: 0,
    createdAt: now,
    note: `Apple IAP notification ${input.notificationType}: ${input.reason}`,
  });
  markEvent("processed");
  writeStore(store);

  return {
    action,
    duplicate: false,
    grant: summarizeEntitlementGrant(grant, store),
    order: summarizeBillingOrder(order, store),
    user: toSafeUser(user),
  };
}

export function updateAdminEntitlementGrantStatus(input: AdminEntitlementGrantStatusInput) {
  const store = readStore();
  const grant = store.entitlementGrants.find((item) => item.id === input.grantId);
  if (!grant) throw new AuthError("权益记录不存在。", 404);
  if (grant.status !== "active") throw new AuthError("只能处理 active 状态的权益记录。", 409);

  const user = store.users.find((item) => !item.deletedAt && item.id === grant.userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  if (user.plan !== grant.plan) {
    throw new AuthError("用户当前方案已变化，不能自动回退该权益。", 409);
  }

  const reason = input.reason?.trim() || `${input.status} entitlement grant`;
  const now = new Date().toISOString();
  grant.status = input.status;
  grant.statusChangedByUserId = input.changedByUserId;
  grant.statusReason = reason;
  grant.statusUpdatedAt = now;
  const order = grant.billingOrderId ? store.billingOrders.find((item) => item.id === grant.billingOrderId) : undefined;
  if (order) {
    order.status = input.status === "refunded" ? "refunded" : "voided";
    order.statusReason = reason;
    order.statusUpdatedAt = now;
  }
  if (grant.previousPlan === "free") {
    restoreLocalFreeTrial(user);
  } else {
    user.plan = grant.previousPlan;
    user.officialMinutesTotal = getPlanMinutes(grant.previousPlan);
    user.officialMinutesUsed = Math.min(user.officialMinutesUsed, user.officialMinutesTotal);
  }
  store.usageEvents.push({
    id: createId("usage"),
    userId: user.id,
    type: "manual_adjustment",
    minutes: 0,
    createdAt: now,
    note: `Admin ${input.changedByUserId} marked grant ${grant.id} ${input.status}: ${reason}`,
  });
  writeStore(store);

  return summarizeEntitlementGrant(grant, store);
}

function applyUserPlanChange(
  userId: string,
  plan: BillingPlanId,
  note: string,
  grant?: {
    grantedByUserId?: string;
    reason: string;
    source: EntitlementGrantSource;
  },
) {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);

  const previousPlan = user.plan;
  const now = new Date().toISOString();
  const billingOrderId = grant ? createId("order") : undefined;
  const entitlementGrantId = grant ? createId("grant") : undefined;
  captureLocalFreeTrialUsage(user);
  if (plan === "free") {
    restoreLocalFreeTrial(user);
  } else {
    user.plan = plan;
    user.officialMinutesTotal = getPlanMinutes(plan);
    user.officialMinutesUsed = Math.min(user.officialMinutesUsed, user.officialMinutesTotal);
  }
  store.usageEvents.push({
    id: createId("usage"),
    userId,
    type: "manual_adjustment",
    minutes: 0,
    createdAt: now,
    note,
  });
  if (grant) {
    store.billingOrders.push({
      id: billingOrderId!,
      userId,
      createdByUserId: grant.grantedByUserId,
      provider: grant.source === "admin_manual" ? "admin_manual" : "external_billing",
      status: "paid",
      plan,
      amountCents: 0,
      currency: "CNY",
      idempotencyKey: `${grant.source}:${userId}:${now}`,
      entitlementGrantId,
      note: grant.reason,
      createdAt: now,
    });
    store.entitlementGrants.push({
      id: entitlementGrantId!,
      userId,
      billingOrderId,
      grantedByUserId: grant.grantedByUserId,
      source: grant.source,
      status: "active",
      previousPlan,
      plan,
      officialMinutesTotal: user.officialMinutesTotal,
      reason: grant.reason,
      createdAt: now,
    });
  }
  writeStore(store);

  return toSafeUser(user);
}

function getPlanMinutes(plan: BillingPlanId) {
  if (plan === "pro") return 1800;
  if (plan === "plus") return 600;
  return 60;
}

function getPlanOutsideAppleSubscriptionFamily(store: AuthStore, userId: string, originalTransactionId: string | undefined, fallback: BillingPlanId) {
  if (!originalTransactionId) return fallback;
  const familyGrantIds = new Set(
    store.billingOrders
      .filter((order) => order.provider === "apple_iap" && order.originalTransactionId === originalTransactionId)
      .map((order) => order.entitlementGrantId)
      .filter((id): id is string => Boolean(id)),
  );
  return (
    store.entitlementGrants
      .filter((grant) => grant.userId === userId && grant.status === "active" && !familyGrantIds.has(grant.id))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.plan || "free"
  );
}

function supersedeAppleSubscriptionFamily(store: AuthStore, originalTransactionId: string, nextTransactionId: string, now: string) {
  for (const order of store.billingOrders) {
    if (order.provider !== "apple_iap" || order.originalTransactionId !== originalTransactionId || order.externalTransactionId === nextTransactionId) continue;
    const grant = order.entitlementGrantId ? store.entitlementGrants.find((item) => item.id === order.entitlementGrantId) : undefined;
    if (grant?.status === "active") {
      grant.status = "revoked";
      grant.statusReason = `Superseded by Apple renewal ${nextTransactionId}`;
      grant.statusUpdatedAt = now;
    }
  }
}

function isAppleLifecycleUpdateStale(input: {
  currentExpiresDate?: string;
  currentPeriodStartDate?: string;
  currentSignedDate?: string;
  incomingExpiresDate?: string;
  incomingPeriodStartDate?: string;
  incomingSignedDate?: string;
}) {
  const currentPeriodStartAt = parseAppleLifecycleDate(input.currentPeriodStartDate);
  const incomingPeriodStartAt = parseAppleLifecycleDate(input.incomingPeriodStartDate);
  if (currentPeriodStartAt !== undefined && incomingPeriodStartAt !== undefined && currentPeriodStartAt !== incomingPeriodStartAt) {
    return incomingPeriodStartAt < currentPeriodStartAt;
  }
  const currentExpiresAt = parseAppleLifecycleDate(input.currentExpiresDate);
  const incomingExpiresAt = parseAppleLifecycleDate(input.incomingExpiresDate);
  if (currentExpiresAt !== undefined && incomingExpiresAt !== undefined && currentExpiresAt !== incomingExpiresAt) {
    return incomingExpiresAt < currentExpiresAt;
  }
  const currentSignedAt = parseAppleLifecycleDate(input.currentSignedDate);
  const incomingSignedAt = parseAppleLifecycleDate(input.incomingSignedDate);
  return currentSignedAt !== undefined && incomingSignedAt !== undefined && incomingSignedAt < currentSignedAt;
}

function isAppleStatusUpdateStale(incomingSignedDate?: string, currentSignedDate?: string) {
  const incoming = parseAppleLifecycleDate(incomingSignedDate);
  const current = parseAppleLifecycleDate(currentSignedDate);
  return incoming !== undefined && current !== undefined && incoming < current;
}

function parseAppleLifecycleDate(value?: string) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getAppleIapNotificationAction(notificationType?: string, subtype?: string, status?: number): AppleIapNotificationAction {
  if (notificationType === "SUBSCRIBED") return "purchased";
  if (notificationType === "OFFER_REDEEMED") return subtype === "DOWNGRADE" ? "renewal_status" : "purchased";
  if (notificationType === "DID_RENEW" || notificationType === "DID_RECOVER") return "renewed";
  if (notificationType === "DID_FAIL_TO_RENEW") return subtype === "GRACE_PERIOD" ? "grace" : "billing_retry";
  if (notificationType === "RENEWAL_EXTENDED") return "extended";
  if (notificationType === "DID_CHANGE_RENEWAL_PREF" && subtype === "UPGRADE") return "purchased";
  if (notificationType === "DID_CHANGE_RENEWAL_STATUS" || notificationType === "DID_CHANGE_RENEWAL_PREF" || notificationType === "PRICE_INCREASE") return "renewal_status";
  if (notificationType === "REFUND") return "refunded";
  if (notificationType === "REFUND_REVERSED") return "restored";
  if (notificationType === "EXPIRED" || notificationType === "GRACE_PERIOD_EXPIRED") return "expired";
  if (notificationType === "REVOKE") return "revoked";
  if (status === 4) return "grace";
  if (status === 3) return "billing_retry";
  if (status === 5) return "revoked";
  if (status === 2) return "expired";
  return "ignored";
}

function getAppleBillingOrderStatus(action: AppleIapNotificationAction, current: BillingOrderStatus): BillingOrderStatus {
  if (action === "refunded") return "refunded";
  if (action === "restored") return "paid";
  return current;
}

function makeLegacyAppleNotificationId(input: AppleIapNotificationInput) {
  const source = [input.notificationType || "UNKNOWN", input.subtype || "", input.transactionId || "", input.signedDate || input.reason].join(":");
  return `legacy_${crypto.createHash("sha256").update(source).digest("hex")}`;
}

function completeLocalAppleNotificationEvent(notificationUUID: string, action: AppleIapNotificationAction) {
  const store = readStore();
  const event = store.appleNotificationEvents.find((item) => item.notificationUUID === notificationUUID);
  if (!event) return;
  event.processingStatus = action === "ignored" ? "ignored" : "processed";
  event.resultAction = action;
  event.errorCode = undefined;
  event.processedAt = new Date().toISOString();
  writeStore(store);
}

function refreshLocalUserEntitlements(store: AuthStore, user: UserRecord) {
  const now = Date.now();
  let changed = false;
  for (const grant of store.entitlementGrants) {
    if (grant.userId !== user.id || grant.source !== "apple_iap" || grant.status !== "active") continue;
    const order = grant.billingOrderId ? store.billingOrders.find((item) => item.id === grant.billingOrderId) : undefined;
    const expiresAt = grant.expiresAt || order?.periodEndAt;
    if (!expiresAt || new Date(expiresAt).getTime() > now) continue;
    const subscription = order?.originalTransactionId
      ? store.appleSubscriptions.find((item) => item.originalTransactionId === order.originalTransactionId)
      : undefined;
    const graceActive = subscription?.status === "grace" && subscription.graceExpiresAt && new Date(subscription.graceExpiresAt).getTime() > now;
    if (graceActive) continue;
    grant.status = "revoked";
    grant.statusReason = APPLE_EXPIRY_RECONCILIATION_REASON;
    grant.statusUpdatedAt = new Date(now).toISOString();
    if (subscription && subscription.status !== "revoked") subscription.status = "expired";
    changed = true;
  }

  const activeGrant = store.entitlementGrants
    .filter((item) => item.userId === user.id && item.status === "active")
    .filter((item) => {
      if (item.source !== "apple_iap") return true;
      const order = item.billingOrderId ? store.billingOrders.find((candidate) => candidate.id === item.billingOrderId) : undefined;
      if (!order?.periodEndAt || new Date(order.periodEndAt).getTime() > now) return true;
      const subscription = order.originalTransactionId
        ? store.appleSubscriptions.find((candidate) => candidate.originalTransactionId === order.originalTransactionId)
        : undefined;
      return Boolean(subscription?.status === "grace" && subscription.graceExpiresAt && new Date(subscription.graceExpiresAt).getTime() > now);
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  if (activeGrant) {
    if (user.plan !== activeGrant.plan || user.officialMinutesBillingOrderId !== activeGrant.billingOrderId) {
      captureLocalFreeTrialUsage(user);
      user.plan = activeGrant.plan;
      user.officialMinutesTotal = activeGrant.officialMinutesTotal;
      user.officialMinutesUsed = Math.min(user.officialMinutesUsed, user.officialMinutesTotal);
      user.officialMinutesPeriodStartAt = activeGrant.startsAt || user.officialMinutesPeriodStartAt;
      user.officialMinutesPeriodEndAt = activeGrant.expiresAt;
      user.officialMinutesPeriodSource = activeGrant.source;
      user.officialMinutesBillingOrderId = activeGrant.billingOrderId;
      changed = true;
    }
    return changed;
  }

  if (restoreLocalFreeTrial(user)) changed = true;
  return changed;
}

function captureLocalFreeTrialUsage(user: UserRecord) {
  normalizeLocalFreeTrialFields(user);
  if (user.plan !== "free") return false;
  const nextUsed = Math.min(user.freeTrialMinutesTotal!, Math.max(0, user.officialMinutesUsed));
  if (user.freeTrialMinutesUsed === nextUsed) return false;
  user.freeTrialMinutesUsed = nextUsed;
  return true;
}

function restoreLocalFreeTrial(user: UserRecord) {
  normalizeLocalFreeTrialFields(user);
  const nextTotal = user.freeTrialMinutesTotal!;
  const nextUsed = user.freeTrialMinutesUsed!;
  const nextStartAt = user.freeTrialGrantedAt || user.createdAt;
  const changed =
    user.plan !== "free" ||
    user.officialMinutesTotal !== nextTotal ||
    user.officialMinutesUsed !== nextUsed ||
    user.officialMinutesPeriodStartAt !== nextStartAt ||
    user.officialMinutesPeriodEndAt !== undefined ||
    user.officialMinutesPeriodSource !== FREE_TRIAL_SOURCE ||
    user.officialMinutesBillingOrderId !== undefined;
  user.plan = "free";
  user.officialMinutesTotal = nextTotal;
  user.officialMinutesUsed = nextUsed;
  user.officialMinutesPeriodStartAt = nextStartAt;
  user.officialMinutesPeriodEndAt = undefined;
  user.officialMinutesPeriodSource = FREE_TRIAL_SOURCE;
  user.officialMinutesBillingOrderId = undefined;
  return changed;
}

function normalizeLocalFreeTrialFields(user: UserRecord) {
  const existingTotal = Number(user.freeTrialMinutesTotal);
  const total = Number.isFinite(existingTotal) && existingTotal >= 0 ? Math.min(FREE_TRIAL_MINUTES, Math.floor(existingTotal)) : FREE_TRIAL_MINUTES;
  let used = Number(user.freeTrialMinutesUsed);
  if (!Number.isFinite(used) || used < 0) {
    if (user.plan === "free") {
      const remaining = Math.max(0, Number(user.officialMinutesTotal || 0) - Number(user.officialMinutesUsed || 0));
      used = total - Math.min(total, remaining);
    } else {
      // Legacy paid accounts do not retain enough history to separate past
      // Free usage from paid usage. Exhausting the legacy trial avoids issuing
      // a second registration grant when the subscription later ends.
      used = total;
    }
  }
  user.freeTrialMinutesTotal = total;
  user.freeTrialMinutesUsed = Math.min(total, Math.max(0, Math.floor(used)));
  user.freeTrialGrantedAt = user.freeTrialGrantedAt || user.createdAt;
  return user;
}

function buildCostControlSummary(store: AuthStore, user: UserRecord): UserUsageSummary["costControl"] {
  const credentials = store.providerCredentials.filter((credential) => credential.userId === user.id);
  const providerCredentialCount = credentials.length;
  const coverage = getByokCoverage(credentials.map((credential) => ({
    providerId: credential.providerId,
    configuredFields: Object.keys(credential.fields),
    configuredSecrets: Object.keys(credential.encryptedSecrets),
  })));
  const mode = user.processingMode;

  return {
    mode,
    selectedMode: user.processingMode,
    providerCredentialCount,
    currentPlanPrice: getPlanPrice(user.plan),
    officialMinuteUnitPrice: getOfficialMinuteUnitPrice(user.plan),
    recommendation: getCostRecommendation(mode, user, coverage.complete),
  };
}

function toUsageEventSummary(event: UsageEventRecord): UsageEventSummary {
  return {
    id: event.id,
    type: event.type,
    minutes: event.minutes,
    createdAt: event.createdAt,
    note: event.note,
    ...(event.type === "meeting_finalize" ? parseMeetingUsage(event) : {}),
  };
}

function getPlanPrice(plan: BillingPlanId) {
  if (plan === "pro") return "US$19.99/月";
  if (plan === "plus") return "US$7.99/月";
  return "免费";
}

function getOfficialMinuteUnitPrice(plan: BillingPlanId) {
  if (plan === "pro") return "约 US$0.011 / 分钟官方额度";
  if (plan === "plus") return "约 US$0.013 / 分钟官方额度";
  return "一次性免费体验额度";
}

function getCostRecommendation(mode: UserUsageSummary["costControl"]["mode"], user: UserRecord, byokReady: boolean) {
  if (mode === "byok") {
    return byokReady
      ? "当前明确使用自己的模型，新会议不扣官方分钟。"
      : "当前选择自己的模型，但配置已不完整；修复前不会自动改扣官方额度。";
  }
  if (Math.max(0, user.officialMinutesTotal - user.officialMinutesUsed) < 10) {
    return user.plan === "free"
      ? "一次性官方体验额度即将用完，建议配置 BYOK 或订阅 Plus。"
      : "本订阅周期的官方额度即将用完，可配置 BYOK 继续处理会议。";
  }
  return user.plan === "free"
    ? "当前使用一次性官方体验额度；如想长期免费使用，可以配置自己的模型 Key。"
    : "当前使用订阅内官方额度；BYOK 仍可随时使用。";
}

export async function saveProviderCredential(userId: string, input: ProviderCredentialInput) {
  const providerId = input.providerId.trim();
  if (!providerId) throw new AuthError("请选择 Provider。", 400);

  const initialStore = readStore();
  if (!initialStore.users.some((user) => !user.deletedAt && user.id === userId)) {
    throw new AuthError("账号不存在或已删除。", 401);
  }

  const fields = sanitizeRecord(input.fields ?? {});
  const secrets = sanitizeRecord(input.secrets ?? {});
  const removeSecretNames = sanitizeNameList(input.removeSecrets ?? []).filter((name) => !(name in secrets));
  if (Object.keys(secrets).length > 0 || removeSecretNames.length > 0) {
    assertSecretAuditSinkWritable();
  }
  const encryptedEntries = await Promise.all(
    Object.entries(secrets).map(async ([key, value]) => ({ encrypted: await encryptSecret(value, { userId, providerId }, key), key, value })),
  );

  const store = readStore();
  if (!store.users.some((user) => !user.deletedAt && user.id === userId)) {
    throw new AuthError("账号不存在或已删除。", 401);
  }

  const now = new Date().toISOString();
  let credential = store.providerCredentials.find((item) => item.userId === userId && item.providerId === providerId);
  if (!credential) {
    credential = {
      id: createId("provider"),
      userId,
      providerId,
      label: input.label?.trim() || providerId,
      fields: {},
      encryptedSecrets: {},
      secretPreviews: {},
      createdAt: now,
      updatedAt: now,
    };
    store.providerCredentials.push(credential);
  }

  credential.label = input.label?.trim() || credential.label;
  credential.fields = { ...credential.fields, ...fields };
  const removedSecretNames: string[] = [];
  for (const name of removeSecretNames) {
    if (!Object.prototype.hasOwnProperty.call(credential.encryptedSecrets, name)) continue;
    delete credential.encryptedSecrets[name];
    delete credential.secretPreviews[name];
    removedSecretNames.push(name);
  }
  const savedSecretNames: string[] = [];
  const rotatedSecretNames: string[] = [];
  for (const { encrypted, key, value } of encryptedEntries) {
    if (Object.prototype.hasOwnProperty.call(credential.encryptedSecrets, key)) {
      rotatedSecretNames.push(key);
    } else {
      savedSecretNames.push(key);
    }
    credential.encryptedSecrets[key] = encrypted;
    credential.secretPreviews[key] = previewSecret(value);
  }
  credential.updatedAt = now;
  const secretAuditEvents = [
    ...(savedSecretNames.length > 0
      ? [
          createSecretAuditEvent({
            eventType: "provider_secret_save" as const,
            userId,
            providerId,
            secretNames: savedSecretNames,
            reason: "provider_save",
          }),
        ]
      : []),
    ...(rotatedSecretNames.length > 0
      ? [
          createSecretAuditEvent({
            eventType: "provider_secret_rotate" as const,
            userId,
            providerId,
            secretNames: rotatedSecretNames,
            reason: "provider_update",
          }),
        ]
      : []),
    ...(removedSecretNames.length > 0
      ? [
          createSecretAuditEvent({
            eventType: "provider_secret_delete" as const,
            userId,
            providerId,
            secretNames: removedSecretNames,
            reason: "provider_auth_switch",
          }),
        ]
      : []),
  ];
  enqueueLocalSecretAuditEvents(store, secretAuditEvents);
  writeStore(store);
  flushLocalSecretAuditOutboxOnce();

  return summarizeCredential(credential);
}

export function listProviderCredentials(userId: string) {
  const store = readStore();
  return store.providerCredentials
    .filter((credential) => credential.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(summarizeCredential);
}

export async function deleteProviderCredential(userId: string, providerId: string) {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) throw new AuthError("请选择 Provider。", 400);

  const store = readStore();
  const credential = store.providerCredentials.find((item) => item.userId === userId && item.providerId === normalizedProviderId);
  if (!credential) throw new AuthError("Provider 配置不存在。", 404);
  assertSecretAuditSinkWritable();

  store.providerCredentials = store.providerCredentials.filter((item) => !(item.userId === userId && item.providerId === normalizedProviderId));
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (user?.processingMode === "byok" && !getLocalByokCoverage(store, userId).complete) {
    user.processingMode = "official_quota";
  }
  enqueueLocalSecretAuditEvents(store, [
    createSecretAuditEvent({
      eventType: "provider_secret_delete",
      userId,
      providerId: credential.providerId,
      secretNames: Object.keys(credential.encryptedSecrets),
      reason: "provider_delete",
    }),
  ]);
  writeStore(store);
  flushLocalSecretAuditOutboxOnce();
  await deleteProviderSecretReference({ localSecretPath: SECRET_PATH, providerId: credential.providerId, userId });
}

export async function getProviderRuntimeConfig(userId: string, providerId: string): Promise<ProviderRuntimeConfig | null> {
  const store = readStore();
  const credential = store.providerCredentials.find((item) => item.userId === userId && item.providerId === providerId);
  if (!credential) return null;

  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(credential.encryptedSecrets)) {
    try {
      secrets[key] = await decryptSecret(value, credential, key);
    } catch (error) {
      enqueueLocalSecretAuditEvents(store, [
        createSecretAuditEvent({
          eventType: "provider_secret_decrypt_failed",
          userId,
          providerId,
          secretNames: [key],
          reason: "provider_runtime_decrypt",
        }),
      ]);
      writeStore(store);
      flushLocalSecretAuditOutboxOnce();
      throw error;
    }
  }

  return {
    providerId: credential.providerId,
    fields: credential.fields,
    secrets,
  };
}

export function getUserProcessingMode(userId: string): UserProcessingMode {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  return user.processingMode;
}

export function updateUserProcessingMode(userId: string, processingMode: UserProcessingMode): SafeUser {
  const store = readStore();
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  if (processingMode === "byok" && !getLocalByokCoverage(store, userId).complete) {
    throw new AuthError("请先完整配置语音识别和纪要总结，再选择自己的模型。", 409, "byok_configuration_incomplete");
  }
  user.processingMode = processingMode;
  writeStore(store);
  return toSafeUser(user);
}

export function reserveMeetingRealtimeQuota(userId: string, input: ReserveRealtimeQuotaInput): RealtimeQuotaClaim {
  return withLocalQuotaMutation((store) => {
    const user = findLocalQuotaUser(store, userId);
    const now = new Date();
    const current = store.meetingProcessingReservations.find(
      (reservation) => reservation.userId === userId && reservation.operationKey === input.operationKey,
    );
    assertLocalReservationMeeting(current, input.meetingId);
    assertLocalReservationProcessingMode(current, input.processingRoute);
    if (current?.status === "finalized") {
      throw new AuthError("会议已经完成处理，不能继续调用实时识别。", 409, "meeting_processing_finalized");
    }

    const highestSequence = current?.realtimeHighestSequence ?? 0;
    const expectedSequence = current ? highestSequence + 1 : input.sequence;
    const duplicate = Boolean(current && input.sequence <= highestSequence);
    if (!duplicate && input.sequence !== expectedSequence) {
      throw new AuthError(`实时分片顺序错误，当前需要第 ${expectedSequence} 片。`, 409, "realtime_sequence_out_of_order");
    }

    const realtimeDurationMs = duplicate
      ? Math.max(0, current?.realtimeDurationMs ?? 0)
      : Math.max(0, current?.realtimeDurationMs ?? 0) + Math.max(1, Math.round(input.durationMs));
    const processingRoute = current?.processingRoute ?? input.processingRoute;
    const requiredMinutes = processingRoute === "byok" ? 0 : Math.max(1, Math.ceil(realtimeDurationMs / 60_000));
    const reservation = current ?? createLocalProcessingReservation(user, input, now);
    if (!current) reservation.processingRoute = input.processingRoute;
    reservation.officialMinutesReserved = reserveLocalOfficialCapacity(store, user, reservation, requiredMinutes, now);
    reservation.realtimeDurationMs = realtimeDurationMs;
    if (!duplicate) reservation.realtimeHighestSequence = input.sequence;
    reactivateLocalReservation(reservation, now);
    if (!current) store.meetingProcessingReservations.push(reservation);
    return {
      ...toMeetingProcessingReservation(reservation),
      duplicate,
      expectedSequence: duplicate ? expectedSequence : input.sequence + 1,
    };
  });
}

export function reserveMeetingFinalizationQuota(userId: string, input: ReserveFinalizationQuotaInput): MeetingProcessingReservation {
  return withLocalQuotaMutation((store) => {
    const user = findLocalQuotaUser(store, userId);
    const now = new Date();
    const current = store.meetingProcessingReservations.find(
      (reservation) => reservation.userId === userId && reservation.operationKey === input.operationKey,
    );
    assertLocalReservationMeeting(current, input.meetingId);
    assertLocalReservationProcessingMode(current, input.processingRoute);
    if (current?.status === "finalized") return toMeetingProcessingReservation(current);

    const processingRoute = current?.processingRoute ?? input.processingRoute;
    const usage = calculateMeetingUsage({ durationMs: input.durationMs, route: processingRoute });
    const reservation = current ?? createLocalProcessingReservation(user, input, now);
    if (!current) reservation.processingRoute = input.processingRoute;
    reservation.processedMinutes = usage.processedMinutes;
    reservation.officialMinutesReserved = reserveLocalOfficialCapacity(
      store,
      user,
      reservation,
      usage.officialMinutesCharged,
      now,
    );
    reactivateLocalReservation(reservation, now);
    if (!current) store.meetingProcessingReservations.push(reservation);
    return toMeetingProcessingReservation(reservation);
  });
}

export function getMeetingProcessingReservation(userId: string, operationKey: string): MeetingProcessingReservation | null {
  const store = readStore();
  const reservation = store.meetingProcessingReservations.find(
    (item) => item.userId === userId && item.operationKey === operationKey,
  );
  return reservation ? toMeetingProcessingReservation(reservation) : null;
}

export function claimMeetingProviderStep(userId: string, input: ClaimMeetingProviderStepInput): MeetingProviderStepClaimResult {
  return withLocalQuotaMutation((store) => {
    findLocalQuotaUser(store, userId);
    const now = new Date();
    const reservation = store.meetingProcessingReservations.find(
      (item) => item.id === input.reservationId && item.userId === userId,
    );
    if (!reservation) throw new AuthError("会议额度预占记录不存在。", 404, "meeting_quota_reservation_missing");
    const stageKey = meetingProviderStageKey(input.stage);
    const current = store.meetingProviderSteps.find(
      (step) => step.reservationId === reservation.id && step.stageKey === stageKey,
    );
    if (current?.status === "completed") return { outcome: "completed", step: toMeetingProviderStep(current) };
    if (current?.status === "started") return { outcome: "uncertain", step: toMeetingProviderStep(current) };
    if (current?.status === "claimed" && new Date(current.leaseExpiresAt).getTime() > now.getTime()) {
      return { outcome: "busy", step: toMeetingProviderStep(current) };
    }
    assertLocalReservationActive(reservation, now);

    const claimToken = crypto.randomBytes(32).toString("base64url");
    const leaseExpiresAt = new Date(now.getTime() + normalizeProviderStepLeaseMs(input.leaseMs)).toISOString();
    const step: MeetingProviderStepRecord = current ?? {
      id: createId("provider_step"),
      reservationId: reservation.id,
      userId,
      stageKey,
      stageType: input.stage.type,
      sequence: input.stage.type === "realtime_asr" ? input.stage.sequence : undefined,
      status: "claimed",
      claimTokenHash: "",
      leaseExpiresAt,
      officialMinutesSettled: 0,
      freeTrialMinutesSettled: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    step.status = "claimed";
    step.claimTokenHash = hashToken(claimToken);
    step.leaseExpiresAt = leaseExpiresAt;
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.releasedAt = undefined;
    step.officialMinutesSettled = 0;
    step.freeTrialMinutesSettled = 0;
    step.settlementPeriodIdentity = undefined;
    step.updatedAt = now.toISOString();
    reservation.releasedAt = undefined;
    reservation.reservationExpiresAt = laterIso(reservation.reservationExpiresAt, leaseExpiresAt);
    reservation.updatedAt = now.toISOString();
    if (!current) store.meetingProviderSteps.push(step);
    return { outcome: "claimed", step: toMeetingProviderStep(step), claimToken };
  });
}

export function startMeetingProviderStep(userId: string, input: StartMeetingProviderStepInput): MeetingProviderStepTransitionResult {
  return withLocalQuotaMutation((store) => {
    const user = findLocalQuotaUser(store, userId);
    const now = new Date();
    const step = findLocalProviderStep(store, userId, input.stepId);
    if (step.status === "completed") return { outcome: "completed", step: toMeetingProviderStep(step) };
    if (step.status === "started") return { outcome: "uncertain", step: toMeetingProviderStep(step) };
    assertLocalProviderStepClaim(step, input.claimToken, now);
    const reservation = findActiveLocalReservation(store, userId, step.reservationId, now);
    normalizeLocalFreeTrialFields(user);
    const freeTrialMinutesBeforeStart = user.freeTrialMinutesUsed!;
    const settlementPeriodIdentity = localSettlementPeriodIdentity(user);
    const settledDelta = settleLocalReservationCapacity(store, user, reservation, now);
    captureLocalFreeTrialUsage(user);
    step.status = "started";
    step.officialMinutesSettled = settledDelta;
    step.freeTrialMinutesSettled = Math.min(
      settledDelta,
      Math.max(0, user.freeTrialMinutesUsed! - freeTrialMinutesBeforeStart),
    );
    step.settlementPeriodIdentity = settlementPeriodIdentity;
    step.startedAt = now.toISOString();
    step.updatedAt = now.toISOString();
    return { outcome: "started", step: toMeetingProviderStep(step) };
  });
}

export function completeMeetingProviderStep(userId: string, input: CompleteMeetingProviderStepInput): MeetingProviderStepTransitionResult {
  return withLocalQuotaMutation((store) => {
    const step = findLocalProviderStep(store, userId, input.stepId);
    if (step.status === "completed") return { outcome: "completed", step: toMeetingProviderStep(step) };
    if (step.status !== "started" || !tokensMatch(step.claimTokenHash, input.claimToken)) {
      return { outcome: "uncertain", step: toMeetingProviderStep(step) };
    }
    const now = new Date().toISOString();
    step.status = "completed";
    step.completedAt = now;
    step.updatedAt = now;
    return { outcome: "completed", step: toMeetingProviderStep(step) };
  });
}

/**
 * Reconcile a paid finalization step only after the caller has verified the
 * owner/meeting/operation/audio-scoped durable output checkpoint. Unlike a
 * claim, this never creates or restarts a provider step.
 */
export function reconcileMeetingProviderStep(
  userId: string,
  input: ReconcileMeetingProviderStepInput,
): MeetingProviderStepTransitionResult {
  return withLocalQuotaMutation((store) => {
    const reservation = store.meetingProcessingReservations.find(
      (item) => item.id === input.reservationId && item.userId === userId,
    );
    if (!reservation) throw new AuthError("会议额度预占记录不存在。", 404, "meeting_quota_reservation_missing");
    const step = store.meetingProviderSteps.find(
      (item) => item.reservationId === reservation.id && item.stageKey === meetingProviderStageKey(input.stage),
    );
    if (!step || !["started", "completed"].includes(step.status)) {
      throw new AuthError(
        "Durable provider output does not match a started provider step.",
        409,
        "provider_step_checkpoint_mismatch",
      );
    }
    if (step.status === "started") {
      const now = new Date().toISOString();
      step.status = "completed";
      step.completedAt = now;
      step.updatedAt = now;
    }
    return { outcome: "completed", step: toMeetingProviderStep(step) };
  });
}

export function releaseMeetingProviderStep(userId: string, input: ReleaseMeetingProviderStepInput): MeetingProviderStepTransitionResult {
  return withLocalQuotaMutation((store) => {
    findLocalQuotaUser(store, userId);
    const step = findLocalProviderStep(store, userId, input.stepId);
    if (step.status === "completed") return { outcome: "completed", step: toMeetingProviderStep(step) };
    if (step.status === "started") return { outcome: "uncertain", step: toMeetingProviderStep(step) };
    if (step.status === "released") return { outcome: "released", step: toMeetingProviderStep(step) };
    if (!tokensMatch(step.claimTokenHash, input.claimToken)) {
      throw new AuthError("Provider 步骤认领令牌无效。", 409, "provider_step_claim_mismatch");
    }
    const now = new Date().toISOString();
    step.status = "released";
    step.releasedAt = now;
    step.updatedAt = now;
    return { outcome: "released", step: toMeetingProviderStep(step) };
  });
}

export function rejectMeetingProviderStep(userId: string, input: RejectMeetingProviderStepInput): MeetingProviderStepTransitionResult {
  return withLocalQuotaMutation((store) => {
    const user = store.users.find((item) => item.id === userId);
    if (!user) throw new AuthError("账号不存在。", 404);
    const step = findLocalProviderStep(store, userId, input.stepId);
    if (!tokensMatch(step.claimTokenHash, input.claimToken)) {
      throw new AuthError("Provider 步骤认领令牌无效。", 409, "provider_step_claim_mismatch");
    }
    if (step.status === "completed") return { outcome: "completed", step: toMeetingProviderStep(step) };
    if (step.status === "released") return { outcome: "released", step: toMeetingProviderStep(step) };

    const now = new Date().toISOString();
    if (user.deletedAt) {
      if (step.status === "started") {
        const reservation = store.meetingProcessingReservations.find(
          (item) => item.id === step.reservationId && item.userId === userId,
        );
        if (reservation) {
          reservation.officialMinutesSettled = Math.max(0, reservation.officialMinutesSettled - Math.max(0, step.officialMinutesSettled));
          reservation.updatedAt = now;
        }
      }
      step.status = "released";
      step.officialMinutesSettled = 0;
      step.freeTrialMinutesSettled = 0;
      step.releasedAt = now;
      step.updatedAt = now;
      return { outcome: "released", step: toMeetingProviderStep(step) };
    }
    if (step.status === "started") {
      const reservation = store.meetingProcessingReservations.find(
        (item) => item.id === step.reservationId && item.userId === userId,
      );
      if (!reservation || reservation.status === "finalized") {
        throw new AuthError(
          "Provider 明确拒绝，但额度记录已无法安全回退。",
          409,
          "provider_step_refund_conflict",
        );
      }
      const settledDelta = Math.max(0, step.officialMinutesSettled);
      if (reservation.officialMinutesSettled < settledDelta) {
        throw new AuthError(
          "Provider 明确拒绝，但已结算分钟与额度记录不一致。",
          409,
          "provider_step_refund_conflict",
        );
      }
      const currentPeriodMatches =
        Boolean(step.settlementPeriodIdentity) &&
        step.settlementPeriodIdentity === localSettlementPeriodIdentity(user);
      if (currentPeriodMatches) {
        if (user.officialMinutesUsed < settledDelta) {
          throw new AuthError(
            "Provider 明确拒绝，但当前账期已用分钟不足以安全回退。",
            409,
            "provider_step_refund_conflict",
          );
        }
        user.officialMinutesUsed -= settledDelta;
      }
      reservation.officialMinutesSettled -= settledDelta;
      reservation.updatedAt = now;
      step.officialMinutesSettled = 0;
      normalizeLocalFreeTrialFields(user);
      user.freeTrialMinutesUsed = Math.max(
        0,
        user.freeTrialMinutesUsed! - Math.max(0, step.freeTrialMinutesSettled),
      );
    }

    step.status = "released";
    step.releasedAt = now;
    step.updatedAt = now;
    return { outcome: "released", step: toMeetingProviderStep(step) };
  });
}

export function releaseMeetingProcessingReservation(
  userId: string,
  input: ReleaseMeetingProcessingReservationInput,
): MeetingProcessingReservation {
  return withLocalQuotaMutation((store) => {
    findLocalQuotaUser(store, userId);
    const reservation = store.meetingProcessingReservations.find(
      (item) => item.id === input.reservationId && item.userId === userId,
    );
    if (!reservation) throw new AuthError("会议额度预占记录不存在。", 404, "meeting_quota_reservation_missing");
    if (reservation.status === "finalized") return toMeetingProcessingReservation(reservation);
    if (store.meetingProviderSteps.some((step) => step.reservationId === reservation.id && step.status === "started")) {
      throw new AuthError("Provider 调用状态不确定，不能释放该额度预占。", 409, "provider_step_uncertain");
    }
    const now = new Date().toISOString();
    for (const step of store.meetingProviderSteps) {
      if (step.reservationId === reservation.id && step.status === "claimed") {
        step.status = "released";
        step.releasedAt = now;
        step.updatedAt = now;
      }
    }
    reservation.releasedAt = now;
    reservation.reservationExpiresAt = now;
    reservation.updatedAt = now;
    return toMeetingProcessingReservation(reservation);
  });
}

export function recordMeetingFinalizeUsage(userId: string, input: { meetingId: string; durationMs: number; route: MeetingProcessingRoute; resultGeneratedAt: string; isReprocess?: boolean; nonBillable?: boolean; reservationId?: string; reservationOperationKey?: string }) {
  withLocalQuotaMutation((store) => {
    const user = findLocalQuotaUser(store, userId);
    const usageKey = `meeting:${input.meetingId}`;
    const resultKey = `result:${input.resultGeneratedAt}`;
    const existing = store.usageEvents.find(
      (event) =>
        event.userId === userId &&
        event.type === "meeting_finalize" &&
        ((input.reservationId && event.processingReservationId === input.reservationId) ||
          (event.note.includes(usageKey) &&
            (event.note.includes(resultKey) || (!input.isReprocess && !event.note.includes("result:"))))),
    );
    if (existing) return;

    const calculatedUsage = calculateMeetingUsage(input);
    const reservation = input.reservationId
      ? store.meetingProcessingReservations.find((item) => item.id === input.reservationId && item.userId === userId)
      : input.reservationOperationKey
        ? store.meetingProcessingReservations.find((item) => item.operationKey === input.reservationOperationKey && item.userId === userId)
        : undefined;
    if (input.reservationId && !reservation) {
      throw new AuthError("会议额度预占记录不存在或不属于当前账号。", 409, "meeting_quota_reservation_missing");
    }
    if (reservation && reservation.meetingId !== input.meetingId) {
      throw new AuthError("会议额度预占记录不存在或不属于当前账号。", 409, "meeting_quota_reservation_missing");
    }

    let officialMinutesCharged: number;
    if (reservation) {
      const requiredSettlement = input.nonBillable ? 0 : calculatedUsage.officialMinutesCharged;
      if (reservation.officialMinutesSettled < requiredSettlement) {
        throw new AuthError("官方额度尚未在 Provider 调用前完成结算。", 409, "meeting_quota_not_settled");
      }
      officialMinutesCharged = reservation.officialMinutesSettled;
    } else {
      // Compatibility for pre-fencing callers. New processing always supplies a
      // reservation and therefore never charges a second time in this ledger step.
      officialMinutesCharged = settleLocalLegacyUsage(store, user, calculatedUsage.officialMinutesCharged, new Date());
    }
    const usage = { processedMinutes: calculatedUsage.processedMinutes, officialMinutesCharged };
    const now = new Date().toISOString();
    if (reservation) {
      reservation.processingRoute = input.route;
      reservation.processedMinutes = usage.processedMinutes;
      reservation.status = "finalized";
      reservation.releasedAt = undefined;
      reservation.resultGeneratedAt = input.resultGeneratedAt;
      reservation.finalizedAt = now;
      reservation.updatedAt = now;
    }
    captureLocalFreeTrialUsage(user);
    store.usageEvents.push({
      id: createId("usage"),
      userId,
      type: "meeting_finalize",
      minutes: usage.officialMinutesCharged,
      createdAt: now,
      note: buildMeetingUsageNote({ meetingId: input.meetingId, resultGeneratedAt: input.resultGeneratedAt, route: input.route, ...usage }),
      processingReservationId: reservation?.id,
    });
  });
  return getUserUsage(userId);
}

function findLocalQuotaUser(store: AuthStore, userId: string) {
  const user = store.users.find((item) => !item.deletedAt && item.id === userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  return user;
}

function assertLocalReservationMeeting(reservation: MeetingProcessingReservationRecord | undefined, meetingId: string) {
  if (reservation && reservation.meetingId !== meetingId) {
    throw new AuthError("会议额度预占记录与当前会议不匹配。", 409, "meeting_quota_owner_mismatch");
  }
}

function assertLocalReservationProcessingMode(
  reservation: MeetingProcessingReservationRecord | undefined,
  requestedRoute: MeetingProcessingRoute,
) {
  if (reservation && reservation.processingRoute !== requestedRoute) {
    throw new AuthError(
      "这场会议的处理方式已在开始时固定，不能在上传或重试时更换。",
      409,
      "meeting_processing_mode_conflict",
    );
  }
}

function createLocalProcessingReservation(
  user: UserRecord,
  input: Pick<ReserveRealtimeQuotaInput, "meetingId" | "operationKey" | "processingRoute">,
  now: Date,
): MeetingProcessingReservationRecord {
  const timestamp = now.toISOString();
  return {
    id: createId("quota"),
    userId: user.id,
    meetingId: input.meetingId,
    operationKey: input.operationKey,
    processingRoute: input.processingRoute,
    processedMinutes: 0,
    officialMinutesReserved: 0,
    officialMinutesSettled: 0,
    realtimeDurationMs: 0,
    realtimeHighestSequence: 0,
    reservationExpiresAt: new Date(now.getTime() + DEFAULT_MEETING_RESERVATION_LEASE_MS).toISOString(),
    status: "reserved",
    quotaPeriodSource: user.officialMinutesPeriodSource,
    quotaPeriodStartAt: user.officialMinutesPeriodStartAt,
    quotaBillingOrderId: user.officialMinutesBillingOrderId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function reactivateLocalReservation(reservation: MeetingProcessingReservationRecord, now: Date) {
  reservation.releasedAt = undefined;
  reservation.reservationExpiresAt = new Date(now.getTime() + DEFAULT_MEETING_RESERVATION_LEASE_MS).toISOString();
  reservation.updatedAt = now.toISOString();
}

function isLocalReservationCapacityActive(reservation: MeetingProcessingReservationRecord, now: Date) {
  return (
    reservation.status === "reserved" &&
    !reservation.releasedAt &&
    new Date(reservation.reservationExpiresAt).getTime() > now.getTime()
  );
}

function localPendingCapacity(store: AuthStore, userId: string, now: Date, excludeReservationId?: string) {
  return store.meetingProcessingReservations.reduce((total, reservation) => {
    if (
      reservation.userId !== userId ||
      reservation.id === excludeReservationId ||
      !isLocalReservationCapacityActive(reservation, now)
    ) {
      return total;
    }
    return total + Math.max(0, reservation.officialMinutesReserved - reservation.officialMinutesSettled);
  }, 0);
}

function reserveLocalOfficialCapacity(
  store: AuthStore,
  user: UserRecord,
  reservation: MeetingProcessingReservationRecord,
  targetMinutes: number,
  now: Date,
) {
  const target = Math.max(reservation.officialMinutesReserved, Math.max(0, Math.round(targetMinutes)));
  const pendingTarget = Math.max(0, target - reservation.officialMinutesSettled);
  const otherPending = localPendingCapacity(store, user.id, now, reservation.id);
  const available = Math.max(0, user.officialMinutesTotal - user.officialMinutesUsed - otherPending);
  if (pendingTarget > available) {
    throw new AuthError(
      `官方额度不足：本次至少需要 ${target} 分钟，扣除其他处理中任务后还可预占 ${available} 分钟。完整录音仍保留，可配置 BYOK 或增加额度后重试。`,
      402,
      "official_quota_insufficient",
    );
  }
  return target;
}

function settleLocalReservationCapacity(
  store: AuthStore,
  user: UserRecord,
  reservation: MeetingProcessingReservationRecord,
  now: Date,
) {
  const delta = Math.max(0, reservation.officialMinutesReserved - reservation.officialMinutesSettled);
  const otherPending = localPendingCapacity(store, user.id, now, reservation.id);
  const available = Math.max(0, user.officialMinutesTotal - user.officialMinutesUsed - otherPending);
  if (delta > available) {
    throw new AuthError(
      `官方额度不足：Provider 调用前需要结算 ${delta} 分钟，当前可结算 ${available} 分钟。`,
      402,
      "official_quota_insufficient",
    );
  }
  user.officialMinutesUsed += delta;
  reservation.officialMinutesSettled += delta;
  reservation.updatedAt = now.toISOString();
  return delta;
}

function settleLocalLegacyUsage(store: AuthStore, user: UserRecord, targetMinutes: number, now: Date) {
  const target = Math.max(0, Math.round(targetMinutes));
  const pending = localPendingCapacity(store, user.id, now);
  const available = Math.max(0, user.officialMinutesTotal - user.officialMinutesUsed - pending);
  if (target > available) {
    throw new AuthError(
      `官方额度不足：本次至少需要 ${target} 分钟，扣除处理中任务后还可使用 ${available} 分钟。`,
      402,
      "official_quota_insufficient",
    );
  }
  user.officialMinutesUsed += target;
  return target;
}

function findActiveLocalReservation(store: AuthStore, userId: string, reservationId: string, now: Date) {
  const reservation = store.meetingProcessingReservations.find(
    (item) => item.id === reservationId && item.userId === userId,
  );
  if (!reservation) throw new AuthError("会议额度预占记录不存在。", 404, "meeting_quota_reservation_missing");
  assertLocalReservationActive(reservation, now);
  return reservation;
}

function assertLocalReservationActive(reservation: MeetingProcessingReservationRecord, now: Date) {
  if (reservation.status === "finalized") {
    throw new AuthError("会议处理已经完成。", 409, "meeting_processing_finalized");
  }
  if (!isLocalReservationCapacityActive(reservation, now)) {
    throw new AuthError("会议额度预占已释放或过期，请重新预占。", 409, "meeting_quota_reservation_expired");
  }
}

function findLocalProviderStep(store: AuthStore, userId: string, stepId: string) {
  const step = store.meetingProviderSteps.find((item) => item.id === stepId && item.userId === userId);
  if (!step) throw new AuthError("Provider 步骤不存在。", 404, "provider_step_missing");
  return step;
}

function assertLocalProviderStepClaim(step: MeetingProviderStepRecord, claimToken: string, now: Date) {
  if (step.status !== "claimed") {
    throw new AuthError("Provider 步骤未处于可启动状态。", 409, "provider_step_not_claimed");
  }
  if (!tokensMatch(step.claimTokenHash, claimToken)) {
    throw new AuthError("Provider 步骤认领令牌无效。", 409, "provider_step_claim_mismatch");
  }
  if (new Date(step.leaseExpiresAt).getTime() <= now.getTime()) {
    throw new AuthError("Provider 步骤认领已过期，可重新认领。", 409, "provider_step_claim_expired");
  }
}

function tokensMatch(expectedHash: string, token: string) {
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function laterIso(left: string, right: string) {
  return new Date(Math.max(new Date(left).getTime(), new Date(right).getTime())).toISOString();
}

function toMeetingProviderStep(step: MeetingProviderStepRecord): MeetingProviderStep {
  return {
    id: step.id,
    reservationId: step.reservationId,
    stageKey: step.stageKey,
    stageType: step.stageType,
    sequence: step.sequence,
    status: step.status,
    leaseExpiresAt: step.leaseExpiresAt,
    officialMinutesSettled: step.officialMinutesSettled,
    freeTrialMinutesSettled: Math.max(0, Number(step.freeTrialMinutesSettled ?? 0)),
    settlementPeriodIdentity: step.settlementPeriodIdentity,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    releasedAt: step.releasedAt,
  };
}

function localSettlementPeriodIdentity(user: UserRecord) {
  return [
    `source=${user.officialMinutesPeriodSource || ""}`,
    `start=${user.officialMinutesPeriodStartAt || ""}`,
    `billing=${user.officialMinutesBillingOrderId || ""}`,
  ].join(";");
}

function toMeetingProcessingReservation(reservation: MeetingProcessingReservationRecord): MeetingProcessingReservation {
  return {
    id: reservation.id,
    meetingId: reservation.meetingId,
    operationKey: reservation.operationKey,
    processingRoute: reservation.processingRoute,
    processedMinutes: reservation.processedMinutes,
    officialMinutesReserved: reservation.officialMinutesReserved,
    officialMinutesSettled: reservation.officialMinutesSettled,
    realtimeDurationMs: reservation.realtimeDurationMs,
    realtimeHighestSequence: reservation.realtimeHighestSequence,
    reservationExpiresAt: reservation.reservationExpiresAt,
    releasedAt: reservation.releasedAt,
    status: reservation.status,
  };
}

export function getAdminMetrics(): AdminMetrics {
  const store = readStore();
  const activeUsers = store.users.filter((user) => !user.deletedAt);

  return {
    totalUsers: store.users.length,
    activeUsers: activeUsers.length,
    totalProviderCredentials: store.providerCredentials.length,
    officialMinutesUsed: activeUsers.reduce((sum, user) => sum + user.officialMinutesUsed, 0),
    officialMinutesTotal: activeUsers.reduce((sum, user) => sum + user.officialMinutesTotal, 0),
  };
}

export function getAdminCommercialMetrics(): AdminCommercialMetrics {
  const store = readStore();
  const activeUsers = store.users.filter((user) => !user.deletedAt);
  const providerUsers = new Set(store.providerCredentials.map((credential) => credential.userId));
  const activatedUsers = new Set(store.usageEvents.filter((event) => event.type === "meeting_finalize").map((event) => event.userId));
  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  const activeProviderUsers = [...providerUsers].filter((userId) => activeUserIds.has(userId));
  const activeActivatedUsers = [...activatedUsers].filter((userId) => activeUserIds.has(userId));
  const payingUsers = activeUsers.filter((user) => user.plan !== "free");

  const byokOnlyUsers = activeUsers.filter((user) => providerUsers.has(user.id) && user.plan === "free").length;
  const officialOnlyUsers = activeUsers.filter((user) => !providerUsers.has(user.id)).length;
  const hybridUsers = activeUsers.filter((user) => providerUsers.has(user.id) && user.plan !== "free").length;

  return {
    activeUsers: activeUsers.length,
    configuredProviderUsers: activeProviderUsers.length,
    activatedUsers: activeActivatedUsers.length,
    payingUsers: payingUsers.length,
    byokOnlyUsers,
    officialOnlyUsers,
    hybridUsers,
    freeUsers: activeUsers.filter((user) => user.plan === "free").length,
    plusUsers: activeUsers.filter((user) => user.plan === "plus").length,
    proUsers: activeUsers.filter((user) => user.plan === "pro").length,
    officialMinutesRemaining: activeUsers.reduce((sum, user) => sum + Math.max(0, user.officialMinutesTotal - user.officialMinutesUsed), 0),
    conversionRates: {
      providerSetup: percent(activeProviderUsers.length, activeUsers.length),
      activation: percent(activeActivatedUsers.length, activeUsers.length),
      paid: percent(payingUsers.length, activeUsers.length),
    },
  };
}

export function getAdminGrowthMetrics(): AdminGrowthMetrics {
  const store = readStore();
  const activeUsers = store.users.filter((user) => !user.deletedAt);
  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  const registrations = store.growthEvents.filter((event) => event.type === "register" && activeUserIds.has(event.userId));
  const shareRegistrations = registrations.filter((event) => event.source === "share" && event.shareId);
  const shareUserIds = new Set(shareRegistrations.map((event) => event.userId));
  const providerUsers = new Set(store.providerCredentials.map((credential) => credential.userId));
  const activatedUsers = new Set(store.usageEvents.filter((event) => event.type === "meeting_finalize").map((event) => event.userId));
  const payingUsers = new Set(activeUsers.filter((user) => user.plan !== "free").map((user) => user.id));
  const shareAttributedProviderUsers = [...shareUserIds].filter((userId) => providerUsers.has(userId)).length;
  const shareAttributedActivatedUsers = [...shareUserIds].filter((userId) => activatedUsers.has(userId)).length;
  const shareAttributedPayingUsers = [...shareUserIds].filter((userId) => payingUsers.has(userId)).length;
  const shareCounts = new Map<string, number>();

  for (const event of shareRegistrations) {
    if (!event.shareId) continue;
    shareCounts.set(event.shareId, (shareCounts.get(event.shareId) ?? 0) + 1);
  }

  return {
    directRegistrations: registrations.filter((event) => event.source === "direct").length,
    shareAttributedActivatedUsers,
    shareAttributedPayingUsers,
    shareAttributedProviderUsers,
    shareAttributedRegistrations: shareRegistrations.length,
    shareConversionRates: {
      activation: percent(shareAttributedActivatedUsers, shareRegistrations.length),
      paid: percent(shareAttributedPayingUsers, shareRegistrations.length),
      providerSetup: percent(shareAttributedProviderUsers, shareRegistrations.length),
    },
    totalTrackedRegistrations: registrations.length,
    topShareRegistrations: [...shareCounts.entries()]
      .map(([shareId, registrations]) => ({ shareId, registrations }))
      .sort((left, right) => right.registrations - left.registrations || left.shareId.localeCompare(right.shareId))
      .slice(0, 5),
  };
}

export function getAdminFunnel() {
  const store = readStore();
  const activeUsers = store.users.filter((user) => !user.deletedAt);
  const providerUsers = new Set(store.providerCredentials.map((credential) => credential.userId));
  const usedQuotaUsers = new Set(store.usageEvents.filter((event) => event.type === "meeting_finalize").map((event) => event.userId));

  return [
    { label: "访问登录页", value: Math.max(activeUsers.length * 3, activeUsers.length) },
    { label: "完成注册", value: activeUsers.length },
    { label: "配置模型", value: [...providerUsers].filter((userId) => activeUsers.some((user) => user.id === userId)).length },
    { label: "完成首场会议", value: [...usedQuotaUsers].filter((userId) => activeUsers.some((user) => user.id === userId)).length },
    { label: "开通 Plus / Pro", value: activeUsers.filter((user) => user.plan !== "free").length },
  ];
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

export function listAdminUsers(): AdminUserSummary[] {
  const store = readStore();

  return store.users
    .map((user) => {
      const userSessions = store.sessions.filter((session) => session.userId === user.id);
      const lastSeenAt = userSessions.map((session) => session.lastSeenAt).sort().at(-1);
      const providerCredentialCount = store.providerCredentials.filter((credential) => credential.userId === user.id).length;
      const meetingFinalizeCount = store.usageEvents.filter((event) => event.userId === user.id && event.type === "meeting_finalize").length;

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        plan: user.plan,
        status: user.deletedAt ? "deleted" : "active",
        createdAt: user.createdAt,
        emailVerifiedAt: user.emailVerifiedAt,
        lastSeenAt,
        providerCredentialCount,
        meetingFinalizeCount,
        officialMinutesTotal: user.officialMinutesTotal,
        officialMinutesUsed: user.officialMinutesUsed,
        officialMinutesRemaining: Math.max(0, user.officialMinutesTotal - user.officialMinutesUsed),
      } satisfies AdminUserSummary;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function listAdminEntitlementGrants(limit = 20): EntitlementGrantSummary[] {
  const store = readStore();

  return store.entitlementGrants
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, limit))
    .map((grant) => summarizeEntitlementGrant(grant, store));
}

export function listAdminBillingOrders(limit = 20): BillingOrderSummary[] {
  const store = readStore();

  return store.billingOrders
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, limit))
    .map((order) => summarizeBillingOrder(order, store));
}

function summarizeEntitlementGrant(grant: EntitlementGrantRecord, store: AuthStore): EntitlementGrantSummary {
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const user = usersById.get(grant.userId);
  const grantedBy = grant.grantedByUserId ? usersById.get(grant.grantedByUserId) : undefined;
  const statusChangedBy = grant.statusChangedByUserId ? usersById.get(grant.statusChangedByUserId) : undefined;
  return {
    id: grant.id,
    userId: grant.userId,
    billingOrderId: grant.billingOrderId,
    userEmail: user?.email || "unknown",
    userName: user?.name || "Unknown User",
    grantedByUserId: grant.grantedByUserId,
    grantedByEmail: grantedBy?.email,
    grantedByName: grantedBy?.name,
    source: grant.source,
    status: grant.status,
    statusChangedByUserId: grant.statusChangedByUserId,
    statusChangedByEmail: statusChangedBy?.email,
    statusChangedByName: statusChangedBy?.name,
    statusReason: grant.statusReason,
    statusUpdatedAt: grant.statusUpdatedAt,
    previousPlan: grant.previousPlan,
    plan: grant.plan,
    officialMinutesTotal: grant.officialMinutesTotal,
    reason: grant.reason,
    createdAt: grant.createdAt,
  };
}

function summarizeBillingOrder(order: BillingOrderRecord, store: AuthStore): BillingOrderSummary {
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const user = usersById.get(order.userId);
  const createdBy = order.createdByUserId ? usersById.get(order.createdByUserId) : undefined;
  return {
    id: order.id,
    userId: order.userId,
    userEmail: user?.email || "unknown",
    userName: user?.name || "Unknown User",
    createdByUserId: order.createdByUserId,
    createdByEmail: createdBy?.email,
    createdByName: createdBy?.name,
    provider: order.provider,
    status: order.status,
    plan: order.plan,
    amountCents: order.amountCents,
    priceMilliunits: order.priceMilliunits === undefined ? undefined : String(order.priceMilliunits),
    currency: order.currency,
    environment: order.environment,
    productId: order.productId,
    storefront: order.storefront,
    offerType: order.offerType,
    offerIdentifier: order.offerIdentifier,
    signedDate: order.signedDate,
    statusSignedDate: order.statusSignedDate,
    externalTransactionId: order.externalTransactionId,
    originalTransactionId: order.originalTransactionId,
    idempotencyKey: order.idempotencyKey,
    periodStartAt: order.periodStartAt,
    periodEndAt: order.periodEndAt,
    entitlementGrantId: order.entitlementGrantId,
    note: order.note,
    statusReason: order.statusReason,
    statusUpdatedAt: order.statusUpdatedAt,
    createdAt: order.createdAt,
  };
}

export class AuthError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function withLocalQuotaMutation<T>(mutation: (store: AuthStore) => T): T {
  ensureStore();
  acquireLocalQuotaLock();
  try {
    const store = readStoreWithRetry();
    const result = mutation(store);
    writeStore(store);
    return result;
  } finally {
    fs.rmSync(QUOTA_LOCK_PATH, { force: true, recursive: true });
  }
}

function acquireLocalQuotaLock() {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      fs.mkdirSync(QUOTA_LOCK_PATH, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
      try {
        const ageMs = Date.now() - fs.statSync(QUOTA_LOCK_PATH).mtimeMs;
        if (ageMs > 30_000) {
          fs.rmSync(QUOTA_LOCK_PATH, { force: true, recursive: true });
          continue;
        }
      } catch (statError) {
        if (!isNodeErrorCode(statError, "ENOENT")) throw statError;
      }
      blockForRetry(Math.min(attempt, 9));
    }
  }
  throw new AuthError("额度状态繁忙，请稍后重试。", 503, "meeting_quota_lock_timeout");
}

function isNodeErrorCode(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function readStore(): AuthStore {
  ensureStore();
  return readStoreWithRetry();
}

function writeStore(store: AuthStore) {
  ensureStore();
  const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, STORE_PATH);
}

function enqueueLocalSecretAuditEvents(store: AuthStore, events: SecretAuditEvent[]) {
  for (const event of events) {
    assertSecretAuditOutboxPayloadSafe(event);
    if (store.secretAuditOutbox.some((record) => record.eventId === event.id)) continue;
    store.secretAuditOutbox.push({
      attemptCount: 0,
      availableAt: event.createdAt,
      createdAt: event.createdAt,
      eventId: event.id,
      payload: event,
    });
  }
}

export function flushLocalSecretAuditOutboxOnce(
  workerId = `local-secret-audit-${process.pid}`,
): SecretAuditOutboxFlushResult {
  let claim:
    | {
        claimToken: string;
        eventId: string;
        payload: SecretAuditEvent;
      }
    | undefined;
  try {
    claim = withLocalSecretAuditOutboxLock(() => {
      const store = readStoreWithRetry();
      const now = Date.now();
      const candidate = store.secretAuditOutbox
        .filter((record) => {
          const leaseExpiresAt = Date.parse(record.leaseExpiresAt || "");
          const claimAvailable =
            !record.claimToken ||
            !Number.isFinite(leaseExpiresAt) ||
            leaseExpiresAt <= now;
          return claimAvailable && Date.parse(record.availableAt) <= now;
        })
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.eventId.localeCompare(right.eventId),
        )[0];
      if (!candidate) return undefined;
      const claimToken = crypto.randomBytes(18).toString("base64url");
      candidate.attemptCount += 1;
      candidate.lockedBy = sanitizeSecretAuditWorkerId(workerId);
      candidate.claimToken = claimToken;
      candidate.leaseExpiresAt = new Date(now + getSecretAuditOutboxLeaseMs()).toISOString();
      writeStore(store);
      return {
        claimToken,
        eventId: candidate.eventId,
        payload: candidate.payload,
      };
    });
  } catch (error) {
    return {
      claimed: false,
      delivered: false,
      errorCode: error instanceof Error ? error.name : "local_outbox_claim_failed",
    };
  }
  if (!claim) return { claimed: false, delivered: false };

  const delivery = deliverSecretAuditEvent(claim.payload);
  try {
    withLocalSecretAuditOutboxLock(() => {
      const store = readStoreWithRetry();
      const current = store.secretAuditOutbox.find(
        (record) =>
          record.eventId === claim?.eventId &&
          record.claimToken === claim?.claimToken,
      );
      if (!current) return;
      if (delivery.ok) {
        store.secretAuditOutbox = store.secretAuditOutbox.filter(
          (record) => record.eventId !== current.eventId,
        );
      } else {
        current.availableAt = new Date(
          Date.now() + getSecretAuditOutboxRetryDelayMs(current.attemptCount),
        ).toISOString();
        current.lastErrorCode = delivery.errorCode.slice(0, 80);
        current.lockedBy = undefined;
        current.claimToken = undefined;
        current.leaseExpiresAt = undefined;
      }
      writeStore(store);
    });
  } catch {
    // A crash or acknowledgement-write failure after append intentionally
    // leaves the same stable event pending for at-least-once redelivery.
  }
  return delivery.ok
    ? { claimed: true, delivered: true, eventId: claim.eventId }
    : {
        claimed: true,
        delivered: false,
        errorCode: delivery.errorCode,
        eventId: claim.eventId,
      };
}

export function getLocalSecretAuditOutboxInfo(): SecretAuditOutboxInfo {
  const store = readStore();
  const now = Date.now();
  const oldestPendingAt =
    store.secretAuditOutbox
      .map((record) => record.createdAt)
      .sort()[0] || null;
  const maxPendingAgeMs = getSecretAuditOutboxMaxPendingAgeMs();
  return {
    claimableCount: store.secretAuditOutbox.filter((record) => {
      const leaseExpiresAt = Date.parse(record.leaseExpiresAt || "");
      return (
        Date.parse(record.availableAt) <= now &&
        (!record.claimToken || !Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now)
      );
    }).length,
    expiredLeaseCount: store.secretAuditOutbox.filter((record) => {
      const leaseExpiresAt = Date.parse(record.leaseExpiresAt || "");
      return Boolean(record.claimToken) && Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= now;
    }).length,
    oldestPendingAgeMs: oldestPendingAt
      ? Math.max(0, now - Date.parse(oldestPendingAt))
      : 0,
    oldestPendingAt,
    overduePendingCount: store.secretAuditOutbox.filter(
      (record) => now - Date.parse(record.createdAt) > maxPendingAgeMs,
    ).length,
    pendingCount: store.secretAuditOutbox.length,
    provider: "local-file",
  };
}

function withLocalSecretAuditOutboxLock<T>(callback: () => T): T {
  ensureStore();
  acquireLocalSecretAuditOutboxLock();
  try {
    return callback();
  } finally {
    fs.rmSync(SECRET_AUDIT_OUTBOX_LOCK_PATH, { force: true, recursive: true });
  }
}

function acquireLocalSecretAuditOutboxLock() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.mkdirSync(SECRET_AUDIT_OUTBOX_LOCK_PATH, { mode: 0o700 });
      return;
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
      try {
        const ageMs = Date.now() - fs.statSync(SECRET_AUDIT_OUTBOX_LOCK_PATH).mtimeMs;
        if (ageMs > getSecretAuditOutboxLeaseMs() * 2) {
          fs.rmSync(SECRET_AUDIT_OUTBOX_LOCK_PATH, { force: true, recursive: true });
          continue;
        }
      } catch (statError) {
        if (!isNodeErrorCode(statError, "ENOENT")) throw statError;
      }
      blockForRetry(Math.min(attempt, 9));
    }
  }
  throw new Error("local_secret_audit_outbox_lock_timeout");
}

function sanitizeSecretAuditWorkerId(workerId: string) {
  const normalized = workerId.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 120);
  return normalized || `local-secret-audit-${process.pid}`;
}

function readStoreWithRetry() {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const raw = fs.readFileSync(STORE_PATH, "utf8");
      return normalizeStore(JSON.parse(raw));
    } catch (error) {
      lastError = error;
      blockForRetry(attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to read auth store.");
}

function normalizeStore(store: Partial<AuthStore>): AuthStore {
  const providerCredentials = Array.isArray(store.providerCredentials) ? store.providerCredentials : [];
  return {
    users: Array.isArray(store.users)
      ? store.users.map((user) => {
          const emailNormalized =
            user.emailVerificationPending === true || user.emailVerifiedAt
              ? user
              : { ...user, emailVerifiedAt: user.createdAt };
          const normalizedUser = normalizeLocalFreeTrialFields(emailNormalized);
          normalizedUser.processingMode =
            normalizedUser.processingMode === "byok" || normalizedUser.processingMode === "official_quota"
              ? normalizedUser.processingMode
              : getByokCoverage(providerCredentials
                  .filter((credential) => credential.userId === normalizedUser.id)
                  .map((credential) => ({
                    providerId: credential.providerId,
                    configuredFields: Object.keys(credential.fields),
                    configuredSecrets: Object.keys(credential.encryptedSecrets),
                  }))).complete
                ? "byok"
                : "official_quota";
          return normalizedUser;
        })
      : [],
    sessions: Array.isArray(store.sessions) ? store.sessions : [],
    emailVerificationTokens: Array.isArray(store.emailVerificationTokens) ? store.emailVerificationTokens : [],
    passwordResetTokens: Array.isArray(store.passwordResetTokens) ? store.passwordResetTokens : [],
    providerCredentials,
    secretAuditOutbox: normalizeLocalSecretAuditOutbox(store.secretAuditOutbox),
    meetingProcessingReservations: Array.isArray(store.meetingProcessingReservations)
      ? store.meetingProcessingReservations.map(normalizeLocalProcessingReservation)
      : [],
    meetingProviderSteps: Array.isArray(store.meetingProviderSteps) ? store.meetingProviderSteps : [],
    usageEvents: Array.isArray(store.usageEvents) ? store.usageEvents : [],
    growthEvents: Array.isArray(store.growthEvents) ? store.growthEvents : [],
    entitlementGrants: Array.isArray(store.entitlementGrants) ? store.entitlementGrants : [],
    billingOrders: Array.isArray(store.billingOrders) ? store.billingOrders : [],
    appleIapAccountBindings: Array.isArray(store.appleIapAccountBindings) ? store.appleIapAccountBindings : [],
    appleSubscriptions: Array.isArray(store.appleSubscriptions) ? store.appleSubscriptions : [],
    appleNotificationEvents: Array.isArray(store.appleNotificationEvents) ? store.appleNotificationEvents : [],
  };
}

function normalizeLocalProcessingReservation(
  reservation: MeetingProcessingReservationRecord,
): MeetingProcessingReservationRecord {
  const officialMinutesReserved = Math.max(0, Number(reservation.officialMinutesReserved) || 0);
  const officialMinutesSettled = Number.isFinite(reservation.officialMinutesSettled)
    ? Math.max(0, Math.min(officialMinutesReserved, Number(reservation.officialMinutesSettled)))
    : officialMinutesReserved;
  const updatedAt = reservation.updatedAt || reservation.createdAt || new Date().toISOString();
  return {
    ...reservation,
    officialMinutesReserved,
    officialMinutesSettled,
    reservationExpiresAt:
      reservation.reservationExpiresAt ||
      new Date(new Date(updatedAt).getTime() + DEFAULT_MEETING_RESERVATION_LEASE_MS).toISOString(),
    updatedAt,
  };
}

function normalizeLocalSecretAuditOutbox(
  records: SecretAuditOutboxRecord[] | undefined,
): SecretAuditOutboxRecord[] {
  if (!Array.isArray(records)) return [];
  return records.map((record) => {
    assertSecretAuditOutboxPayloadSafe(record.payload);
    if (record.eventId !== record.payload.id) {
      throw new Error("secret_audit_outbox_event_id_mismatch");
    }
    const createdAt = Number.isFinite(Date.parse(record.createdAt))
      ? record.createdAt
      : record.payload.createdAt;
    const availableAt = Number.isFinite(Date.parse(record.availableAt))
      ? record.availableAt
      : createdAt;
    const claimComplete =
      Boolean(record.lockedBy) &&
      Boolean(record.claimToken) &&
      Number.isFinite(Date.parse(record.leaseExpiresAt || ""));
    return {
      attemptCount: Math.max(0, Math.round(Number(record.attemptCount) || 0)),
      availableAt,
      createdAt,
      eventId: record.eventId,
      lastErrorCode:
        typeof record.lastErrorCode === "string"
          ? record.lastErrorCode.slice(0, 80)
          : undefined,
      lockedBy: claimComplete ? record.lockedBy?.slice(0, 120) : undefined,
      claimToken: claimComplete ? record.claimToken?.slice(0, 120) : undefined,
      leaseExpiresAt: claimComplete ? record.leaseExpiresAt : undefined,
      payload: record.payload,
    };
  });
}

function blockForRetry(attempt: number) {
  const delayMs = 10 * (attempt + 1);
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, delayMs);
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(STORE_PATH)) {
    const initial: AuthStore = {
      users: [],
      sessions: [],
      emailVerificationTokens: [],
      passwordResetTokens: [],
      providerCredentials: [],
      secretAuditOutbox: [],
      meetingProcessingReservations: [],
      meetingProviderSteps: [],
      usageEvents: [],
      growthEvents: [],
      entitlementGrants: [],
      billingOrders: [],
      appleIapAccountBindings: [],
      appleSubscriptions: [],
      appleNotificationEvents: [],
    };
    fs.writeFileSync(STORE_PATH, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
  }
}

function getLocalSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const envSecret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (envSecret && envSecret.length >= 32) return envSecret;

  if (!fs.existsSync(SECRET_PATH)) {
    fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
  }

  return fs.readFileSync(SECRET_PATH, "utf8").trim();
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64).toString("base64url");
  return { salt, hash };
}

function verifyPassword(password: string, salt: string, expectedHash: string) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "base64url");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function hashToken(token: string) {
  return crypto.createHmac("sha256", getLocalSecret()).update(token).digest("base64url");
}

function createEmailVerificationCode() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashEmailVerificationCode(input: { code: string; tokenId: string; userId: string }) {
  const otpKey = crypto.createHmac("sha256", getLocalSecret()).update("email-otp-v1").digest();
  return crypto
    .createHmac("sha256", otpKey)
    .update(`email-verify:v1:${input.tokenId}:${input.userId}:${input.code}`)
    .digest("base64url");
}

function safeDigestEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function consumeDummyEmailVerificationCode(code: string) {
  hashEmailVerificationCode({ code: code || "000000", tokenId: "missing", userId: "missing" });
}

function invalidEmailVerificationCodeError() {
  return new AuthError("验证码无效，请检查后重试。", 400, "invalid_email_verification_code");
}

function grantLocalRegistrationBonus(store: AuthStore, user: UserRecord, grantedAt: string) {
  const existing = store.usageEvents.some((event) => event.userId === user.id && event.type === "register_bonus");
  if (!existing) {
    store.usageEvents.push({
      id: createId("usage"),
      userId: user.id,
      type: "register_bonus",
      minutes: FREE_TRIAL_MINUTES,
      createdAt: grantedAt,
      note: "Free plan official trial quota",
    });
  }
  user.freeTrialGrantedAt = existing && user.freeTrialGrantedAt ? user.freeTrialGrantedAt : grantedAt;
  user.freeTrialMinutesTotal = Math.max(FREE_TRIAL_MINUTES, user.freeTrialMinutesTotal || 0);
  user.freeTrialMinutesUsed = Math.min(user.freeTrialMinutesTotal, Math.max(0, user.freeTrialMinutesUsed || 0));
  if (user.plan === "free") {
    user.officialMinutesTotal = user.freeTrialMinutesTotal;
    user.officialMinutesUsed = user.freeTrialMinutesUsed;
    user.officialMinutesPeriodStartAt = user.freeTrialGrantedAt;
    user.officialMinutesPeriodEndAt = undefined;
    user.officialMinutesPeriodSource = FREE_TRIAL_SOURCE;
    user.officialMinutesBillingOrderId = undefined;
  }
}

async function encryptSecret(secret: string, credential: Pick<ProviderCredentialRecord, "providerId" | "userId">, secretName: string) {
  return encryptProviderSecret(secret, { ...credential, localSecretPath: SECRET_PATH, secretName });
}

async function decryptSecret(encrypted: string, credential: Pick<ProviderCredentialRecord, "providerId" | "userId">, secretName: string) {
  try {
    return await decryptProviderSecret(encrypted, { ...credential, localSecretPath: SECRET_PATH, secretName });
  } catch {
    throw new AuthError("Provider 密钥格式无效，请重新保存。", 500);
  }
}

function sanitizeRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [key.trim(), value.trim()])
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

function sanitizeNameList(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function previewSecret(secret: string) {
  if (secret.length <= 8) return "已保存";
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

function summarizeCredential(credential: ProviderCredentialRecord): ProviderCredentialSummary {
  return {
    id: credential.id,
    providerId: credential.providerId,
    label: credential.label,
    configuredFields: Object.keys(credential.fields),
    configuredSecrets: Object.keys(credential.encryptedSecrets),
    secretPreviews: credential.secretPreviews,
    updatedAt: credential.updatedAt,
  };
}

function toSafeUser(user: UserRecord): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    createdAt: user.createdAt,
    emailVerifiedAt: user.emailVerifiedAt,
    officialMinutesTotal: user.officialMinutesTotal,
    officialMinutesUsed: user.officialMinutesUsed,
    processingMode: user.processingMode,
  };
}

function getLocalByokCoverage(store: AuthStore, userId: string) {
  return getByokCoverage(store.providerCredentials
    .filter((credential) => credential.userId === userId)
    .map((credential) => ({
      providerId: credential.providerId,
      configuredFields: Object.keys(credential.fields),
      configuredSecrets: Object.keys(credential.encryptedSecrets),
    })));
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeRegisterSource(value: unknown): GrowthEventRecord["source"] {
  return value === "share" ? "share" : "direct";
}

function normalizeShareAttributionId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 120);
  return normalized || undefined;
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}
