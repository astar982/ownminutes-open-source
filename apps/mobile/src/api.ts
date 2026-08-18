import { File as ExpoFile, FileMode, Paths, UploadType, type UploadResult } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { assertSafeMobileApiUrl } from "./config";
import {
  createMobileApiError,
  fetchMobileApi,
  MobileApiError,
  mobileRegistrationUnavailableMessage,
  mobileSessionExpiredMessage,
  parseMobileJsonResponse,
  parseMobileJsonText,
  readMobileJsonResponse,
  readMobileTextResponse,
  runMobileApiOperationWithTimeout,
} from "./mobile-http";
import {
  assertNoAuthoritativeSessionRejection,
  MobileApiResponseError,
} from "./session-recovery";
import type {
  AccountUsageResponse,
  AccountDeletionStatusResponse,
  AccountDeletionTicketResponse,
  AppleAccountTokenResponse,
  AppleTransactionResponse,
  AccountExportResponse,
  AsrLiveTestResponse,
  AudioChunkAck,
  AuthMeResponse,
  AuthResponse,
  BackendHealthResponse,
  BillingPlanId,
  DeleteMeetingResponse,
  EmailVerificationResponse,
  FinalizeMeetingResponse,
  MeetingDetailResponse,
  MeetingHumanReviewResponse,
  MeetingMetadataUpdateResponse,
  MeetingSummary,
  MeetingSummaryUpdateResponse,
  MeetingSpeakerUpdateResponse,
  MeetingTranscriptSpeakerUpdateResponse,
  MeetingShareResponse,
  MeetingsResponse,
  ProviderCredentialsResponse,
  ProviderDiagnostic,
  ProviderHealthResponse,
  RealtimeAsrAuthTestResponse,
  PaymentDiagnosticsResponse,
  PaymentStorefrontResponse,
  PasswordChangeResponse,
  PasswordResetRequestResponse,
  PasswordResetConfirmResponse,
  ProcessingModeResponse,
  RealtimeAudioChunkAck,
  RealtimeSessionFinishAck,
  ReleaseReadinessResponse,
  ShareVisibility,
  UserProcessingMode,
} from "./types";
import { readAccountDeletionResponse } from "./account-deletion-transport";

let mobileApiLanguage = "en";

export class AdminDiagnosticsAccessError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("ADMIN_DIAGNOSTICS_ACCESS_DENIED");
    this.name = "AdminDiagnosticsAccessError";
    this.status = status;
  }
}

export function setMobileApiLanguage(language: string) {
  mobileApiLanguage = language || "en";
}

export function extractSessionCookie(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const sessionCookie = setCookie
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("ownminutes_session="));

  return sessionCookie?.split(";")[0] ?? null;
}

export { MobileApiResponseError } from "./session-recovery";

export async function registerAccount(params: {
  apiBaseUrl: string;
  name: string;
  email: string;
  password: string;
}) {
  return authRequest(`${params.apiBaseUrl.replace(/\/$/, "")}/api/auth/register`, {
    name: params.name,
    email: params.email,
    password: params.password,
  }, true);
}

export async function loginAccount(params: {
  apiBaseUrl: string;
  email: string;
  password: string;
}) {
  return authRequest(`${params.apiBaseUrl.replace(/\/$/, "")}/api/auth/login`, {
    email: params.email,
    password: params.password,
  });
}

export async function requestAccountEmailVerification(apiBaseUrl: string, email: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/email-verification/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const payload = await parseMobileJsonResponse<EmailVerificationResponse>(response, mobileApiLanguage);
  if (!response.ok || !payload.ok) {
    throw authApiError(payload.error || `验证邮件请求失败：${response.status}`, payload.code, response.status);
  }
  return payload;
}

export async function requestAccountEmailVerificationCode(apiBaseUrl: string, email: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/email-verification/code/request`, {
    method: "POST",
    headers: {
      "Accept-Language": mobileApiLanguage,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });
  const payload = await parseMobileJsonResponse<EmailVerificationResponse & { retryAfterSeconds?: number }>(
    response,
    mobileApiLanguage,
  );
  if (!response.ok || !payload.ok) {
    throw authApiError(
      payload.error || `验证码发送失败：${response.status}`,
      payload.code,
      response.status,
      readRetryAfterSeconds(response, payload.retryAfterSeconds),
    );
  }
  return payload;
}

export async function confirmAccountEmailVerification(apiBaseUrl: string, token: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/email-verification/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const payload = await parseMobileJsonResponse<EmailVerificationResponse>(response, mobileApiLanguage);
  const sessionCookie = extractSessionCookie(response);
  if (!response.ok || !payload.ok || !payload.user || !sessionCookie) {
    throw authApiError(payload.error || `邮箱验证失败：${response.status}`, payload.code, response.status);
  }
  return { payload, sessionCookie };
}

export async function confirmAccountEmailVerificationCode(apiBaseUrl: string, email: string, code: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/email-verification/code/confirm`, {
    method: "POST",
    headers: {
      "Accept-Language": mobileApiLanguage,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, code }),
  });
  const payload = await parseMobileJsonResponse<EmailVerificationResponse & { retryAfterSeconds?: number }>(
    response,
    mobileApiLanguage,
  );
  const sessionCookie = extractSessionCookie(response);
  if (!response.ok || !payload.ok || !payload.user || !sessionCookie) {
    throw authApiError(
      payload.error || `验证码验证失败：${response.status}`,
      payload.code,
      response.status,
      readRetryAfterSeconds(response, payload.retryAfterSeconds),
    );
  }
  return { payload, sessionCookie };
}

