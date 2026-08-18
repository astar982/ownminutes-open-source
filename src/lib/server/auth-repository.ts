import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  assertSecretAuditOutboxPayloadSafe,
  assertSecretAuditSinkWritable,
  createSecretAuditEvent,
  deliverSecretAuditEvent,
  getSecretAuditErrorCode,
  getSecretAuditOutboxLeaseMs,
  getSecretAuditOutboxMaxPendingAgeMs,
  getSecretAuditOutboxPollMs,
  getSecretAuditOutboxRetryDelayMs,
  type SecretAuditEvent,
  type SecretAuditOutboxFlushResult,
  type SecretAuditOutboxInfo,
} from "@/lib/server/secret-audit";
import { decryptProviderSecret, deleteProviderSecretReference, encryptProviderSecret } from "@/lib/server/secret-provider";
import {
  getPostgresDatabaseUrl,
  getPostgresRuntimePool,
  getRuntimeInstanceId,
  type PgClient,
  type PgPool,
} from "@/lib/server/postgres-runtime";
import { roleForPublicRegistration } from "@/lib/server/registration-policy";
import { isEmailVerificationRequired } from "@/lib/server/email-verification-policy";
import {
  archiveAndDeletePostgresMeetingProcessingLedger,
  archiveAndDeletePostgresProcessingLedger,
} from "@/lib/server/account-deletion-processing-ledger";
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
import {
  AuthError,
  bindAppleIapAccount as localBindAppleIapAccount,
  changePassword as localChangePassword,
  claimMeetingProviderStep as localClaimMeetingProviderStep,
  completeMeetingProviderStep as localCompleteMeetingProviderStep,
  reconcileLocalAccountDeletionProcessing as localReconcileAccountDeletionProcessing,
  reconcileMeetingProviderStep as localReconcileMeetingProviderStep,
  updateAdminEntitlementGrantStatus as localUpdateAdminEntitlementGrantStatus,
  adminGrantUserPlan as localAdminGrantUserPlan,
  createSession as localCreateSession,
  deleteAccount as localDeleteAccount,
  deleteProviderCredential as localDeleteProviderCredential,
  destroySession as localDestroySession,
  flushLocalSecretAuditOutboxOnce,
  getLocalSecretAuditOutboxInfo,
  getAdminCommercialMetrics as localGetAdminCommercialMetrics,
  getAdminFunnel as localGetAdminFunnel,
  getAdminGrowthMetrics as localGetAdminGrowthMetrics,
  getAdminMetrics as localGetAdminMetrics,
  getProviderRuntimeConfig as localGetProviderRuntimeConfig,
  getMeetingProcessingReservation as localGetMeetingProcessingReservation,
  getUserById as localGetUserById,
  getUserBySessionToken as localGetUserBySessionToken,
  getUserUsage as localGetUserUsage,
  getUserProcessingMode as localGetUserProcessingMode,
  purgeMeetingProcessingLedger as localPurgeMeetingProcessingLedger,
  listAdminBillingOrders as localListAdminBillingOrders,
  listAdminEntitlementGrants as localListAdminEntitlementGrants,
  listAdminUsers as localListAdminUsers,
  listProviderCredentials as localListProviderCredentials,
  loginUser as localLoginUser,
  requestPasswordReset as localRequestPasswordReset,
  requestEmailVerification as localRequestEmailVerification,
  resetPasswordWithToken as localResetPasswordWithToken,
  verifyEmailWithToken as localVerifyEmailWithToken,
  verifyEmailWithCode as localVerifyEmailWithCode,
  recordAppleIapNotification as localRecordAppleIapNotification,
  recordAppleIapPurchase as localRecordAppleIapPurchase,
  recordMeetingFinalizeUsage as localRecordMeetingFinalizeUsage,
  rejectMeetingProviderStep as localRejectMeetingProviderStep,
  releaseMeetingProcessingReservation as localReleaseMeetingProcessingReservation,
  releaseMeetingProviderStep as localReleaseMeetingProviderStep,
  reserveMeetingFinalizationQuota as localReserveMeetingFinalizationQuota,
  reserveMeetingRealtimeQuota as localReserveMeetingRealtimeQuota,
  startMeetingProviderStep as localStartMeetingProviderStep,
  registerUser as localRegisterUser,
  saveProviderCredential as localSaveProviderCredential,
  updateUserProcessingMode as localUpdateUserProcessingMode,
  SESSION_COOKIE_NAME,
  updateUserPlan as localUpdateUserPlan,
  type AppleIapNotificationInput,
  type AppleIapNotificationResult,
  type AppleIapPurchaseInput,
  type AppleIapPurchaseResult,
  type AdminCommercialMetrics,
  type AdminEntitlementGrantStatusInput,
  type AdminGrowthMetrics,
  type AdminMetrics,
  type AdminPlanGrantInput,
  type AdminUserSummary,
  type BillingOrderProvider,
  type BillingOrderStatus,
  type BillingOrderSummary,
  type BillingPlanId,
  type ChangePasswordInput,
  type EntitlementGrantSource,
  type EntitlementGrantStatus,
  type EntitlementGrantSummary,
  type ProviderCredentialInput,
  type ProviderCredentialSummary,
  type ProviderRuntimeConfig,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
  type PasswordResetRequestResult,
  type EmailVerificationRequestResult,
  type EmailVerificationCodeConfirmInput,
  type RegisterAttributionInput,
  type SafeUser,
  type UserUsageSummary,
} from "@/lib/server/auth-store";

export { AuthError, SESSION_COOKIE_NAME };
export type {
  AdminCommercialMetrics,
  AdminEntitlementGrantStatusInput,
  AdminGrowthMetrics,
  AdminMetrics,
  AdminPlanGrantInput,
  AdminUserSummary,
  AppleIapNotificationInput,
  AppleIapNotificationResult,
  AppleIapPurchaseInput,
  AppleIapPurchaseResult,
  BillingOrderProvider,
  BillingOrderStatus,
  BillingOrderSummary,
  BillingPlanId,
  ChangePasswordInput,
  EntitlementGrantSource,
  EntitlementGrantStatus,
  EntitlementGrantSummary,
  ProviderCredentialInput,
  ProviderCredentialSummary,
  ProviderRuntimeConfig,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  PasswordResetRequestResult,
  EmailVerificationRequestResult,
  EmailVerificationCodeConfirmInput,
  RegisterAttributionInput,
  SafeUser,
  UserUsageSummary,
  UserProcessingMode,
};

export type AuthRepositoryProvider = "local-file" | "postgres";
type Awaitable<T> = T | Promise<T>;

export type AuthRepository = {
  adminGrantUserPlan(input: AdminPlanGrantInput): Awaitable<SafeUser>;
  bindAppleIapAccount(userId: string, appAccountToken: string, keyVersion?: string): Awaitable<void>;
  changePassword(userId: string, input: ChangePasswordInput): Awaitable<SafeUser>;
  claimMeetingProviderStep(userId: string, input: ClaimMeetingProviderStepInput): Awaitable<MeetingProviderStepClaimResult>;
  completeMeetingProviderStep(userId: string, input: CompleteMeetingProviderStepInput): Awaitable<MeetingProviderStepTransitionResult>;
  reconcileMeetingProviderStep(userId: string, input: ReconcileMeetingProviderStepInput): Awaitable<MeetingProviderStepTransitionResult>;
  createSession(userId: string): Awaitable<{ maxAge: number; token: string }>;
  deleteAccount(userId: string): Awaitable<void>;
  deleteProviderCredential(userId: string, providerId: string): Awaitable<void>;
  destroySession(token?: string | null): Awaitable<void>;
  getAdminCommercialMetrics(): Awaitable<AdminCommercialMetrics>;
  getAdminFunnel(): Awaitable<Array<{ label: string; value: number }>>;
  getAdminGrowthMetrics(): Awaitable<AdminGrowthMetrics>;
  getAdminMetrics(): Awaitable<AdminMetrics>;
  getProviderRuntimeConfig(userId: string, providerId: string): Awaitable<ProviderRuntimeConfig | null>;
  getMeetingProcessingReservation(userId: string, operationKey: string): Awaitable<MeetingProcessingReservation | null>;
  purgeMeetingProcessingLedger(userId: string, meetingId: string): Awaitable<void>;
  getUserById(userId: string): Awaitable<SafeUser | null>;
  getUserBySessionToken(token?: string | null): Awaitable<SafeUser | null>;
  getUserUsage(userId: string): Awaitable<UserUsageSummary>;
  getUserProcessingMode(userId: string): Awaitable<UserProcessingMode>;
  listAdminBillingOrders(limit?: number): Awaitable<BillingOrderSummary[]>;
  listAdminEntitlementGrants(limit?: number): Awaitable<EntitlementGrantSummary[]>;
  listAdminUsers(): Awaitable<AdminUserSummary[]>;
  listProviderCredentials(userId: string): Awaitable<ProviderCredentialSummary[]>;
  loginUser(input: { email: string; password: string }): Awaitable<SafeUser>;
  requestPasswordReset(input: PasswordResetRequestInput): Awaitable<PasswordResetRequestResult>;
  requestEmailVerification(input: { email: string }): Awaitable<EmailVerificationRequestResult>;
  resetPasswordWithToken(input: PasswordResetConfirmInput): Awaitable<SafeUser>;
  verifyEmailWithToken(token: string): Awaitable<SafeUser>;
  verifyEmailWithCode(input: EmailVerificationCodeConfirmInput): Awaitable<SafeUser>;
  recordAppleIapNotification(input: AppleIapNotificationInput): Awaitable<AppleIapNotificationResult>;
  recordAppleIapPurchase(input: AppleIapPurchaseInput): Awaitable<AppleIapPurchaseResult>;
  recordMeetingFinalizeUsage(userId: string, input: { durationMs: number; meetingId: string; route: MeetingProcessingRoute; resultGeneratedAt: string; isReprocess?: boolean; nonBillable?: boolean; reservationId?: string; reservationOperationKey?: string }): Awaitable<UserUsageSummary>;
  rejectMeetingProviderStep(userId: string, input: RejectMeetingProviderStepInput): Awaitable<MeetingProviderStepTransitionResult>;
  releaseMeetingProcessingReservation(userId: string, input: ReleaseMeetingProcessingReservationInput): Awaitable<MeetingProcessingReservation>;
  releaseMeetingProviderStep(userId: string, input: ReleaseMeetingProviderStepInput): Awaitable<MeetingProviderStepTransitionResult>;
  reserveMeetingFinalizationQuota(userId: string, input: ReserveFinalizationQuotaInput): Awaitable<MeetingProcessingReservation>;
  reserveMeetingRealtimeQuota(userId: string, input: ReserveRealtimeQuotaInput): Awaitable<RealtimeQuotaClaim>;
  startMeetingProviderStep(userId: string, input: StartMeetingProviderStepInput): Awaitable<MeetingProviderStepTransitionResult>;
  registerUser(input: { attribution?: RegisterAttributionInput; email: string; name: string; password: string }): Awaitable<SafeUser>;
  saveProviderCredential(userId: string, input: ProviderCredentialInput): Awaitable<ProviderCredentialSummary>;
  updateAdminEntitlementGrantStatus(input: AdminEntitlementGrantStatusInput): Awaitable<EntitlementGrantSummary>;
  updateUserPlan(userId: string, plan: BillingPlanId): Awaitable<SafeUser>;
  updateUserProcessingMode(userId: string, processingMode: UserProcessingMode): Awaitable<SafeUser>;
};

type SecretAuditOutboxWorkerRuntime = {
  nextMaintenanceAt: number;
  started: boolean;
  workerId: string;
};

const secretAuditOutboxWorkerKey = Symbol.for("ownminutes.secret-audit-outbox-worker");
const globalSecretAuditOutboxWorker = globalThis as typeof globalThis & {
  [secretAuditOutboxWorkerKey]?: SecretAuditOutboxWorkerRuntime;
};

export function getAuthRepository(): AuthRepository {
  const provider = getAuthRepositoryProvider();
  if (provider === "postgres") return postgresAuthRepository;
  return localAuthRepository;
}

export function getAuthRepositoryInfo() {
  const provider = getAuthRepositoryProvider();
  const databaseUrl = getDatabaseUrl();
  return {
    provider,
    productionReady: provider === "postgres" && Boolean(databaseUrl),
    supportsRuntimeWrites: provider === "local-file" || (provider === "postgres" && Boolean(databaseUrl)),
    notes:
      provider === "postgres"
        ? databaseUrl
          ? ["PostgreSQL repository is selected and runtime CRUD is enabled."]
          : ["PostgreSQL repository is selected, but DATABASE_URL or POSTGRES_URL is missing."]
        : ["Local file repository is active. PostgreSQL schema, export, and migration runner are available for migration preparation."],
  };
}

export async function flushSecretAuditOutboxOnce(
  workerId = createSecretAuditOutboxWorkerId(),
): Promise<SecretAuditOutboxFlushResult> {
  if (getAuthRepositoryProvider() === "postgres") {
    return postgresFlushSecretAuditOutboxOnce(workerId);
  }
  return flushLocalSecretAuditOutboxOnce(workerId);
}

export async function getSecretAuditOutboxInfo(): Promise<SecretAuditOutboxInfo> {
  if (getAuthRepositoryProvider() === "postgres") {
    return postgresGetSecretAuditOutboxInfo();
  }
  return getLocalSecretAuditOutboxInfo();
}

export async function maintainSecretAuditOutboxOnce(): Promise<number> {
  if (getAuthRepositoryProvider() !== "postgres") return 0;
  return cleanupDeliveredPostgresSecretAuditOutbox();
}

export function startSecretAuditOutboxWorker() {
  if (globalSecretAuditOutboxWorker[secretAuditOutboxWorkerKey]?.started) {
    return globalSecretAuditOutboxWorker[secretAuditOutboxWorkerKey];
  }
  const workerId = createSecretAuditOutboxWorkerId();
  const runtime = { nextMaintenanceAt: 0, started: true, workerId };
  globalSecretAuditOutboxWorker[secretAuditOutboxWorkerKey] = runtime;

  void (async () => {
    while (globalSecretAuditOutboxWorker[secretAuditOutboxWorkerKey]?.started) {
      if (Date.now() >= runtime.nextMaintenanceAt) {
        runtime.nextMaintenanceAt =
          Date.now() + SECRET_AUDIT_DELIVERED_MAINTENANCE_INTERVAL_MS;
        try {
          await maintainSecretAuditOutboxOnce();
        } catch (error) {
          console.error("Secret audit delivered-outbox maintenance failed.", {
            code: getSecretAuditErrorCode(error),
          });
        }
      }
      try {
        const result = await flushSecretAuditOutboxOnce(workerId);
        if (!result.claimed || !result.delivered) {
          await secretAuditOutboxDelay(getSecretAuditOutboxPollMs());
        }
      } catch (error) {
        console.error("Secret audit outbox worker failed.", {
          code: getSecretAuditErrorCode(error),
        });
        await secretAuditOutboxDelay(getSecretAuditOutboxPollMs());
      }
    }
  })();

  return runtime;
}

function getAuthRepositoryProvider(): AuthRepositoryProvider {
  return process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" ? "postgres" : "local-file";
}

export function createSession(userId: string) {
  return getAuthRepository().createSession(userId);
}

export function adminGrantUserPlan(input: AdminPlanGrantInput) {
  return getAuthRepository().adminGrantUserPlan(input);
}

export function bindAppleIapAccount(userId: string, appAccountToken: string, keyVersion?: string) {
  return getAuthRepository().bindAppleIapAccount(userId, appAccountToken, keyVersion);
}

export function changePassword(userId: string, input: ChangePasswordInput) {
  return getAuthRepository().changePassword(userId, input);
}

export function updateAdminEntitlementGrantStatus(input: AdminEntitlementGrantStatusInput) {
  return getAuthRepository().updateAdminEntitlementGrantStatus(input);
}

export function deleteAccount(userId: string) {
  return getAuthRepository().deleteAccount(userId);
}

export function reconcileLocalAccountDeletionProcessing(userId: string) {
  return localReconcileAccountDeletionProcessing(userId);
}

export function deleteProviderCredential(userId: string, providerId: string) {
  return getAuthRepository().deleteProviderCredential(userId, providerId);
}

export function destroySession(token?: string | null) {
  return getAuthRepository().destroySession(token);
}

export function getAdminCommercialMetrics() {
  return getAuthRepository().getAdminCommercialMetrics();
}

export function getAdminFunnel() {
  return getAuthRepository().getAdminFunnel();
}

export function getAdminGrowthMetrics() {
  return getAuthRepository().getAdminGrowthMetrics();
}

export function getAdminMetrics() {
  return getAuthRepository().getAdminMetrics();
}

export function getProviderRuntimeConfig(userId: string, providerId: string) {
  return getAuthRepository().getProviderRuntimeConfig(userId, providerId);
}

export function getMeetingProcessingReservation(userId: string, operationKey: string) {
  return getAuthRepository().getMeetingProcessingReservation(userId, operationKey);
}

export function getUserBySessionToken(token?: string | null) {
  return getAuthRepository().getUserBySessionToken(token);
}

export function getUserById(userId: string) {
  return getAuthRepository().getUserById(userId);
}

export function getUserUsage(userId: string) {
  return getAuthRepository().getUserUsage(userId);
}

export function getUserProcessingMode(userId: string) {
  return getAuthRepository().getUserProcessingMode(userId);
}

export function listAdminUsers() {
  return getAuthRepository().listAdminUsers();
}

export function listAdminBillingOrders(limit?: number) {
  return getAuthRepository().listAdminBillingOrders(limit);
}

export function listAdminEntitlementGrants(limit?: number) {
  return getAuthRepository().listAdminEntitlementGrants(limit);
}

export function listProviderCredentials(userId: string) {
  return getAuthRepository().listProviderCredentials(userId);
}

export function loginUser(input: { email: string; password: string }) {
  return getAuthRepository().loginUser(input);
}

export function requestPasswordReset(input: PasswordResetRequestInput) {
  return getAuthRepository().requestPasswordReset(input);
}

export function requestEmailVerification(input: { email: string }) {
  return getAuthRepository().requestEmailVerification(input);
}

export function resetPasswordWithToken(input: PasswordResetConfirmInput) {
  return getAuthRepository().resetPasswordWithToken(input);
}

export function verifyEmailWithToken(token: string) {
  return getAuthRepository().verifyEmailWithToken(token);
}

export function verifyEmailWithCode(input: EmailVerificationCodeConfirmInput) {
  return getAuthRepository().verifyEmailWithCode(input);
}

export function recordAppleIapNotification(input: AppleIapNotificationInput) {
  return getAuthRepository().recordAppleIapNotification(input);
}

export function recordAppleIapPurchase(input: AppleIapPurchaseInput) {
  return getAuthRepository().recordAppleIapPurchase(input);
}

export function recordMeetingFinalizeUsage(userId: string, input: { durationMs: number; meetingId: string; route: MeetingProcessingRoute; resultGeneratedAt: string; isReprocess?: boolean; nonBillable?: boolean; reservationId?: string; reservationOperationKey?: string }) {
  return getAuthRepository().recordMeetingFinalizeUsage(userId, input);
}

export async function claimMeetingProviderStep(userId: string, input: ClaimMeetingProviderStepInput) {
  return await getAuthRepository().claimMeetingProviderStep(userId, input);
}

export async function startMeetingProviderStep(userId: string, input: StartMeetingProviderStepInput) {
  return await getAuthRepository().startMeetingProviderStep(userId, input);
}

export async function completeMeetingProviderStep(userId: string, input: CompleteMeetingProviderStepInput) {
  return await getAuthRepository().completeMeetingProviderStep(userId, input);
}

export async function reconcileMeetingProviderStep(userId: string, input: ReconcileMeetingProviderStepInput) {
  return await getAuthRepository().reconcileMeetingProviderStep(userId, input);
}

export async function releaseMeetingProviderStep(userId: string, input: ReleaseMeetingProviderStepInput) {
  return await getAuthRepository().releaseMeetingProviderStep(userId, input);
}

export async function rejectMeetingProviderStep(userId: string, input: RejectMeetingProviderStepInput) {
  return await getAuthRepository().rejectMeetingProviderStep(userId, input);
}

export async function releaseMeetingProcessingReservation(userId: string, input: ReleaseMeetingProcessingReservationInput) {
  return await getAuthRepository().releaseMeetingProcessingReservation(userId, input);
}

export function reserveMeetingFinalizationQuota(userId: string, input: ReserveFinalizationQuotaInput) {
  return getAuthRepository().reserveMeetingFinalizationQuota(userId, input);
}

export function purgeMeetingProcessingLedger(userId: string, meetingId: string) {
  return getAuthRepository().purgeMeetingProcessingLedger(userId, meetingId);
}

export function reserveMeetingRealtimeQuota(userId: string, input: ReserveRealtimeQuotaInput) {
  return getAuthRepository().reserveMeetingRealtimeQuota(userId, input);
}

export function registerUser(input: { attribution?: RegisterAttributionInput; email: string; name: string; password: string }) {
  return getAuthRepository().registerUser(input);
}

export function saveProviderCredential(userId: string, input: ProviderCredentialInput) {
  return getAuthRepository().saveProviderCredential(userId, input);
}

export function updateUserPlan(userId: string, plan: BillingPlanId) {
  return getAuthRepository().updateUserPlan(userId, plan);
}

export function updateUserProcessingMode(userId: string, processingMode: UserProcessingMode) {
  return getAuthRepository().updateUserProcessingMode(userId, processingMode);
}