export async function requestAccountPasswordReset(apiBaseUrl: string, email: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/password-reset/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const payload = await parseMobileJsonResponse<PasswordResetRequestResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `密码重置请求失败：${response.status}`);
  }

  return payload;
}

export async function confirmAccountPasswordReset(params: {
  apiBaseUrl: string;
  token: string;
  newPassword: string;
}) {
  const response = await safeFetch(`${params.apiBaseUrl.replace(/\/$/, "")}/api/auth/password-reset/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: params.token, newPassword: params.newPassword }),
  });
  const payload = await parseMobileJsonResponse<PasswordResetConfirmResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `密码重置失败：${response.status}`);
  }

  return payload;
}

export async function changeAccountPassword(params: {
  apiBaseUrl: string;
  authCookie: string;
  currentPassword: string;
  newPassword: string;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/auth/password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({
      currentPassword: params.currentPassword,
      newPassword: params.newPassword,
    }),
  });
  const payload = await parseMobileJsonResponse<PasswordChangeResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.user) {
    throw new Error(payload.error || `修改密码失败：${response.status}`);
  }

  return payload.user;
}

export async function fetchCurrentUser(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/me`, {
    headers: { Cookie: authCookie },
  }, { forbiddenIsAuthoritative: true });
  const payload = await parseMobileJsonResponse<AuthMeResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload?.ok || !payload.user) {
    throw new MobileApiResponseError(payload?.error || `会话验证失败：${response.status}`, response.status);
  }

  return payload;
}

export async function fetchAccountUsage(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/usage`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<AccountUsageResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.usage) {
    throw new Error(payload.error || `用量读取失败：${response.status}`);
  }

  return payload.usage;
}

export async function updateProcessingMode(params: {
  apiBaseUrl: string;
  authCookie: string;
  processingMode: UserProcessingMode;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/account/processing-mode`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({ processingMode: params.processingMode }),
  });
  const payload = await parseMobileJsonResponse<ProcessingModeResponse>(response, mobileApiLanguage);
  if (!response.ok || !payload.ok || !payload.processingMode || !payload.user) {
    throw new Error(payload.error || `处理方式保存失败：${response.status}`);
  }
  return { ...payload, processingMode: payload.processingMode, user: payload.user };
}

export async function exportAccountData(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/export`, {
    headers: { Cookie: authCookie },
  });
  const { body: text, payload } = await readMobileJsonResponse<AccountExportResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `账号数据导出失败：${response.status}`);
  }

  return { payload, text };
}

export async function logoutAccount(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: authCookie },
  });
  await readMobileTextResponse(response, mobileApiLanguage);
}

export async function deleteAccount(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: authCookie },
  });
  return readAccountDeletionResponse(response, mobileApiLanguage);
}

export async function prepareAccountDeletion(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/delete`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<AccountDeletionTicketResponse>(response, mobileApiLanguage);
  if (!response.ok || !payload.ok || !payload.ticket || !payload.expiresAt) {
    throw authApiError(payload.error || `Account deletion confirmation failed: ${response.status}`, undefined, response.status);
  }
  return { expiresAt: payload.expiresAt, ticket: payload.ticket };
}

export async function checkAccountDeletionStatus(apiBaseUrl: string, ticket: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/auth/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
  const payload = await parseMobileJsonResponse<AccountDeletionStatusResponse>(response, mobileApiLanguage);
  if (
    !response.ok ||
    !payload.ok ||
    (payload.status !== "active" && payload.status !== "pending_cleanup" && payload.status !== "deleted")
  ) {
    throw authApiError(payload.error || `Account deletion status failed: ${response.status}`, undefined, response.status);
  }
  return payload.status;
}

export async function updateAccountPlan(apiBaseUrl: string, authCookie: string, plan: BillingPlanId) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/plan`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookie,
    },
    body: JSON.stringify({ plan }),
  });
  const payload = await parseMobileJsonResponse<AuthResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.user) {
    throw new Error(payload.error || `方案更新失败：${response.status}`);
  }

  return payload.user;
}

export async function fetchPaymentDiagnostics(apiBaseUrl: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/payments/diagnostics`);
  const payload = await parseMobileJsonResponse<PaymentDiagnosticsResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.diagnostics) {
    throw new Error(payload.error || `支付状态读取失败：${response.status}`);
  }

  return {
    diagnostics: payload.diagnostics,
    productIds: payload.productIds ?? [],
    products: payload.products ?? [],
  };
}