const localAuthRepository: AuthRepository = {
  adminGrantUserPlan: localAdminGrantUserPlan,
  bindAppleIapAccount: localBindAppleIapAccount,
  changePassword: localChangePassword,
  claimMeetingProviderStep: localClaimMeetingProviderStep,
  completeMeetingProviderStep: localCompleteMeetingProviderStep,
  reconcileMeetingProviderStep: localReconcileMeetingProviderStep,
  createSession: localCreateSession,
  deleteAccount: localDeleteAccount,
  deleteProviderCredential: localDeleteProviderCredential,
  destroySession: localDestroySession,
  getAdminCommercialMetrics: localGetAdminCommercialMetrics,
  getAdminFunnel: localGetAdminFunnel,
  getAdminGrowthMetrics: localGetAdminGrowthMetrics,
  getAdminMetrics: localGetAdminMetrics,
  getProviderRuntimeConfig: localGetProviderRuntimeConfig,
  getMeetingProcessingReservation: localGetMeetingProcessingReservation,
  purgeMeetingProcessingLedger: localPurgeMeetingProcessingLedger,
  getUserById: localGetUserById,
  getUserBySessionToken: localGetUserBySessionToken,
  getUserUsage: localGetUserUsage,
  getUserProcessingMode: localGetUserProcessingMode,
  listAdminBillingOrders: localListAdminBillingOrders,
  listAdminEntitlementGrants: localListAdminEntitlementGrants,
  listAdminUsers: localListAdminUsers,
  listProviderCredentials: localListProviderCredentials,
  loginUser: localLoginUser,
  requestPasswordReset: localRequestPasswordReset,
  requestEmailVerification: localRequestEmailVerification,
  resetPasswordWithToken: localResetPasswordWithToken,
  verifyEmailWithToken: localVerifyEmailWithToken,
  verifyEmailWithCode: localVerifyEmailWithCode,
  recordAppleIapNotification: localRecordAppleIapNotification,
  recordAppleIapPurchase: localRecordAppleIapPurchase,
  recordMeetingFinalizeUsage: localRecordMeetingFinalizeUsage,
  rejectMeetingProviderStep: localRejectMeetingProviderStep,
  releaseMeetingProcessingReservation: localReleaseMeetingProcessingReservation,
  releaseMeetingProviderStep: localReleaseMeetingProviderStep,
  reserveMeetingFinalizationQuota: localReserveMeetingFinalizationQuota,
  reserveMeetingRealtimeQuota: localReserveMeetingRealtimeQuota,
  startMeetingProviderStep: localStartMeetingProviderStep,
  registerUser: localRegisterUser,
  saveProviderCredential: localSaveProviderCredential,
  updateAdminEntitlementGrantStatus: localUpdateAdminEntitlementGrantStatus,
  updateUserPlan: localUpdateUserPlan,
  updateUserProcessingMode: localUpdateUserProcessingMode,
};

const postgresAuthRepository: AuthRepository = {
  adminGrantUserPlan: postgresAdminGrantUserPlan,
  bindAppleIapAccount: postgresBindAppleIapAccount,
  changePassword: postgresChangePassword,
  claimMeetingProviderStep: postgresClaimMeetingProviderStep,
  completeMeetingProviderStep: postgresCompleteMeetingProviderStep,
  reconcileMeetingProviderStep: postgresReconcileMeetingProviderStep,
  createSession: postgresCreateSession,
  deleteAccount: postgresDeleteAccount,
  deleteProviderCredential: postgresDeleteProviderCredential,
  destroySession: postgresDestroySession,
  getAdminCommercialMetrics: postgresGetAdminCommercialMetrics,
  getAdminFunnel: postgresGetAdminFunnel,
  getAdminGrowthMetrics: postgresGetAdminGrowthMetrics,
  getAdminMetrics: postgresGetAdminMetrics,
  getProviderRuntimeConfig: postgresGetProviderRuntimeConfig,
  getMeetingProcessingReservation: postgresGetMeetingProcessingReservation,
  purgeMeetingProcessingLedger: postgresPurgeMeetingProcessingLedger,
  getUserById: postgresGetUserById,
  getUserBySessionToken: postgresGetUserBySessionToken,
  getUserUsage: postgresGetUserUsage,
  getUserProcessingMode: postgresGetUserProcessingMode,
  listAdminBillingOrders: postgresListAdminBillingOrders,
  listAdminEntitlementGrants: postgresListAdminEntitlementGrants,
  listAdminUsers: postgresListAdminUsers,
  listProviderCredentials: postgresListProviderCredentials,
  loginUser: postgresLoginUser,
  requestPasswordReset: postgresRequestPasswordReset,
  requestEmailVerification: postgresRequestEmailVerification,
  resetPasswordWithToken: postgresResetPasswordWithToken,
  verifyEmailWithToken: postgresVerifyEmailWithToken,
  verifyEmailWithCode: postgresVerifyEmailWithCode,
  recordAppleIapNotification: postgresRecordAppleIapNotification,
  recordAppleIapPurchase: postgresRecordAppleIapPurchase,
  recordMeetingFinalizeUsage: postgresRecordMeetingFinalizeUsage,
  rejectMeetingProviderStep: postgresRejectMeetingProviderStep,
  releaseMeetingProcessingReservation: postgresReleaseMeetingProcessingReservation,
  releaseMeetingProviderStep: postgresReleaseMeetingProviderStep,
  reserveMeetingFinalizationQuota: postgresReserveMeetingFinalizationQuota,
  reserveMeetingRealtimeQuota: postgresReserveMeetingRealtimeQuota,
  startMeetingProviderStep: postgresStartMeetingProviderStep,
  registerUser: postgresRegisterUser,
  saveProviderCredential: postgresSaveProviderCredential,
  updateAdminEntitlementGrantStatus: postgresUpdateAdminEntitlementGrantStatus,
  updateUserPlan: postgresUpdateUserPlan,
  updateUserProcessingMode: postgresUpdateUserProcessingMode,
};

type PgRow = Record<string, unknown>;

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  plan: BillingPlanId;
  processing_mode: UserProcessingMode;
  free_trial_granted_at?: Date | string | null;
  free_trial_minutes_total: number;
  free_trial_minutes_used: number;
  official_minutes_total: number;
  official_minutes_used: number;
  official_minutes_period_start_at?: Date | string | null;
  official_minutes_period_end_at?: Date | string | null;
  official_minutes_period_source?: string | null;
  official_minutes_billing_order_id?: string | null;
  password_salt: string;
  password_hash: string;
  created_at: Date | string;
  email_verified_at?: Date | string | null;
  deleted_at?: Date | string | null;
};

type ProviderCredentialRow = {
  id: string;
  user_id: string;
  provider_id: string;
  label: string;
  fields: Record<string, string> | string;
  encrypted_secrets: Record<string, string> | string;
  secret_previews: Record<string, string> | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type SecretAuditOutboxRow = {
  attempt_count: number;
  available_at: Date | string;
  claim_token?: string | null;
  created_at: Date | string;
  event_id: string;
  last_error_code?: string | null;
  lease_expires_at?: Date | string | null;
  locked_by?: string | null;
  payload: SecretAuditEvent | string;
};

type UsageEventRow = {
  id: string;
  user_id: string;
  type: "register_bonus" | "meeting_finalize" | "manual_adjustment";
  minutes: number;
  created_at: Date | string;
  note: string;
  processing_reservation_id?: string | null;
};

type MeetingProcessingReservationRow = {
  id: string;
  user_id: string;
  meeting_id: string;
  operation_key: string;
  processing_route: MeetingProcessingRoute;
  status: "reserved" | "finalized";
  processed_minutes: number;
  official_minutes_reserved: number;
  official_minutes_settled: number;
  realtime_duration_ms: number | string;
  realtime_highest_sequence: number;
  reservation_expires_at: Date | string;
  released_at?: Date | string | null;
  quota_period_source?: string | null;
  quota_period_start_at?: Date | string | null;
  quota_billing_order_id?: string | null;
  result_generated_at?: Date | string | null;
  finalized_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type MeetingProviderStepRow = {
  id: string;
  reservation_id: string;
  user_id: string;
  stage_key: string;
  stage_type: MeetingProviderStep["stageType"];
  sequence?: number | null;
  status: MeetingProviderStep["status"];
  claim_token_hash: string;
  lease_expires_at: Date | string;
  official_minutes_settled: number;
  free_trial_minutes_settled: number;
  settlement_period_identity?: string | null;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
  released_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type GrowthEventRow = {
  id: string;
  user_id: string;
  type: "register";
  source: "direct" | "share";
  share_id?: string | null;
  created_at: Date | string;
};

type PasswordResetTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date | string;
  expires_at: Date | string;
  used_at?: Date | string | null;
};

type EmailVerificationTokenRow = PasswordResetTokenRow & {
  credential_kind: "link" | "otp";
  failed_attempts: number;
  locked_at?: Date | string | null;
};

type EntitlementGrantRow = {
  id: string;
  user_id: string;
  billing_order_id?: string | null;
  granted_by_user_id?: string | null;
  source: EntitlementGrantSource;
  status: EntitlementGrantStatus;
  status_changed_by_user_id?: string | null;
  status_reason?: string | null;
  status_updated_at?: Date | string | null;
  previous_plan: BillingPlanId;
  plan: BillingPlanId;
  official_minutes_total: number;
  reason: string;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  created_at: Date | string;
};

type BillingOrderRow = {
  id: string;
  user_id: string;
  created_by_user_id?: string | null;
  provider: BillingOrderProvider;
  status: BillingOrderStatus;
  plan: BillingPlanId;
  amount_cents: number | null;
  price_milliunits?: number | null;
  currency: string;
  environment?: string | null;
  product_id?: string | null;
  storefront?: string | null;
  offer_type?: number | null;
  offer_identifier?: string | null;
  app_account_token?: string | null;
  signed_date?: Date | string | null;
  status_signed_date?: Date | string | null;
  external_transaction_id?: string | null;
  original_transaction_id?: string | null;
  idempotency_key: string;
  period_start_at?: Date | string | null;
  period_end_at?: Date | string | null;
  entitlement_grant_id?: string | null;
  note: string;
  status_reason?: string | null;
  status_updated_at?: Date | string | null;
  created_at: Date | string;
};

type AppleSubscriptionRow = {
  original_transaction_id: string;
  user_id: string;
  current_transaction_id: string;
  product_id: string;
  environment: string;
  status: "active" | "grace" | "billing_retry" | "expired" | "revoked";
  expires_at?: Date | string | null;
  grace_expires_at?: Date | string | null;
  auto_renew_status?: boolean | null;
  last_signed_date?: Date | string | null;
  last_notification_uuid?: string | null;
};

const POSTGRES_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const APPLE_EXPIRY_RECONCILIATION_REASON = "Apple subscription period expired; reconciled from signed expiry";
const FREE_TRIAL_MINUTES = 60;
const FREE_TRIAL_SOURCE = "free_trial";
const EMAIL_VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_VERIFICATION_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
const EMAIL_VERIFICATION_MAX_FAILED_ATTEMPTS = 5;
const PASSWORD_RESET_RESEND_COOLDOWN_MS = 60 * 1000;
const POSTGRES_DATA_DIR = path.join(process.cwd(), ".data", "auth");
const POSTGRES_SECRET_PATH = path.join(POSTGRES_DATA_DIR, "local-secret");
const SECRET_AUDIT_DELIVERED_RETENTION_DAYS = 7;
const SECRET_AUDIT_DELIVERED_CLEANUP_BATCH = 500;
const SECRET_AUDIT_DELIVERED_MAINTENANCE_INTERVAL_MS = 60_000;

async function postgresRegisterUser(input: { attribution?: RegisterAttributionInput; email: string; name: string; password: string }) {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();

  if (!isValidEmail(email)) throw new AuthError("请输入有效邮箱。", 400);
  if (name.length < 2) throw new AuthError("姓名或团队名至少需要 2 个字符。", 400);
  if (input.password.length < 8) throw new AuthError("密码至少需要 8 位。", 400);

  const now = new Date().toISOString();
  const password = hashPassword(input.password);
  const activeUserCount = await postgresScalar<number>("select count(*)::int as value from users where deleted_at is null");
  const verificationRequired = isEmailVerificationRequired();
  const user: UserRow = {
    id: createId("user"),
    email,
    name,
    role: roleForPublicRegistration(activeUserCount),
    plan: "free",
    processing_mode: "official_quota",
    free_trial_granted_at: verificationRequired ? null : now,
    free_trial_minutes_total: verificationRequired ? 0 : FREE_TRIAL_MINUTES,
    free_trial_minutes_used: 0,
    official_minutes_total: verificationRequired ? 0 : FREE_TRIAL_MINUTES,
    official_minutes_used: 0,
    official_minutes_period_start_at: verificationRequired ? null : now,
    official_minutes_period_source: verificationRequired ? null : FREE_TRIAL_SOURCE,
    password_salt: password.salt,
    password_hash: password.hash,
    created_at: now,
    email_verified_at: verificationRequired ? null : now,
  };

  try {
    await postgresTransaction(async (client) => {
      await client.query(
        "insert into users (id, email, name, role, plan, processing_mode, free_trial_minutes_total, free_trial_minutes_used, free_trial_granted_at, official_minutes_total, official_minutes_used, official_minutes_period_start_at, official_minutes_period_end_at, official_minutes_period_source, password_salt, password_hash, created_at, email_verified_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
        [
          user.id,
          user.email,
          user.name,
          user.role,
          user.plan,
          user.processing_mode,
          user.free_trial_minutes_total,
          user.free_trial_minutes_used,
          user.free_trial_granted_at,
          user.official_minutes_total,
          user.official_minutes_used,
          user.official_minutes_period_start_at,
          user.official_minutes_period_end_at,
          user.official_minutes_period_source,
          user.password_salt,
          user.password_hash,
          user.created_at,
          user.email_verified_at,
        ],
      );
      if (!verificationRequired) {
        await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
          createId("usage"),
          user.id,
          "register_bonus",
          FREE_TRIAL_MINUTES,
          now,
          "Free plan official trial quota",
        ]);
      }
      await client.query("insert into growth_events (id, user_id, type, source, share_id, created_at) values ($1,$2,$3,$4,$5,$6)", [
        createId("growth"),
        user.id,
        "register",
        normalizeRegisterSource(input.attribution?.source),
        normalizeShareAttributionId(input.attribution?.shareId) || null,
        now,
      ]);
    });
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      throw new AuthError("该邮箱已经注册，请直接登录。", 409);
    }
    throw error;
  }

  return toSafeUser(user);
}

async function postgresLoginUser(input: { email: string; password: string }) {
  const email = normalizeEmail(input.email);
  const user = await postgresFindActiveUserByEmail(email);

  if (!user || !verifyPassword(input.password, user.password_salt, user.password_hash)) {
    throw new AuthError("邮箱或密码不正确。", 401);
  }
  if (isEmailVerificationRequired() && !user.email_verified_at) {
    throw new AuthError("请先完成邮箱验证。", 403, "email_verification_required");
  }

  return toSafeUser(user);
}

async function postgresRequestEmailVerification(input: { email: string }): Promise<EmailVerificationRequestResult> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { emailSent: true };
  return postgresTransaction(async (client) => {
    const userResult = await client.query<UserRow>("select * from users where lower(email) = $1 and deleted_at is null limit 1 for update", [email]);
    const user = userResult.rows[0];
    if (!user || user.email_verified_at) return { emailSent: true };

    const now = new Date();
    const latestOtpResult = await client.query<Pick<EmailVerificationTokenRow, "created_at">>(
      `select created_at
       from email_verification_tokens
       where user_id = $1 and credential_kind = 'otp'
       order by created_at desc
       limit 1`,
      [user.id],
    );
    const latestOtp = latestOtpResult.rows[0];
    if (latestOtp) {
      const resendAvailableAtMs = new Date(latestOtp.created_at).getTime() + EMAIL_VERIFICATION_RESEND_COOLDOWN_MS;
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
    await client.query("delete from email_verification_tokens where user_id = $1 and used_at is null", [user.id]);
    await client.query("delete from email_verification_tokens where expires_at <= $1 or used_at is not null", [now.toISOString()]);
    await client.query(
      `insert into email_verification_tokens
       (id, user_id, token_hash, credential_kind, failed_attempts, created_at, expires_at)
       values ($1,$2,$3,'link',0,$4,$5)`,
      [linkId, user.id, hashToken(verificationToken), now.toISOString(), expiresAt],
    );
    await client.query(
      `insert into email_verification_tokens
       (id, user_id, token_hash, credential_kind, failed_attempts, created_at, expires_at)
       values ($1,$2,$3,'otp',0,$4,$5)`,
      [
        otpId,
        user.id,
        hashEmailVerificationCode({ code: verificationCode, tokenId: otpId, userId: user.id }),
        now.toISOString(),
        codeExpiresAt,
      ],
    );
    return {
      emailSent: true,
      expiresAt,
      codeExpiresAt,
      resendAvailableAt,
      retryAfterSeconds: Math.ceil(EMAIL_VERIFICATION_RESEND_COOLDOWN_MS / 1000),
      verificationCode,
      verificationToken,
    };
  });
}

async function postgresVerifyEmailWithToken(token: string) {
  if (!token || token.length < 24) throw new AuthError("邮箱验证链接无效或已过期。", 400, "invalid_email_verification_token");
  const tokenHash = hashToken(token);
  const now = new Date();
  return postgresTransaction(async (client) => {
    // Lock the user before the credential so link and OTP confirmation share
    // the same lock order. That avoids a deadlock when both are submitted at
    // nearly the same time during the legacy-client transition window.
    const candidateResult = await client.query<Pick<EmailVerificationTokenRow, "id" | "user_id">>(
      "select id, user_id from email_verification_tokens where credential_kind = 'link' and token_hash = $1 and used_at is null limit 1",
      [tokenHash],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) {
      throw new AuthError("邮箱验证链接无效或已过期。", 400, "invalid_email_verification_token");
    }
    const userResult = await client.query<UserRow>("select * from users where id = $1 and deleted_at is null limit 1 for update", [candidate.user_id]);
    const user = userResult.rows[0];
    if (!user) throw new AuthError("账号不存在或已删除。", 404);
    const tokenResult = await client.query<EmailVerificationTokenRow>(
      "select * from email_verification_tokens where id = $1 and credential_kind = 'link' and token_hash = $2 and used_at is null for update",
      [candidate.id, tokenHash],
    );
    const record = tokenResult.rows[0];
    if (!record || new Date(record.expires_at).getTime() <= now.getTime()) {
      throw new AuthError("邮箱验证链接无效或已过期。", 400, "invalid_email_verification_token");
    }
    const firstVerification = !user.email_verified_at;
    const verifiedAt = user.email_verified_at ? toIsoString(user.email_verified_at) : now.toISOString();
    await client.query("update users set email_verified_at = $1 where id = $2", [verifiedAt, user.id]);
    if (firstVerification) await grantPostgresRegistrationBonus(client, user, verifiedAt);
    await client.query("update email_verification_tokens set used_at = $1 where id = $2", [now.toISOString(), record.id]);
    await client.query("delete from email_verification_tokens where user_id = $1 and id <> $2", [user.id, record.id]);
    const updatedUser = await client.query<UserRow>("select * from users where id = $1 limit 1", [user.id]);
    return toSafeUser(updatedUser.rows[0] || { ...user, email_verified_at: verifiedAt });
  });
}

async function postgresVerifyEmailWithCode(input: EmailVerificationCodeConfirmInput) {
  const email = normalizeEmail(input.email);
  const code = input.code.trim();
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    consumeDummyEmailVerificationCode(code);
    throw invalidEmailVerificationCodeError();
  }

  const result = await postgresTransaction(async (client) => {
    const now = new Date();
    const userResult = await client.query<UserRow>("select * from users where lower(email) = $1 and deleted_at is null limit 1 for update", [email]);
    const user = userResult.rows[0];
    if (!user || user.email_verified_at) {
      consumeDummyEmailVerificationCode(code);
      return { error: invalidEmailVerificationCodeError() };
    }

    const tokenResult = await client.query<EmailVerificationTokenRow>(
      `select *
       from email_verification_tokens
       where user_id = $1 and credential_kind = 'otp' and used_at is null
       order by created_at desc
       limit 1
       for update`,
      [user.id],
    );
    const record = tokenResult.rows[0];
    if (!record) return { error: invalidEmailVerificationCodeError() };
    if (record.locked_at || record.failed_attempts >= EMAIL_VERIFICATION_MAX_FAILED_ATTEMPTS) {
      return { error: new AuthError("验证码尝试次数过多，请重新获取。", 400, "email_verification_code_locked") };
    }
    if (new Date(record.expires_at).getTime() <= now.getTime()) {
      return { error: new AuthError("验证码已过期，请重新获取。", 400, "email_verification_code_expired") };
    }

    const expectedHash = hashEmailVerificationCode({ code, tokenId: record.id, userId: user.id });
    if (!safeDigestEqual(expectedHash, record.token_hash)) {
      const failedAttempts = record.failed_attempts + 1;
      const lockedAt = failedAttempts >= EMAIL_VERIFICATION_MAX_FAILED_ATTEMPTS ? now.toISOString() : null;
      await client.query("update email_verification_tokens set failed_attempts = $1, locked_at = $2 where id = $3", [
        failedAttempts,
        lockedAt,
        record.id,
      ]);
      return {
        error: lockedAt
          ? new AuthError("验证码尝试次数过多，请重新获取。", 400, "email_verification_code_locked")
          : invalidEmailVerificationCodeError(),
      };
    }

    const verifiedAt = now.toISOString();
    await client.query("update users set email_verified_at = $1 where id = $2", [verifiedAt, user.id]);
    await grantPostgresRegistrationBonus(client, user, verifiedAt);
    await client.query("update email_verification_tokens set used_at = $1 where id = $2", [verifiedAt, record.id]);
    await client.query("delete from email_verification_tokens where user_id = $1 and id <> $2", [user.id, record.id]);
    const updatedUser = await client.query<UserRow>("select * from users where id = $1 limit 1", [user.id]);
    return { user: toSafeUser(updatedUser.rows[0]) };
  });

  if (result.error) throw result.error;
  if (!result.user) throw invalidEmailVerificationCodeError();
  return result.user;
}

async function postgresChangePassword(userId: string, input: ChangePasswordInput) {
  if (input.newPassword.length < 8) throw new AuthError("新密码至少需要 8 位。", 400);
  if (input.currentPassword === input.newPassword) throw new AuthError("新密码不能和当前密码相同。", 400);

  const user = await postgresFindActiveUserById(userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  if (!verifyPassword(input.currentPassword, user.password_salt, user.password_hash)) {
    throw new AuthError("当前密码不正确。", 401);
  }

  const nextPassword = hashPassword(input.newPassword);
  await postgresTransaction(async (client) => {
    await client.query("update users set password_salt = $1, password_hash = $2 where id = $3 and deleted_at is null", [
      nextPassword.salt,
      nextPassword.hash,
      userId,
    ]);
    const currentTokenHash = input.currentSessionToken ? hashToken(input.currentSessionToken) : null;
    if (currentTokenHash) {
      await client.query("delete from sessions where user_id = $1 and token_hash <> $2", [userId, currentTokenHash]);
    } else {
      await client.query("delete from sessions where user_id = $1", [userId]);
    }
  });

  return {
    ...toSafeUser(user),
  };
}

async function postgresRequestPasswordReset(input: PasswordResetRequestInput): Promise<PasswordResetRequestResult> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return { emailSent: true };
  }

  return postgresTransaction(async (client) => {
    const userResult = await client.query<UserRow>(
      "select * from users where lower(email) = $1 and deleted_at is null limit 1 for update",
      [email],
    );
    const user = userResult.rows[0];
    if (!user) return { emailSent: true };

    const now = new Date();
    const latestResetResult = await client.query<Pick<PasswordResetTokenRow, "created_at">>(
      `select created_at
       from password_reset_tokens
       where user_id = $1 and used_at is null
       order by created_at desc
       limit 1`,
      [user.id],
    );
    const latestReset = latestResetResult.rows[0];
    if (latestReset && new Date(latestReset.created_at).getTime() + PASSWORD_RESET_RESEND_COOLDOWN_MS > now.getTime()) {
      return { emailSent: true };
    }

    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const resetToken = crypto.randomBytes(32).toString("base64url");
    await client.query("delete from password_reset_tokens where user_id = $1 and used_at is null", [user.id]);
    await client.query("delete from password_reset_tokens where expires_at <= $1 or used_at is not null", [now.toISOString()]);
    await client.query(
      "insert into password_reset_tokens (id, user_id, token_hash, created_at, expires_at) values ($1,$2,$3,$4,$5)",
      [createId("reset"), user.id, hashToken(resetToken), now.toISOString(), expiresAt],
    );
    return {
      emailSent: true,
      expiresAt,
      resetToken,
    };
  });
}