export async function fetchPaymentStorefront(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/payments/storefront`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<PaymentStorefrontResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.storefront) {
    throw new Error(payload.error || `支付商店状态读取失败：${response.status}`);
  }
  return payload.storefront;
}

export async function fetchAppleAccountToken(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/payments/apple/account-token`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<AppleAccountTokenResponse>(response, mobileApiLanguage);
  if (!response.ok || !payload.ok || !payload.appAccountToken) {
    throw new Error(payload.error || `Apple 账号绑定初始化失败：${response.status}`);
  }
  return payload.appAccountToken;
}

export async function submitAppleTransaction(params: {
  apiBaseUrl: string;
  authCookie: string;
  productId: string;
  transactionId: string;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/payments/apple/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({ productId: params.productId, transactionId: params.transactionId }),
  });
  const payload = await parseMobileJsonResponse<AppleTransactionResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.entitlementGranted || !payload.user) {
    throw Object.assign(
      new Error(payload.error || `Apple 交易校验失败：${response.status}`),
      { code: payload.code, status: response.status },
    );
  }

  return payload;
}

export async function fetchProviderCredentials(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/provider-credentials`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<ProviderCredentialsResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Provider 配置读取失败：${response.status}`);
  }

  return payload.providerCredentials ?? [];
}

export async function saveProviderCredential(params: {
  apiBaseUrl: string;
  authCookie: string;
  providerId: "volcano-asr" | "volcano-ark";
  label: string;
  fields: Record<string, string>;
  secrets: Record<string, string>;
  removeSecrets?: string[];
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/account/provider-credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({
      providerId: params.providerId,
      label: params.label,
      fields: params.fields,
      secrets: params.secrets,
      removeSecrets: params.removeSecrets ?? [],
    }),
  });
  const payload = await parseMobileJsonResponse<ProviderCredentialsResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.credential) {
    throw new Error(payload.error || `Provider 配置保存失败：${response.status}`);
  }

  return payload.credential;
}

export async function deleteProviderCredential(apiBaseUrl: string, authCookie: string, providerId: "volcano-asr" | "volcano-ark") {
  const search = new URLSearchParams({ providerId });
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/provider-credentials?${search.toString()}`, {
    method: "DELETE",
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<ProviderCredentialsResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Provider 配置删除失败：${response.status}`);
  }

  return payload.providerCredentials ?? [];
}

export async function fetchProviderHealth(apiBaseUrl: string, authCookie: string, options: { live?: boolean; providerId?: string } = {}) {
  const search = new URLSearchParams();
  if (options.live) search.set("live", "1");
  if (options.providerId) search.set("providerId", options.providerId);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/provider-health${suffix}`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<ProviderHealthResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Provider 健康检查失败：${response.status}`);
  }

  return payload.health ?? [];
}

export async function runAsrSubmitTest(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/provider-health/asr-test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookie,
    },
    body: JSON.stringify({ live: true, mode: "submit" }),
  });
  const payload = await parseMobileJsonResponse<AsrLiveTestResponse>(response, mobileApiLanguage);

  if (!payload.result) {
    throw new Error(payload.error || `ASR 提交测试失败：${response.status}`);
  }

  return payload.result;
}

export async function runRealtimeAsrAuthTest(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/account/provider-health/realtime-test`, {
    method: "POST",
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<RealtimeAsrAuthTestResponse>(response, mobileApiLanguage);
  if (!payload.result) {
    throw new Error(payload.error || `实时识别连接测试失败：${response.status}`);
  }
  return payload.result;
}

async function authRequest(url: string, body: Record<string, string>, allowVerification = false) {
  const response = await safeFetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept-Language": mobileApiLanguage,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let payload: AuthResponse;
  try {
    payload = (await readMobileJsonResponse<AuthResponse>(response, mobileApiLanguage)).payload;
  } catch (error) {
    if (response.status === 404 && allowVerification) {
      throw authApiError(mobileRegistrationUnavailableMessage(mobileApiLanguage), undefined, response.status);
    }
    throw error;
  }
  const sessionCookie = extractSessionCookie(response);
  const retryAfterSeconds = readRetryAfterSeconds(
    response,
    (payload as AuthResponse & { retryAfterSeconds?: number }).retryAfterSeconds,
  );

  if (!response.ok || !payload.ok || !payload.user) {
    throw authApiError(payload.error || `账号请求失败：${response.status}`, payload.code, response.status, retryAfterSeconds);
  }
  if (allowVerification && payload.verificationRequired) return { payload, sessionCookie: null };
  if (!sessionCookie) throw authApiError(payload.error || `账号请求失败：${response.status}`, payload.code, response.status);

  return { payload, sessionCookie };
}

function authApiError(message: string, code?: string, status?: number, retryAfterSeconds?: number) {
  return Object.assign(new Error(message), { code, retryAfterSeconds, status });
}

function readRetryAfterSeconds(response: Response, payloadValue?: number) {
  const headerValue = Number.parseInt(response.headers.get("retry-after") || "", 10);
  const value = Number.isFinite(payloadValue) && Number(payloadValue) > 0 ? Number(payloadValue) : headerValue;
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

export async function uploadMeetingAudio(params: {
  apiBaseUrl: string;
  meetingId: string;
  audioUri: string;
  mimeType: string;
  durationMs: number;
  recordedAt: number;
  consentConfirmedAt?: string;
  consentMethod?: "in_app_confirmation" | "legacy_unknown";
  consentPolicyVersion?: string;
  authCookie: string;
  uploadId: string;
  onProgress?: (progress: { totalParts: number; uploadedParts: number }) => Promise<void> | void;
}) {
  const uploadUrl = `${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/recording-upload`;
  assertSafeMobileApiUrl(uploadUrl);
  const file = new ExpoFile(params.audioUri);
  if (!file.exists || file.size <= 0) throw new Error("本地录音文件不存在或为空，无法继续上传。");
  const totalBytes = file.size;
  const totalParts = Math.ceil(totalBytes / recordingUploadPartBytes);
  const recordedAt = Math.max(1, Math.round(params.recordedAt));
  const consentMethod = params.consentMethod === "in_app_confirmation"
    ? "in_app_confirmation"
    : "legacy_unknown";
  const metadataHeaders = {
    ...(params.consentConfirmedAt
      ? { "X-OwnMinutes-Consent-Confirmed-At": params.consentConfirmedAt }
      : {}),
    "X-OwnMinutes-Consent-Method": consentMethod,
    ...(params.consentPolicyVersion
      ? { "X-OwnMinutes-Consent-Policy-Version": params.consentPolicyVersion }
      : {}),
    "X-OwnMinutes-Duration-Ms": String(Math.max(1, Math.round(params.durationMs))),
    "X-OwnMinutes-Mime-Type": params.mimeType,
    "X-OwnMinutes-Recorded-At": String(Math.round(recordedAt)),
    "X-OwnMinutes-Total-Bytes": String(totalBytes),
    "X-OwnMinutes-Total-Parts": String(totalParts),
  };
  const status = await fetchRecordingUploadStatus(uploadUrl, params.uploadId, params.authCookie);
  assertRecordingUploadMatches(status, {
    consentConfirmedAt: params.consentConfirmedAt,
    consentMethod,
    consentPolicyVersion: params.consentPolicyVersion,
    durationMs: Number(metadataHeaders["X-OwnMinutes-Duration-Ms"]),
    mimeType: params.mimeType.toLowerCase(),
    recordedAt: Number(metadataHeaders["X-OwnMinutes-Recorded-At"]),
    totalBytes,
    totalParts,
    uploadId: params.uploadId,
  });
  if (status.committed && status.ack) {
    await params.onProgress?.({ totalParts, uploadedParts: totalParts });
    return status.ack;
  }

  const receivedParts = new Set(status.receivedParts);
  await params.onProgress?.({ totalParts, uploadedParts: receivedParts.size });
  for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
    if (receivedParts.has(partIndex)) continue;
    const start = partIndex * recordingUploadPartBytes;
    const end = Math.min(totalBytes, start + recordingUploadPartBytes);
    const partBytes = readRecordingPart(file, start, end - start);
    const sha256 = await sha256Hex(partBytes);
    const partFile = new ExpoFile(Paths.cache, `${params.uploadId}-part-${partIndex}-${Crypto.randomUUID()}.bin`);
    try {
      partFile.create({ overwrite: true });
      partFile.write(partBytes);
    } catch (error) {
      safeDeleteTemporaryUploadFile(partFile);
      throw error;
    }
    const result = await uploadTemporaryNativeFileWithTimeout(
      partFile,
      `${uploadUrl}?uploadId=${encodeURIComponent(params.uploadId)}&part=${partIndex}`,
      {
        httpMethod: "PUT",
        uploadType: UploadType.BINARY_CONTENT,
        mimeType: "application/octet-stream",
        sessionType: "background",
        headers: {
          ...buildSessionHeaders(params.authCookie),
          ...metadataHeaders,
          "Content-Type": "application/octet-stream",
          "X-OwnMinutes-Part-Sha256": sha256,
        },
      },
      recordingUploadPartTimeoutMs,
    );
    const payload = parseNativeRecordingUploadResult<RecordingPartUploadResponse>(result, "录音分片上传");
    if (payload.sha256 !== sha256 || payload.partIndex !== partIndex) throw new Error("服务端录音分片确认不一致，请保留本地录音后重试。");
    for (const receivedPart of payload.receivedParts) receivedParts.add(receivedPart);
    await params.onProgress?.({ totalParts, uploadedParts: receivedParts.size });
  }

  const response = await fetchWithSession(`${uploadUrl}?uploadId=${encodeURIComponent(params.uploadId)}`, {
    method: "POST",
    headers: {
      ...buildSessionHeaders(params.authCookie),
      ...metadataHeaders,
    },
  });
  return parseRecordingUploadResponse<AudioChunkAck>(response, "完整录音提交");
}

export function createRecordingUploadId() {
  return `recording-${Crypto.randomUUID()}`;
}

export const recordingUploadPartBytes = 4 * 1024 * 1024;
export const recordingUploadPartTimeoutMs = 120_000;
export const realtimeChunkUploadTimeoutMs = 20_000;

type RecordingUploadStatusResponse = {
  ack?: AudioChunkAck;
  committed: boolean;
  error?: string;
  exists: boolean;
  metadata?: RecordingUploadMetadata;
  receivedParts: number[];
  totalBytes: number;
  totalParts: number;
};

type RecordingUploadMetadata = {
  consentConfirmedAt?: string;
  consentMethod: "in_app_confirmation" | "legacy_unknown";
  consentPolicyVersion?: string;
  durationMs: number;
  mimeType: string;
  recordedAt: number;
  totalBytes: number;
  totalParts: number;
  uploadId: string;
};

type RecordingPartUploadResponse = {
  committed: boolean;
  duplicate: boolean;
  error?: string;
  partIndex: number;
  receivedParts: number[];
  sha256: string;
};

async function fetchRecordingUploadStatus(uploadUrl: string, uploadId: string, authCookie: string) {
  const response = await fetchWithSession(`${uploadUrl}?uploadId=${encodeURIComponent(uploadId)}`, {
    headers: buildSessionHeaders(authCookie),
  });
  return parseRecordingUploadResponse<RecordingUploadStatusResponse>(response, "录音上传进度读取");
}

function assertRecordingUploadMatches(status: RecordingUploadStatusResponse, expected: RecordingUploadMetadata) {
  if (!status.exists) return;
  if (!status.metadata) {
    if (status.totalBytes === expected.totalBytes && status.totalParts === expected.totalParts) return;
  } else {
    const fields: Array<keyof RecordingUploadMetadata> = [
      "consentConfirmedAt",
      "consentMethod",
      "consentPolicyVersion",
      "durationMs",
      "mimeType",
      "recordedAt",
      "totalBytes",
      "totalParts",
      "uploadId",
    ];
    if (fields.every((field) => status.metadata?.[field] === expected[field])) return;
  }
  throw Object.assign(new Error("本地录音与服务端续传进度不一致，请保留录音并重新开始上传。"), {
    code: "RECORDING_UPLOAD_METADATA_CONFLICT",
  });
}

async function parseRecordingUploadResponse<T>(response: Response, operation: string): Promise<T> {
  const payload = await parseMobileJsonResponse<T & { code?: string; error?: string }>(response, mobileApiLanguage);
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `${operation}失败：${response.status}`), {
      code: payload.code,
      retryAfterSeconds: parseRetryAfterSeconds(response.headers),
      status: response.status,
    });
  }
  return payload;
}

function parseNativeRecordingUploadResult<T>(result: UploadResult, operation: string): T {
  if (result.status === 401) {
    throw new MobileApiResponseError(mobileSessionExpiredMessage(mobileApiLanguage), result.status);
  }
  const payload = parseMobileJsonText<T & { code?: string; error?: string }>(
    result.body,
    result.status,
    mobileApiLanguage,
    { retryAfterSeconds: parseRetryAfterSeconds(result.headers) },
  );
  if (result.status < 200 || result.status >= 300) {
    throw Object.assign(new Error(payload.error || `${operation}失败：${result.status}`), {
      code: payload.code,
      retryAfterSeconds: parseRetryAfterSeconds(result.headers),
      status: result.status,
    });
  }
  return payload;
}

function parseRetryAfterSeconds(headers: Headers | Record<string, string>) {
  const raw =
    headers instanceof Headers
      ? headers.get("retry-after")
      : Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(15 * 60, Math.ceil(seconds)) : undefined;
}

function readRecordingPart(file: ExpoFile, offset: number, length: number) {
  const handle = file.open(FileMode.ReadOnly);
  try {
    handle.offset = offset;
    const bytes = handle.readBytes(length);
    if (bytes.byteLength !== length) throw new Error("本地录音分片读取不完整，请保留录音后重试。");
    return bytes;
  } finally {
    handle.close();
  }
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildSessionHeaders(authCookie: string) {
  const sessionToken = authCookie.match(/(?:^|;\s*)ownminutes_session=([^;]+)/)?.[1];
  return {
    "Accept-Language": mobileApiLanguage,
    Cookie: authCookie,
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  };
}

export async function uploadRealtimePcmChunk(params: {
  apiBaseUrl: string;
  meetingId: string;
  sequence: number;
  bytes: ArrayBuffer;
  durationMs: number;
  sampleRate: number;
  channels: number;
  authCookie: string;
  processingMode: UserProcessingMode;
}) {
  const uploadUrl = `${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/realtime-chunks`;
  assertSafeMobileApiUrl(uploadUrl);
  const chunkFile = new ExpoFile(Paths.cache, `ownminutes-realtime-${Crypto.randomUUID()}.pcm`);
  let result: UploadResult;
  let nativeUploadStarted = false;
  try {
    chunkFile.create({ overwrite: true });
    chunkFile.write(new Uint8Array(params.bytes));
    try {
      nativeUploadStarted = true;
      result = await uploadTemporaryNativeFileWithTimeout(
        chunkFile,
        uploadUrl,
        {
          httpMethod: "POST",
          uploadType: UploadType.BINARY_CONTENT,
          mimeType: "audio/pcm",
          // Realtime PCM chunks are short-lived and owned by the active JS session.
          // Keeping them foreground prevents an iOS background task from outliving
          // the cancellation handle after the app process is terminated.
          sessionType: "foreground",
          headers: {
            ...buildSessionHeaders(params.authCookie),
            "X-OwnMinutes-Channels": String(params.channels),
            "X-OwnMinutes-Duration-Ms": String(params.durationMs),
            "X-OwnMinutes-Mime-Type": "audio/pcm;encoding=signed-integer;bits=16",
            "x-ownminutes-processing-mode": params.processingMode,
            "X-OwnMinutes-Recorded-At": String(Date.now()),
            "X-OwnMinutes-Sample-Rate": String(params.sampleRate),
            "X-OwnMinutes-Sequence": String(params.sequence),
          },
        },
        realtimeChunkUploadTimeoutMs,
      );
    } catch (error) {
      const transportError = error instanceof MobileApiError
        ? error
        : createMobileApiError("network", mobileApiLanguage);
      throw new RealtimeChunkUploadError(
        transportError.message,
        transportError.kind === "timeout" ? 408 : 503,
        { code: transportError.code, retryAfterSeconds: transportError.retryAfterSeconds },
      );
    }
  } finally {
    // Once started, the bounded helper defers deletion until the native promise settles.
    if (!nativeUploadStarted) safeDeleteTemporaryUploadFile(chunkFile);
  }

  let payload: RealtimeAudioChunkAck & { error?: string };
  try {
    payload = parseMobileJsonText<RealtimeAudioChunkAck & { error?: string }>(
      result.body,
      result.status,
      mobileApiLanguage,
      { retryAfterSeconds: parseRetryAfterSeconds(result.headers) },
    );
  } catch (error) {
    if (result.status === 401) {
      throw new MobileApiResponseError(mobileSessionExpiredMessage(mobileApiLanguage), result.status);
    }
    if (error instanceof MobileApiError) {
      throw new RealtimeChunkUploadError(error.message, error.status || (result.status >= 400 ? result.status : 502), {
        code: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    throw error;
  }

  if (result.status === 422 && payload.providerStatus === "rejected_format") {
    return payload;
  }

  if (result.status === 401) {
    throw new MobileApiResponseError(payload.error || "登录状态已失效。", result.status);
  }

  if (result.status < 200 || result.status >= 300 || !payload.ok) {
    throw new RealtimeChunkUploadError(
      payload.error || `实时分片上传失败：${result.status}`,
      result.status,
      { code: payload.code },
    );
  }

  return payload;
}

export class RealtimeChunkUploadError extends Error {
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;
  readonly status: number;

  constructor(message: string, status: number, options: { code?: string; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "RealtimeChunkUploadError";
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.status = status;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

export function isRetryableRealtimeChunkUploadError(error: unknown) {
  return error instanceof TypeError || (error instanceof RealtimeChunkUploadError && error.retryable);
}

async function uploadTemporaryNativeFileWithTimeout(
  file: ExpoFile,
  url: string,
  options: Parameters<ExpoFile["createUploadTask"]>[1],
  timeoutMs: number,
) {
  let nativeUploadStarted = false;
  try {
    return await runMobileApiOperationWithTimeout((signal) => {
      const uploadTask = file.createUploadTask(url, { ...options, signal });
      nativeUploadStarted = true;
      return Promise.resolve().then(() => uploadTask.uploadAsync()).finally(() => {
        try {
          uploadTask.release();
        } finally {
          safeDeleteTemporaryUploadFile(file);
        }
      });
    }, { language: mobileApiLanguage, timeoutMs });
  } finally {
    // A native upload may ignore AbortSignal briefly. Keep its temporary file
    // alive until that native promise settles, while the JS caller still gets
    // a hard timeout and can release the serial realtime queue.
    if (!nativeUploadStarted) safeDeleteTemporaryUploadFile(file);
  }
}

function safeDeleteTemporaryUploadFile(file: ExpoFile) {
  try {
    if (file.exists) file.delete();
  } catch {
    // Cache cleanup must never replace the upload result or the localized transport error.
  }
}

export async function finishRealtimePcmSession(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  processingMode: UserProcessingMode;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/realtime-chunks`, {
    method: "DELETE",
    headers: {
      Cookie: params.authCookie,
      "x-ownminutes-processing-mode": params.processingMode,
    },
  });
  const payload = await parseMobileJsonResponse<RealtimeSessionFinishAck>(response, mobileApiLanguage);
  if (!response.ok || !payload.ok || payload.providerStatus !== "completed") {
    throw new Error(payload.error || `结束实时识别失败：${response.status}`);
  }
  return payload;
}

export async function finishRealtimePcmSessionIfPresent(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  processingMode: UserProcessingMode;
}) {
  const url = `${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/realtime-chunks`;
  const response = await fetchWithSession(url, {
    headers: {
      Cookie: params.authCookie,
    },
  });
  const payload = await parseMobileJsonResponse<{
    error?: string;
    ok: boolean;
    realtimeSession?: {
      lastProviderStatus?: string;
    };
  }>(response, mobileApiLanguage);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(payload.error || `读取实时识别状态失败：${response.status}`);
  }
  if (payload.realtimeSession?.lastProviderStatus === "completed") return null;
  return finishRealtimePcmSession(params);
}