async function postgresResetPasswordWithToken(input: PasswordResetConfirmInput) {
  if (input.newPassword.length < 8) throw new AuthError("新密码至少需要 8 位。", 400);
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(input.token)) throw new AuthError("重置链接无效或已过期。", 400);

  const tokenHash = hashToken(input.token);
  const now = new Date();

  return postgresTransaction(async (client) => {
    const tokenResult = await client.query<PasswordResetTokenRow>(
      "select * from password_reset_tokens where token_hash = $1 and used_at is null for update",
      [tokenHash],
    );
    const resetToken = tokenResult.rows[0];
    if (!resetToken || new Date(resetToken.expires_at).getTime() <= now.getTime()) {
      throw new AuthError("重置链接无效或已过期。", 400);
    }

    const userResult = await client.query<UserRow>("select * from users where id = $1 and deleted_at is null limit 1", [resetToken.user_id]);
    const user = userResult.rows[0];
    if (!user) throw new AuthError("账号不存在或已删除。", 404);

    const nextPassword = hashPassword(input.newPassword);
    await client.query("update users set password_salt = $1, password_hash = $2 where id = $3 and deleted_at is null", [
      nextPassword.salt,
      nextPassword.hash,
      user.id,
    ]);
    await client.query("update password_reset_tokens set used_at = $1 where id = $2", [now.toISOString(), resetToken.id]);
    await client.query("delete from sessions where user_id = $1", [user.id]);

    return toSafeUser({
      ...user,
      password_salt: nextPassword.salt,
      password_hash: nextPassword.hash,
    });
  });
}

async function postgresCreateSession(userId: string) {
  const user = await postgresFindActiveUserById(userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 401);

  const now = new Date();
  const token = crypto.randomBytes(32).toString("base64url");
  await postgresQuery("delete from sessions where expires_at <= $1", [now.toISOString()]);
  await postgresQuery("insert into sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at) values ($1,$2,$3,$4,$5,$6)", [
    createId("session"),
    userId,
    hashToken(token),
    now.toISOString(),
    now.toISOString(),
    new Date(now.getTime() + POSTGRES_SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
  ]);

  return { token, maxAge: POSTGRES_SESSION_MAX_AGE_SECONDS };
}

async function postgresGetUserBySessionToken(token?: string | null) {
  if (!token) return null;

  const tokenHash = hashToken(token);
  const result = await postgresQuery<UserRow>(
    `update sessions
       set last_seen_at = now()
      from users
      where sessions.user_id = users.id
        and sessions.token_hash = $1
        and sessions.expires_at > now()
        and users.deleted_at is null
      returning users.*`,
    [tokenHash],
  );

  const user = result.rows[0];
  if (!user) return null;
  await postgresRefreshUserEntitlements(user.id);
  const refreshed = await postgresQuery<UserRow>("select * from users where id = $1 and deleted_at is null limit 1", [user.id]);
  return refreshed.rows[0] ? toSafeUser(refreshed.rows[0]) : null;
}

async function postgresGetUserById(userId: string) {
  const user = await postgresFindActiveUserById(userId);
  return user ? toSafeUser(user) : null;
}

async function postgresBindAppleIapAccount(userId: string, appAccountToken: string, keyVersion = "v1") {
  const token = appAccountToken.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
    throw new AuthError("Apple 交易账号令牌格式无效。", 400);
  }
  try {
    await postgresQuery(
      `insert into apple_iap_account_bindings (app_account_token, user_id, key_version, created_at, last_seen_at)
       values ($1, $2, $3, now(), now())
       on conflict (app_account_token) do update
       set last_seen_at = now()
       where apple_iap_account_bindings.user_id = excluded.user_id`,
      [token, userId, keyVersion],
    );
    const owner = await postgresQuery<{ user_id: string }>("select user_id from apple_iap_account_bindings where app_account_token = $1", [token]);
    if (owner.rows[0]?.user_id !== userId) throw new AuthError("Apple 交易账号令牌已绑定到其他账号。", 409);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (isPostgresUniqueViolation(error)) throw new AuthError("Apple 交易账号令牌已绑定到其他账号。", 409);
    throw error;
  }
}

async function postgresDestroySession(token?: string | null) {
  if (!token) return;
  await postgresQuery("delete from sessions where token_hash = $1", [hashToken(token)]);
}

async function postgresDeleteAccount(userId: string) {
  const now = new Date().toISOString();
  const deletedPassword = hashPassword(crypto.randomBytes(32).toString("base64url"));
  const hasProviderCredentials = await postgresQuery<{ exists: boolean }>(
    "select exists(select 1 from provider_credentials where user_id = $1) as exists",
    [userId],
  );
  if (hasProviderCredentials.rows[0]?.exists) assertSecretAuditSinkWritable();
  await postgresTransaction(async (client) => {
    const activeUser = await client.query<UserRow>(
      "select * from users where id = $1 and deleted_at is null for update",
      [userId],
    );
    if (!activeUser.rows[0]) throw new AuthError("账号不存在或已删除。", 404);
    const deletedCredentials = await client.query<ProviderCredentialRow>(
      "select * from provider_credentials where user_id = $1 for update",
      [userId],
    );
    const secretAuditEvents = deletedCredentials.rows.map((credential) =>
      createSecretAuditEvent({
        eventType: "provider_secret_delete",
      userId,
      providerId: credential.provider_id,
      secretNames: Object.keys(parseJsonRecord(credential.encrypted_secrets)),
      reason: "account_delete",
      }),
    );
    await client.query(
      `update meeting_processing_provider_steps
       set status = 'released', released_at = coalesce(released_at, now()), updated_at = now()
       where user_id = $1 and status = 'claimed'`,
      [userId],
    );
    const started = await client.query(
      "select 1 from meeting_processing_provider_steps where user_id = $1 and status = 'started' limit 1",
      [userId],
    );
    if (!started.rowCount) await archiveAndDeletePostgresProcessingLedger(client, userId);
    await client.query(
      "update users set email = $1, name = $2, deleted_at = $3, password_salt = $4, password_hash = $5, plan = 'free', official_minutes_total = 0, official_minutes_used = 0, official_minutes_period_start_at = null, official_minutes_period_end_at = null, official_minutes_period_source = 'deleted', official_minutes_billing_order_id = null where id = $6",
      [`deleted-${userId}@ownminutes.local`, "Deleted User", now, deletedPassword.salt, deletedPassword.hash, userId],
    );
    await client.query("delete from sessions where user_id = $1", [userId]);
    await client.query("delete from email_verification_tokens where user_id = $1", [userId]);
    await client.query("delete from password_reset_tokens where user_id = $1", [userId]);
    await client.query("delete from provider_credentials where user_id = $1", [userId]);
    await client.query("delete from meeting_finalization_jobs where owner_user_id = $1", [userId]);
    await client.query("delete from usage_events where user_id = $1", [userId]);
    await client.query("delete from growth_events where user_id = $1", [userId]);
    // Preserve the minimum Apple billing ledger, subscription state, and stable
    // account binding. Apple can continue sending renewal/refund notifications
    // after OwnMinutes PII has been deleted.
    await enqueuePostgresSecretAuditEvents(client, secretAuditEvents);
    assertSecretAuditTransactionTestHook();
  });
  await flushSecretAuditOutboxBestEffort(1);
}

async function postgresGetUserUsage(userId: string): Promise<UserUsageSummary> {
  const user = await postgresFindActiveUserById(userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);

  const [eventsResult, credentialsResult] = await Promise.all([
    postgresQuery<UsageEventRow>("select * from usage_events where user_id = $1 order by created_at desc limit 20", [userId]),
    postgresQuery<ProviderCredentialRow>("select * from provider_credentials where user_id = $1", [userId]),
  ]);
  const credentialDescriptors = credentialsResult.rows.map(providerCredentialDescriptorFromRow);

  return {
    plan: user.plan,
    officialMinutesTotal: user.official_minutes_total,
    officialMinutesUsed: user.official_minutes_used,
    officialMinutesRemaining: Math.max(0, user.official_minutes_total - user.official_minutes_used),
    costControl: buildPostgresCostControlSummary(user, credentialDescriptors),
    events: eventsResult.rows.map((event) => ({
      id: event.id,
      type: event.type,
      minutes: event.minutes,
      createdAt: toIsoString(event.created_at),
      note: event.note,
      ...(event.type === "meeting_finalize" ? parseMeetingUsage({ minutes: event.minutes, note: event.note }) : {}),
    })),
  };
}

async function postgresGetUserProcessingMode(userId: string): Promise<UserProcessingMode> {
  const user = await postgresFindActiveUserById(userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  return user.processing_mode || "official_quota";
}

async function postgresUpdateUserProcessingMode(userId: string, processingMode: UserProcessingMode): Promise<SafeUser> {
  return postgresTransaction(async (client) => {
    await lockPostgresQuotaUser(client, userId);
    if (processingMode === "byok") {
      const credentials = await client.query<ProviderCredentialRow>(
        "select * from provider_credentials where user_id = $1",
        [userId],
      );
      const coverage = getByokCoverage(credentials.rows.map(providerCredentialDescriptorFromRow));
      if (!coverage.complete) {
        throw new AuthError("请先完整配置语音识别和纪要总结，再选择自己的模型。", 409, "byok_configuration_incomplete");
      }
    }
    const updated = await client.query<UserRow>(
      "update users set processing_mode = $1 where id = $2 and deleted_at is null returning *",
      [processingMode, userId],
    );
    if (!updated.rows[0]) throw new AuthError("账号不存在或已删除。", 404);
    return toSafeUser(updated.rows[0]);
  });
}

async function postgresUpdateUserPlan(userId: string, plan: BillingPlanId) {
  return postgresApplyUserPlanChange(userId, plan, `Changed plan to ${plan}`);
}

async function postgresAdminGrantUserPlan(input: AdminPlanGrantInput) {
  const reason = input.reason?.trim();
  return postgresApplyUserPlanChange(
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

async function postgresApplyUserPlanChange(
  userId: string,
  plan: BillingPlanId,
  note: string,
  grant?: {
    grantedByUserId?: string;
    reason: string;
    source: EntitlementGrantSource;
  },
) {
  const user = await postgresFindActiveUserById(userId);
  if (!user) throw new AuthError("账号不存在或已删除。", 404);

  const officialMinutesTotal = getPlanMinutes(plan);
  const freeTrialMinutesUsed = user.plan === "free"
    ? Math.min(user.free_trial_minutes_total, user.official_minutes_used)
    : user.free_trial_minutes_used;
  const nextOfficialMinutesTotal = plan === "free" ? user.free_trial_minutes_total : officialMinutesTotal;
  const nextOfficialMinutesUsed = plan === "free"
    ? freeTrialMinutesUsed
    : Math.min(user.official_minutes_used, officialMinutesTotal);
  const now = new Date().toISOString();
  const result = await postgresTransaction(async (client) => {
    const updated = await client.query<UserRow>(
      `update users
       set plan = $1,
           free_trial_minutes_used = $2,
           official_minutes_total = $3,
           official_minutes_used = $4,
           official_minutes_period_start_at = case when $1 = 'free' then free_trial_granted_at else official_minutes_period_start_at end,
           official_minutes_period_end_at = case when $1 = 'free' then null else official_minutes_period_end_at end,
           official_minutes_period_source = case when $1 = 'free' then '${FREE_TRIAL_SOURCE}' else official_minutes_period_source end,
           official_minutes_billing_order_id = case when $1 = 'free' then null else official_minutes_billing_order_id end
       where id = $5 and deleted_at is null returning *`,
      [plan, freeTrialMinutesUsed, nextOfficialMinutesTotal, nextOfficialMinutesUsed, userId],
    );
    await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
      createId("usage"),
      userId,
      "manual_adjustment",
      0,
      now,
      note,
    ]);
    if (grant) {
      const billingOrderId = createId("order");
      const entitlementGrantId = createId("grant");
      await client.query(
        `insert into billing_orders
          (id, user_id, created_by_user_id, provider, status, plan, amount_cents, currency, idempotency_key, entitlement_grant_id, note, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          billingOrderId,
          userId,
          grant.grantedByUserId || null,
          grant.source === "admin_manual" ? "admin_manual" : "external_billing",
          "paid",
          plan,
          0,
          "CNY",
          `${grant.source}:${userId}:${now}`,
          entitlementGrantId,
          grant.reason,
          now,
        ],
      );
      await client.query(
        `insert into entitlement_grants
          (id, user_id, billing_order_id, granted_by_user_id, source, status, previous_plan, plan, official_minutes_total, reason, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          entitlementGrantId,
          userId,
          billingOrderId,
          grant.grantedByUserId || null,
          grant.source,
          "active",
          user.plan,
          plan,
          officialMinutesTotal,
          grant.reason,
          now,
        ],
      );
    }
    return updated.rows[0];
  });

  if (!result) throw new AuthError("账号不存在或已删除。", 404);
  return toSafeUser(result);
}

async function postgresRecordAppleIapPurchase(input: AppleIapPurchaseInput): Promise<AppleIapPurchaseResult> {
  const now = new Date().toISOString();
  const note = [
    `Apple IAP ${input.productId}`,
    `environment=${input.environment}`,
    input.originalTransactionId ? `originalTransactionId=${input.originalTransactionId}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  const result = await postgresTransaction(async (client) => {
    if (input.originalTransactionId) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple-iap-family:${input.originalTransactionId}`]);
    }
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple-iap:${input.externalTransactionId}`]);
    const userResult = await client.query<UserRow>("select * from users where id = $1 and deleted_at is null for update", [input.userId]);
    const user = userResult.rows[0];
    if (!user) throw new AuthError("账号不存在或已删除。", 404);
    if (input.appAccountToken) {
      const binding = await client.query<{ user_id: string }>(
        "select user_id from apple_iap_account_bindings where app_account_token = $1 for update",
        [input.appAccountToken.toLowerCase()],
      );
      if (binding.rows[0]?.user_id !== input.userId) throw new AuthError("Apple 交易账号令牌与当前账号不一致。", 403);
    }
    const existingOrderResult = await client.query<BillingOrderRow>(
      `select * from billing_orders
       where idempotency_key = $1
          or (provider = 'apple_iap' and external_transaction_id = $2)
       order by created_at asc
       limit 1`,
      [input.idempotencyKey, input.externalTransactionId],
    );
    const existingOrder = existingOrderResult.rows[0];
    if (existingOrder) {
      if (existingOrder.user_id !== input.userId) {
        throw new AuthError("该 Apple 交易已绑定到其他 OwnMinutes 账号。", 409);
      }
      await postgresEnsureAppleSubscriptionForOrder(client, existingOrder, {
        environment: input.environment,
        expiresDate: input.periodEndAt,
        productId: input.productId,
        signedDate: input.signedDate,
        status: "active",
      });
      return {
        duplicate: true,
        order: existingOrder,
        user,
      };
    }

    const existingSubscription = input.originalTransactionId
      ? (
          await client.query<AppleSubscriptionRow>(
            "select * from apple_subscriptions where original_transaction_id = $1 for update",
            [input.originalTransactionId],
          )
        ).rows[0]
      : undefined;
    if (existingSubscription && existingSubscription.user_id !== input.userId) {
      throw new AuthError("该 Apple 订阅已绑定到其他 OwnMinutes 账号。", 409, "apple_iap_subscription_owner_conflict");
    }
    const currentSubscriptionOrder = existingSubscription
      ? (
          await client.query<BillingOrderRow>(
            "select * from billing_orders where provider = 'apple_iap' and external_transaction_id = $1 for update",
            [existingSubscription.current_transaction_id],
          )
        ).rows[0]
      : undefined;
    if (
      existingSubscription &&
      existingSubscription.current_transaction_id !== input.externalTransactionId &&
      isAppleLifecycleUpdateStale({
        currentExpiresDate: existingSubscription.expires_at,
        currentPeriodStartDate: currentSubscriptionOrder?.period_start_at,
        currentSignedDate: existingSubscription.last_signed_date,
        incomingExpiresDate: input.periodEndAt,
        incomingPeriodStartDate: input.periodStartAt,
        incomingSignedDate: input.signedDate,
      })
    ) {
      if (!currentSubscriptionOrder) throw new AuthError("Apple 订阅当前账期订单缺失，拒绝应用乱序交易。", 409, "apple_iap_stale_transaction");
      return { duplicate: true, order: currentSubscriptionOrder, user };
    }

    const billingOrderId = createId("order");
    const entitlementGrantId = createId("grant");
    const officialMinutesTotal = getPlanMinutes(input.plan);
    const previousPlan = input.originalTransactionId
      ? await postgresSupersedeAppleSubscriptionFamily(client, input.userId, input.originalTransactionId, input.externalTransactionId, now)
      : user.plan;
    const updated = await client.query<UserRow>(
      `update users
       set free_trial_minutes_used = case
             when plan = 'free' then least(free_trial_minutes_total, official_minutes_used)
             else free_trial_minutes_used
           end,
           plan = $1,
           official_minutes_total = $2,
           official_minutes_used = 0,
           official_minutes_period_start_at = coalesce($3::timestamptz, $4::timestamptz),
           official_minutes_period_end_at = $5::timestamptz,
           official_minutes_period_source = 'apple_iap',
           official_minutes_billing_order_id = $6
       where id = $7 and deleted_at is null
       returning *`,
      [input.plan, officialMinutesTotal, input.periodStartAt || null, now, input.periodEndAt || null, billingOrderId, input.userId],
    );
    await client.query(
      `insert into billing_orders
        (id, user_id, provider, status, plan, amount_cents, price_milliunits, currency, environment, product_id, storefront, offer_type, offer_identifier, app_account_token, signed_date, external_transaction_id, original_transaction_id, idempotency_key, period_start_at, period_end_at, entitlement_grant_id, note, created_at, status_signed_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        billingOrderId,
        input.userId,
        "apple_iap",
        "paid",
        input.plan,
        input.amountCents ?? null,
        input.priceMilliunits ?? null,
        input.currency,
        input.environment,
        input.productId,
        input.storefront || null,
        input.offerType ?? null,
        input.offerIdentifier || null,
        input.appAccountToken?.toLowerCase() || null,
        input.signedDate || null,
        input.externalTransactionId,
        input.originalTransactionId || null,
        input.idempotencyKey,
        input.periodStartAt || null,
        input.periodEndAt || null,
        entitlementGrantId,
        note,
        now,
        input.signedDate || null,
      ],
    );
    await client.query(
      `insert into entitlement_grants
        (id, user_id, billing_order_id, source, status, previous_plan, plan, official_minutes_total, reason, starts_at, expires_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [entitlementGrantId, input.userId, billingOrderId, "apple_iap", "active", previousPlan, input.plan, officialMinutesTotal, note, input.periodStartAt || now, input.periodEndAt || null, now],
    );
    if (input.originalTransactionId) {
      await client.query(
        `insert into apple_subscriptions
          (original_transaction_id, user_id, current_transaction_id, product_id, environment, status, expires_at, last_signed_date, created_at, updated_at)
         values ($1,$2,$3,$4,$5,'active',$6,$7,$8,$8)
         on conflict (original_transaction_id) do update
         set user_id = excluded.user_id,
             current_transaction_id = excluded.current_transaction_id,
             product_id = excluded.product_id,
             environment = excluded.environment,
             status = 'active',
             expires_at = excluded.expires_at,
             grace_expires_at = null,
             last_signed_date = excluded.last_signed_date,
             updated_at = excluded.updated_at
         where apple_subscriptions.user_id = excluded.user_id
           and (apple_subscriptions.last_signed_date is null or excluded.last_signed_date is null or apple_subscriptions.last_signed_date <= excluded.last_signed_date)`,
        [input.originalTransactionId, input.userId, input.externalTransactionId, input.productId, input.environment, input.periodEndAt || null, input.signedDate || null, now],
      );
    }
    await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
      createId("usage"),
      input.userId,
      "manual_adjustment",
      0,
      now,
      `Apple IAP entitlement granted: ${input.productId}`,
    ]);

    const orderResult = await client.query<BillingOrderRow>("select * from billing_orders where id = $1", [billingOrderId]);
    return {
      duplicate: false,
      order: orderResult.rows[0],
      user: updated.rows[0],
    };
  });

  return {
    duplicate: result.duplicate,
    order: await postgresSummarizeBillingOrder(result.order),
    user: toSafeUser(result.user),
  };
}

async function postgresRecordAppleIapNotification(input: AppleIapNotificationInput): Promise<AppleIapNotificationResult> {
  const action = getAppleIapNotificationAction(input.notificationType, input.subtype, input.status);
  const notificationUUID = input.notificationUUID || makeLegacyAppleNotificationId(input);
  const payloadSha256 = input.payloadSha256 || crypto.createHash("sha256").update(input.reason).digest("hex");
  const eventInsert = await postgresQuery<{ notification_uuid: string }>(
    `insert into apple_notification_events
      (notification_uuid, environment, notification_type, subtype, signed_date, transaction_id, original_transaction_id, payload_sha256, processing_status, received_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'received',now())
     on conflict (notification_uuid) do update
     set processing_status = 'received', error_code = null, received_at = now()
     where apple_notification_events.processing_status in ('failed', 'received')
       and apple_notification_events.payload_sha256 = excluded.payload_sha256
     returning notification_uuid`,
    [
      notificationUUID,
      input.environment || null,
      input.notificationType || "UNKNOWN",
      input.subtype || null,
      input.signedDate || null,
      input.transactionId || null,
      input.originalTransactionId || null,
      payloadSha256,
    ],
  );
  if (!eventInsert.rows[0]) {
    const existingEvent = await postgresQuery<{ payload_sha256: string }>(
      "select payload_sha256 from apple_notification_events where notification_uuid = $1",
      [notificationUUID],
    );
    if (existingEvent.rows[0] && existingEvent.rows[0].payload_sha256 !== payloadSha256) {
      throw new AuthError("Apple notificationUUID 对应的 payload hash 不一致。", 409, "apple_notification_payload_mismatch");
    }
    return { action, duplicate: true };
  }
  if (action === "ignored") {
    await postgresCompleteAppleNotificationEvent(notificationUUID, "ignored", action);
    return {
      action,
      duplicate: false,
    };
  }

  if (!input.transactionId) {
    await postgresFailAppleNotificationEvent(notificationUUID, "missing_transaction_id");
    throw new AuthError("Apple notification 缺少 transactionId。", 400);
  }

  const now = new Date().toISOString();
  let result: { duplicate: boolean; grant?: EntitlementGrantRow; order: BillingOrderRow; user: UserRow };
  try {
    result = await postgresTransaction(async (client) => {
    if (action === "renewed" || action === "purchased") {
      if (input.originalTransactionId) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple-iap-family:${input.originalTransactionId}`]);
      }
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple-iap:${input.transactionId}`]);
      const existingOrderResult = await client.query<BillingOrderRow>(
        "select * from billing_orders where provider = 'apple_iap' and external_transaction_id = $1",
        [input.transactionId],
      );
      const existingOrder = existingOrderResult.rows[0];
      if (existingOrder) {
        const existingUserResult = await client.query<UserRow>("select * from users where id = $1 for update", [existingOrder.user_id]);
        const existingUser = existingUserResult.rows[0];
        if (!existingUser) throw new AuthError("Apple IAP 订单账号不存在。", 404);
        await postgresEnsureAppleSubscriptionForOrder(client, existingOrder, {
          environment: input.environment,
          expiresDate: input.expiresDate,
          notificationUUID,
          productId: input.productId,
          signedDate: input.signedDate,
          status: "active",
        });
        const familyId = input.originalTransactionId || existingOrder.original_transaction_id;
        if (familyId) {
          const subscription = (
            await client.query<AppleSubscriptionRow>(
              "select * from apple_subscriptions where original_transaction_id = $1 for update",
              [familyId],
            )
          ).rows[0];
          if (
            subscription &&
            !isAppleLifecycleUpdateStale({
              currentExpiresDate: subscription.expires_at,
              currentSignedDate: subscription.last_signed_date,
              incomingExpiresDate: input.expiresDate,
              incomingSignedDate: input.signedDate,
            })
          ) {
            await client.query(
              `update apple_subscriptions
               set status = 'active',
                   expires_at = coalesce($1::timestamptz, expires_at),
                   auto_renew_status = coalesce($2::boolean, auto_renew_status),
                   last_signed_date = coalesce($3::timestamptz, last_signed_date),
                   last_notification_uuid = $4,
                   updated_at = $5
               where original_transaction_id = $6`,
              [input.expiresDate || null, input.autoRenewStatus ?? null, input.signedDate || null, notificationUUID, now, familyId],
            );
          }
        }
        return {
          duplicate: true,
          order: existingOrder,
          user: existingUser,
        };
      }

      if (!input.originalTransactionId) throw new AuthError("Apple 续期通知缺少 originalTransactionId。", 400);

      const existingSubscription = (
        await client.query<AppleSubscriptionRow>(
          "select * from apple_subscriptions where original_transaction_id = $1 for update",
          [input.originalTransactionId],
        )
      ).rows[0];
      const currentSubscriptionOrder = existingSubscription
        ? (
            await client.query<BillingOrderRow>(
              "select * from billing_orders where provider = 'apple_iap' and external_transaction_id = $1 for update",
              [existingSubscription.current_transaction_id],
            )
          ).rows[0]
        : undefined;
      if (
        existingSubscription &&
        existingSubscription.current_transaction_id !== input.transactionId &&
        isAppleLifecycleUpdateStale({
          currentExpiresDate: existingSubscription.expires_at,
          currentPeriodStartDate: currentSubscriptionOrder?.period_start_at,
          currentSignedDate: existingSubscription.last_signed_date,
          incomingExpiresDate: input.expiresDate,
          incomingPeriodStartDate: input.purchaseDate,
          incomingSignedDate: input.signedDate,
        })
      ) {
        const currentUser = currentSubscriptionOrder
          ? (await client.query<UserRow>("select * from users where id = $1 for update", [currentSubscriptionOrder.user_id])).rows[0]
          : undefined;
        if (!currentSubscriptionOrder || !currentUser) {
          throw new AuthError("Apple 订阅当前账期账本缺失，拒绝应用乱序通知。", 409, "apple_iap_stale_notification");
        }
        return { duplicate: true, order: currentSubscriptionOrder, user: currentUser };
      }

      const previousOrderResult = await client.query<BillingOrderRow>(
        `select * from billing_orders
         where provider = 'apple_iap' and original_transaction_id = $1
         order by created_at desc
         limit 1`,
        [input.originalTransactionId],
      );
      const previousOrder = previousOrderResult.rows[0];
      const entitlementPlan = input.plan || previousOrder?.plan || currentSubscriptionOrder?.plan;
      if (!entitlementPlan || !input.productId || !input.idempotencyKey) throw new AuthError("Apple 续期通知缺少权益映射。", 400);
      const bindingResult = !previousOrder && input.appAccountToken
        ? await client.query<{ user_id: string }>("select user_id from apple_iap_account_bindings where app_account_token = $1 for update", [input.appAccountToken.toLowerCase()])
        : undefined;
      const ownerUserId = previousOrder?.user_id || bindingResult?.rows[0]?.user_id;
      if (!ownerUserId) throw new AuthError("Apple IAP 通知无法关联 OwnMinutes 账号，等待客户端恢复购买或对账。", 404);
      if (existingSubscription && existingSubscription.user_id !== ownerUserId) {
        throw new AuthError("该 Apple 订阅已绑定到其他 OwnMinutes 账号。", 409, "apple_iap_subscription_owner_conflict");
      }

      const userResult = await client.query<UserRow>("select * from users where id = $1 for update", [ownerUserId]);
      const user = userResult.rows[0];
      if (!user) throw new AuthError("Apple IAP 订单账号不存在。", 404);
      if (user.deleted_at) {
        const deletedOrderId = createId("order");
        await client.query(
          `insert into billing_orders
            (id, user_id, provider, status, plan, amount_cents, price_milliunits, currency, environment, product_id, storefront, offer_type, offer_identifier, app_account_token, signed_date, external_transaction_id, original_transaction_id, idempotency_key, period_start_at, period_end_at, note, created_at, status_signed_date)
           values ($1,$2,'apple_iap','paid',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            deletedOrderId,
            user.id,
            entitlementPlan,
            input.amountCents ?? null,
            input.priceMilliunits ?? null,
            input.currency || "XXX",
            input.environment || "Sandbox",
            input.productId,
            input.storefront || null,
            input.offerType ?? null,
            input.offerIdentifier || null,
            input.appAccountToken?.toLowerCase() || null,
            input.signedDate || null,
            input.transactionId,
            input.originalTransactionId,
            input.idempotencyKey,
            input.purchaseDate || null,
            input.expiresDate || null,
            "Apple IAP renewal retained for deleted account; no entitlement granted",
            now,
            input.signedDate || null,
          ],
        );
        await client.query(
          `insert into apple_subscriptions
            (original_transaction_id, user_id, current_transaction_id, product_id, environment, status, expires_at, auto_renew_status, is_upgraded, last_signed_date, last_notification_uuid, created_at, updated_at)
           values ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$11)
           on conflict (original_transaction_id) do update
           set current_transaction_id = excluded.current_transaction_id,
               product_id = excluded.product_id,
               environment = excluded.environment,
               status = 'active',
               expires_at = excluded.expires_at,
               grace_expires_at = null,
               auto_renew_status = coalesce(excluded.auto_renew_status, apple_subscriptions.auto_renew_status),
               last_signed_date = excluded.last_signed_date,
               last_notification_uuid = excluded.last_notification_uuid,
               updated_at = excluded.updated_at`,
          [input.originalTransactionId, user.id, input.transactionId, input.productId, input.environment || "Sandbox", input.expiresDate || null, input.autoRenewStatus ?? null, input.isUpgraded === true, input.signedDate || null, notificationUUID, now],
        );
        const deletedOrder = await client.query<BillingOrderRow>("select * from billing_orders where id = $1", [deletedOrderId]);
        return { duplicate: false, order: deletedOrder.rows[0], user };
      }

      const existingIdempotencyResult = await client.query<BillingOrderRow>("select * from billing_orders where idempotency_key = $1 for update", [
        input.idempotencyKey,
      ]);
      const existingIdempotencyOrder = existingIdempotencyResult.rows[0];
      if (existingIdempotencyOrder) {
        return {
          duplicate: true,
          order: existingIdempotencyOrder,
          user,
        };
      }

      const billingOrderId = createId("order");
      const entitlementGrantId = createId("grant");
      const officialMinutesTotal = getPlanMinutes(entitlementPlan);
      const previousPlan = await postgresSupersedeAppleSubscriptionFamily(
        client,
        user.id,
        input.originalTransactionId,
        input.transactionId!,
        now,
      );
      const note = [
        `Apple IAP renewal ${input.productId}`,
        input.environment ? `environment=${input.environment}` : "",
        `originalTransactionId=${input.originalTransactionId}`,
      ]
        .filter(Boolean)
        .join("; ");

      const updated = await client.query<UserRow>(
        `update users
         set free_trial_minutes_used = case
               when plan = 'free' then least(free_trial_minutes_total, official_minutes_used)
               else free_trial_minutes_used
             end,
             plan = $1,
             official_minutes_total = $2,
             official_minutes_used = 0,
             official_minutes_period_start_at = coalesce($3::timestamptz, $4::timestamptz),
             official_minutes_period_end_at = $5::timestamptz,
             official_minutes_period_source = 'apple_iap',
             official_minutes_billing_order_id = $6
         where id = $7 and deleted_at is null returning *`,
        [entitlementPlan, officialMinutesTotal, input.purchaseDate || null, now, input.expiresDate || null, billingOrderId, user.id],
      );
      await client.query(
        `insert into billing_orders
          (id, user_id, provider, status, plan, amount_cents, price_milliunits, currency, environment, product_id, storefront, offer_type, offer_identifier, app_account_token, signed_date, external_transaction_id, original_transaction_id, idempotency_key, period_start_at, period_end_at, entitlement_grant_id, note, created_at, status_signed_date)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [
          billingOrderId,
          user.id,
          "apple_iap",
          "paid",
          entitlementPlan,
          input.amountCents ?? null,
          input.priceMilliunits ?? null,
          input.currency || "XXX",
          input.environment || "Sandbox",
          input.productId,
          input.storefront || null,
          input.offerType ?? null,
          input.offerIdentifier || null,
          input.appAccountToken?.toLowerCase() || null,
          input.signedDate || null,
          input.transactionId,
          input.originalTransactionId,
          input.idempotencyKey,
          input.purchaseDate || null,
          input.expiresDate || null,
          entitlementGrantId,
          note,
          now,
          input.signedDate || null,
        ],
      );
      await client.query(
        `insert into entitlement_grants
          (id, user_id, billing_order_id, source, status, previous_plan, plan, official_minutes_total, reason, starts_at, expires_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [entitlementGrantId, user.id, billingOrderId, "apple_iap", "active", previousPlan, entitlementPlan, officialMinutesTotal, note, input.purchaseDate || now, input.expiresDate || null, now],
      );
      await client.query(
        `insert into apple_subscriptions
          (original_transaction_id, user_id, current_transaction_id, product_id, environment, status, expires_at, auto_renew_status, is_upgraded, last_signed_date, last_notification_uuid, created_at, updated_at)
         values ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$11)
         on conflict (original_transaction_id) do update
         set current_transaction_id = excluded.current_transaction_id,
             product_id = excluded.product_id,
             environment = excluded.environment,
             status = 'active',
             expires_at = excluded.expires_at,
             grace_expires_at = null,
             auto_renew_status = coalesce(excluded.auto_renew_status, apple_subscriptions.auto_renew_status),
             is_upgraded = excluded.is_upgraded,
             last_signed_date = excluded.last_signed_date,
             last_notification_uuid = excluded.last_notification_uuid,
             updated_at = excluded.updated_at
         where apple_subscriptions.user_id = excluded.user_id
           and (apple_subscriptions.last_signed_date is null or excluded.last_signed_date is null or apple_subscriptions.last_signed_date <= excluded.last_signed_date)`,
        [input.originalTransactionId, user.id, input.transactionId, input.productId, input.environment || "Sandbox", input.expiresDate || null, input.autoRenewStatus ?? null, input.isUpgraded === true, input.signedDate || null, notificationUUID, now],
      );
      await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
        createId("usage"),
        user.id,
        "manual_adjustment",
        0,
        now,
        `Apple IAP renewal granted: ${input.productId}`,
      ]);

      const orderResult = await client.query<BillingOrderRow>("select * from billing_orders where id = $1", [billingOrderId]);
      return {
        duplicate: false,
        order: orderResult.rows[0],
        user: updated.rows[0],
      };
    }

    if (action === "grace" || action === "billing_retry" || action === "extended" || action === "renewal_status") {
      const familyResult = input.originalTransactionId
        ? await client.query<BillingOrderRow>(
            `select * from billing_orders
             where provider = 'apple_iap' and original_transaction_id = $1
             order by (
               external_transaction_id = (
                 select current_transaction_id from apple_subscriptions where original_transaction_id = $1
               )
             ) desc, created_at desc
             limit 1`,
            [input.originalTransactionId],
          )
        : await client.query<BillingOrderRow>(
            "select * from billing_orders where provider = 'apple_iap' and external_transaction_id = $1",
            [input.transactionId],
          );
      const familyOrder = familyResult.rows[0];
      if (!familyOrder) throw new AuthError("Apple IAP 订阅状态通知找不到原始订单。", 404);
      const lifecycleUserResult = await client.query<UserRow>("select * from users where id = $1 for update", [familyOrder.user_id]);
      let lifecycleUser = lifecycleUserResult.rows[0];
      if (!lifecycleUser) throw new AuthError("Apple IAP 订单账号不存在。", 404);

      const nextStatus = action === "renewal_status" ? null : action === "grace" ? "grace" : action === "billing_retry" ? "billing_retry" : "active";
      await postgresEnsureAppleSubscriptionForOrder(client, familyOrder, {
        environment: input.environment,
        expiresDate: input.expiresDate,
        notificationUUID,
        productId: input.productId,
        signedDate: input.signedDate,
        status: nextStatus || undefined,
      });
      const subscriptionUpdate = await client.query<{ original_transaction_id: string }>(
        `update apple_subscriptions
         set status = coalesce($1, status),
             expires_at = coalesce($2::timestamptz, expires_at),
             grace_expires_at = case
               when $9::text = 'billing_retry' then null
               else coalesce($3::timestamptz, grace_expires_at)
             end,
             auto_renew_status = coalesce($4::boolean, auto_renew_status),
             last_signed_date = coalesce($5::timestamptz, last_signed_date),
             last_notification_uuid = $6,
             updated_at = $7
         where original_transaction_id = $8
           and (last_signed_date is null or $5::timestamptz is null or last_signed_date <= $5::timestamptz)
         returning original_transaction_id`,
        [nextStatus, input.expiresDate || null, input.graceExpiresDate || null, input.autoRenewStatus ?? null, input.signedDate || null, notificationUUID, now, input.originalTransactionId || familyOrder.original_transaction_id, action],
      );
      if (!subscriptionUpdate.rows[0]) {
        return { duplicate: true, order: familyOrder, user: lifecycleUser };
      }

      if (action === "extended" && input.expiresDate) {
        await client.query(
          `update billing_orders set period_end_at = $1, status_reason = $2, status_updated_at = $3
           where id = $4`,
          [input.expiresDate, input.reason, now, familyOrder.id],
        );
        if (familyOrder.entitlement_grant_id) {
          await client.query("update entitlement_grants set expires_at = $1, status_reason = $2, status_updated_at = $3 where id = $4", [input.expiresDate, input.reason, now, familyOrder.entitlement_grant_id]);
        }
        if (!lifecycleUser.deleted_at && lifecycleUser.official_minutes_billing_order_id === familyOrder.id) {
          await client.query("update users set official_minutes_period_end_at = $1 where id = $2", [input.expiresDate, lifecycleUser.id]);
          lifecycleUser.official_minutes_period_end_at = input.expiresDate;
        }
      }

      const recoveryUntil = action === "grace" ? input.graceExpiresDate : action === "extended" ? input.expiresDate : undefined;
      if (!lifecycleUser.deleted_at && familyOrder.entitlement_grant_id && recoveryUntil && Date.parse(recoveryUntil) > Date.now()) {
        const recoveredGrant = await client.query<EntitlementGrantRow>(
          `update entitlement_grants
           set status = 'active',
               status_reason = $1,
               status_updated_at = $2,
               expires_at = case when $3::text = 'extended' then $4::timestamptz else expires_at end
           where id = $5
             and status = 'revoked'
             and status_reason = $6
           returning *`,
          [
            `${input.reason}; restored after delayed Apple lifecycle notification`,
            now,
            action,
            input.expiresDate || null,
            familyOrder.entitlement_grant_id,
            APPLE_EXPIRY_RECONCILIATION_REASON,
          ],
        );
        const recovered = recoveredGrant.rows[0];
        if (recovered) {
          const recoveredUser = await client.query<UserRow>(
            `update users
             set plan = $1,
                 official_minutes_total = $2,
                 official_minutes_used = least(official_minutes_used, $2),
                 official_minutes_period_start_at = coalesce($3::timestamptz, official_minutes_period_start_at),
                 official_minutes_period_end_at = $4::timestamptz,
                 official_minutes_period_source = 'apple_iap',
                 official_minutes_billing_order_id = $5
             where id = $6 and deleted_at is null
             returning *`,
            [
              recovered.plan,
              recovered.official_minutes_total,
              recovered.starts_at || familyOrder.period_start_at || null,
              recoveryUntil,
              familyOrder.id,
              lifecycleUser.id,
            ],
          );
          lifecycleUser = recoveredUser.rows[0] || lifecycleUser;
        }
      }

      const refreshedOrder = await client.query<BillingOrderRow>("select * from billing_orders where id = $1", [familyOrder.id]);
      const refreshedGrant = familyOrder.entitlement_grant_id
        ? await client.query<EntitlementGrantRow>("select * from entitlement_grants where id = $1", [familyOrder.entitlement_grant_id])
        : undefined;
      return {
        duplicate: false,
        grant: refreshedGrant?.rows[0],
        order: refreshedOrder.rows[0],
        user: lifecycleUser,
      };
    }

    if (input.originalTransactionId) {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple-iap-family:${input.originalTransactionId}`]);
    }
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple-iap:${input.transactionId}`]);
    const orderResult = await client.query<BillingOrderRow>(
      "select * from billing_orders where provider = 'apple_iap' and external_transaction_id = $1",
      [input.transactionId],
    );
    const order = orderResult.rows[0];
    if (!order) throw new AuthError("Apple IAP 订单不存在。", 404);

    const lifecycleUserResult = await client.query<UserRow>("select * from users where id = $1 for update", [order.user_id]);
    const lifecycleUser = lifecycleUserResult.rows[0];
    if (!lifecycleUser) throw new AuthError("Apple IAP 订单账号不存在。", 404);
    const grantResult = await client.query<EntitlementGrantRow>("select * from entitlement_grants where id = $1 for update", [order.entitlement_grant_id]);
    const grant = grantResult.rows[0];
    const subscription = order.original_transaction_id
      ? (
          await client.query<AppleSubscriptionRow>(
            "select * from apple_subscriptions where original_transaction_id = $1 for update",
            [order.original_transaction_id],
          )
        ).rows[0]
      : undefined;
    const targetsCurrentSubscription = Boolean(
      subscription && subscription.current_transaction_id === order.external_transaction_id,
    );
    if (
      isAppleStatusUpdateStale(input.signedDate, order.status_signed_date) ||
      (targetsCurrentSubscription &&
        isAppleLifecycleUpdateStale({
          currentExpiresDate: subscription?.expires_at,
          currentSignedDate: subscription?.last_signed_date,
          incomingExpiresDate: input.expiresDate,
          incomingSignedDate: input.signedDate,
        }))
    ) {
      return { duplicate: true, grant, order, user: lifecycleUser };
    }
    await client.query(
      "update billing_orders set status_signed_date = coalesce($1::timestamptz, status_signed_date) where id = $2",
      [input.signedDate || null, order.id],
    );
    order.status_signed_date = input.signedDate || order.status_signed_date;
    if (targetsCurrentSubscription && subscription) {
      await client.query(
        `update apple_subscriptions
         set last_signed_date = coalesce($1::timestamptz, last_signed_date),
             last_notification_uuid = $2,
             updated_at = $3
         where original_transaction_id = $4`,
        [input.signedDate || null, notificationUUID, now, subscription.original_transaction_id],
      );
      subscription.last_signed_date = input.signedDate || subscription.last_signed_date;
      subscription.last_notification_uuid = notificationUUID;
    }
    if (!grant) {
      const ledgerUser = lifecycleUser;
      if (ledgerUser?.deleted_at) {
        const nextOrder = await client.query<BillingOrderRow>(
          `update billing_orders
           set status = $1, status_reason = $2, status_updated_at = $3
           where id = $4 returning *`,
          [getAppleBillingOrderStatus(action, order.status), `${input.reason}; deleted account ledger only`, now, order.id],
        );
        if (order.original_transaction_id) {
          await client.query(
            `update apple_subscriptions
             set status = $1, last_signed_date = coalesce($2::timestamptz, last_signed_date), last_notification_uuid = $3, updated_at = $4
             where original_transaction_id = $5`,
            [action === "restored" ? "active" : action === "expired" ? "expired" : "revoked", input.signedDate || null, notificationUUID, now, order.original_transaction_id],
          );
        }
        return { duplicate: false, order: nextOrder.rows[0], user: ledgerUser };
      }
      throw new AuthError("Apple IAP 权益记录不存在。", 404);
    }

    const user = lifecycleUser;

    if (user.deleted_at) {
      const deletedGrantStatus: EntitlementGrantStatus = action === "refunded" ? "refunded" : "revoked";
      const deletedOrderStatus = getAppleBillingOrderStatus(action, order.status);
      const nextGrant = await client.query<EntitlementGrantRow>(
        `update entitlement_grants
         set status = $1, status_reason = $2, status_updated_at = $3
         where id = $4 returning *`,
        [deletedGrantStatus, `${input.reason}; account already deleted`, now, grant.id],
      );
      const nextOrder = await client.query<BillingOrderRow>(
        `update billing_orders
         set status = $1, status_reason = $2, status_updated_at = $3
         where id = $4 returning *`,
        [deletedOrderStatus, `${input.reason}; account already deleted`, now, order.id],
      );
      if (order.original_transaction_id) {
        await client.query(
          `update apple_subscriptions
           set status = $1, last_signed_date = coalesce($2::timestamptz, last_signed_date), last_notification_uuid = $3, updated_at = $4
           where original_transaction_id = $5
             and (last_signed_date is null or $2::timestamptz is null or last_signed_date <= $2::timestamptz)`,
          [action === "restored" ? "active" : action === "expired" ? "expired" : "revoked", input.signedDate || null, notificationUUID, now, order.original_transaction_id],
        );
      }
      return { duplicate: false, grant: nextGrant.rows[0], order: nextOrder.rows[0], user };
    }

    if (action === "restored") {
      if (grant.status === "active" && order.status === "paid") {
        if (targetsCurrentSubscription && subscription) {
          await client.query(
            "update apple_subscriptions set status = 'active', updated_at = $1 where original_transaction_id = $2",
            [now, subscription.original_transaction_id],
          );
        }
        return {
          duplicate: true,
          grant,
          order,
          user,
        };
      }
      const activeFamilyGrant = order.original_transaction_id
        ? await client.query<{ id: string }>(
            `select entitlement_grants.id
             from entitlement_grants
             join billing_orders on billing_orders.id = entitlement_grants.billing_order_id
             where billing_orders.provider = 'apple_iap'
               and billing_orders.original_transaction_id = $1
               and billing_orders.id <> $2
               and entitlement_grants.status = 'active'
             limit 1`,
            [order.original_transaction_id, order.id],
          )
        : undefined;
      if (activeFamilyGrant?.rows[0]) {
        const historicalGrant = await client.query<EntitlementGrantRow>(
          `update entitlement_grants
           set status = case when status = 'refunded' then 'revoked' else status end,
               status_reason = $1,
               status_updated_at = $2
           where id = $3
           returning *`,
          [`${input.reason}; historical period restored without replacing current entitlement`, now, grant.id],
        );
        const historicalOrder = await client.query<BillingOrderRow>(
          `update billing_orders set status = 'paid', status_reason = $1, status_updated_at = $2 where id = $3 returning *`,
          [input.reason, now, order.id],
        );
        return {
          duplicate: false,
          grant: historicalGrant.rows[0],
          order: historicalOrder.rows[0],
          user,
        };
      }
      const previousPlan = order.original_transaction_id
        ? await postgresSupersedeAppleSubscriptionFamily(
            client,
            user.id,
            order.original_transaction_id,
            order.external_transaction_id || input.transactionId!,
            now,
          )
        : user.plan;
      const restoredGrant = await client.query<EntitlementGrantRow>(
        `update entitlement_grants
         set status = 'active', previous_plan = $1, status_reason = $2, status_updated_at = $3
         where id = $4
         returning *`,
        [previousPlan, input.reason, now, grant.id],
      );
      const restoredOrder = await client.query<BillingOrderRow>(
        `update billing_orders
         set status = 'paid', status_reason = $1, status_updated_at = $2
         where id = $3
         returning *`,
        [input.reason, now, order.id],
      );
      if (order.original_transaction_id) {
        await client.query(
          `update apple_subscriptions
           set status = 'active', last_signed_date = coalesce($1::timestamptz, last_signed_date), last_notification_uuid = $2, updated_at = $3
           where original_transaction_id = $4
             and current_transaction_id = $5
             and (last_signed_date is null or $1::timestamptz is null or last_signed_date <= $1::timestamptz)`,
          [input.signedDate || null, notificationUUID, now, order.original_transaction_id, order.external_transaction_id],
        );
      }
      const restoredUser = await client.query<UserRow>(
        `update users
         set plan = $1, official_minutes_total = $2, official_minutes_used = least(official_minutes_used, $2),
             official_minutes_period_start_at = coalesce($3::timestamptz, official_minutes_period_start_at),
             official_minutes_period_end_at = $4::timestamptz,
             official_minutes_period_source = 'apple_iap', official_minutes_billing_order_id = $5
         where id = $6 and deleted_at is null returning *`,
        [grant.plan, grant.official_minutes_total, order.period_start_at || null, order.period_end_at || null, order.id, user.id],
      );
      await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
        createId("usage"),
        user.id,
        "manual_adjustment",
        0,
        now,
        `Apple IAP notification ${input.notificationType}: ${input.reason}`,
      ]);
      return {
        duplicate: false,
        grant: restoredGrant.rows[0],
        order: restoredOrder.rows[0],
        user: restoredUser.rows[0],
      };
    }

    if (grant.status !== "active") {
      const expectedOrderStatus = getAppleBillingOrderStatus(action, order.status);
      if (order.status !== expectedOrderStatus) {
        const historicalOrder = await client.query<BillingOrderRow>(
          `update billing_orders set status = $1, status_reason = $2, status_updated_at = $3 where id = $4 returning *`,
          [expectedOrderStatus, input.reason, now, order.id],
        );
        await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
          createId("usage"),
          user.id,
          "manual_adjustment",
          0,
          now,
          `Apple IAP historical notification ${input.notificationType}: ${input.reason}`,
        ]);
        return {
          duplicate: false,
          grant,
          order: historicalOrder.rows[0],
          user,
        };
      }
      return {
        duplicate: true,
        grant,
        order,
        user,
      };
    }

    const nextGrantStatus: EntitlementGrantStatus = action === "refunded" ? "refunded" : "revoked";
    const familyOrderCondition = order.original_transaction_id
      ? "provider = 'apple_iap' and original_transaction_id = $5"
      : "id = $5";
    await client.query(
      `update entitlement_grants
       set status = case when id = $4 then $1 else 'revoked' end,
           status_reason = $2,
           status_updated_at = $3
       where status = 'active'
         and billing_order_id in (select id from billing_orders where ${familyOrderCondition})`,
      [nextGrantStatus, input.reason, now, grant.id, order.original_transaction_id || order.id],
    );
    await client.query(
      `update billing_orders
       set status = $1,
           status_reason = $2,
           status_updated_at = $3
       where id = $4`,
      [getAppleBillingOrderStatus(action, order.status), input.reason, now, order.id],
    );
    if (order.original_transaction_id) {
      await client.query(
        `update apple_subscriptions
         set status = $1, last_signed_date = coalesce($2::timestamptz, last_signed_date), last_notification_uuid = $3, updated_at = $4
         where original_transaction_id = $5
           and current_transaction_id = $6
           and (last_signed_date is null or $2::timestamptz is null or last_signed_date <= $2::timestamptz)`,
        [action === "expired" ? "expired" : "revoked", input.signedDate || null, notificationUUID, now, order.original_transaction_id, order.external_transaction_id],
      );
    }

    const activePlan = await postgresResolveActivePlan(client, user.id);
    const activePlanMinutes = getPlanMinutes(activePlan);
    const updatedUserResult = activePlan === "free"
      ? await client.query<UserRow>(
          `update users
           set plan = 'free',
               official_minutes_total = free_trial_minutes_total,
               official_minutes_used = free_trial_minutes_used,
               official_minutes_period_start_at = free_trial_granted_at,
               official_minutes_period_end_at = null,
               official_minutes_period_source = '${FREE_TRIAL_SOURCE}',
               official_minutes_billing_order_id = null
           where id = $1 and deleted_at is null returning *`,
          [user.id],
        )
      : await client.query<UserRow>(
          "update users set plan = $1, official_minutes_total = $2, official_minutes_used = least(official_minutes_used, $2) where id = $3 and deleted_at is null returning *",
          [activePlan, activePlanMinutes, user.id],
        );
    const updatedUser = updatedUserResult.rows[0] || user;

    await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
      createId("usage"),
      user.id,
      "manual_adjustment",
      0,
      now,
      `Apple IAP notification ${input.notificationType}: ${input.reason}`,
    ]);

    const nextOrderResult = await client.query<BillingOrderRow>("select * from billing_orders where id = $1", [order.id]);
    const nextGrantResult = await client.query<EntitlementGrantRow>("select * from entitlement_grants where id = $1", [grant.id]);
    return {
      duplicate: false,
      grant: nextGrantResult.rows[0],
      order: nextOrderResult.rows[0],
      user: updatedUser,
    };
  });
  } catch (error) {
    await postgresFailAppleNotificationEvent(notificationUUID, error instanceof AuthError ? error.code || `http_${error.status}` : "processing_failed");
    throw error;
  }

  await postgresCompleteAppleNotificationEvent(notificationUUID, "processed", action);

  return {
    action,
    duplicate: result.duplicate,
    grant: result.grant ? await postgresSummarizeEntitlementGrant(result.grant) : undefined,
    order: await postgresSummarizeBillingOrder(result.order),
    user: toSafeUser(result.user),
  };
}