export async function fetchProviderDiagnostic(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/providers/diagnostics`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<ProviderDiagnostic>(response, mobileApiLanguage);

  if (response.status === 401 || response.status === 403) {
    throw new AdminDiagnosticsAccessError(response.status);
  }
  if (!response.ok) {
    throw new Error(`Provider 检查失败：${response.status}`);
  }

  return payload;
}

export async function fetchBackendHealth(apiBaseUrl: string) {
  const response = await safeFetch(`${apiBaseUrl.replace(/\/$/, "")}/api/health`);
  const payload = await parseMobileJsonResponse<BackendHealthResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(`后端健康检查失败：${response.status}`);
  }

  return payload;
}

export async function fetchReleaseReadinessSummary(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/release/readiness`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<ReleaseReadinessResponse>(response, mobileApiLanguage);

  if (response.status === 401 || response.status === 403) {
    throw new AdminDiagnosticsAccessError(response.status);
  }
  if (!response.ok || !payload.ok || !payload.report?.summary) {
    throw new Error(`上线状态检查失败：${response.status}`);
  }

  return {
    blockers: payload.report.blockers ?? [],
    summary: payload.report.summary,
  };
}

export async function fetchMeetings(apiBaseUrl: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/meetings`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<MeetingsResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `会议历史读取失败：${response.status}`);
  }

  return payload.meetings ?? [];
}

export async function fetchMeetingDetail(apiBaseUrl: string, meetingId: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/meetings/${meetingId}`, {
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<MeetingDetailResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.meeting) {
    throw new Error(payload.error || `会议详情读取失败：${response.status}`);
  }

  return payload.meeting;
}