async function postgresUpdateAdminEntitlementGrantStatus(input: AdminEntitlementGrantStatusInput): Promise<EntitlementGrantSummary> {
  const now = new Date().toISOString();
  const reason = input.reason?.trim() || `${input.status} entitlement grant`;

  const result = await postgresTransaction(async (client) => {
    const grantResult = await client.query<EntitlementGrantRow>("select * from entitlement_grants where id = $1 for update", [input.grantId]);
    const grant = grantResult.rows[0];
    if (!grant) throw new AuthError("权益记录不存在。", 404);
    if (grant.status !== "active") throw new AuthError("只能处理 active 状态的权益记录。", 409);

    const userResult = await client.query<UserRow>("select * from users where id = $1 and deleted_at is null for update", [grant.user_id]);
    const user = userResult.rows[0];
    if (!user) throw new AuthError("账号不存在或已删除。", 404);
    if (user.plan !== grant.plan) {
      throw new AuthError("用户当前方案已变化，不能自动回退该权益。", 409);
    }

    if (grant.previous_plan === "free") {
      await client.query(
        `update users
         set plan = 'free',
             official_minutes_total = free_trial_minutes_total,
             official_minutes_used = free_trial_minutes_used,
             official_minutes_period_start_at = free_trial_granted_at,
             official_minutes_period_end_at = null,
             official_minutes_period_source = '${FREE_TRIAL_SOURCE}',
             official_minutes_billing_order_id = null
         where id = $1 and deleted_at is null`,
        [grant.user_id],
      );
    } else {
      const previousPlanMinutes = getPlanMinutes(grant.previous_plan);
      await client.query(
        "update users set plan = $1, official_minutes_total = $2, official_minutes_used = least(official_minutes_used, $2) where id = $3 and deleted_at is null",
        [grant.previous_plan, previousPlanMinutes, grant.user_id],
      );
    }
    const updatedGrant = await client.query<EntitlementGrantRow>(
      `update entitlement_grants
       set status = $1,
           status_changed_by_user_id = $2,
           status_reason = $3,
           status_updated_at = $4
       where id = $5
       returning *`,
      [input.status, input.changedByUserId, reason, now, input.grantId],
    );
    if (grant.billing_order_id) {
      await client.query(
        `update billing_orders
         set status = $1,
             status_reason = $2,
             status_updated_at = $3
         where id = $4`,
        [input.status === "refunded" ? "refunded" : "voided", reason, now, grant.billing_order_id],
      );
    }
    await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
      createId("usage"),
      grant.user_id,
      "manual_adjustment",
      0,
      now,
      `Admin ${input.changedByUserId} marked grant ${grant.id} ${input.status}: ${reason}`,
    ]);

    return updatedGrant.rows[0];
  });

  return postgresSummarizeEntitlementGrant(result);
}

async function postgresSaveProviderCredential(userId: string, input: ProviderCredentialInput) {
  const providerId = input.providerId.trim();
  if (!providerId) throw new AuthError("请选择 Provider。", 400);
  if (!(await postgresFindActiveUserById(userId))) throw new AuthError("账号不存在或已删除。", 401);

  const fields = sanitizeRecord(input.fields ?? {});
  const secrets = sanitizeRecord(input.secrets ?? {});
  const removeSecretNames = sanitizeNameList(input.removeSecrets ?? []).filter((name) => !(name in secrets));
  if (Object.keys(secrets).length > 0 || removeSecretNames.length > 0) {
    assertSecretAuditSinkWritable();
  }
  const encryptedEntries = await Promise.all(
    Object.entries(secrets).map(async ([key, value]) => ({ encrypted: await encryptSecret(value, { userId, providerId }, key), key, value })),
  );
  const result = await postgresTransaction(async (client) => {
    const activeUser = await client.query("select id from users where id = $1 and deleted_at is null for update", [userId]);
    if (!activeUser.rows[0]) throw new AuthError("账号不存在或已删除。", 401);

    const existing = await client.query<ProviderCredentialRow>(
      "select * from provider_credentials where user_id = $1 and provider_id = $2",
      [userId, providerId],
    );
    const current = existing.rows[0];
    const encryptedSecrets = parseJsonRecord(current?.encrypted_secrets);
    const secretPreviews = parseJsonRecord(current?.secret_previews);
    const mergedFields = { ...parseJsonRecord(current?.fields), ...fields };
    const savedSecretNames: string[] = [];
    const rotatedSecretNames: string[] = [];
    const removedSecretNames: string[] = [];

    for (const name of removeSecretNames) {
      if (!Object.prototype.hasOwnProperty.call(encryptedSecrets, name)) continue;
      delete encryptedSecrets[name];
      delete secretPreviews[name];
      removedSecretNames.push(name);
    }
    for (const { encrypted, key, value } of encryptedEntries) {
      if (Object.prototype.hasOwnProperty.call(encryptedSecrets, key)) rotatedSecretNames.push(key);
      else savedSecretNames.push(key);
      encryptedSecrets[key] = encrypted;
      secretPreviews[key] = previewSecret(value);
    }

    const now = new Date().toISOString();
    const saved = await client.query<ProviderCredentialRow>(
      `insert into provider_credentials (id, user_id, provider_id, label, fields, encrypted_secrets, secret_previews, created_at, updated_at)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)
       on conflict (user_id, provider_id)
       do update set label = excluded.label, fields = excluded.fields, encrypted_secrets = excluded.encrypted_secrets, secret_previews = excluded.secret_previews, updated_at = excluded.updated_at
       returning *`,
      [
        current?.id || createId("provider"),
        userId,
        providerId,
        input.label?.trim() || current?.label || providerId,
        JSON.stringify(mergedFields),
        JSON.stringify(encryptedSecrets),
        JSON.stringify(secretPreviews),
        current ? toIsoString(current.created_at) : now,
        now,
      ],
    );
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
    await enqueuePostgresSecretAuditEvents(client, secretAuditEvents);
    assertSecretAuditTransactionTestHook();
    return {
      row: saved.rows[0],
      secretAuditEventCount: secretAuditEvents.length,
    };
  });
  await flushSecretAuditOutboxBestEffort(result.secretAuditEventCount);

  return summarizeCredential(result.row);
}

async function postgresListProviderCredentials(userId: string) {
  const result = await postgresQuery<ProviderCredentialRow>("select * from provider_credentials where user_id = $1 order by updated_at desc", [userId]);
  return result.rows.map(summarizeCredential);
}

async function postgresDeleteProviderCredential(userId: string, providerId: string) {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) throw new AuthError("请选择 Provider。", 400);
  assertSecretAuditSinkWritable();

  const credential = await postgresTransaction(async (client) => {
    const user = await lockPostgresQuotaUser(client, userId);
    const result = await client.query<ProviderCredentialRow>(
      "delete from provider_credentials where user_id = $1 and provider_id = $2 returning *",
      [userId, normalizedProviderId],
    );
    const deleted = result.rows[0];
    if (!deleted) throw new AuthError("Provider 配置不存在。", 404);
    if ((user.processing_mode || "official_quota") === "byok") {
      const remaining = await client.query<ProviderCredentialRow>(
        "select * from provider_credentials where user_id = $1",
        [userId],
      );
      if (!getByokCoverage(remaining.rows.map(providerCredentialDescriptorFromRow)).complete) {
        await client.query(
          "update users set processing_mode = 'official_quota' where id = $1 and deleted_at is null",
          [userId],
        );
      }
    }
    await enqueuePostgresSecretAuditEvents(client, [
      createSecretAuditEvent({
        eventType: "provider_secret_delete",
        userId,
        providerId: deleted.provider_id,
        secretNames: Object.keys(parseJsonRecord(deleted.encrypted_secrets)),
        reason: "provider_delete",
      }),
    ]);
    assertSecretAuditTransactionTestHook();
    return deleted;
  });

  await flushSecretAuditOutboxBestEffort(1);
  await deleteProviderSecretReference({ localSecretPath: POSTGRES_SECRET_PATH, providerId: credential.provider_id, userId });
}

async function postgresGetProviderRuntimeConfig(userId: string, providerId: string): Promise<ProviderRuntimeConfig | null> {
  const result = await postgresQuery<ProviderCredentialRow>("select * from provider_credentials where user_id = $1 and provider_id = $2", [userId, providerId]);
  const credential = result.rows[0];
  if (!credential) return null;

  const encryptedSecrets = parseJsonRecord(credential.encrypted_secrets);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(encryptedSecrets)) {
    try {
      secrets[key] = await decryptSecret(value, { userId: credential.user_id, providerId: credential.provider_id }, key);
    } catch (error) {
      const event = createSecretAuditEvent({
        eventType: "provider_secret_decrypt_failed",
        userId: credential.user_id,
        providerId: credential.provider_id,
        secretNames: [key],
        reason: "provider_runtime_decrypt",
      });
      await postgresTransaction(async (client) => {
        await enqueuePostgresSecretAuditEvents(client, [event]);
      });
      await flushSecretAuditOutboxBestEffort(1);
      throw error;
    }
  }

  return {
    providerId: credential.provider_id,
    fields: parseJsonRecord(credential.fields),
    secrets,
  };
}

async function postgresGetMeetingProcessingReservation(
  userId: string,
  operationKey: string,
): Promise<MeetingProcessingReservation | null> {
  const result = await postgresQuery<MeetingProcessingReservationRow>(
    "select * from meeting_processing_reservations where user_id = $1 and operation_key = $2",
    [userId, operationKey],
  );
  return result.rows[0] ? mapPostgresProcessingReservation(result.rows[0]) : null;
}

async function postgresReserveMeetingRealtimeQuota(userId: string, input: ReserveRealtimeQuotaInput): Promise<RealtimeQuotaClaim> {
  return postgresTransaction(async (client) => {
    const user = await lockPostgresQuotaUser(client, userId);
    const existing = await findPostgresProcessingReservation(client, userId, input.operationKey);
    assertPostgresReservationMeeting(existing, input.meetingId);
    assertPostgresReservationProcessingMode(existing, input.processingRoute);
    if (existing?.status === "finalized") {
      throw new AuthError("会议已经完成处理，不能继续调用实时识别。", 409, "meeting_processing_finalized");
    }

    const highestSequence = Number(existing?.realtime_highest_sequence ?? 0);
    const expectedSequence = existing ? highestSequence + 1 : input.sequence;
    const duplicate = Boolean(existing && input.sequence <= highestSequence);
    if (!duplicate && input.sequence !== expectedSequence) {
      throw new AuthError(`实时分片顺序错误，当前需要第 ${expectedSequence} 片。`, 409, "realtime_sequence_out_of_order");
    }

    const realtimeDurationMs = duplicate
      ? Math.max(0, Number(existing?.realtime_duration_ms ?? 0))
      : Math.max(0, Number(existing?.realtime_duration_ms ?? 0)) + Math.max(1, Math.round(input.durationMs));
    const processingRoute = existing?.processing_route ?? input.processingRoute;
    const requiredMinutes = processingRoute === "byok" ? 0 : Math.max(1, Math.ceil(realtimeDurationMs / 60_000));
    const officialMinutesReserved = await reservePostgresOfficialCapacity(
      client,
      user,
      existing,
      requiredMinutes,
    );
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const reservationExpiresAt = new Date(nowDate.getTime() + DEFAULT_MEETING_RESERVATION_LEASE_MS).toISOString();
    const saved = await client.query<MeetingProcessingReservationRow>(
      `insert into meeting_processing_reservations (
         id, user_id, meeting_id, operation_key, processing_route, status,
         processed_minutes, official_minutes_reserved, official_minutes_settled,
         realtime_duration_ms, realtime_highest_sequence, reservation_expires_at,
         quota_period_source, quota_period_start_at, quota_billing_order_id,
         created_at, updated_at
       ) values ($1,$2,$3,$4,$5,'reserved',0,$6,0,$7,$8,$9,$10,$11,$12,$13,$13)
       on conflict (user_id, operation_key) do update
       set processing_route = meeting_processing_reservations.processing_route,
           official_minutes_reserved = excluded.official_minutes_reserved,
           realtime_duration_ms = excluded.realtime_duration_ms,
           realtime_highest_sequence = excluded.realtime_highest_sequence,
           reservation_expires_at = excluded.reservation_expires_at,
           released_at = null,
           updated_at = excluded.updated_at
       returning *`,
      [
        existing?.id || createId("quota"),
        userId,
        input.meetingId,
        input.operationKey,
        input.processingRoute,
        officialMinutesReserved,
        realtimeDurationMs,
        duplicate ? highestSequence : input.sequence,
        reservationExpiresAt,
        user.official_minutes_period_source ?? null,
        user.official_minutes_period_start_at ?? null,
        user.official_minutes_billing_order_id ?? null,
        now,
      ],
    );
    return {
      ...mapPostgresProcessingReservation(saved.rows[0]),
      duplicate,
      expectedSequence: duplicate ? expectedSequence : input.sequence + 1,
    };
  });
}

async function postgresReserveMeetingFinalizationQuota(userId: string, input: ReserveFinalizationQuotaInput): Promise<MeetingProcessingReservation> {
  return postgresTransaction(async (client) => {
    const user = await lockPostgresQuotaUser(client, userId);
    const existing = await findPostgresProcessingReservation(client, userId, input.operationKey);
    assertPostgresReservationMeeting(existing, input.meetingId);
    assertPostgresReservationProcessingMode(existing, input.processingRoute);
    if (existing?.status === "finalized") return mapPostgresProcessingReservation(existing);
    const processingRoute = existing?.processing_route ?? input.processingRoute;
    const usage = calculateMeetingUsage({ durationMs: input.durationMs, route: processingRoute });
    const officialMinutesReserved = await reservePostgresOfficialCapacity(
      client,
      user,
      existing,
      usage.officialMinutesCharged,
    );
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const reservationExpiresAt = new Date(nowDate.getTime() + DEFAULT_MEETING_RESERVATION_LEASE_MS).toISOString();
    const saved = await client.query<MeetingProcessingReservationRow>(
      `insert into meeting_processing_reservations (
         id, user_id, meeting_id, operation_key, processing_route, status,
         processed_minutes, official_minutes_reserved, official_minutes_settled,
         realtime_duration_ms, realtime_highest_sequence, reservation_expires_at,
         quota_period_source, quota_period_start_at, quota_billing_order_id,
         created_at, updated_at
       ) values ($1,$2,$3,$4,$5,'reserved',$6,$7,0,0,0,$8,$9,$10,$11,$12,$12)
       on conflict (user_id, operation_key) do update
       set processing_route = meeting_processing_reservations.processing_route,
           processed_minutes = excluded.processed_minutes,
           official_minutes_reserved = excluded.official_minutes_reserved,
           reservation_expires_at = excluded.reservation_expires_at,
           released_at = null,
           updated_at = excluded.updated_at
       returning *`,
      [
        existing?.id || createId("quota"),
        userId,
        input.meetingId,
        input.operationKey,
        input.processingRoute,
        usage.processedMinutes,
        officialMinutesReserved,
        reservationExpiresAt,
        user.official_minutes_period_source ?? null,
        user.official_minutes_period_start_at ?? null,
        user.official_minutes_billing_order_id ?? null,
        now,
      ],
    );
    return mapPostgresProcessingReservation(saved.rows[0]);
  });
}

async function postgresClaimMeetingProviderStep(
  userId: string,
  input: ClaimMeetingProviderStepInput,
): Promise<MeetingProviderStepClaimResult> {
  return postgresTransaction(async (client) => {
    await lockPostgresQuotaUser(client, userId);
    const now = new Date();
    const reservation = await findPostgresReservationById(client, userId, input.reservationId);
    const stageKey = meetingProviderStageKey(input.stage);
    const current = (
      await client.query<MeetingProviderStepRow>(
        "select * from meeting_processing_provider_steps where reservation_id = $1 and stage_key = $2 for update",
        [reservation.id, stageKey],
      )
    ).rows[0];
    if (current?.status === "completed") return { outcome: "completed", step: mapPostgresProviderStep(current) };
    if (current?.status === "started") return { outcome: "uncertain", step: mapPostgresProviderStep(current) };
    if (current?.status === "claimed" && new Date(current.lease_expires_at).getTime() > now.getTime()) {
      return { outcome: "busy", step: mapPostgresProviderStep(current) };
    }
    assertPostgresReservationActive(reservation, now);

    const claimToken = crypto.randomBytes(32).toString("base64url");
    const leaseExpiresAt = new Date(now.getTime() + normalizeProviderStepLeaseMs(input.leaseMs)).toISOString();
    const saved = await client.query<MeetingProviderStepRow>(
      `insert into meeting_processing_provider_steps (
         id, reservation_id, user_id, stage_key, stage_type, sequence, status,
         claim_token_hash, lease_expires_at, official_minutes_settled, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,'claimed',$7,$8,0,$9,$9)
       on conflict (reservation_id, stage_key) do update
       set status = 'claimed', claim_token_hash = excluded.claim_token_hash,
           lease_expires_at = excluded.lease_expires_at, started_at = null,
           completed_at = null, released_at = null, official_minutes_settled = 0,
           free_trial_minutes_settled = 0, settlement_period_identity = null,
           updated_at = excluded.updated_at
       returning *`,
      [
        current?.id || createId("provider_step"),
        reservation.id,
        userId,
        stageKey,
        input.stage.type,
        input.stage.type === "realtime_asr" ? input.stage.sequence : null,
        hashPostgresClaimToken(claimToken),
        leaseExpiresAt,
        now.toISOString(),
      ],
    );
    await client.query(
      `update meeting_processing_reservations
       set reservation_expires_at = greatest(reservation_expires_at, $1), released_at = null, updated_at = $2
       where id = $3`,
      [leaseExpiresAt, now.toISOString(), reservation.id],
    );
    return { outcome: "claimed", step: mapPostgresProviderStep(saved.rows[0]), claimToken };
  });
}

async function postgresStartMeetingProviderStep(
  userId: string,
  input: StartMeetingProviderStepInput,
): Promise<MeetingProviderStepTransitionResult> {
  return postgresTransaction(async (client) => {
    const user = await lockPostgresQuotaUser(client, userId);
    const step = await findPostgresProviderStep(client, userId, input.stepId);
    if (step.status === "completed") return { outcome: "completed", step: mapPostgresProviderStep(step) };
    if (step.status === "started") return { outcome: "uncertain", step: mapPostgresProviderStep(step) };
    const now = new Date();
    assertPostgresProviderClaim(step, input.claimToken, now);
    const reservation = await findPostgresReservationById(client, userId, step.reservation_id);
    assertPostgresReservationActive(reservation, now);
    const freeTrialMinutesBeforeStart = Number(user.free_trial_minutes_used);
    const settlementPeriodIdentity = postgresSettlementPeriodIdentity(user);
    const settledDelta = await settlePostgresReservationCapacity(client, user, reservation, now);
    const freeTrialMinutesSettled = Math.min(
      settledDelta,
      Math.max(0, Number(user.free_trial_minutes_used) - freeTrialMinutesBeforeStart),
    );
    const saved = await client.query<MeetingProviderStepRow>(
      `update meeting_processing_provider_steps
       set status = 'started', official_minutes_settled = $1,
           free_trial_minutes_settled = $2, settlement_period_identity = $3,
           started_at = $4, updated_at = $4
       where id = $5 returning *`,
      [settledDelta, freeTrialMinutesSettled, settlementPeriodIdentity, now.toISOString(), step.id],
    );
    return { outcome: "started", step: mapPostgresProviderStep(saved.rows[0]) };
  });
}

async function postgresCompleteMeetingProviderStep(
  userId: string,
  input: CompleteMeetingProviderStepInput,
): Promise<MeetingProviderStepTransitionResult> {
  return postgresTransaction(async (client) => {
    await lockPostgresQuotaUserIncludingDeleted(client, userId);
    const step = await findPostgresProviderStep(client, userId, input.stepId);
    if (step.status === "completed") return { outcome: "completed", step: mapPostgresProviderStep(step) };
    if (step.status !== "started" || hashPostgresClaimToken(input.claimToken) !== step.claim_token_hash) {
      return { outcome: "uncertain", step: mapPostgresProviderStep(step) };
    }
    const now = new Date().toISOString();
    const saved = await client.query<MeetingProviderStepRow>(
      `update meeting_processing_provider_steps
       set status = 'completed', completed_at = $1, updated_at = $1
       where id = $2 returning *`,
      [now, step.id],
    );
    return { outcome: "completed", step: mapPostgresProviderStep(saved.rows[0]) };
  });
}

async function postgresReconcileMeetingProviderStep(
  userId: string,
  input: ReconcileMeetingProviderStepInput,
): Promise<MeetingProviderStepTransitionResult> {
  return postgresTransaction(async (client) => {
    await lockPostgresQuotaUserIncludingDeleted(client, userId);
    const reservation = await findPostgresReservationById(client, userId, input.reservationId);
    const step = (
      await client.query<MeetingProviderStepRow>(
        "select * from meeting_processing_provider_steps where reservation_id = $1 and stage_key = $2 for update",
        [reservation.id, meetingProviderStageKey(input.stage)],
      )
    ).rows[0];
    if (!step || !["started", "completed"].includes(step.status)) {
      throw new AuthError(
        "Durable provider output does not match a started provider step.",
        409,
        "provider_step_checkpoint_mismatch",
      );
    }
    if (step.status === "completed") return { outcome: "completed", step: mapPostgresProviderStep(step) };
    const now = new Date().toISOString();
    const saved = await client.query<MeetingProviderStepRow>(
      `update meeting_processing_provider_steps
       set status = 'completed', completed_at = $1, updated_at = $1
       where id = $2 and status = 'started' returning *`,
      [now, step.id],
    );
    if (!saved.rows[0]) {
      throw new AuthError(
        "Durable provider output could not reconcile its provider step.",
        409,
        "provider_step_checkpoint_mismatch",
      );
    }
    return { outcome: "completed", step: mapPostgresProviderStep(saved.rows[0]) };
  });
}

async function postgresReleaseMeetingProviderStep(
  userId: string,
  input: ReleaseMeetingProviderStepInput,
): Promise<MeetingProviderStepTransitionResult> {
  return postgresTransaction(async (client) => {
    await lockPostgresQuotaUser(client, userId);
    const step = await findPostgresProviderStep(client, userId, input.stepId);
    if (step.status === "completed") return { outcome: "completed", step: mapPostgresProviderStep(step) };
    if (step.status === "started") return { outcome: "uncertain", step: mapPostgresProviderStep(step) };
    if (step.status === "released") return { outcome: "released", step: mapPostgresProviderStep(step) };
    if (hashPostgresClaimToken(input.claimToken) !== step.claim_token_hash) {
      throw new AuthError("Provider 步骤认领令牌无效。", 409, "provider_step_claim_mismatch");
    }
    const now = new Date().toISOString();
    const saved = await client.query<MeetingProviderStepRow>(
      `update meeting_processing_provider_steps
       set status = 'released', released_at = $1, updated_at = $1
       where id = $2 returning *`,
      [now, step.id],
    );
    return { outcome: "released", step: mapPostgresProviderStep(saved.rows[0]) };
  });
}

async function postgresRejectMeetingProviderStep(
  userId: string,
  input: RejectMeetingProviderStepInput,
): Promise<MeetingProviderStepTransitionResult> {
  return postgresTransaction(async (client) => {
    const user = await lockPostgresQuotaUserIncludingDeleted(client, userId);
    const step = await findPostgresProviderStep(client, userId, input.stepId);
    if (hashPostgresClaimToken(input.claimToken) !== step.claim_token_hash) {
      throw new AuthError("Provider 步骤认领令牌无效。", 409, "provider_step_claim_mismatch");
    }
    if (step.status === "completed") return { outcome: "completed", step: mapPostgresProviderStep(step) };
    if (step.status === "released") return { outcome: "released", step: mapPostgresProviderStep(step) };

    const now = new Date().toISOString();
    if (user.deleted_at) {
      if (step.status === "started") {
        await client.query(
          `update meeting_processing_reservations
           set official_minutes_settled = greatest(official_minutes_settled - $1, 0), updated_at = $2
           where id = $3`,
          [Math.max(0, Number(step.official_minutes_settled)), now, step.reservation_id],
        );
      }
      const saved = await client.query<MeetingProviderStepRow>(
        `update meeting_processing_provider_steps
         set status = 'released', official_minutes_settled = 0,
             free_trial_minutes_settled = 0, released_at = $1, updated_at = $1
         where id = $2 returning *`,
        [now, step.id],
      );
      return { outcome: "released", step: mapPostgresProviderStep(saved.rows[0]) };
    }
    if (step.status === "started") {
      const reservation = await findPostgresReservationById(client, userId, step.reservation_id);
      if (reservation.status === "finalized") {
        throw new AuthError(
          "Provider 明确拒绝，但额度记录已无法安全回退。",
          409,
          "provider_step_refund_conflict",
        );
      }
      const settledDelta = Math.max(0, Number(step.official_minutes_settled));
      if (Number(reservation.official_minutes_settled) < settledDelta) {
        throw new AuthError(
          "Provider 明确拒绝，但已结算分钟与额度记录不一致。",
          409,
          "provider_step_refund_conflict",
        );
      }
      const currentPeriodMatches =
        Boolean(step.settlement_period_identity) &&
        step.settlement_period_identity === postgresSettlementPeriodIdentity(user);
      if (currentPeriodMatches && Number(user.official_minutes_used) < settledDelta) {
        throw new AuthError(
          "Provider 明确拒绝，但当前账期已用分钟不足以安全回退。",
          409,
          "provider_step_refund_conflict",
        );
      }
      const freeTrialMinutesSettled = Math.max(0, Number(step.free_trial_minutes_settled ?? 0));
      await client.query(
        `update users
         set official_minutes_used = case
               when $2 then official_minutes_used - $1
               else official_minutes_used
             end,
             free_trial_minutes_used = greatest(free_trial_minutes_used - $3, 0)
         where id = $4 and deleted_at is null`,
        [settledDelta, currentPeriodMatches, freeTrialMinutesSettled, userId],
      );
      await client.query(
        `update meeting_processing_reservations
         set official_minutes_settled = official_minutes_settled - $1, updated_at = $2
         where id = $3`,
        [settledDelta, now, reservation.id],
      );
    }

    const saved = await client.query<MeetingProviderStepRow>(
      `update meeting_processing_provider_steps
       set status = 'released', official_minutes_settled = 0, released_at = $1, updated_at = $1
       where id = $2 returning *`,
      [now, step.id],
    );
    return { outcome: "released", step: mapPostgresProviderStep(saved.rows[0]) };
  });
}

async function postgresReleaseMeetingProcessingReservation(
  userId: string,
  input: ReleaseMeetingProcessingReservationInput,
): Promise<MeetingProcessingReservation> {
  return postgresTransaction(async (client) => {
    await lockPostgresQuotaUser(client, userId);
    const reservation = await findPostgresReservationById(client, userId, input.reservationId);
    if (reservation.status === "finalized") return mapPostgresProcessingReservation(reservation);
    const uncertain = await client.query(
      "select id from meeting_processing_provider_steps where reservation_id = $1 and status = 'started' limit 1 for update",
      [reservation.id],
    );
    if (uncertain.rowCount) {
      throw new AuthError("Provider 调用状态不确定，不能释放该额度预占。", 409, "provider_step_uncertain");
    }
    const now = new Date().toISOString();
    await client.query(
      `update meeting_processing_provider_steps
       set status = 'released', released_at = $1, updated_at = $1
       where reservation_id = $2 and status = 'claimed'`,
      [now, reservation.id],
    );
    const saved = await client.query<MeetingProcessingReservationRow>(
      `update meeting_processing_reservations
       set released_at = $1, reservation_expires_at = $1, updated_at = $1
       where id = $2 returning *`,
      [now, reservation.id],
    );
    return mapPostgresProcessingReservation(saved.rows[0]);
  });
}

async function postgresPurgeMeetingProcessingLedger(userId: string, meetingId: string) {
  await postgresTransaction(async (client) => {
    await archiveAndDeletePostgresMeetingProcessingLedger(client, userId, meetingId);
  });
}

async function postgresRecordMeetingFinalizeUsage(userId: string, input: { meetingId: string; durationMs: number; route: MeetingProcessingRoute; resultGeneratedAt: string; isReprocess?: boolean; nonBillable?: boolean; reservationId?: string; reservationOperationKey?: string }) {
  await postgresTransaction(async (client) => {
    const user = await lockPostgresQuotaUser(client, userId);
    const usageKey = `meeting:${input.meetingId}`;
    const resultKey = `result:${input.resultGeneratedAt}`;
    const existingEvents = await client.query<UsageEventRow>(
      `select * from usage_events
       where user_id = $1 and type = 'meeting_finalize'
         and (($2::text is not null and processing_reservation_id = $2) or note like $3)
       for update`,
      [userId, input.reservationId ?? null, `%${usageKey}%`],
    );
    const alreadyRecorded = existingEvents.rows.some((event) =>
      (input.reservationId && event.processing_reservation_id === input.reservationId) ||
      event.note.includes(resultKey) ||
      (!input.isReprocess && !event.note.includes("result:")),
    );
    if (alreadyRecorded) return;

    const calculatedUsage = calculateMeetingUsage(input);
    const reservation = input.reservationId
      ? (
          await client.query<MeetingProcessingReservationRow>(
            "select * from meeting_processing_reservations where id = $1 and user_id = $2 for update",
            [input.reservationId, userId],
          )
        ).rows[0]
      : input.reservationOperationKey
        ? await findPostgresProcessingReservation(client, userId, input.reservationOperationKey)
        : undefined;
    if (input.reservationId && !reservation) {
      throw new AuthError("会议额度预占记录不存在或不属于当前账号。", 409, "meeting_quota_reservation_missing");
    }
    if (reservation && reservation.meeting_id !== input.meetingId) {
      throw new AuthError("会议额度预占记录不存在或不属于当前账号。", 409, "meeting_quota_reservation_missing");
    }
    let officialMinutesCharged: number;
    if (reservation) {
      officialMinutesCharged = Number(reservation.official_minutes_settled);
      const requiredSettlement = input.nonBillable ? 0 : calculatedUsage.officialMinutesCharged;
      if (officialMinutesCharged < requiredSettlement) {
        throw new AuthError("官方额度尚未在 Provider 调用前完成结算。", 409, "meeting_quota_not_settled");
      }
    } else {
      // Backward-compatible ledger path for callers created before provider fencing.
      officialMinutesCharged = await settlePostgresLegacyUsage(client, user, calculatedUsage.officialMinutesCharged);
    }
    const usage = { processedMinutes: calculatedUsage.processedMinutes, officialMinutesCharged };
    const now = new Date().toISOString();
    if (reservation) {
      await client.query(
        `update meeting_processing_reservations
         set processing_route = $1, processed_minutes = $2, status = 'finalized',
             released_at = null, result_generated_at = $3, finalized_at = $4, updated_at = $4
         where id = $5`,
        [input.route, usage.processedMinutes, input.resultGeneratedAt, now, reservation.id],
      );
    }
    await client.query(
      "insert into usage_events (id, user_id, type, minutes, created_at, note, processing_reservation_id) values ($1,$2,$3,$4,$5,$6,$7)",
      [
        createId("usage"),
        userId,
        "meeting_finalize",
        usage.officialMinutesCharged,
        now,
        buildMeetingUsageNote({ meetingId: input.meetingId, resultGeneratedAt: input.resultGeneratedAt, route: input.route, ...usage }),
        reservation?.id ?? null,
      ],
    );
  });

  return postgresGetUserUsage(userId);
}

async function lockPostgresQuotaUser(client: PgClient, userId: string) {
  const result = await client.query<UserRow>("select * from users where id = $1 and deleted_at is null for update", [userId]);
  const user = result.rows[0];
  if (!user) throw new AuthError("账号不存在或已删除。", 404);
  return user;
}

async function lockPostgresQuotaUserIncludingDeleted(client: PgClient, userId: string) {
  const result = await client.query<UserRow>("select * from users where id = $1 for update", [userId]);
  const user = result.rows[0];
  if (!user) throw new AuthError("账号不存在。", 404);
  return user;
}

async function findPostgresProcessingReservation(client: PgClient, userId: string, operationKey: string) {
  const result = await client.query<MeetingProcessingReservationRow>(
    "select * from meeting_processing_reservations where user_id = $1 and operation_key = $2 for update",
    [userId, operationKey],
  );
  return result.rows[0];
}

function assertPostgresReservationMeeting(reservation: MeetingProcessingReservationRow | undefined, meetingId: string) {
  if (reservation && reservation.meeting_id !== meetingId) {
    throw new AuthError("会议额度预占记录与当前会议不匹配。", 409, "meeting_quota_owner_mismatch");
  }
}

function assertPostgresReservationProcessingMode(
  reservation: MeetingProcessingReservationRow | undefined,
  requestedRoute: MeetingProcessingRoute,
) {
  if (reservation && reservation.processing_route !== requestedRoute) {
    throw new AuthError(
      "这场会议的处理方式已在开始时固定，不能在上传或重试时更换。",
      409,
      "meeting_processing_mode_conflict",
    );
  }
}

async function reservePostgresOfficialCapacity(
  client: PgClient,
  user: UserRow,
  reservation: MeetingProcessingReservationRow | undefined,
  targetMinutes: number,
) {
  const target = Math.max(Number(reservation?.official_minutes_reserved ?? 0), Math.max(0, Math.round(targetMinutes)));
  const settled = Number(reservation?.official_minutes_settled ?? 0);
  const pendingTarget = Math.max(0, target - settled);
  const otherPending = await postgresPendingCapacity(client, user.id, reservation?.id);
  const available = Math.max(0, Number(user.official_minutes_total) - Number(user.official_minutes_used) - otherPending);
  if (pendingTarget > available) {
    throw new AuthError(
      `官方额度不足：本次至少需要 ${target} 分钟，扣除其他处理中任务后还可预占 ${available} 分钟。完整录音仍保留，可配置 BYOK 或增加额度后重试。`,
      402,
      "official_quota_insufficient",
    );
  }
  return target;
}

async function settlePostgresReservationCapacity(
  client: PgClient,
  user: UserRow,
  reservation: MeetingProcessingReservationRow,
  now: Date,
) {
  const delta = Math.max(0, Number(reservation.official_minutes_reserved) - Number(reservation.official_minutes_settled));
  const otherPending = await postgresPendingCapacity(client, user.id, reservation.id);
  const available = Math.max(0, Number(user.official_minutes_total) - Number(user.official_minutes_used) - otherPending);
  if (delta > available) {
    throw new AuthError(
      `官方额度不足：Provider 调用前需要结算 ${delta} 分钟，当前可结算 ${available} 分钟。`,
      402,
      "official_quota_insufficient",
    );
  }
  if (delta > 0) {
    await incrementPostgresOfficialMinutes(client, user, delta);
    await client.query(
      `update meeting_processing_reservations
       set official_minutes_settled = official_minutes_settled + $1, updated_at = $2
       where id = $3`,
      [delta, now.toISOString(), reservation.id],
    );
    reservation.official_minutes_settled = Number(reservation.official_minutes_settled) + delta;
  }
  return delta;
}

async function settlePostgresLegacyUsage(client: PgClient, user: UserRow, targetMinutes: number) {
  const target = Math.max(0, Math.round(targetMinutes));
  const pending = await postgresPendingCapacity(client, user.id);
  const available = Math.max(0, Number(user.official_minutes_total) - Number(user.official_minutes_used) - pending);
  if (target > available) {
    throw new AuthError(
      `官方额度不足：本次至少需要 ${target} 分钟，扣除处理中任务后还可使用 ${available} 分钟。`,
      402,
      "official_quota_insufficient",
    );
  }
  await incrementPostgresOfficialMinutes(client, user, target);
  return target;
}