export async function deleteMeeting(apiBaseUrl: string, meetingId: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/meetings/${meetingId}`, {
    method: "DELETE",
    headers: { Cookie: authCookie },
  });
  const payload = await parseMobileJsonResponse<DeleteMeetingResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw authApiError(payload.error || `会议删除失败：${response.status}`, undefined, response.status);
  }

  return payload;
}

export async function fetchMeetingMarkdown(apiBaseUrl: string, meetingId: string, authCookie: string) {
  const response = await fetchWithSession(`${apiBaseUrl.replace(/\/$/, "")}/api/meetings/${meetingId}/export`, {
    headers: { Cookie: authCookie },
  });
  const text = await readMobileTextResponse(response, mobileApiLanguage);

  if (!response.ok) {
    throw new Error(`Markdown 导出失败：${response.status}`);
  }

  return text;
}

export async function updateMeetingShare(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  visibility: ShareVisibility;
  includeTranscript: boolean;
  expiresAt?: string;
  confirmUnverified?: boolean;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({
      visibility: params.visibility,
      includeTranscript: params.includeTranscript,
      expiresAt: params.expiresAt,
      confirmUnverified: Boolean(params.confirmUnverified),
    }),
  });
  const payload = await parseMobileJsonResponse<MeetingShareResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.share) {
    throw new Error(payload.error || `分享设置失败：${response.status}`);
  }

  return payload;
}

export async function updateMeetingHumanReview(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  confirmed: boolean;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/review`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({ confirmed: params.confirmed }),
  });
  const payload = await parseMobileJsonResponse<MeetingHumanReviewResponse>(response, mobileApiLanguage);
  if (!response.ok || !payload.ok || !payload.humanReview) {
    throw new Error(payload.error || `人工复核状态保存失败：${response.status}`);
  }
  return payload;
}