async function incrementPostgresOfficialMinutes(client: PgClient, user: UserRow, minutes: number) {
  if (minutes <= 0) return;
  await client.query(
    `update users
     set official_minutes_used = official_minutes_used + $1,
         free_trial_minutes_used = case
           when plan = 'free' then least(free_trial_minutes_total, free_trial_minutes_used + $1)
           else free_trial_minutes_used
         end
     where id = $2 and deleted_at is null`,
    [minutes, user.id],
  );
  user.official_minutes_used += minutes;
  if (user.plan === "free") {
    user.free_trial_minutes_used = Math.min(user.free_trial_minutes_total, user.free_trial_minutes_used + minutes);
  }
}

async function postgresPendingCapacity(client: PgClient, userId: string, excludeReservationId?: string) {
  const result = await client.query<{ pending: number | string }>(
    `select coalesce(sum(greatest(official_minutes_reserved - official_minutes_settled, 0)), 0) as pending
     from meeting_processing_reservations
     where user_id = $1 and status = 'reserved' and released_at is null
       and reservation_expires_at > now() and ($2::text is null or id <> $2)`,
    [userId, excludeReservationId ?? null],
  );
  return Number(result.rows[0]?.pending ?? 0);
}

async function findPostgresReservationById(client: PgClient, userId: string, reservationId: string) {
  const result = await client.query<MeetingProcessingReservationRow>(
    "select * from meeting_processing_reservations where id = $1 and user_id = $2 for update",
    [reservationId, userId],
  );
  const reservation = result.rows[0];
  if (!reservation) throw new AuthError("会议额度预占记录不存在。", 404, "meeting_quota_reservation_missing");
  return reservation;
}

function assertPostgresReservationActive(reservation: MeetingProcessingReservationRow, now: Date) {
  if (reservation.status === "finalized") {
    throw new AuthError("会议处理已经完成。", 409, "meeting_processing_finalized");
  }
  if (reservation.released_at || new Date(reservation.reservation_expires_at).getTime() <= now.getTime()) {
    throw new AuthError("会议额度预占已释放或过期，请重新预占。", 409, "meeting_quota_reservation_expired");
  }
}

async function findPostgresProviderStep(client: PgClient, userId: string, stepId: string) {
  const result = await client.query<MeetingProviderStepRow>(
    "select * from meeting_processing_provider_steps where id = $1 and user_id = $2 for update",
    [stepId, userId],
  );
  const step = result.rows[0];
  if (!step) throw new AuthError("Provider 步骤不存在。", 404, "provider_step_missing");
  return step;
}

function assertPostgresProviderClaim(step: MeetingProviderStepRow, claimToken: string, now: Date) {
  if (step.status !== "claimed") {
    throw new AuthError("Provider 步骤未处于可启动状态。", 409, "provider_step_not_claimed");
  }
  if (hashPostgresClaimToken(claimToken) !== step.claim_token_hash) {
    throw new AuthError("Provider 步骤认领令牌无效。", 409, "provider_step_claim_mismatch");
  }
  if (new Date(step.lease_expires_at).getTime() <= now.getTime()) {
    throw new AuthError("Provider 步骤认领已过期，可重新认领。", 409, "provider_step_claim_expired");
  }
}

function hashPostgresClaimToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function mapPostgresProviderStep(row: MeetingProviderStepRow): MeetingProviderStep {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    stageKey: row.stage_key,
    stageType: row.stage_type,
    sequence: row.sequence == null ? undefined : Number(row.sequence),
    status: row.status,
    leaseExpiresAt: toIsoString(row.lease_expires_at),
    officialMinutesSettled: Number(row.official_minutes_settled),
    freeTrialMinutesSettled: Math.max(0, Number(row.free_trial_minutes_settled ?? 0)),
    settlementPeriodIdentity: row.settlement_period_identity || undefined,
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    releasedAt: row.released_at ? toIsoString(row.released_at) : undefined,
  };
}

function postgresSettlementPeriodIdentity(user: UserRow) {
  return [
    `source=${user.official_minutes_period_source || ""}`,
    `start=${user.official_minutes_period_start_at ? toIsoString(user.official_minutes_period_start_at) : ""}`,
    `billing=${user.official_minutes_billing_order_id || ""}`,
  ].join(";");
}

function mapPostgresProcessingReservation(row: MeetingProcessingReservationRow): MeetingProcessingReservation {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    operationKey: row.operation_key,
    processingRoute: row.processing_route,
    processedMinutes: Number(row.processed_minutes),
    officialMinutesReserved: Number(row.official_minutes_reserved),
    officialMinutesSettled: Number(row.official_minutes_settled),
    realtimeDurationMs: Number(row.realtime_duration_ms),
    realtimeHighestSequence: Number(row.realtime_highest_sequence),
    reservationExpiresAt: toIsoString(row.reservation_expires_at),
    releasedAt: row.released_at ? toIsoString(row.released_at) : undefined,
    status: row.status,
  };
}

async function postgresGetAdminMetrics(): Promise<AdminMetrics> {
  const result = await postgresQuery<{
    total_users: number;
    active_users: number;
    total_provider_credentials: number;
    official_minutes_used: number;
    official_minutes_total: number;
  }>(
    `select
       (select count(*)::int from users) as total_users,
       (select count(*)::int from users where deleted_at is null) as active_users,
       (select count(*)::int from provider_credentials) as total_provider_credentials,
       coalesce((select sum(official_minutes_used)::int from users where deleted_at is null), 0) as official_minutes_used,
       coalesce((select sum(official_minutes_total)::int from users where deleted_at is null), 0) as official_minutes_total`,
  );
  const row = result.rows[0];
  return {
    totalUsers: row.total_users,
    activeUsers: row.active_users,
    totalProviderCredentials: row.total_provider_credentials,
    officialMinutesUsed: row.official_minutes_used,
    officialMinutesTotal: row.official_minutes_total,
  };
}

async function postgresGetAdminCommercialMetrics(): Promise<AdminCommercialMetrics> {
  const activeUsers = await postgresQuery<UserRow>("select * from users where deleted_at is null");
  const providerRows = await postgresQuery<{ user_id: string }>("select distinct user_id from provider_credentials");
  const activatedRows = await postgresQuery<{ user_id: string }>("select distinct user_id from usage_events where type = 'meeting_finalize'");
  const providerUsers = new Set(providerRows.rows.map((row) => row.user_id));
  const activatedUsers = new Set(activatedRows.rows.map((row) => row.user_id));
  const activeUserIds = new Set(activeUsers.rows.map((user) => user.id));
  const activeProviderUsers = [...providerUsers].filter((userId) => activeUserIds.has(userId));
  const activeActivatedUsers = [...activatedUsers].filter((userId) => activeUserIds.has(userId));
  const payingUsers = activeUsers.rows.filter((user) => user.plan !== "free");

  return {
    activeUsers: activeUsers.rows.length,
    configuredProviderUsers: activeProviderUsers.length,
    activatedUsers: activeActivatedUsers.length,
    payingUsers: payingUsers.length,
    byokOnlyUsers: activeUsers.rows.filter((user) => providerUsers.has(user.id) && user.plan === "free").length,
    officialOnlyUsers: activeUsers.rows.filter((user) => !providerUsers.has(user.id)).length,
    hybridUsers: activeUsers.rows.filter((user) => providerUsers.has(user.id) && user.plan !== "free").length,
    freeUsers: activeUsers.rows.filter((user) => user.plan === "free").length,
    plusUsers: activeUsers.rows.filter((user) => user.plan === "plus").length,
    proUsers: activeUsers.rows.filter((user) => user.plan === "pro").length,
    officialMinutesRemaining: activeUsers.rows.reduce((sum, user) => sum + Math.max(0, user.official_minutes_total - user.official_minutes_used), 0),
    conversionRates: {
      providerSetup: percent(activeProviderUsers.length, activeUsers.rows.length),
      activation: percent(activeActivatedUsers.length, activeUsers.rows.length),
      paid: percent(payingUsers.length, activeUsers.rows.length),
    },
  };
}

async function postgresGetAdminGrowthMetrics(): Promise<AdminGrowthMetrics> {
  const [activeUsers, registrationsResult, providerRows, activatedRows] = await Promise.all([
    postgresQuery<UserRow>("select * from users where deleted_at is null"),
    postgresQuery<GrowthEventRow>(
      `select growth_events.*
       from growth_events
       inner join users on users.id = growth_events.user_id
       where users.deleted_at is null
         and growth_events.type = 'register'
       order by growth_events.created_at asc`,
    ),
    postgresQuery<{ user_id: string }>(
      `select distinct provider_credentials.user_id
       from provider_credentials
       inner join users on users.id = provider_credentials.user_id
       where users.deleted_at is null`,
    ),
    postgresQuery<{ user_id: string }>(
      `select distinct usage_events.user_id
       from usage_events
       inner join users on users.id = usage_events.user_id
       where users.deleted_at is null
         and usage_events.type = 'meeting_finalize'`,
    ),
  ]);
  const registrations = registrationsResult.rows;
  const shareRegistrations = registrations.filter((event) => event.source === "share" && event.share_id);
  const shareUserIds = new Set(shareRegistrations.map((event) => event.user_id));
  const providerUsers = new Set(providerRows.rows.map((row) => row.user_id));
  const activatedUsers = new Set(activatedRows.rows.map((row) => row.user_id));
  const payingUsers = new Set(activeUsers.rows.filter((user) => user.plan !== "free").map((user) => user.id));
  const shareAttributedProviderUsers = [...shareUserIds].filter((userId) => providerUsers.has(userId)).length;
  const shareAttributedActivatedUsers = [...shareUserIds].filter((userId) => activatedUsers.has(userId)).length;
  const shareAttributedPayingUsers = [...shareUserIds].filter((userId) => payingUsers.has(userId)).length;
  const shareCounts = new Map<string, number>();

  for (const event of shareRegistrations) {
    if (!event.share_id) continue;
    shareCounts.set(event.share_id, (shareCounts.get(event.share_id) ?? 0) + 1);
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

async function postgresGetAdminFunnel() {
  const activeUsers = await postgresQuery<UserRow>("select * from users where deleted_at is null");
  const providerUsers = await postgresQuery<{ user_id: string }>("select distinct user_id from provider_credentials");
  const usedQuotaUsers = await postgresQuery<{ user_id: string }>("select distinct user_id from usage_events where type = 'meeting_finalize'");
  const activeUserIds = new Set(activeUsers.rows.map((user) => user.id));

  return [
    { label: "访问登录页", value: Math.max(activeUsers.rows.length * 3, activeUsers.rows.length) },
    { label: "完成注册", value: activeUsers.rows.length },
    { label: "配置模型", value: providerUsers.rows.filter((row) => activeUserIds.has(row.user_id)).length },
    { label: "完成首场会议", value: usedQuotaUsers.rows.filter((row) => activeUserIds.has(row.user_id)).length },
    { label: "开通 Plus / Pro", value: activeUsers.rows.filter((user) => user.plan !== "free").length },
  ];
}

async function postgresListAdminUsers(): Promise<AdminUserSummary[]> {
  const result = await postgresQuery<
    UserRow & {
      last_seen_at?: Date | string | null;
      provider_credential_count: number;
      meeting_finalize_count: number;
    }
  >(
    `select
       users.*,
       (select max(last_seen_at) from sessions where sessions.user_id = users.id) as last_seen_at,
       (select count(*)::int from provider_credentials where provider_credentials.user_id = users.id) as provider_credential_count,
       (select count(*)::int from usage_events where usage_events.user_id = users.id and usage_events.type = 'meeting_finalize') as meeting_finalize_count
     from users
     order by created_at desc`,
  );

  return result.rows.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    status: user.deleted_at ? "deleted" : "active",
    createdAt: toIsoString(user.created_at),
    emailVerifiedAt: user.email_verified_at ? toIsoString(user.email_verified_at) : undefined,
    lastSeenAt: user.last_seen_at ? toIsoString(user.last_seen_at) : undefined,
    providerCredentialCount: user.provider_credential_count,
    meetingFinalizeCount: user.meeting_finalize_count,
    officialMinutesTotal: user.official_minutes_total,
    officialMinutesUsed: user.official_minutes_used,
    officialMinutesRemaining: Math.max(0, user.official_minutes_total - user.official_minutes_used),
  }));
}

async function postgresListAdminEntitlementGrants(limit = 20): Promise<EntitlementGrantSummary[]> {
  const result = await postgresQuery<
    EntitlementGrantRow & {
      user_email?: string | null;
      user_name?: string | null;
      granted_by_email?: string | null;
      granted_by_name?: string | null;
      status_changed_by_email?: string | null;
      status_changed_by_name?: string | null;
    }
  >(
    `select
       entitlement_grants.*,
       target.email as user_email,
       target.name as user_name,
       admin.email as granted_by_email,
       admin.name as granted_by_name,
       status_admin.email as status_changed_by_email,
       status_admin.name as status_changed_by_name
     from entitlement_grants
     left join users target on target.id = entitlement_grants.user_id
     left join users admin on admin.id = entitlement_grants.granted_by_user_id
     left join users status_admin on status_admin.id = entitlement_grants.status_changed_by_user_id
     order by entitlement_grants.created_at desc
     limit $1`,
    [Math.max(1, Math.min(100, limit))],
  );

  return result.rows.map((grant) => ({
    id: grant.id,
    userId: grant.user_id,
    billingOrderId: grant.billing_order_id || undefined,
    userEmail: grant.user_email || "unknown",
    userName: grant.user_name || "Unknown User",
    grantedByUserId: grant.granted_by_user_id || undefined,
    grantedByEmail: grant.granted_by_email || undefined,
    grantedByName: grant.granted_by_name || undefined,
    source: grant.source,
    status: grant.status,
    statusChangedByUserId: grant.status_changed_by_user_id || undefined,
    statusChangedByEmail: grant.status_changed_by_email || undefined,
    statusChangedByName: grant.status_changed_by_name || undefined,
    statusReason: grant.status_reason || undefined,
    statusUpdatedAt: grant.status_updated_at ? toIsoString(grant.status_updated_at) : undefined,
    previousPlan: grant.previous_plan,
    plan: grant.plan,
    officialMinutesTotal: grant.official_minutes_total,
    reason: grant.reason,
    createdAt: toIsoString(grant.created_at),
  }));
}

async function postgresListAdminBillingOrders(limit = 20): Promise<BillingOrderSummary[]> {
  const result = await postgresQuery<BillingOrderWithUserRow>(
    `select
       billing_orders.*,
       target.email as user_email,
       target.name as user_name,
       creator.email as created_by_email,
       creator.name as created_by_name
     from billing_orders
     left join users target on target.id = billing_orders.user_id
     left join users creator on creator.id = billing_orders.created_by_user_id
     order by billing_orders.created_at desc
     limit $1`,
    [Math.max(1, Math.min(100, limit))],
  );

  return result.rows.map(summarizeBillingOrderRow);
}

type BillingOrderWithUserRow = BillingOrderRow & {
  user_email?: string | null;
  user_name?: string | null;
  created_by_email?: string | null;
  created_by_name?: string | null;
};

async function postgresSummarizeBillingOrder(order: BillingOrderRow): Promise<BillingOrderSummary> {
  const result = await postgresQuery<BillingOrderWithUserRow>(
    `select
       billing_orders.*,
       target.email as user_email,
       target.name as user_name,
       creator.email as created_by_email,
       creator.name as created_by_name
     from billing_orders
     left join users target on target.id = billing_orders.user_id
     left join users creator on creator.id = billing_orders.created_by_user_id
     where billing_orders.id = $1`,
    [order.id],
  );

  return summarizeBillingOrderRow(result.rows[0] || order);
}

function summarizeBillingOrderRow(order: BillingOrderWithUserRow): BillingOrderSummary {
  return {
    id: order.id,
    userId: order.user_id,
    userEmail: order.user_email || "unknown",
    userName: order.user_name || "Unknown User",
    createdByUserId: order.created_by_user_id || undefined,
    createdByEmail: order.created_by_email || undefined,
    createdByName: order.created_by_name || undefined,
    provider: order.provider,
    status: order.status,
    plan: order.plan,
    amountCents: order.amount_cents ?? undefined,
    priceMilliunits:
      order.price_milliunits === null || order.price_milliunits === undefined
        ? undefined
        : String(order.price_milliunits),
    currency: order.currency,
    environment: order.environment || undefined,
    productId: order.product_id || undefined,
    storefront: order.storefront || undefined,
    offerType: order.offer_type ?? undefined,
    offerIdentifier: order.offer_identifier || undefined,
    signedDate: order.signed_date ? toIsoString(order.signed_date) : undefined,
    statusSignedDate: order.status_signed_date ? toIsoString(order.status_signed_date) : undefined,
    externalTransactionId: order.external_transaction_id || undefined,
    originalTransactionId: order.original_transaction_id || undefined,
    idempotencyKey: order.idempotency_key,
    periodStartAt: order.period_start_at ? toIsoString(order.period_start_at) : undefined,
    periodEndAt: order.period_end_at ? toIsoString(order.period_end_at) : undefined,
    entitlementGrantId: order.entitlement_grant_id || undefined,
    note: order.note,
    statusReason: order.status_reason || undefined,
    statusUpdatedAt: order.status_updated_at ? toIsoString(order.status_updated_at) : undefined,
    createdAt: toIsoString(order.created_at),
  };
}

async function postgresSummarizeEntitlementGrant(grant: EntitlementGrantRow): Promise<EntitlementGrantSummary> {
  const result = await postgresQuery<
    EntitlementGrantRow & {
      user_email?: string | null;
      user_name?: string | null;
      granted_by_email?: string | null;
      granted_by_name?: string | null;
      status_changed_by_email?: string | null;
      status_changed_by_name?: string | null;
    }
  >(
    `select
       entitlement_grants.*,
       target.email as user_email,
       target.name as user_name,
       admin.email as granted_by_email,
       admin.name as granted_by_name,
       status_admin.email as status_changed_by_email,
       status_admin.name as status_changed_by_name
     from entitlement_grants
     left join users target on target.id = entitlement_grants.user_id
     left join users admin on admin.id = entitlement_grants.granted_by_user_id
     left join users status_admin on status_admin.id = entitlement_grants.status_changed_by_user_id
     where entitlement_grants.id = $1
     limit 1`,
    [grant.id],
  );
  const row = result.rows[0];
  if (!row) throw new AuthError("权益记录不存在。", 404);
  return {
    id: row.id,
    userId: row.user_id,
    billingOrderId: row.billing_order_id || undefined,
    userEmail: row.user_email || "unknown",
    userName: row.user_name || "Unknown User",
    grantedByUserId: row.granted_by_user_id || undefined,
    grantedByEmail: row.granted_by_email || undefined,
    grantedByName: row.granted_by_name || undefined,
    source: row.source,
    status: row.status,
    statusChangedByUserId: row.status_changed_by_user_id || undefined,
    statusChangedByEmail: row.status_changed_by_email || undefined,
    statusChangedByName: row.status_changed_by_name || undefined,
    statusReason: row.status_reason || undefined,
    statusUpdatedAt: row.status_updated_at ? toIsoString(row.status_updated_at) : undefined,
    previousPlan: row.previous_plan,
    plan: row.plan,
    officialMinutesTotal: row.official_minutes_total,
    reason: row.reason,
    createdAt: toIsoString(row.created_at),
  };
}

async function postgresFindActiveUserByEmail(email: string) {
  const result = await postgresQuery<UserRow>("select * from users where lower(email) = lower($1) and deleted_at is null limit 1", [email]);
  return result.rows[0] || null;
}

async function postgresFindActiveUserById(userId: string) {
  await postgresRefreshUserEntitlements(userId);
  const result = await postgresQuery<UserRow>("select * from users where id = $1 and deleted_at is null limit 1", [userId]);
  return result.rows[0] || null;
}

async function postgresRefreshUserEntitlements(userId: string) {
  await postgresTransaction(async (client) => {
    const userResult = await client.query<UserRow>("select * from users where id = $1 and deleted_at is null for update", [userId]);
    const user = userResult.rows[0];
    if (!user) return;
    const now = new Date();
    const nowIso = now.toISOString();

    await client.query(
      `update entitlement_grants
       set status = 'revoked',
           status_reason = '${APPLE_EXPIRY_RECONCILIATION_REASON}',
           status_updated_at = $2
       where user_id = $1
         and source = 'apple_iap'
         and status = 'active'
         and billing_order_id in (
           select billing_orders.id
           from billing_orders
           left join apple_subscriptions
             on apple_subscriptions.original_transaction_id = billing_orders.original_transaction_id
           where billing_orders.user_id = $1
             and billing_orders.provider = 'apple_iap'
             and billing_orders.period_end_at is not null
             and billing_orders.period_end_at <= $2::timestamptz
             and not (
               apple_subscriptions.status = 'grace'
               and apple_subscriptions.grace_expires_at is not null
               and apple_subscriptions.grace_expires_at > $2::timestamptz
             )
         )`,
      [userId, nowIso],
    );
    await client.query(
      `update apple_subscriptions
       set status = 'expired', updated_at = $2
       where user_id = $1
         and status in ('active', 'billing_retry', 'grace')
         and coalesce(grace_expires_at, expires_at) is not null
         and coalesce(grace_expires_at, expires_at) <= $2::timestamptz`,
      [userId, nowIso],
    );

    const activeGrant = await client.query<{
      plan: BillingPlanId;
      official_minutes_total: number;
      billing_order_id?: string | null;
      starts_at?: Date | string | null;
      expires_at?: Date | string | null;
      source: EntitlementGrantSource;
    }>(
      `select entitlement_grants.plan,
              entitlement_grants.official_minutes_total,
              entitlement_grants.billing_order_id,
              entitlement_grants.starts_at,
              entitlement_grants.expires_at,
              entitlement_grants.source
       from entitlement_grants
       left join billing_orders on billing_orders.id = entitlement_grants.billing_order_id
       left join apple_subscriptions on apple_subscriptions.original_transaction_id = billing_orders.original_transaction_id
       where entitlement_grants.user_id = $1
         and entitlement_grants.status = 'active'
         and (
           entitlement_grants.source <> 'apple_iap'
           or billing_orders.period_end_at is null
           or billing_orders.period_end_at > $2::timestamptz
           or (
             apple_subscriptions.status = 'grace'
             and apple_subscriptions.grace_expires_at is not null
             and apple_subscriptions.grace_expires_at > $2::timestamptz
           )
         )
       order by entitlement_grants.created_at desc
       limit 1`,
      [userId, nowIso],
    );
    const grant = activeGrant.rows[0];
    if (grant) {
      const nextSource = grant.source === "apple_iap" ? "apple_iap" : grant.source;
      if (user.plan !== grant.plan || user.official_minutes_billing_order_id !== (grant.billing_order_id || null)) {
        await client.query(
          `update users
           set plan = $1,
               official_minutes_total = $2,
               official_minutes_used = least(official_minutes_used, $2),
               official_minutes_period_start_at = coalesce($3::timestamptz, official_minutes_period_start_at),
               official_minutes_period_end_at = $4::timestamptz,
               official_minutes_period_source = $5,
               official_minutes_billing_order_id = $6
           where id = $7`,
          [grant.plan, grant.official_minutes_total, grant.starts_at || null, grant.expires_at || null, nextSource, grant.billing_order_id || null, userId],
        );
      }
      return;
    }

    const freeTrialNeedsRestore =
      user.plan !== "free" ||
      user.official_minutes_total !== user.free_trial_minutes_total ||
      user.official_minutes_used !== user.free_trial_minutes_used ||
      user.official_minutes_period_source !== FREE_TRIAL_SOURCE ||
      user.official_minutes_period_end_at != null ||
      user.official_minutes_billing_order_id != null;
    if (freeTrialNeedsRestore) {
      await client.query(
        `update users
         set plan = 'free',
             official_minutes_total = free_trial_minutes_total,
             official_minutes_used = free_trial_minutes_used,
             official_minutes_period_start_at = free_trial_granted_at,
             official_minutes_period_end_at = null,
             official_minutes_period_source = '${FREE_TRIAL_SOURCE}',
             official_minutes_billing_order_id = null
         where id = $1`,
        [userId],
      );
    }
  });
}