export async function updateMeetingSpeakers(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  speakerNames: Record<string, string>;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({
      speakerNames: params.speakerNames,
    }),
  });
  const payload = await parseMobileJsonResponse<MeetingSpeakerUpdateResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.result) {
    throw new Error(payload.error || `发言人名称保存失败：${response.status}`);
  }

  return payload;
}

export async function updateMeetingTranscriptSpeakers(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  speakerAssignments: Record<string, string>;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({
      transcriptSpeakerAssignments: params.speakerAssignments,
    }),
  });
  const payload = await parseMobileJsonResponse<MeetingTranscriptSpeakerUpdateResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.result) {
    throw new Error(payload.error || `发言段归属保存失败：${response.status}`);
  }

  return payload;
}

export async function updateMeetingMetadata(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  title: string;
  project: string;
  participants: string[];
  tags: string[];
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({
      title: params.title,
      project: params.project,
      participants: params.participants,
      tags: params.tags,
    }),
  });
  const payload = await parseMobileJsonResponse<MeetingMetadataUpdateResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.metadata) {
    throw new Error(payload.error || `会议信息保存失败：${response.status}`);
  }

  return payload;
}

export async function updateMeetingSummary(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
  summaryPatch: Partial<Pick<MeetingSummary, "summary" | "topics" | "speakerViews" | "decisions" | "actionItems" | "risks" | "openQuestions" | "knowledgePoints">>;
}) {
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
    },
    body: JSON.stringify({
      summaryPatch: params.summaryPatch,
    }),
  });
  const payload = await parseMobileJsonResponse<MeetingSummaryUpdateResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok || !payload.result) {
    throw new Error(payload.error || `纪要保存失败：${response.status}`);
  }

  return payload;
}