async function enqueuePostgresSecretAuditEvents(
  client: PgClient,
  events: SecretAuditEvent[],
) {
  for (const event of events) {
    assertSecretAuditOutboxPayloadSafe(event);
    await client.query(
      `insert into secret_audit_outbox
        (event_id, payload, created_at, available_at)
       values ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)
       on conflict (event_id) do nothing`,
      [event.id, JSON.stringify(event), event.createdAt],
    );
  }
}

async function postgresFlushSecretAuditOutboxOnce(
  workerId: string,
): Promise<SecretAuditOutboxFlushResult> {
  const client = await getPostgresPool().connect();
  const claimToken = crypto.randomBytes(18).toString("base64url");
  let claim: SecretAuditOutboxRow | undefined;
  try {
    await client.query("begin");
    const claimed = await client.query<SecretAuditOutboxRow>(
      `with candidate as (
         select event_id
         from secret_audit_outbox
         where delivered_at is null
           and available_at <= now()
           and (lease_expires_at is null or lease_expires_at <= now())
         order by created_at asc, event_id asc
         for update skip locked
         limit 1
       )
       update secret_audit_outbox as outbox
       set attempt_count = outbox.attempt_count + 1,
           locked_by = $1,
           claim_token = $2,
           lease_expires_at = now() + ($3::bigint * interval '1 millisecond')
       from candidate
       where outbox.event_id = candidate.event_id
       returning outbox.*`,
      [
        sanitizeSecretAuditOutboxWorkerId(workerId),
        claimToken,
        getSecretAuditOutboxLeaseMs(),
      ],
    );
    claim = claimed.rows[0];
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!claim) return { claimed: false, delivered: false };

  let payload: SecretAuditEvent;
  try {
    payload = parseSecretAuditOutboxPayload(claim.payload);
  } catch (error) {
    const errorCode = getSecretAuditErrorCode(error);
    await releaseFailedPostgresSecretAuditClaim(
      claim.event_id,
      claimToken,
      claim.attempt_count,
      errorCode,
    );
    return {
      claimed: true,
      delivered: false,
      errorCode,
      eventId: claim.event_id,
    };
  }

  const delivery = deliverSecretAuditEvent(payload);
  if (!delivery.ok) {
    await releaseFailedPostgresSecretAuditClaim(
      claim.event_id,
      claimToken,
      claim.attempt_count,
      delivery.errorCode,
    );
    return {
      claimed: true,
      delivered: false,
      errorCode: delivery.errorCode,
      eventId: claim.event_id,
    };
  }

  const acknowledged = await postgresQuery(
    `update secret_audit_outbox
     set delivered_at = now(),
         locked_by = null,
         claim_token = null,
         lease_expires_at = null,
         last_error_code = null
     where event_id = $1
       and claim_token = $2
       and delivered_at is null`,
    [claim.event_id, claimToken],
  );
  if (acknowledged.rowCount !== 1) {
    return {
      claimed: true,
      delivered: false,
      errorCode: "secret_audit_claim_lost_after_delivery",
      eventId: claim.event_id,
    };
  }
  await cleanupDeliveredPostgresSecretAuditOutbox().catch((error) => {
    console.error("Secret audit delivered-outbox cleanup failed.", {
      code: getSecretAuditErrorCode(error),
    });
  });
  return {
    claimed: true,
    delivered: true,
    eventId: claim.event_id,
  };
}

async function cleanupDeliveredPostgresSecretAuditOutbox() {
  const result = await postgresQuery(
    `with expired as (
       select event_id
       from secret_audit_outbox
       where delivered_at < now() - ($1::int * interval '1 day')
       order by delivered_at asc, event_id asc
       for update skip locked
       limit $2
     )
     delete from secret_audit_outbox as outbox
     using expired
     where outbox.event_id = expired.event_id`,
    [
      SECRET_AUDIT_DELIVERED_RETENTION_DAYS,
      SECRET_AUDIT_DELIVERED_CLEANUP_BATCH,
    ],
  );
  return result.rowCount || 0;
}

async function releaseFailedPostgresSecretAuditClaim(
  eventId: string,
  claimToken: string,
  attemptCount: number,
  errorCode: string,
) {
  await postgresQuery(
    `update secret_audit_outbox
     set available_at = now() + ($3::bigint * interval '1 millisecond'),
         locked_by = null,
         claim_token = null,
         lease_expires_at = null,
         last_error_code = $4
     where event_id = $1
       and claim_token = $2
       and delivered_at is null`,
    [
      eventId,
      claimToken,
      getSecretAuditOutboxRetryDelayMs(attemptCount),
      errorCode.slice(0, 80),
    ],
  );
}

async function postgresGetSecretAuditOutboxInfo(): Promise<SecretAuditOutboxInfo> {
  const result = await postgresQuery<{
    claimable_count: number | string;
    expired_lease_count: number | string;
    oldest_pending_at: Date | string | null;
    overdue_pending_count: number | string;
    pending_count: number | string;
  }>(
    `select
       count(*) filter (
         where delivered_at is null
           and available_at <= now()
           and (lease_expires_at is null or lease_expires_at <= now())
       )::int as claimable_count,
       count(*) filter (
         where delivered_at is null
           and lease_expires_at is not null
           and lease_expires_at <= now()
       )::int as expired_lease_count,
       min(created_at) filter (where delivered_at is null) as oldest_pending_at,
       count(*) filter (
         where delivered_at is null
           and created_at < now() - ($1::bigint * interval '1 millisecond')
       )::int as overdue_pending_count,
       count(*) filter (where delivered_at is null)::int as pending_count
     from secret_audit_outbox`,
    [getSecretAuditOutboxMaxPendingAgeMs()],
  );
  const row = result.rows[0];
  const oldestPendingAt = row?.oldest_pending_at
    ? toIsoString(row.oldest_pending_at)
    : null;
  return {
    claimableCount: Number(row?.claimable_count || 0),
    expiredLeaseCount: Number(row?.expired_lease_count || 0),
    oldestPendingAgeMs: oldestPendingAt
      ? Math.max(0, Date.now() - Date.parse(oldestPendingAt))
      : 0,
    oldestPendingAt,
    overduePendingCount: Number(row?.overdue_pending_count || 0),
    pendingCount: Number(row?.pending_count || 0),
    provider: "postgres",
  };
}

async function flushSecretAuditOutboxBestEffort(maxEvents: number) {
  const limit = Math.max(0, Math.min(32, Math.round(maxEvents)));
  const workerId = createSecretAuditOutboxWorkerId();
  for (let index = 0; index < limit; index += 1) {
    try {
      const result = await flushSecretAuditOutboxOnce(workerId);
      if (!result.claimed || !result.delivered) return;
    } catch (error) {
      console.error("Secret audit outbox immediate flush failed.", {
        code: getSecretAuditErrorCode(error),
      });
      return;
    }
  }
}

function parseSecretAuditOutboxPayload(
  value: SecretAuditEvent | string,
): SecretAuditEvent {
  const parsed =
    typeof value === "string"
      ? (JSON.parse(value) as SecretAuditEvent)
      : value;
  assertSecretAuditOutboxPayloadSafe(parsed);
  return parsed;
}

function assertSecretAuditTransactionTestHook() {
  if (
    process.env.NODE_ENV === "test" &&
    process.env.OWNMINUTES_SECRET_AUDIT_TEST_ROLLBACK_AFTER_ENQUEUE === "1"
  ) {
    throw new Error("secret_audit_test_rollback_after_enqueue");
  }
}

function createSecretAuditOutboxWorkerId() {
  return sanitizeSecretAuditOutboxWorkerId(
    `secret-audit:${getRuntimeInstanceId()}:${crypto.randomBytes(6).toString("hex")}`,
  );
}

function sanitizeSecretAuditOutboxWorkerId(workerId: string) {
  const normalized = workerId
    .replace(/[^A-Za-z0-9_.:-]/g, "-")
    .slice(0, 120);
  return normalized || `secret-audit:${process.pid}`;
}

function secretAuditOutboxDelay(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function postgresQuery<T = PgRow>(text: string, values: unknown[] = []) {
  return getPostgresPool().query<T>(text, values);
}

async function postgresScalar<T>(text: string, values: unknown[] = []): Promise<T> {
  const result = await postgresQuery<{ value: T }>(text, values);
  return result.rows[0]?.value;
}

async function postgresTransaction<T>(callback: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function getPostgresPool(): PgPool {
  try {
    return getPostgresRuntimePool("PostgreSQL auth repository");
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : "PostgreSQL auth repository is unavailable.", 500);
  }
}

function getDatabaseUrl() {
  return getPostgresDatabaseUrl();
}

async function postgresEnsureAppleSubscriptionForOrder(
  client: PgClient,
  order: BillingOrderRow,
  input: {
    environment?: string;
    expiresDate?: string;
    notificationUUID?: string;
    productId?: string;
    signedDate?: string;
    status?: AppleSubscriptionRow["status"];
  },
) {
  if (!order.original_transaction_id || !order.external_transaction_id) return;
  const productId = input.productId || order.product_id;
  const environment = input.environment || order.environment;
  if (!productId || !environment) {
    throw new AuthError("Apple 历史订单缺少商品或环境，无法修复订阅状态。", 409, "apple_iap_subscription_reconciliation_required");
  }
  const expiresDate = input.expiresDate || (order.period_end_at ? toIsoString(order.period_end_at) : undefined);
  const status =
    input.status ||
    (expiresDate && Date.parse(expiresDate) <= Date.now() ? "expired" : order.status === "refunded" ? "revoked" : "active");
  await client.query(
    `update billing_orders
     set product_id = coalesce(product_id, $1),
         environment = coalesce(environment, $2),
         period_end_at = coalesce(period_end_at, $3::timestamptz),
         signed_date = coalesce(signed_date, $4::timestamptz)
     where id = $5`,
    [productId, environment, expiresDate || null, input.signedDate || null, order.id],
  );
  if (order.entitlement_grant_id) {
    await client.query(
      `update entitlement_grants
       set starts_at = coalesce(starts_at, $1::timestamptz),
           expires_at = coalesce(expires_at, $2::timestamptz)
       where id = $3`,
      [order.period_start_at || null, expiresDate || null, order.entitlement_grant_id],
    );
  }
  await client.query(
    `insert into apple_subscriptions
      (original_transaction_id, user_id, current_transaction_id, product_id, environment, status, expires_at, last_signed_date, last_notification_uuid, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     on conflict (original_transaction_id) do nothing`,
    [
      order.original_transaction_id,
      order.user_id,
      order.external_transaction_id,
      productId,
      environment,
      status,
      expiresDate || null,
      input.signedDate || (order.signed_date ? toIsoString(order.signed_date) : null),
      input.notificationUUID || null,
      toIsoString(order.created_at),
    ],
  );
}

async function postgresSupersedeAppleSubscriptionFamily(
  client: PgClient,
  userId: string,
  originalTransactionId: string,
  nextTransactionId: string,
  now: string,
): Promise<BillingPlanId> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple-iap-family:${originalTransactionId}`]);
  const fallbackPlanResult = await client.query<{ plan: BillingPlanId }>(
    `select entitlement_grants.plan
     from entitlement_grants
     left join billing_orders on billing_orders.id = entitlement_grants.billing_order_id
     where entitlement_grants.user_id = $1
       and entitlement_grants.status = 'active'
       and not (billing_orders.provider = 'apple_iap' and billing_orders.original_transaction_id = $2)
     order by entitlement_grants.created_at desc
     limit 1`,
    [userId, originalTransactionId],
  );
  const reason = `Superseded by Apple renewal ${nextTransactionId}`;
  await client.query(
    `update entitlement_grants
     set status = 'revoked', status_reason = $1, status_updated_at = $2
     where status = 'active'
       and billing_order_id in (
         select id from billing_orders
         where provider = 'apple_iap' and original_transaction_id = $3 and external_transaction_id <> $4
       )`,
    [reason, now, originalTransactionId, nextTransactionId],
  );
  return fallbackPlanResult.rows[0]?.plan || "free";
}

async function postgresResolveActivePlan(client: PgClient, userId: string): Promise<BillingPlanId> {
  const result = await client.query<{ plan: BillingPlanId }>(
    `select entitlement_grants.plan
     from entitlement_grants
     left join billing_orders on billing_orders.id = entitlement_grants.billing_order_id
     left join apple_subscriptions on apple_subscriptions.original_transaction_id = billing_orders.original_transaction_id
     where entitlement_grants.user_id = $1
       and entitlement_grants.status = 'active'
       and (
         entitlement_grants.source <> 'apple_iap'
         or billing_orders.period_end_at is null
         or billing_orders.period_end_at > now()
         or (apple_subscriptions.status = 'grace' and apple_subscriptions.grace_expires_at > now())
       )
     order by entitlement_grants.created_at desc
     limit 1`,
    [userId],
  );
  return result.rows[0]?.plan || "free";
}

function getPlanMinutes(plan: BillingPlanId) {
  if (plan === "pro") return 1800;
  if (plan === "plus") return 600;
  return 60;
}

function getAppleIapNotificationAction(notificationType?: string, subtype?: string, status?: number): AppleIapNotificationResult["action"] {
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

function getAppleBillingOrderStatus(
  action: AppleIapNotificationResult["action"],
  current: BillingOrderStatus,
): BillingOrderStatus {
  if (action === "refunded") return "refunded";
  if (action === "restored") return "paid";
  return current;
}

function isAppleLifecycleUpdateStale(input: {
  currentExpiresDate?: Date | string | null;
  currentPeriodStartDate?: Date | string | null;
  currentSignedDate?: Date | string | null;
  incomingExpiresDate?: Date | string | null;
  incomingPeriodStartDate?: Date | string | null;
  incomingSignedDate?: Date | string | null;
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

function isAppleStatusUpdateStale(incomingSignedDate?: Date | string | null, currentSignedDate?: Date | string | null) {
  const incoming = parseAppleLifecycleDate(incomingSignedDate);
  const current = parseAppleLifecycleDate(currentSignedDate);
  return incoming !== undefined && current !== undefined && incoming < current;
}

function parseAppleLifecycleDate(value?: Date | string | null) {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function makeLegacyAppleNotificationId(input: AppleIapNotificationInput) {
  const source = [input.notificationType || "UNKNOWN", input.subtype || "", input.transactionId || "", input.signedDate || input.reason].join(":");
  return `legacy_${crypto.createHash("sha256").update(source).digest("hex")}`;
}

async function postgresCompleteAppleNotificationEvent(notificationUUID: string, status: "ignored" | "processed", action: string) {
  await postgresQuery(
    `update apple_notification_events
     set processing_status = $1, result_action = $2, error_code = null, processed_at = now()
     where notification_uuid = $3`,
    [status, action, notificationUUID],
  );
}

async function postgresFailAppleNotificationEvent(notificationUUID: string, errorCode: string) {
  await postgresQuery(
    `update apple_notification_events
     set processing_status = 'failed', error_code = $1, processed_at = now()
     where notification_uuid = $2`,
    [errorCode, notificationUUID],
  );
}

function buildPostgresCostControlSummary(user: UserRow, credentials: Array<{ providerId: string; configuredFields: string[]; configuredSecrets: string[] }>): UserUsageSummary["costControl"] {
  const providerCredentialCount = credentials.length;
  const coverage = getByokCoverage(credentials);
  const mode = user.processing_mode || "official_quota";
  return {
    mode,
    selectedMode: user.processing_mode || "official_quota",
    providerCredentialCount,
    currentPlanPrice: getPlanPrice(user.plan),
    officialMinuteUnitPrice: getOfficialMinuteUnitPrice(user.plan),
    recommendation: getCostRecommendation(mode, user, coverage.complete),
  };
}

function providerCredentialDescriptorFromRow(credential: ProviderCredentialRow) {
  return {
    providerId: credential.provider_id,
    configuredFields: Object.keys(parseJsonRecord(credential.fields)),
    configuredSecrets: Object.keys(parseJsonRecord(credential.encrypted_secrets)),
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

function getCostRecommendation(mode: UserUsageSummary["costControl"]["mode"], user: Pick<UserRow, "official_minutes_total" | "official_minutes_used" | "plan">, byokReady: boolean) {
  if (mode === "byok") {
    return byokReady
      ? "当前明确使用自己的模型，新会议不扣官方分钟。"
      : "当前选择自己的模型，但配置已不完整；修复前不会自动改扣官方额度。";
  }
  if (Math.max(0, user.official_minutes_total - user.official_minutes_used) < 10) {
    return user.plan === "free"
      ? "一次性官方体验额度即将用完，建议配置 BYOK 或订阅 Plus。"
      : "本订阅周期的官方额度即将用完，可配置 BYOK 继续处理会议。";
  }
  return user.plan === "free"
    ? "当前使用一次性官方体验额度；如想长期免费使用，可以配置自己的模型 Key。"
    : "当前使用订阅内官方额度；BYOK 仍可随时使用。";
}

function percent(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function normalizeRegisterSource(value: unknown): GrowthEventRow["source"] {
  return value === "share" ? "share" : "direct";
}

function normalizeShareAttributionId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 120);
  return normalized || undefined;
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

async function grantPostgresRegistrationBonus(client: PgClient, user: UserRow, grantedAt: string) {
  const existing = await client.query<{ exists: boolean }>(
    "select exists(select 1 from usage_events where user_id = $1 and type = 'register_bonus') as exists",
    [user.id],
  );
  if (existing.rows[0]?.exists) return;

  await client.query(
    `update users
     set free_trial_granted_at = $1,
         free_trial_minutes_total = $2,
         free_trial_minutes_used = 0,
         official_minutes_total = case when plan = 'free' then $2 else official_minutes_total end,
         official_minutes_used = case when plan = 'free' then 0 else official_minutes_used end,
         official_minutes_period_start_at = case when plan = 'free' then $1 else official_minutes_period_start_at end,
         official_minutes_period_end_at = case when plan = 'free' then null else official_minutes_period_end_at end,
         official_minutes_period_source = case when plan = 'free' then $3 else official_minutes_period_source end,
         official_minutes_billing_order_id = case when plan = 'free' then null else official_minutes_billing_order_id end
     where id = $4`,
    [grantedAt, FREE_TRIAL_MINUTES, FREE_TRIAL_SOURCE, user.id],
  );
  await client.query("insert into usage_events (id, user_id, type, minutes, created_at, note) values ($1,$2,$3,$4,$5,$6)", [
    createId("usage"),
    user.id,
    "register_bonus",
    FREE_TRIAL_MINUTES,
    grantedAt,
    "Free plan official trial quota",
  ]);
}

function getLocalSecret() {
  fs.mkdirSync(POSTGRES_DATA_DIR, { recursive: true, mode: 0o700 });
  const envSecret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (envSecret && envSecret.length >= 32) return envSecret;

  if (!fs.existsSync(POSTGRES_SECRET_PATH)) {
    fs.writeFileSync(POSTGRES_SECRET_PATH, crypto.randomBytes(32).toString("base64url"), { mode: 0o600 });
  }

  return fs.readFileSync(POSTGRES_SECRET_PATH, "utf8").trim();
}

async function encryptSecret(
  secret: string,
  credential: Pick<ProviderCredentialRow, "provider_id" | "user_id"> | { providerId: string; userId: string },
  secretName: string,
) {
  const providerId = "providerId" in credential ? credential.providerId : credential.provider_id;
  const userId = "userId" in credential ? credential.userId : credential.user_id;
  return encryptProviderSecret(secret, { localSecretPath: POSTGRES_SECRET_PATH, providerId, secretName, userId });
}

async function decryptSecret(
  encrypted: string,
  credential: Pick<ProviderCredentialRow, "provider_id" | "user_id"> | { providerId: string; userId: string },
  secretName: string,
) {
  const providerId = "providerId" in credential ? credential.providerId : credential.provider_id;
  const userId = "userId" in credential ? credential.userId : credential.user_id;
  try {
    return await decryptProviderSecret(encrypted, { localSecretPath: POSTGRES_SECRET_PATH, providerId, secretName, userId });
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

function summarizeCredential(credential: ProviderCredentialRow): ProviderCredentialSummary {
  const encryptedSecrets = parseJsonRecord(credential.encrypted_secrets);
  return {
    id: credential.id,
    providerId: credential.provider_id,
    label: credential.label,
    configuredFields: Object.keys(parseJsonRecord(credential.fields)),
    configuredSecrets: Object.keys(encryptedSecrets),
    secretPreviews: parseJsonRecord(credential.secret_previews),
    updatedAt: toIsoString(credential.updated_at),
  };
}

function toSafeUser(user: UserRow): SafeUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    createdAt: toIsoString(user.created_at),
    emailVerifiedAt: user.email_verified_at ? toIsoString(user.email_verified_at) : undefined,
    officialMinutesTotal: user.official_minutes_total,
    officialMinutesUsed: user.official_minutes_used,
    processingMode: user.processing_mode || "official_quota",
  };
}

function parseJsonRecord(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, string>;
  return value as Record<string, string>;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function isPostgresUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