export async function finalizeMeeting(params: {
  apiBaseUrl: string;
  meetingId: string;
  title: string;
  authCookie: string;
  force?: boolean;
  operationId?: string;
  processingMode?: UserProcessingMode;
}) {
  const operationId = params.force
    ? params.operationId ?? `reprocess-${Crypto.randomUUID()}`
    : undefined;
  const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/finalize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: params.authCookie,
      ...(operationId ? { "Idempotency-Key": operationId } : {}),
    },
    body: JSON.stringify({
      title: params.title,
      force: Boolean(params.force),
      operationId,
      processingMode: params.processingMode,
    }),
  });
  const payload = await parseMobileJsonResponse<FinalizeMeetingResponse>(response, mobileApiLanguage);

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `正式处理失败：${response.status}`);
  }

  if (!payload.result && (payload.queued || payload.processing?.status === "queued" || payload.processing?.status === "processing")) {
    return pollMeetingFinalization(params);
  }

  return payload;
}

async function pollMeetingFinalization(params: {
  apiBaseUrl: string;
  meetingId: string;
  authCookie: string;
}) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(2_000);
    const response = await fetchWithSession(`${params.apiBaseUrl.replace(/\/$/, "")}/api/meetings/${params.meetingId}/finalize`, {
      headers: { Cookie: params.authCookie },
    });
    const payload = await parseMobileJsonResponse<FinalizeMeetingResponse>(response, mobileApiLanguage);
    if (!response.ok || !payload.ok) throw new Error(payload.error || `会议处理状态读取失败：${response.status}`);
    if (payload.result && payload.processing?.status === "completed") return payload;
    if (payload.processing?.status === "failed") {
      throw new Error(payload.processing.error?.message || "会议纪要生成失败，音频已保留，可稍后重试。");
    }
  }
  throw new Error("会议处理仍在后台进行。音频已经保存，可稍后在会议历史中查看结果。");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithSession(
  input: RequestInfo | URL,
  init: RequestInit = {},
  sessionOptions: { forbiddenIsAuthoritative?: boolean } = {},
) {
  const headers = new Headers(init.headers);
  const sessionCookie = headers.get("Cookie");
  const sessionToken = sessionCookie?.match(/(?:^|;\s*)ownminutes_session=([^;]+)/)?.[1];
  if (sessionToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${sessionToken}`);
  }

  const response = await safeFetch(input, {
    ...init,
    credentials: "include",
    headers,
  });
  return assertNoAuthoritativeSessionRejection(response, { ...sessionOptions, language: mobileApiLanguage });
}

function safeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  assertSafeMobileApiUrl(url);
  const headers = new Headers(init.headers);
  if (!headers.has("Accept-Language")) headers.set("Accept-Language", mobileApiLanguage);
  return fetchMobileApi(input, { ...init, headers }, { language: mobileApiLanguage });
}
