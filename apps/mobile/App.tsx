import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import {
  AudioQuality,
  createAudioPlayer,
  IOSOutputFormat,
  type RecordingStatus,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  useAudioStream,
} from "expo-audio";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import { deepLinkToSubscriptions } from "expo-iap";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  AppStateStatus,
  Image,
  Keyboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  Share,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import appIcon from "./assets/icon.png";
import {
  AdminDiagnosticsAccessError,
  changeAccountPassword,
  checkAccountDeletionStatus,
  confirmAccountPasswordReset,
  createRecordingUploadId,
  deleteAccount,
  deleteMeeting,
  deleteProviderCredential,
  exportAccountData,
  fetchAccountUsage,
  fetchBackendHealth,
  fetchCurrentUser,
  fetchMeetingDetail,
  fetchMeetingMarkdown,
  fetchMeetings,
  fetchProviderCredentials,
  fetchProviderDiagnostic,
  fetchProviderHealth,
  fetchReleaseReadinessSummary,
  finalizeMeeting,
  finishRealtimePcmSession,
  finishRealtimePcmSessionIfPresent,
  confirmAccountEmailVerification,
  confirmAccountEmailVerificationCode,
  loginAccount,
  logoutAccount,
  prepareAccountDeletion,
  registerAccount,
  requestAccountEmailVerificationCode,
  requestAccountPasswordReset,
  runAsrSubmitTest,
  runRealtimeAsrAuthTest,
  saveProviderCredential,
  setMobileApiLanguage,
  updateMeetingHumanReview,
  updateMeetingShare,
  updateMeetingMetadata,
  updateMeetingSummary,
  updateMeetingSpeakers,
  updateMeetingTranscriptSpeakers,
  updateProcessingMode,
  uploadMeetingAudio,
  uploadRealtimePcmChunk,
  isRetryableRealtimeChunkUploadError,
} from "./src/api";
import { Panel, Stat } from "./src/components";
import { LocalAudioErrorBoundary } from "./src/local-audio-error-boundary";
import {
  deleteAccountWithConfirmation,
  parseAccountDeletionReceipt,
  reconcileAccountDeletionReceipt,
  serializeAccountDeletionReceipt,
  type AccountDeletionReceipt,
} from "./src/account-deletion";
import { deleteMeetingWithConfirmation, isMeetingDeletionBlocked } from "./src/meeting-deletion";
import { initialEmailVerificationState } from "./src/email-verification-state";
import {
  CUSTOM_API_BASE_URL_EDITING_ENABLED,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_BASE_URL_BUILD_MARKER,
  assertSafeMobileApiUrl,
  getApiBaseUrlGuidance,
  normalizeApiBaseUrl,
} from "./src/config";
import { IapPlanStore, IapPlanStoreProvider } from "./src/IapPlanStore";
import { meetingResultHasNoSpeech, toUserFacingMeetingDiagnostic } from "./src/meeting-diagnostics";
import { createDefaultMeetingShareExpiresAt } from "./src/meeting-share";
import { extractPasswordResetToken } from "./src/password-reset";
import {
  initialUploadState,
  AccountUsage,
  AuthResponse,
  AsrLiveTestResult,
  BackendHealthResponse,
  MeetingDetail,
  MeetingListItem,
  MeetingResult,
  MeetingStatus,
  MobileUser,
  ProviderCredentialSummary,
  ProviderDiagnostic,
  ProviderHealthResult,
  RecordingConsentMetadata,
  RealtimeAsrAuthTestResult,
  ReleaseReadinessBlocker,
  ReleaseReadinessSummary,
  TranscriptSegment,
  UploadState,
  UserProcessingMode,
} from "./src/types";
import { createMeetingId, formatBytes, formatDuration } from "./src/utils";
import {
  attachPendingRealtimeSessionUri,
  audioMimeTypeForUri,
  completePendingRealtimeSession,
  deleteLocalRecordingFromDevice,
  deletePendingRecordingAfterRemoteDelete,
  deleteLocalRecordingsForUser,
  loadPendingRecordings,
  PendingRecording,
  preparePendingRealtimeSession,
  type RecordingRecoveryIssue,
  upsertPendingRecording,
} from "./src/recording-store";
import {
  mergeDeferredSyncOptions,
  pendingRetryDelayMs,
  shouldDrainDeferredSync,
  type PendingSyncOptions,
  selectPendingSyncTargets,
} from "./src/pending-sync";
import {
  selectAccountLocalRecordings,
  selectDeviceLegacyRecoveryRecordings,
} from "./src/local-recording-privacy";
import { assessInterruptedRecordingRecovery, isInterruptedRecordingState } from "./src/interrupted-recording-recovery";
import {
  parseOfflineSessionSnapshot,
  serializeOfflineSessionSnapshot,
  sessionRestoreFailureDisposition,
} from "./src/offline-session";
import {
  isRecordingStartSessionCurrent,
  runtimeSessionFailureDisposition,
  shouldBlockRecordingSensitiveMutation,
  type RecordingStartSessionFence,
} from "./src/session-recovery";
import { getPostMeetingPresentation } from "./src/post-meeting-presentation";
import { buildMarkdownExportFileName } from "./src/export-file-name";
import { filterMeetingHistory, type MeetingHistoryFilter } from "./src/meeting-history";
import { getFirstRunGuide, type FirstRunAction, type FirstRunGuide } from "./src/first-run";
import {
  formatMeetingBilling,
  getMeetingCostPreview,
  getMobileByokCoverage,
  type MeetingCostPreview,
} from "./src/meeting-cost";
import {
  assessRecordingFileHealth,
  createRecordingFileHealth,
  type RecordingFileHealth,
} from "./src/recording-health";
import {
  assessRecordingDurationLimit,
  assessRecordingStorageHealth,
  classifyNativeRecordingCompletion,
  createUnknownRecordingStorageHealth,
  recordingDurationMaximumMs,
  recordingStorageEstimatedMaximumBytes,
  recordingStorageStartMinimumBytes,
  remainingRecordingDurationSeconds,
  type RecordingStorageHealth,
  type RecordingStoragePhase,
  unavailableRecordingStorageHealth,
} from "./src/recording-storage";
import { AppStoreShowcase } from "./src/AppStoreShowcase";
import { LanguageSelector } from "./src/i18n/LanguageSelector";
import { formatLocalizedDate, translate, type AppLocale } from "./src/i18n/core";
import { I18nProvider, useI18n } from "./src/i18n/provider";
import {
  isRealtimeUploadQueueCancelledError,
  nextRealtimeUploadSequence,
  realtimeCaptureMayResume,
  realtimeFailureCooldownMs,
  realtimeSequenceAfterFailure,
  RealtimeUploadQueue,
  RealtimeUploadQueueCancelledError,
  retryRealtimeUpload,
} from "./src/realtime-upload-queue";

const keepAwakeTag = "ownminutes-recording";
const recordingConsentPolicyVersion = "2026-07-30";
const sessionCookieKey = "ownminutes_session_cookie";
const offlineSessionSnapshotKey = "ownminutes_offline_session_v1";
const pendingAccountDeletionKey = "ownminutes_pending_account_deletion_v1";
const apiBaseUrlKey = "ownminutes_api_base_url";
const nonSensitiveTextInputProps = {
  autoComplete: "off",
  importantForAutofill: "no",
  secureTextEntry: false,
  textContentType: "none",
} as const;
const recordingFileWatchIntervalMs = 5000;
const recordingStorageWatchIntervalMs = 15000;
const recordingRestoreBudgetMs = 12_000;
const recordingRestoreTimeoutCode = "ownminutes-recording-restore-timeout";
const delayedRecordingUriAttempts = 60;
const delayedRecordingUriIntervalMs = 250;
// The realtime endpoint includes provider processing time. Three-second chunks
// arrive faster than a serialized mobile request can complete on 5G, so the
// queue inevitably grows and then cancels the session. Ten-second chunks keep
// the secondary live draft bounded while the durable recorder remains primary.
const realtimeChunkTargetMs = 10_000;
const realtimePcmBytesPerSecond = 16000 * 1 * 2;
const realtimeChunkTargetBytes = Math.round((realtimePcmBytesPerSecond * realtimeChunkTargetMs) / 1000);
type RealtimePcmChunk = {
  bytes: ArrayBuffer;
  byteLength: number;
  channels: number;
  createdAt: string;
  durationMs: number;
  sampleRate: number;
  sequence: number;
};
type RecordingStopReason =
  | "duration-limit"
  | "file-missing"
  | "file-stalled"
  | "low-storage"
  | "native-error";
const realtimeChunkQueueLimit = 6;
const emailVerificationCodeLength = 6;
const emailVerificationResendDurationSeconds = 60;

type EmailVerificationCodeCopy = {
  accountExists: string;
  changeEmail: string;
  close: string;
  codeHint: string;
  codeLabel: string;
  deliveryFailed: string;
  invalidCode: string;
  invalidCredentials: string;
  legacyLinkRequired: string;
  loginFailed: string;
  registrationFailed: string;
  resend: string;
  resendFailed: string;
  resendIn: (seconds: number) => string;
  resending: string;
  sentAgain: string;
  subtitle: (email: string) => string;
  success: string;
  title: string;
  tooManyAttempts: string;
  verificationRequired: string;
  verify: string;
  verifying: string;
};

const emailVerificationCodeCopy: Record<AppLocale, EmailVerificationCodeCopy> = {
  en: {
    accountExists: "This email is already registered. Sign in or reset your password.",
    changeEmail: "Change email",
    close: "Close verification",
    codeHint: "Enter all six digits. The code will be submitted automatically.",
    codeLabel: "6-digit verification code",
    deliveryFailed: "Your account was created, but the verification email was not delivered. Use Resend as soon as it becomes available.",
    invalidCode: "That code is incorrect or has expired. Request a new code and try again.",
    invalidCredentials: "The email or password is incorrect.",
    legacyLinkRequired: "The service is being upgraded. Open the verification link in your email, then return here and sign in.",
    loginFailed: "Could not sign in right now. Check your connection and try again.",
    registrationFailed: "Could not create the account. Check your details and try again.",
    resend: "Resend code",
    resendFailed: "Could not send a new code. Try again shortly.",
    resendIn: (seconds) => `Resend in ${seconds}s`,
    resending: "Sending code…",
    sentAgain: "A new code was sent.",
    subtitle: (email) => `Enter the code sent to ${email}.`,
    success: "Email verified.",
    title: "Check your email",
    tooManyAttempts: "Too many attempts. Please wait before trying again.",
    verificationRequired: "Verify this email to continue.",
    verify: "Verify and continue",
    verifying: "Verifying…",
  },
  "zh-Hans": {
    accountExists: "该邮箱已经注册，请直接登录或重置密码。",
    changeEmail: "修改邮箱",
    close: "关闭验证",
    codeHint: "输入全部 6 位数字后会自动验证。",
    codeLabel: "6 位邮箱验证码",
    deliveryFailed: "账号已创建，但验证邮件暂未送达。重新发送可用后，请点击重发。",
    invalidCode: "验证码不正确或已过期，请重新获取后再试。",
    invalidCredentials: "邮箱或密码不正确。",
    legacyLinkRequired: "服务正在升级，请先打开邮件中的验证链接，完成后返回这里登录。",
    loginFailed: "暂时无法登录，请检查网络后重试。",
    registrationFailed: "暂时无法创建账号，请检查填写内容后重试。",
    resend: "重新发送验证码",
    resendFailed: "验证码发送失败，请稍后重试。",
    resendIn: (seconds) => `${seconds} 秒后重新发送`,
    resending: "正在发送…",
    sentAgain: "新的验证码已发送。",
    subtitle: (email) => `请输入发送到 ${email} 的验证码。`,
    success: "邮箱验证成功。",
    title: "查收邮箱验证码",
    tooManyAttempts: "尝试次数过多，请稍后再试。",
    verificationRequired: "请先验证邮箱后继续。",
    verify: "验证并继续",
    verifying: "正在验证…",
  },
  "zh-Hant": {
    accountExists: "此電子郵件已註冊，請直接登入或重設密碼。",
    changeEmail: "修改電子郵件",
    close: "關閉驗證",
    codeHint: "輸入全部 6 位數字後會自動驗證。",
    codeLabel: "6 位電子郵件驗證碼",
    deliveryFailed: "帳號已建立，但驗證郵件暫未送達。重新傳送可用後，請點擊重傳。",
    invalidCode: "驗證碼不正確或已過期，請重新取得後再試。",
    invalidCredentials: "電子郵件或密碼不正確。",
    legacyLinkRequired: "服務正在升級，請先開啟郵件中的驗證連結，完成後返回此處登入。",
    loginFailed: "暫時無法登入，請檢查網路後重試。",
    registrationFailed: "暫時無法建立帳號，請檢查填寫內容後重試。",
    resend: "重新傳送驗證碼",
    resendFailed: "驗證碼傳送失敗，請稍後再試。",
    resendIn: (seconds) => `${seconds} 秒後重新傳送`,
    resending: "正在傳送…",
    sentAgain: "新的驗證碼已傳送。",
    subtitle: (email) => `請輸入傳送到 ${email} 的驗證碼。`,
    success: "電子郵件驗證成功。",
    title: "查看電子郵件驗證碼",
    tooManyAttempts: "嘗試次數過多，請稍後再試。",
    verificationRequired: "請先驗證電子郵件後繼續。",
    verify: "驗證並繼續",
    verifying: "正在驗證…",
  },
};
const volcanoSpeechConsoleUrl = "https://console.volcengine.com/speech";
const volcanoSpeechApiDocsUrl = "https://www.volcengine.com/docs/6561/1631584?lang=zh";
const volcanoArkConsoleUrl = "https://console.volcengine.com/ark";
const durableRecordingOptions = {
  extension: ".m4a",
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  directory: "document" as const,
  isMeteringEnabled: true,
  android: {
    extension: ".m4a",
    outputFormat: "mpeg4" as const,
    audioEncoder: "aac" as const,
    sampleRate: 16000,
  },
  ios: {
    extension: ".caf",
    sampleRate: 16000,
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: "audio/webm;codecs=opus",
    bitsPerSecond: 64000,
  },
};
type MobileTab = "record" | "meetings" | "settings" | "account";
type RecordSegment = "transcript" | "notes";
type PendingSyncResult = { deferred: boolean; failed: number; succeeded: number };
type AutoSyncNoticeTone = "info" | "warning";
type NetworkStatus = "checking" | "offline" | "online";
const historyPageSize = 20;
const transcriptReviewPageSize = 30;

export default function App() {
  return (
    <I18nProvider>
      {process.env.EXPO_PUBLIC_APPSTORE_SHOWCASE === "1" ? <AppStoreShowcase /> : <OwnMinutesApp />}
    </I18nProvider>
  );
}

function OwnMinutesApp() {
  const { locale, ready: i18nReady, t } = useI18n();
  const verificationCopy = emailVerificationCodeCopy[locale];
  const nativeRecorderStatusRef = useRef<(event: RecordingStatus) => void>(() => undefined);
  const recorder = useAudioRecorder(durableRecordingOptions, (event) => nativeRecorderStatusRef.current(event));
  const recorderState = useAudioRecorderState(recorder, 500);
  const [status, setStatus] = useState<MeetingStatus>("idle");
  const [recordingStartPreflightBusy, setRecordingStartPreflightBusy] = useState(false);
  const [recordingTransitionBusy, setRecordingTransitionBusy] = useState(false);
  const [meetingId, setMeetingId] = useState(createMeetingId());
  const [meetingTitle, setMeetingTitle] = useState(() => createDefaultMeetingTitle(locale));
  const defaultMeetingTitleRef = useRef(meetingTitle);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [activeTab, setActiveTab] = useState<MobileTab>("account");
  const [recordSegment, setRecordSegment] = useState<RecordSegment>("transcript");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [sessionCookie, setSessionCookie] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<MobileUser | null>(null);
  const [accountUsage, setAccountUsage] = useState<AccountUsage | null>(null);
  const markOfficialProcessingUnknown = useCallback(() => {
    setAccountUsage((current) => (
      current
        ? { ...current, officialProcessing: { status: "unknown" } }
        : current
    ));
  }, []);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [emailVerificationVisible, setEmailVerificationVisible] = useState(false);
  const [emailVerificationCode, setEmailVerificationCode] = useState("");
  const [emailVerificationToken, setEmailVerificationToken] = useState("");
  const [emailVerificationMessage, setEmailVerificationMessage] = useState<string | null>(null);
  const [emailVerificationResendSeconds, setEmailVerificationResendSeconds] = useState(0);
  const [emailVerificationSubmitting, setEmailVerificationSubmitting] = useState(false);
  const [emailVerificationResending, setEmailVerificationResending] = useState(false);
  const emailVerificationSubmitLockRef = useRef(false);
  const [authAcceptedTerms, setAuthAcceptedTerms] = useState(false);
  const [authPasswordVisible, setAuthPasswordVisible] = useState(false);
  const [passwordResetRequesting, setPasswordResetRequesting] = useState(false);
  const [passwordResetToken, setPasswordResetToken] = useState("");
  const [passwordResetNewPassword, setPasswordResetNewPassword] = useState("");
  const [passwordResetConfirmPassword, setPasswordResetConfirmPassword] = useState("");
  const [passwordResetVisible, setPasswordResetVisible] = useState(false);
  const [passwordResetPasswordVisible, setPasswordResetPasswordVisible] = useState(false);
  const [passwordResetSubmitting, setPasswordResetSubmitting] = useState(false);
  const [passwordResetMessage, setPasswordResetMessage] = useState<string | null>(null);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordChangeVisible, setPasswordChangeVisible] = useState(false);
  const [passwordChanging, setPasswordChanging] = useState(false);
  const [passwordChangeMessage, setPasswordChangeMessage] = useState<string | null>(null);
  const [showHelpAndLegal, setShowHelpAndLegal] = useState(false);
  const [sessionRestoreComplete, setSessionRestoreComplete] = useState(false);
  const [offlineSessionRestored, setOfflineSessionRestored] = useState(false);
  const [offlineSessionRetryTick, setOfflineSessionRetryTick] = useState(0);
  const [sessionReauthenticationRequired, setSessionReauthenticationRequired] = useState(false);
  const [recordedUri, setRecordedUri] = useState<string | null>(null);
  const [activeRecordingUri, setActiveRecordingUri] = useState<string | null>(null);
  const [recordingFileHealth, setRecordingFileHealth] = useState<RecordingFileHealth>(() => ({
    bytes: 0,
    lastCheckedAt: 0,
    lastGrowthAt: 0,
    status: "idle",
  }));
  const [recordingStorageHealth, setRecordingStorageHealth] = useState<RecordingStorageHealth>(() =>
    createUnknownRecordingStorageHealth(),
  );
  const [recordingSessionElapsedMs, setRecordingSessionElapsedMs] = useState(0);
  const [uploadState, setUploadState] = useState<UploadState>(initialUploadState);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [meetings, setMeetings] = useState<MeetingListItem[]>([]);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingDetail | null>(null);
  const [selectedLocalRecordingId, setSelectedLocalRecordingId] = useState<string | null>(null);
  const [selectedMeetingAudioAvailability, setSelectedMeetingAudioAvailability] = useState<
    "idle" | "checking" | "available" | "unavailable"
  >("idle");
  const [selectedMeetingAudioProbeVersion, setSelectedMeetingAudioProbeVersion] = useState(0);
  const [localRecordingDeleting, setLocalRecordingDeleting] = useState(false);
  const [finalMeetingResult, setFinalMeetingResult] = useState<MeetingResult | null>(null);
  const [formalMarkdown, setFormalMarkdown] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState<MeetingHistoryFilter>("all");
  const [historyVisibleCount, setHistoryVisibleCount] = useState(historyPageSize);
  const [selectedFinalizing, setSelectedFinalizing] = useState(false);
  const [shareUpdating, setShareUpdating] = useState(false);
  const [reviewUpdating, setReviewUpdating] = useState(false);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [speakerNameDrafts, setSpeakerNameDrafts] = useState<Record<string, string>>({});
  const [speakerSaving, setSpeakerSaving] = useState(false);
  const [speakerMessage, setSpeakerMessage] = useState<string | null>(null);
  const [transcriptSpeakerDrafts, setTranscriptSpeakerDrafts] = useState<Record<string, string>>({});
  const [transcriptSpeakerSaving, setTranscriptSpeakerSaving] = useState(false);
  const [transcriptSpeakerMessage, setTranscriptSpeakerMessage] = useState<string | null>(null);
  const [transcriptSpeakerError, setTranscriptSpeakerError] = useState(false);
  const [transcriptVisibleCount, setTranscriptVisibleCount] = useState(transcriptReviewPageSize);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [topicsDraft, setTopicsDraft] = useState("");
  const [risksDraft, setRisksDraft] = useState("");
  const [openQuestionsDraft, setOpenQuestionsDraft] = useState("");
  const [knowledgeDraft, setKnowledgeDraft] = useState("");
  const [speakerViewsDraft, setSpeakerViewsDraft] = useState("");
  const [decisionDraft, setDecisionDraft] = useState("");
  const [actionDraft, setActionDraft] = useState("");
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryMessage, setSummaryMessage] = useState<string | null>(null);
  const [metadataTitleDraft, setMetadataTitleDraft] = useState("");
  const [metadataProjectDraft, setMetadataProjectDraft] = useState("");
  const [metadataParticipantsDraft, setMetadataParticipantsDraft] = useState("");
  const [metadataTagsDraft, setMetadataTagsDraft] = useState("");
  const [metadataSaving, setMetadataSaving] = useState(false);
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null);
  const [showMetadataEditor, setShowMetadataEditor] = useState(false);
  const [showMeetingEditor, setShowMeetingEditor] = useState(false);
  const [showSpeakerEditor, setShowSpeakerEditor] = useState(false);
  const [showTranscriptReview, setShowTranscriptReview] = useState(false);
  const [showTranscriptCorrection, setShowTranscriptCorrection] = useState(false);
  const [showShareControls, setShowShareControls] = useState(false);
  const [showMeetingTools, setShowMeetingTools] = useState(false);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>("checking");
  const [pcmBuffers, setPcmBuffers] = useState(0);
  const [pcmBytes, setPcmBytes] = useState(0);
  const [realtimeChunks, setRealtimeChunks] = useState(0);
  const [realtimeChunkBytes, setRealtimeChunkBytes] = useState(0);
  const [realtimePendingBytes, setRealtimePendingBytes] = useState(0);
  const [realtimeRetainedChunks, setRealtimeRetainedChunks] = useState(0);
  const [realtimeDroppedChunks, setRealtimeDroppedChunks] = useState(0);
  const [realtimeUploadedChunks, setRealtimeUploadedChunks] = useState(0);
  const [realtimeRejectedChunks, setRealtimeRejectedChunks] = useState(0);
  const [realtimeMaxByteDrift, setRealtimeMaxByteDrift] = useState(0);
  const [realtimePendingUploads, setRealtimePendingUploads] = useState(0);
  const [realtimeFailedUploads, setRealtimeFailedUploads] = useState(0);
  const [realtimeUploadDiagnostic, setRealtimeUploadDiagnostic] = useState<string | null>(null);
  const [lastRealtimeChunkAt, setLastRealtimeChunkAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [recordingRecoveryError, setRecordingRecoveryError] = useState<string | null>(null);
  const [providerDiagnostic, setProviderDiagnostic] = useState<ProviderDiagnostic | null>(null);
  const [providerCredentials, setProviderCredentials] = useState<ProviderCredentialSummary[]>([]);
  const [providerMode, setProviderMode] = useState<"volcano-asr" | "volcano-ark">("volcano-asr");
  const [providerAppId, setProviderAppId] = useState("");
  const [providerAsrResourceId, setProviderAsrResourceId] = useState("volc.bigasr.auc_turbo");
  const [providerRealtimeAsrResourceId, setProviderRealtimeAsrResourceId] = useState("volc.seedasr.sauc.duration");
  const [providerAsrWsUrl, setProviderAsrWsUrl] = useState("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");
  const [providerModel, setProviderModel] = useState("");
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerAsrApiKey, setProviderAsrApiKey] = useState("");
  const [providerAsrToken, setProviderAsrToken] = useState("");
  const [providerArkApiKey, setProviderArkApiKey] = useState("");
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<ProviderHealthResult[]>([]);
  const [providerHealthLoading, setProviderHealthLoading] = useState(false);
  const [providerDeleting, setProviderDeleting] = useState<string | null>(null);
  const [processingModeSaving, setProcessingModeSaving] = useState(false);
  const [processingModeMessage, setProcessingModeMessage] = useState<string | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [showRecordingPrivacy, setShowRecordingPrivacy] = useState(false);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [showProviderEditor, setShowProviderEditor] = useState(false);
  const [showProviderAdvancedFields, setShowProviderAdvancedFields] = useState(false);
  const [showUsageHistory, setShowUsageHistory] = useState(false);
  const [showMembership, setShowMembership] = useState(false);
  const [asrSubmitTesting, setAsrSubmitTesting] = useState(false);
  const [asrSubmitMessage, setAsrSubmitMessage] = useState<string | null>(null);
  const [realtimeAsrTesting, setRealtimeAsrTesting] = useState(false);
  const [realtimeAsrTestMessage, setRealtimeAsrTestMessage] = useState<string | null>(null);
  const [microphonePermission, setMicrophonePermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const [keepAwakeActive, setKeepAwakeActive] = useState(false);
  const [pendingRecordings, setPendingRecordings] = useState<PendingRecording[]>([]);
  const [completedDurationMs, setCompletedDurationMs] = useState(0);
  const [autoSyncNotice, setAutoSyncNotice] = useState<{ message: string; tone: AutoSyncNoticeTone } | null>(null);
  const autoSyncMessage = autoSyncNotice?.message ?? null;
  const autoSyncTone = autoSyncNotice?.tone ?? "info";
  const setAutoSyncMessage = useCallback((message: string | null, tone: AutoSyncNoticeTone = "info") => {
    setAutoSyncNotice(message ? { message, tone } : null);
  }, []);
  const [backendHealth, setBackendHealth] = useState<BackendHealthResponse | null>(null);
  const [releaseSummary, setReleaseSummary] = useState<ReleaseReadinessSummary | null>(null);
  const [releaseBlockers, setReleaseBlockers] = useState<ReleaseReadinessBlocker[]>([]);
  const [backendChecking, setBackendChecking] = useState(false);
  const [apiBaseUrlRestored, setApiBaseUrlRestored] = useState(false);
  const [appStateLabel, setAppStateLabel] = useState("前台");
  const [backgroundInterruptions, setBackgroundInterruptions] = useState(0);
  const [lastBackgroundAt, setLastBackgroundAt] = useState<string | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const uploadInFlightRef = useRef(false);
  const realtimeChunkBufferBytesRef = useRef(0);
  const realtimePendingBuffersRef = useRef<Uint8Array[]>([]);
  const flushRealtimePcmBufferRef = useRef<() => void>(() => undefined);
  const realtimeChunkSequenceRef = useRef(0);
  const realtimeUploadQueueRef = useRef(new RealtimeUploadQueue());
  const activeRealtimeMeetingIdRef = useRef<string | null>(null);
  const activeRealtimeJournalMeetingIdRef = useRef<string | null>(null);
  const activeRecordingProcessingModeRef = useRef<UserProcessingMode | null>(null);
  const activeRecordingConsentRef = useRef<RecordingConsentMetadata | null>(null);
  const realtimeFailureStreakRef = useRef(0);
  const realtimeRetryNotBeforeRef = useRef(0);
  const realtimeStreamRestartInFlightRef = useRef(false);
  const pcmBuffersRef = useRef(0);
  const pcmBytesRef = useRef(0);
  const pcmUiUpdatedAtRef = useRef(0);
  const activeRecordingUriRef = useRef<string | null>(null);
  const currentMeetingIdRef = useRef(meetingId);
  const recordingStartedAtRef = useRef(0);
  const recordingDurationRef = useRef(0);
  const recordingStatusRef = useRef<MeetingStatus>("idle");
  const recordingGenerationRef = useRef(0);
  const mediaServicesResetHandledRef = useRef(false);
  const sessionRestoreStartedRef = useRef(false);
  const offlineSessionRevalidationInFlightRef = useRef(false);
  const activeSessionRevalidationInFlightRef = useRef(false);
  const sessionReauthenticationRequiredRef = useRef(false);
  const recordingLifecycleBusyRef = useRef(false);
  const recordingStorageEmergencyStopRef = useRef(false);
  const recordingDurationLimitStopRef = useRef(false);
  const recordingFileWatchdogFailuresRef = useRef(0);
  const recordingFileWatchdogStopRef = useRef(false);
  const recordingTransitionInFlightRef = useRef(false);
  const pendingRecordingStopRef = useRef<{ reason?: RecordingStopReason } | null>(null);
  const recordingFileHealthRef = useRef(recordingFileHealth);
  const nativeDurationLimitArmedRef = useRef(false);
  const recordingStopInFlightRef = useRef(false);
  const foregroundRecordingCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountSessionMutationInFlightRef = useRef(false);
  const providerMutationInFlightRef = useRef(false);
  const providerDraftUserIdRef = useRef<string | null>(null);
  const localRecordingDeleteInFlightRef = useRef(false);
  const stopRecordingRef = useRef<(reason?: RecordingStopReason) => Promise<void>>(async () => undefined);
  const handleMediaServicesResetRef = useRef<() => Promise<void>>(async () => undefined);
  const autoSyncInFlightRef = useRef(false);
  const autoSyncRequestRef = useRef<() => void>(() => undefined);
  const autoSyncWakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deferredSyncOptionsRef = useRef<PendingSyncOptions | null>(null);
  const syncSessionGenerationRef = useRef(0);
  const pendingRecordingsRef = useRef<PendingRecording[]>([]);
  const meetingAudioControllerRef = useRef<MeetingAudioController | null>(null);
  const mainScrollRef = useRef<ScrollView>(null);
  const providerPanelYRef = useRef(0);
  const authNameInputRef = useRef<TextInput>(null);
  const authEmailInputRef = useRef<TextInput>(null);
  const authPasswordInputRef = useRef<TextInput>(null);
  const canPlayMeetingAudio = useCallback(
    () => !recordingLifecycleBusyRef.current && !recordingStopInFlightRef.current,
    [],
  );

  const audioStream = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: "int16",
    onBuffer: (buffer) => {
      if (!activeRealtimeMeetingIdRef.current || recordingStatusRef.current !== "recording") return;
      const now = Date.now();
      if (!realtimeCaptureMayResume(now, realtimeRetryNotBeforeRef.current)) return;
      pcmBuffersRef.current += 1;
      pcmBytesRef.current += buffer.data.byteLength;
      if (now - pcmUiUpdatedAtRef.current >= 1000) {
        pcmUiUpdatedAtRef.current = now;
        setPcmBuffers(pcmBuffersRef.current);
        setPcmBytes(pcmBytesRef.current);
      }
      accumulateRealtimePcmBuffer(buffer);
    },
  });

  const liveRecordingDurationMs = recorderState.durationMillis ?? 0;
  const recordingActive = status === "recording" || status === "paused";
  recordingStatusRef.current = status;
  currentMeetingIdRef.current = meetingId;
  recordingFileHealthRef.current = recordingFileHealth;
  const recordingLifecycleBusy =
    recordingStartPreflightBusy || status === "requesting" || recordingActive || status === "processing";
  recordingLifecycleBusyRef.current = recordingLifecycleBusy;
  if (recordingActive) recordingDurationRef.current = Math.max(recordingDurationRef.current, liveRecordingDurationMs);
  const durationSeconds = Math.floor((recordingActive ? liveRecordingDurationMs : completedDurationMs) / 1000);
  const metering = typeof recorderState.metering === "number" ? Math.max(0, Math.round((recorderState.metering + 60) * 1.6)) : 0;
  const transcriptCount = segments.length;
  const realtimeTranscriptDelayed =
    status === "recording" &&
    liveRecordingDurationMs >= 60_000 &&
    realtimeUploadedChunks >= 3 &&
    transcriptCount === 0;
  const realtimeTranscriptionWarning =
    realtimeUploadDiagnostic &&
    (realtimeFailedUploads > 0 ||
      realtimeRejectedChunks > 0 ||
      realtimeDroppedChunks > 0 ||
      !audioStream.isStreaming)
      ? realtimeUploadDiagnostic
      : realtimeTranscriptDelayed
        ? t("runtime.realtimeTranscriptDelayed")
        : null;
  const userLocalRecordings = selectAccountLocalRecordings(pendingRecordings, currentUser?.id);
  const deviceLegacyRecoveryRecordings = selectDeviceLegacyRecoveryRecordings(pendingRecordings)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const userPendingRecordings = userLocalRecordings.filter((recording) => !recording.finalizedAt);
  const userBrowsableLocalRecordings = userLocalRecordings
    .filter(
      (recording) =>
        recording.activeRecording !== true ||
        recording.meetingId !== meetingId ||
        !recordingLifecycleBusy,
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const serverMeetingIds = new Set(meetings.map((meeting) => meeting.meetingId));
  const standaloneLocalRecordings = userBrowsableLocalRecordings.filter(
    (recording) => !serverMeetingIds.has(recording.meetingId),
  );
  const showStandaloneLocalRecordings = standaloneLocalRecordings.length > 0;
  // Keep the device recovery entry visible even at zero so a user can tell
  // that the on-device scan completed. Hiding it makes an empty result
  // indistinguishable from a failed or skipped recovery scan.
  const showDeviceLegacyRecovery = true;
  const pendingRecording = userLocalRecordings.find((recording) => recording.meetingId === meetingId) ?? null;
  const selectedMeetingAnyLocalRecording = selectedMeeting
    ? userLocalRecordings.find((recording) => recording.meetingId === selectedMeeting.meetingId) ?? null
    : null;
  const selectedMeetingLocalRecording = selectedMeetingAnyLocalRecording?.activeRecording === true &&
    selectedMeetingAnyLocalRecording.meetingId === meetingId &&
    recordingLifecycleBusy
      ? null
      : selectedMeetingAnyLocalRecording;
  const selectedLocalRecording = selectedLocalRecordingId
    ? [...deviceLegacyRecoveryRecordings, ...userBrowsableLocalRecordings]
        .find((recording) => recording.meetingId === selectedLocalRecordingId) ?? null
    : null;
  const selectedPlaybackRecording = selectedMeetingLocalRecording ?? selectedLocalRecording;
  const selectedMeetingDeletionBlocked = Boolean(selectedMeeting && isMeetingDeletionBlocked({
    currentMeetingId: meetingId,
    recordingLifecycleBusy,
    targetMeetingId: selectedMeeting.meetingId,
  }));
  useEffect(() => {
    const uri = selectedPlaybackRecording?.uri;
    let cancelled = false;
    void (async () => {
      // Yield once so this effect synchronizes with the native file system
      // without cascading a synchronous render from the effect body.
      await Promise.resolve();
      if (cancelled) return;
      if (!uri) {
        setSelectedMeetingAudioAvailability("idle");
        return;
      }
      setSelectedMeetingAudioAvailability("checking");
      try {
        const info = await withTimeout(FileSystem.getInfoAsync(uri), 2500, "local audio probe timeout");
        if (cancelled) return;
        setSelectedMeetingAudioAvailability(
          info.exists && !info.isDirectory && info.size > 0 ? "available" : "unavailable",
        );
      } catch {
        if (!cancelled) setSelectedMeetingAudioAvailability("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMeetingAudioProbeVersion, selectedPlaybackRecording?.uri]);
  const hasInterruptedRecording = isInterruptedRecordingState({
    activeRecording: pendingRecording?.activeRecording,
    recordingLifecycleBusy,
  });
  const hasIsolatedRecovery = pendingRecording?.localRecoveryOnly === true;
  const activeMeetingResult = finalMeetingResult;
  const activeMeetingQuality = useMemo(() => assessMobileMeetingQuality(activeMeetingResult), [activeMeetingResult]);
  const activeMeetingNoSpeech = useMemo(
    () => meetingResultHasNoSpeech(activeMeetingResult?.diagnostics),
    [activeMeetingResult],
  );
  const hasLocalRecording = Boolean(recordedUri || pendingRecording);
  const meetingFinalized = Boolean(formalMarkdown || activeMeetingResult || pendingRecording?.finalizedAt);
  const postMeetingPresentation = getPostMeetingPresentation({
    audioUploaded: Boolean(pendingRecording?.audioUploadedAt),
    finalized: meetingFinalized,
    hasLocalRecording,
    status,
  }, locale);
  const heroHint =
    status === "recording"
      ? t("record.hintRecording")
      : status === "paused"
        ? t("record.hintPaused")
        : hasInterruptedRecording
          ? t("record.hintInterrupted")
      : postMeetingPresentation
          ? postMeetingPresentation.hint
          : meetingFinalized
            ? activeMeetingQuality.status === "verified"
              ? t("record.hintVerified")
              : activeMeetingNoSpeech
                ? t("record.hintNoSpeech")
              : activeMeetingResult
                ? t("record.hintNeedsModels")
                : t("record.hintComplete")
            : t("record.hintIdle");
  const recordingFileHealthMessage =
    recordingFileHealth.status === "healthy"
      ? t("record.fileHealthy", { bytes: formatBytes(recordingFileHealth.bytes) })
      : recordingFileHealth.status === "paused"
        ? t("record.filePaused", { bytes: formatBytes(recordingFileHealth.bytes) })
        : recordingFileHealth.status === "stalled"
          ? t("record.fileStalled")
          : recordingFileHealth.status === "missing"
            ? t("record.fileMissing")
            : t("record.fileConfirming");
  const recordingFileHealthWarning = recordingFileHealth.status === "stalled" || recordingFileHealth.status === "missing";
  const recordingStorageWarning =
    recordingStorageHealth.status === "warning" ||
    recordingStorageHealth.status === "blocked" ||
    recordingStorageHealth.status === "critical" ||
    recordingStorageHealth.status === "unavailable";
  const recordingStorageMessage =
    recordingStorageHealth.status === "critical"
      ? t("record.storageCritical", { bytes: formatBytes(recordingStorageHealth.freeBytes ?? 0) })
      : recordingStorageHealth.status === "blocked"
        ? t("record.storageBlocked", { bytes: formatBytes(recordingStorageHealth.freeBytes ?? 0), minimum: formatBytes(recordingStorageStartMinimumBytes) })
        : recordingStorageHealth.status === "warning"
          ? t("record.storageWarning", { bytes: formatBytes(recordingStorageHealth.freeBytes ?? 0), maximum: formatBytes(recordingStorageEstimatedMaximumBytes) })
          : recordingStorageHealth.status === "unavailable"
            ? t("record.storageUnavailable")
            : recordingStorageHealth.status === "ready" && recordingStorageHealth.freeBytes !== null
              ? t("record.storageReady", { bytes: formatBytes(recordingStorageHealth.freeBytes) })
              : t("record.storageIdle");
  const recordingDurationLimit = assessRecordingDurationLimit(recordingSessionElapsedMs);
  const recordingDurationMessage = !recordingActive
    ? t("record.durationIdle", { limit: formatDuration(Math.floor(recordingDurationMaximumMs / 1000)) })
    : recordingDurationLimit.shouldStop
      ? t("record.durationStop")
      : recordingDurationLimit.shouldWarn
        ? t("record.durationWarning", { remaining: formatDuration(Math.ceil(recordingDurationLimit.remainingMs / 1000)) })
        : t("record.durationIdle", { limit: formatDuration(Math.floor(recordingDurationMaximumMs / 1000)) });

  const clearProviderDrafts = useCallback((preserveMessage = false) => {
    setProviderMode("volcano-asr");
    setProviderAppId("");
    setProviderAsrResourceId("volc.bigasr.auc_turbo");
    setProviderRealtimeAsrResourceId("volc.seedasr.sauc.duration");
    setProviderAsrWsUrl("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");
    setProviderModel("");
    setProviderBaseUrl("");
    setProviderAsrApiKey("");
    setProviderAsrToken("");
    setProviderArkApiKey("");
    if (!preserveMessage) setProviderMessage(null);
    setShowProviderAdvancedFields(false);
    setShowProviderEditor(false);
  }, []);

  useEffect(() => {
    const nextUserId = currentUser?.id ?? null;
    if (providerDraftUserIdRef.current !== nextUserId) {
      clearProviderDrafts();
      providerDraftUserIdRef.current = nextUserId;
    }
  }, [clearProviderDrafts, currentUser?.id]);

  const noteAuthenticatedSessionFailure = useCallback((error: unknown) => {
    const disposition = runtimeSessionFailureDisposition(error, recordingLifecycleBusyRef.current);
    if (disposition === "preserve") return false;

    clearProviderDrafts();
    sessionReauthenticationRequiredRef.current = true;
    setSessionReauthenticationRequired(true);
    setOfflineSessionRestored(false);
    setAutoSyncMessage(
      disposition === "reauthenticate-after-recording"
        ? t("auth.sessionExpiredRecording")
        : t("auth.sessionExpiredIdle"),
      "warning",
    );
    return true;
  }, [clearProviderDrafts, setAutoSyncMessage, t]);
  const heroLocalStatusLabel = recordingFileHealthWarning
    ? t("record.localNeedsCheck")
    : recordingActive
      ? status === "paused"
        ? t("record.localPaused")
        : recordingFileHealth.status === "healthy"
          ? t("record.localSaving")
          : t("record.localConfirming")
      : hasLocalRecording
        ? t("record.localSaved")
        : t("record.localReady");
  const heroLocalStatusIcon: keyof typeof Ionicons.glyphMap = recordingFileHealthWarning
    ? "warning-outline"
    : recordingActive
      ? status === "paused"
        ? "pause-circle-outline"
        : recordingFileHealth.status === "healthy"
          ? "save-outline"
          : "ellipsis-horizontal-circle-outline"
      : hasLocalRecording
        ? "checkmark-circle"
        : "shield-checkmark-outline";
  const heroLocalStatusColor = recordingFileHealthWarning ? "#b54735" : "#23745b";
  const apiBaseUrlGuidance = useMemo(() => getApiBaseUrlGuidance(apiBaseUrl), [apiBaseUrl]);
  const canShowMeetingProgress =
    status !== "idle" ||
    durationSeconds > 0 ||
    uploadState.uploaded > 0 ||
    uploadState.pending > 0 ||
    transcriptCount > 0 ||
    Boolean(recordedUri || pendingRecording);
  const canResetMeeting =
    canShowMeetingProgress &&
    status !== "requesting" &&
    status !== "recording" &&
    status !== "paused" &&
    status !== "processing";
  const providerSetupState = useMemo(() => {
    const fileAsrReady = providerHealth.some((item) => item.status === "ready" && item.canUseFor.includes("file_asr"));
    const summaryReady = providerHealth.some((item) => item.status === "ready" && item.canUseFor.includes("summary"));
    const missing = [
      fileAsrReady ? null : t("settings.fileRecognition"),
      summaryReady ? null : t("settings.summaryModel"),
    ].filter(Boolean) as string[];

    return {
      fileAsrReady,
      summaryReady,
      ready: fileAsrReady && summaryReady,
      missing,
      headline: fileAsrReady && summaryReady ? t("settings.modelsReady") : t("settings.modelsIncomplete"),
      detail:
        fileAsrReady && summaryReady
          ? t("settings.modelsReadyDetail")
          : t("settings.modelsMissingDetail", { missing: missing.join(locale === "en" ? ", " : "、") }),
    };
  }, [locale, providerHealth, t]);
  const mobileByokCoverage = useMemo(
    () => getMobileByokCoverage(providerCredentials, providerHealth),
    [providerCredentials, providerHealth],
  );
  // This coarse authenticated signal never exposes provider configuration.
  // A missing or stale response is unknown and must never be presented as ready.
  const officialProcessingStatus = accountUsage?.officialProcessing?.status ?? "unknown";
  const selectedProcessingMode = currentUser?.processingMode ?? accountUsage?.costControl.selectedMode ?? "official_quota";
  const firstRunGuide = useMemo(() => {
    if (!currentUser || !accountUsage) return null;
    return getFirstRunGuide({
      hasCompletedMeeting: accountUsage.events.some((event) => event.type === "meeting_finalize"),
      hasProviderConfig: providerCredentials.length > 0,
      hasReadyProvider: mobileByokCoverage.complete,
      officialProcessingStatus,
      officialMinutesRemaining: accountUsage.officialMinutesRemaining,
      processingMode: selectedProcessingMode,
    }, locale);
  }, [accountUsage, currentUser, locale, mobileByokCoverage.complete, officialProcessingStatus, providerCredentials.length, selectedProcessingMode]);
  const meetingCostPreview = useMemo(
    () => accountUsage
      ? getMeetingCostPreview({
          credentials: providerCredentials,
          health: providerHealth,
          officialMinutesRemaining: accountUsage.officialMinutesRemaining,
          officialProcessingStatus,
          processingMode: selectedProcessingMode,
        }, locale)
      : null,
    [accountUsage, locale, officialProcessingStatus, providerCredentials, providerHealth, selectedProcessingMode],
  );
  const activeMeetingBilling = useMemo(() => formatMeetingBilling(activeMeetingResult ?? {}, locale), [activeMeetingResult, locale]);
  const selectedMeetingBilling = useMemo(() => formatMeetingBilling(selectedMeeting?.result ?? {}, locale), [locale, selectedMeeting]);
  const stabilityChecks = useMemo(
    () => [
      {
        label: "后端 API",
        state: backendHealth?.ok ? "ready" : "warning",
        detail: backendHealth?.ok
          ? `已连接 ${backendHealth.service || "OwnMinutes"}。`
          : "真机录音前请先检查后端连接，避免结束会议后无法上传。",
      },
      {
        label: "账号会话",
        state: currentUser && sessionCookie ? "ready" : "blocked",
        detail: currentUser ? "已登录，录音会绑定到当前账号。" : "请先登录，避免音频无法上传和归档。",
      },
      {
        label: "网络状态",
        state: networkStatus === "online" ? "ready" : "warning",
        detail: t(
          networkStatus === "online"
            ? "runtime.networkOnline"
            : networkStatus === "offline"
              ? "runtime.networkOffline"
              : "runtime.networkChecking",
        ),
      },
      {
        label: "麦克风权限",
        state: microphonePermission === "granted" ? "ready" : microphonePermission === "denied" ? "blocked" : "warning",
        detail:
          microphonePermission === "granted"
            ? "麦克风已授权。"
            : microphonePermission === "denied"
              ? "系统拒绝麦克风权限，请到 iOS 设置中开启。"
              : "开始录音时会请求麦克风权限。",
      },
      {
        label: "屏幕常亮",
        state: keepAwakeActive ? "ready" : status === "recording" || status === "paused" ? "warning" : "idle",
        detail: keepAwakeActive ? "录音中已启用 Keep Awake。" : "录音开始后会启用，降低长会议中断风险。",
      },
      {
        label: "后台录音",
        state: backgroundInterruptions > 0 ? "warning" : status === "recording" || status === "paused" ? "ready" : "idle",
        detail:
          backgroundInterruptions > 0
            ? `录音期间经过 ${backgroundInterruptions} 次前后台切换，最后一次 ${lastBackgroundAt ? formatShortDate(lastBackgroundAt, locale) : "未知"}。iOS 已启用后台录音，结束后仍建议回放确认。`
            : `当前 App ${appStateLabel}，iOS 已启用锁屏与后台录音能力。`,
      },
      {
        label: "PCM 输入流",
        state: pcmBuffers > 0 ? "ready" : status === "recording" || status === "paused" ? "warning" : "idle",
        detail: pcmBuffers > 0 ? `已收到 ${pcmBuffers} 个 PCM buffer，缓存 ${formatBytes(pcmBytes)}。` : "开始录音后用于实时 ASR 接入前检查输入流。",
      },
      {
        label: "实时分片缓存",
        state: realtimeChunks > 0 ? "ready" : status === "recording" || status === "paused" ? "warning" : "idle",
        detail:
          realtimeChunks > 0
            ? `已按 ${Math.round(realtimeChunkTargetMs / 1000)} 秒阈值切出 ${realtimeChunks} 个 PCM 分片，内存保留 ${realtimeRetainedChunks} 个。`
            : `开始录音后每约 ${Math.round(realtimeChunkTargetMs / 1000)} 秒切出一个实时 ASR 候选分片。`,
      },
      {
        label: "实时分片上传",
        state: realtimeFailedUploads > 0 || realtimeRejectedChunks > 0 ? "warning" : realtimeUploadedChunks > 0 ? "ready" : status === "recording" || status === "paused" ? "warning" : "idle",
        detail:
          realtimeUploadedChunks > 0 || realtimePendingUploads > 0 || realtimeFailedUploads > 0 || realtimeRejectedChunks > 0
            ? `已推送 ${realtimeUploadedChunks} 个，等待 ${realtimePendingUploads} 个，格式拒绝 ${realtimeRejectedChunks} 个，失败 ${realtimeFailedUploads} 个。`
            : "实时 PCM 分片会推送到独立草稿接口，不写入正式会后音频。",
      },
      {
        label: "录音文件写入",
        state: recordingFileHealthWarning ? "blocked" : recordingFileHealth.status === "healthy" ? "ready" : recordingActive ? "warning" : "idle",
        detail: recordingFileHealthMessage,
      },
      {
        label: "设备存储空间",
        state:
          recordingStorageHealth.status === "critical" || recordingStorageHealth.status === "blocked"
            ? "blocked"
            : recordingStorageWarning
              ? "warning"
              : recordingStorageHealth.status === "ready"
                ? "ready"
                : "idle",
        detail: recordingStorageMessage,
      },
      {
        label: "单场会话时长",
        state: !recordingActive
          ? "idle"
          : recordingDurationLimit.shouldStop
            ? "blocked"
            : recordingDurationLimit.shouldWarn
              ? "warning"
              : "ready",
        detail: recordingDurationMessage,
      },
      {
        label: "本地音频",
        state: recordedUri || pendingRecording ? "ready" : status === "processing" ? "warning" : "idle",
        detail:
          recordedUri || pendingRecording
            ? pendingRecording
              ? pendingRecording.finalizedAt
                ? `已完成会议的本地音频继续保留：${pendingRecording.meetingId}。`
                : pendingRecording.audioUploadedAt
                ? `音频已上传，正式纪要待恢复：${pendingRecording.meetingId}。`
                : `已持久化待上传录音：${pendingRecording.meetingId}。`
              : "已拿到本地录音文件，可重试上传或导出。"
            : "结束会议后必须先拿到本地音频 URI。",
      },
      {
        label: "待处理录音",
        state: userPendingRecordings.length > 0 ? "warning" : "ready",
        detail:
          userPendingRecordings.length > 0
            ? `设备文档目录中有 ${userPendingRecordings.length} 场录音等待上传或生成纪要，不会被新会议覆盖。`
            : "没有等待恢复的本地录音。",
      },
      {
        label: "上传队列",
        state: uploadState.failed > 0 ? "blocked" : uploadState.pending > 0 ? "warning" : uploadState.uploaded > 0 ? "ready" : "idle",
        detail:
          uploadState.failed > 0
            ? `有 ${uploadState.failed} 次上传失败，可用本地音频重试。`
            : uploadState.pending > 0
              ? `${uploadState.pending} 个上传任务处理中。`
              : uploadState.uploaded > 0
                ? "服务端已接收音频。"
                : "录音结束后会上传完整音频。",
      },
    ] as Array<{
      label: string;
      state: "ready" | "warning" | "blocked" | "idle";
      detail: string;
    }>,
    [appStateLabel, backgroundInterruptions, backendHealth, currentUser, keepAwakeActive, lastBackgroundAt, locale, microphonePermission, networkStatus, pcmBuffers, pcmBytes, pendingRecording, realtimeChunks, realtimeFailedUploads, realtimePendingUploads, realtimeRejectedChunks, realtimeRetainedChunks, realtimeUploadedChunks, recordedUri, recordingActive, recordingDurationLimit.shouldStop, recordingDurationLimit.shouldWarn, recordingDurationMessage, recordingFileHealth.status, recordingFileHealthMessage, recordingFileHealthWarning, recordingStorageHealth.status, recordingStorageMessage, recordingStorageWarning, sessionCookie, status, t, uploadState.failed, uploadState.pending, uploadState.uploaded, userPendingRecordings.length],
  );
  const officialMarkdown = selectedMeeting
    ? selectedMeeting.obsidianMarkdown ?? selectedMeeting.result?.obsidianMarkdown ?? null
    : formalMarkdown ?? activeMeetingResult?.obsidianMarkdown ?? null;
  const canExportMarkdown = Boolean(officialMarkdown || activeMeetingResult || selectedMeeting?.result);
  const filteredMeetings = useMemo(
    () => filterMeetingHistory(meetings, { filter: historyFilter, query: historyQuery }),
    [historyFilter, historyQuery, meetings],
  );
  const showHistoryControls =
    meetings.length >= 8 || historyQuery.trim().length > 0 || historyFilter !== "all";
  const visibleMeetings = filteredMeetings.slice(0, historyVisibleCount);
  const selectedMeetingSpeakers = useMemo(() => getMeetingSpeakers(selectedMeeting?.result), [selectedMeeting?.result]);
  const selectedMeetingTranscript = selectedMeeting?.result?.transcript ?? [];
  const visibleSelectedMeetingTranscript = selectedMeetingTranscript.slice(0, transcriptVisibleCount);
  const transcriptSpeakerChangeCount = selectedMeetingTranscript.filter((segment) => {
    const draft = normalizeSpeakerNameDraft(transcriptSpeakerDrafts[segment.id] ?? segment.speaker);
    return draft && draft !== segment.speaker;
  }).length;
  const selectedMeetingQuality = useMemo(() => assessMobileMeetingQuality(selectedMeeting?.result ?? null), [selectedMeeting?.result]);
  const selectedMeetingQualityLabel = selectedMeetingQuality.status === "verified"
    ? t("meetingDetail.verifiedQuality")
    : t("meetingDetail.unverifiedQuality");
  const selectedMeetingQualityDetail = selectedMeetingQuality.status === "verified"
    ? ""
    : t("meetingDetail.unverifiedQualityDetail");

  useEffect(() => {
    setMobileApiLanguage(locale);
  }, [locale]);

  useEffect(() => {
    const timer = setTimeout(() => setAuthMessage(null), 0);
    return () => clearTimeout(timer);
  }, [locale]);

  useEffect(() => {
    if (meetingTitle !== defaultMeetingTitleRef.current) return;
    const localizedTitle = createDefaultMeetingTitle(locale);
    defaultMeetingTitleRef.current = localizedTitle;
    setMeetingTitle(localizedTitle);
  }, [locale, meetingTitle]);

  useEffect(() => {
    refreshNetworkState();
    const subscription = Network.addNetworkStateListener((event) => {
      const nextStatus = networkStateIsOnline(event) ? "online" : "offline";
      setNetworkStatus(nextStatus);
      if (nextStatus !== "online") markOfficialProcessingUnknown();
    });

    return () => subscription.remove();
  }, [markOfficialProcessingUnknown]);

  useEffect(() => {
    if (!activeRecordingUri || (status !== "recording" && status !== "paused")) return;
    let cancelled = false;

    const inspect = async () => {
      try {
        const info = await FileSystem.getInfoAsync(activeRecordingUri);
        if (cancelled) return;
        const current = recordingFileHealthRef.current;
        const next = assessRecordingFileHealth(current, {
          durationMs: recordingDurationRef.current,
          exists: info.exists,
          now: Date.now(),
          recording: status === "recording",
          size: info.exists ? info.size : current.bytes,
        });
        recordingFileHealthRef.current = next;
        setRecordingFileHealth(next);
        if (status === "recording" && (next.status === "stalled" || next.status === "missing")) {
          recordingFileWatchdogFailuresRef.current += 1;
          if (recordingFileWatchdogFailuresRef.current >= 2 && !recordingFileWatchdogStopRef.current) {
            recordingFileWatchdogStopRef.current = true;
            setLastError(t("runtime.recordingSafetyStopped"));
            void stopRecordingRef.current(next.status === "missing" ? "file-missing" : "file-stalled");
          }
        } else {
          recordingFileWatchdogFailuresRef.current = 0;
        }
      } catch {
        if (!cancelled) {
          const next: RecordingFileHealth = {
            ...recordingFileHealthRef.current,
            lastCheckedAt: Date.now(),
            status: "missing",
          };
          recordingFileHealthRef.current = next;
          setRecordingFileHealth(next);
          if (status === "recording") {
            recordingFileWatchdogFailuresRef.current += 1;
            if (recordingFileWatchdogFailuresRef.current >= 2 && !recordingFileWatchdogStopRef.current) {
              recordingFileWatchdogStopRef.current = true;
              setLastError(t("runtime.recordingSafetyStopped"));
              void stopRecordingRef.current("file-missing");
            }
          }
        }
      }
    };

    void inspect();
    const interval = setInterval(() => void inspect(), recordingFileWatchIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeRecordingUri, status, t]);

  useEffect(() => {
    if (status !== "recording" && status !== "paused") return;
    let cancelled = false;

    const inspect = async () => {
      const health = await readRecordingStorageHealth("recording");
      if (cancelled) return;
      setRecordingStorageHealth(health);
      if (health.shouldStop && !recordingStorageEmergencyStopRef.current) {
        recordingStorageEmergencyStopRef.current = true;
        setLastError(t("runtime.recordingStorageStopped"));
        void stopRecordingRef.current("low-storage");
      }
    };

    void inspect();
    const interval = setInterval(() => void inspect(), recordingStorageWatchIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, t]);

  useEffect(() => {
    if (status !== "recording" && status !== "paused") return;
    const recordedDurationMs = Math.max(recordingDurationRef.current, liveRecordingDurationMs);
    recordingDurationRef.current = recordedDurationMs;
    setRecordingSessionElapsedMs(recordedDurationMs);
  }, [liveRecordingDurationMs, status]);

  useEffect(() => {
    if (status !== "recording" && status !== "paused") return;
    const limit = assessRecordingDurationLimit(recordingSessionElapsedMs);
    if (!limit.shouldStop || recordingDurationLimitStopRef.current) return;

    recordingDurationLimitStopRef.current = true;
    setLastError(t("recordingFlow.durationLimit"));
    void stopRecordingRef.current("duration-limit");
  }, [recordingSessionElapsedMs, status, t]);

  useEffect(() => {
    if (status !== "recording" || audioStream.isStreaming) return;
    let cancelled = false;

    const restart = async () => {
      if (
        cancelled ||
        recordingStatusRef.current !== "recording" ||
        appStateRef.current !== "active" ||
        audioStream.stream.isStreaming ||
        realtimeStreamRestartInFlightRef.current
      ) return;
      realtimeStreamRestartInFlightRef.current = true;
      try {
        await audioStream.stream.start();
        if (
          realtimeFailedUploads === 0 &&
          realtimeRejectedChunks === 0 &&
          realtimeDroppedChunks === 0
        ) setRealtimeUploadDiagnostic(null);
      } catch {
        if (!cancelled) setRealtimeUploadDiagnostic(t("recordingFlow.realtimeStartFailed"));
      } finally {
        realtimeStreamRestartInFlightRef.current = false;
      }
    };

    const firstAttempt = setTimeout(() => void restart(), 2_000);
    const interval = setInterval(() => void restart(), 10_000);
    return () => {
      cancelled = true;
      clearTimeout(firstAttempt);
      clearInterval(interval);
    };
  }, [
    audioStream.isStreaming,
    audioStream.stream,
    realtimeDroppedChunks,
    realtimeFailedUploads,
    realtimeRejectedChunks,
    status,
    t,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      setAppStateLabel(appStateStatusLabel(nextState));
      if (foregroundRecordingCheckTimerRef.current) {
        clearTimeout(foregroundRecordingCheckTimerRef.current);
        foregroundRecordingCheckTimerRef.current = null;
      }

      if ((status === "recording" || status === "paused") && previousState === "active" && nextState !== "active") {
        setBackgroundInterruptions((value) => value + 1);
        setLastBackgroundAt(new Date().toISOString());
      }

      if (status === "recording" && nextState === "active") {
        const generation = recordingGenerationRef.current;
        foregroundRecordingCheckTimerRef.current = setTimeout(() => {
          foregroundRecordingCheckTimerRef.current = null;
          if (
            generation !== recordingGenerationRef.current ||
            recordingStatusRef.current !== "recording" ||
            recordingStopInFlightRef.current ||
            recordingTransitionInFlightRef.current ||
            appStateRef.current !== "active"
          ) return;
          const nativeStatus = recorder.getStatus();
          const recordingAge = Date.now() - recordingStartedAtRef.current;
          if (!nativeStatus.isRecording && recordingAge > 1500 && !nativeStatus.mediaServicesDidReset) {
            try {
              audioStream.stream.stop();
            } catch {
              // The secondary live stream may already have stopped with the interruption.
            }
            flushRealtimePcmBufferRef.current();
            setStatus(nativeStatus.canRecord ? "paused" : "error");
            setLastError(
              nativeStatus.canRecord
                ? t("runtime.recordingSystemPaused")
                : t("runtime.recordingSystemStopped"),
            );
          }
        }, 800);
      }
    });

    return () => {
      subscription.remove();
      if (foregroundRecordingCheckTimerRef.current) {
        clearTimeout(foregroundRecordingCheckTimerRef.current);
        foregroundRecordingCheckTimerRef.current = null;
      }
    };
  }, [audioStream.stream, recorder, status, t]);

  useEffect(() => {
    if (!recorderState.mediaServicesDidReset || mediaServicesResetHandledRef.current) return;
    void handleMediaServicesResetRef.current();
  }, [recorderState.mediaServicesDidReset]);

  const refreshMeetings = useCallback(async (cookie = sessionCookie) => {
    if (!cookie) return;

    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const list = await fetchMeetings(apiBaseUrl, cookie);
      setMeetings(list);
      setHistoryVisibleCount(historyPageSize);
    } catch (error) {
      if (noteAuthenticatedSessionFailure(error)) return;
      setHistoryError(t("runtime.historyRefreshFailed"));
    } finally {
      setHistoryLoading(false);
    }
  }, [apiBaseUrl, noteAuthenticatedSessionFailure, sessionCookie, t]);

  const refreshProviderCredentials = useCallback(async (cookie = sessionCookie) => {
    if (!cookie) return;

    try {
      const credentials = await fetchProviderCredentials(apiBaseUrl, cookie);
      setProviderCredentials(credentials);
    } catch (error) {
      if (noteAuthenticatedSessionFailure(error)) return;
      setProviderMessage(t("providerSetup.providerReadFailed"));
    }
  }, [apiBaseUrl, noteAuthenticatedSessionFailure, sessionCookie, t]);

  const refreshAccountUsage = useCallback(async (cookie = sessionCookie) => {
    if (!cookie) return;

    markOfficialProcessingUnknown();
    try {
      const usage = await fetchAccountUsage(apiBaseUrl, cookie);
      setAccountUsage(usage);
    } catch (error) {
      if (noteAuthenticatedSessionFailure(error)) return;
      markOfficialProcessingUnknown();
      setLastError(t("runtime.usageRefreshFailed"));
    }
  }, [apiBaseUrl, markOfficialProcessingUnknown, noteAuthenticatedSessionFailure, sessionCookie, t]);

  const handleEntitlementUpdated = useCallback(async (user: MobileUser) => {
    setCurrentUser(user);
    try {
      await SecureStore.setItemAsync(
        offlineSessionSnapshotKey,
        serializeOfflineSessionSnapshot({ apiBaseUrl, user }),
      );
    } catch {
      setLastError(t("runtime.planCacheFailed"));
    }
    await refreshAccountUsage();
  }, [apiBaseUrl, refreshAccountUsage, t]);

  const handlePaymentError = useCallback((message: string) => setLastError(message), []);

  const refreshProviderHealth = useCallback(async (cookie = sessionCookie, options: { live?: boolean; providerId?: string } = {}) => {
    if (!cookie) return;

    setProviderHealthLoading(true);
    try {
      const health = await fetchProviderHealth(apiBaseUrl, cookie, options);
      setProviderHealth((current) => (options.live ? mergeProviderHealth(current, health) : health));
      if (options.live) setProviderMessage(t("providerSetup.liveHealthComplete"));
    } catch (error) {
      if (noteAuthenticatedSessionFailure(error)) return;
      setProviderMessage(t("providerSetup.healthCheckFailed"));
    } finally {
      setProviderHealthLoading(false);
    }
  }, [apiBaseUrl, noteAuthenticatedSessionFailure, sessionCookie, t]);

  const restorePendingRecording = useCallback(async () => {
    let snapshot: Awaited<ReturnType<typeof loadPendingRecordings>>;
    try {
      snapshot = await withTimeout(
        loadPendingRecordings(),
        recordingRestoreBudgetMs,
        recordingRestoreTimeoutCode,
      );
    } catch (error) {
      setRecordingRecoveryError(
        error instanceof Error && error.message === recordingRestoreTimeoutCode
          ? t("runtime.localRecoveryTimedOut")
          : t("runtime.localRecoveryFailed"),
      );
      throw error;
    }
    pendingRecordingsRef.current = snapshot.recordings;
    setPendingRecordings(snapshot.recordings);
    const issueMessages = (snapshot.issues ?? []).map((issue: RecordingRecoveryIssue) => {
        switch (issue.kind) {
          case "deletion_journal_completion_pending":
            return t("ux.localDeletionFencePending");
          case "indexed_file_inaccessible":
            return t("ux.localIndexedFilesUnavailable", { count: issue.count });
          case "index_unrecoverable":
            return t("ux.localIndexUnrecoverable", { count: issue.count });
          case "isolated_recording":
            return t("ux.localIsolatedRecordings", { count: issue.count });
          case "local_cleanup_pending":
            return t("ux.localCleanupPending", { count: issue.count });
          case "orphan_directory_inaccessible":
            return t("ux.localRecordingDirectoriesUnavailable", { count: issue.count });
          case "orphan_file_inaccessible":
            return t("ux.localOrphanFilesUnavailable", { count: issue.count });
          case "undersized_recording":
            return t("ux.localUndersizedRecordings", { count: issue.count });
        }
      });
    setRecordingRecoveryError(issueMessages.length > 0 ? issueMessages.join(" ") : null);
    if (snapshot.notice) {
      const notices = [
        snapshot.notice.indexRecovered ? t("ux.localIndexRecovered") : null,
        snapshot.notice.relocatedCount > 0
          ? t("ux.localRecordingReconnected", { count: snapshot.notice.relocatedCount })
          : null,
        snapshot.notice.orphanMatchedCount > 0
          ? t("ux.localRootRecordingRecovered", { count: snapshot.notice.orphanMatchedCount })
          : null,
        snapshot.notice.localCleanupCount > 0
          ? t("ux.localCleanupFinished", { count: snapshot.notice.localCleanupCount })
          : null,
      ].filter((message): message is string => Boolean(message));
      if (notices.length > 0) setAutoSyncMessage(notices.join(" "));
    }
    return snapshot.recordings;
  }, [setAutoSyncMessage, t]);

  const activatePendingRecording = useCallback((recordings: PendingRecording[], userId: string | undefined) => {
    const ownedRecordings = selectAccountLocalRecordings(recordings, userId);
    const parsed =
      ownedRecordings.find((recording) => !recording.finalizedAt && !recording.localRecoveryOnly) ??
      ownedRecordings.find((recording) => !recording.finalizedAt) ??
      ownedRecordings[0];
    if (!parsed) return;

    currentMeetingIdRef.current = parsed.meetingId;
    setMeetingId(parsed.meetingId);
    setMeetingTitle(parsed.title || createDefaultMeetingTitle(locale, new Date(parsed.createdAt)));
    setRecordedUri(parsed.uri);
    setActiveRecordingUri(parsed.uri);
    activeRecordingUriRef.current = parsed.uri;
    activeRecordingProcessingModeRef.current = parsed.processingMode ?? null;
    activeRecordingConsentRef.current = normalizeRecordingConsent(parsed);
    const restoredDurationMs = Math.max(0, parsed.durationMs ?? 0);
    recordingDurationRef.current = restoredDurationMs;
    setCompletedDurationMs(restoredDurationMs);
    setStatus("complete");
    setUploadState((current) => ({
      ...current,
      diagnostic: parsed.finalizedAt
        ? t("runtime.recoveredFinalizedRecording", { meetingId: parsed.meetingId })
        : parsed.audioUploadedAt
        ? t("runtime.recoveredUploadedRecording", { meetingId: parsed.meetingId })
        : parsed.activeRecording
          ? t("runtime.recoveredInterruptedRecording", { meetingId: parsed.meetingId })
          : t("runtime.recoveredPendingRecording", { meetingId: parsed.meetingId }),
    }));
  }, [locale, t]);

  const restoreApiBaseUrl = useCallback(async () => {
    try {
      if (!CUSTOM_API_BASE_URL_EDITING_ENABLED) {
        await SecureStore.deleteItemAsync(apiBaseUrlKey);
        setApiBaseUrl(DEFAULT_API_BASE_URL);
        return;
      }
      const storedUrl = await SecureStore.getItemAsync(apiBaseUrlKey);
      if (storedUrl) {
        setApiBaseUrl(storedUrl.replace(/\/$/, ""));
      }
    } catch {
      setLastError(t("runtime.apiSettingsDefaulted"));
    } finally {
      setApiBaseUrlRestored(true);
    }
  }, [t]);

  const restoreSession = useCallback(async () => {
    let restoredRecordings: PendingRecording[] = [];
    try {
      restoredRecordings = await restorePendingRecording();
    } catch {
      // restorePendingRecording already reports a localized, bounded warning.
    }

    try {
      const rawDeletionReceipt = await SecureStore.getItemAsync(pendingAccountDeletionKey);
      if (rawDeletionReceipt) {
        const receipt = parseAccountDeletionReceipt(rawDeletionReceipt);
        if (!receipt) {
          await Promise.allSettled([
            SecureStore.deleteItemAsync(sessionCookieKey),
            SecureStore.deleteItemAsync(offlineSessionSnapshotKey),
          ]);
          setAuthMessage(t("accountActions.deleteReceiptExpired"));
          setActiveTab("account");
          return;
        }
        const reconciliation = await reconcileAccountDeletionReceipt({
          checkStatus: (ticket) => checkAccountDeletionStatus(apiBaseUrl, ticket),
          receipt,
        });
        if (reconciliation.status === "deleted") {
          let cleanupRecordings = restoredRecordings;
          try {
            const cleanup = await deleteLocalRecordingsForUser(receipt.userId);
            cleanupRecordings = cleanup.recordings;
          } catch {
            // The durable local deletion journal, when available, will retry.
          }
          pendingRecordingsRef.current = cleanupRecordings;
          setPendingRecordings(cleanupRecordings);
          await Promise.allSettled([
            SecureStore.deleteItemAsync(pendingAccountDeletionKey),
            SecureStore.deleteItemAsync(sessionCookieKey),
            SecureStore.deleteItemAsync(offlineSessionSnapshotKey),
          ]);
          setAuthMessage(t("accountActions.deleteReconciled"));
          setActiveTab("account");
          return;
        }
        if (reconciliation.status === "active") {
          await SecureStore.deleteItemAsync(pendingAccountDeletionKey);
        } else {
          await Promise.allSettled([
            SecureStore.deleteItemAsync(sessionCookieKey),
            SecureStore.deleteItemAsync(offlineSessionSnapshotKey),
          ]);
          setAuthMessage(
            reconciliation.status === "expired"
              ? t("accountActions.deleteReceiptExpired")
              : reconciliation.status === "pending_cleanup"
                ? t("accountActions.deleteCleanupPendingBody")
                : t("accountActions.deleteConfirmationOffline"),
          );
          setActiveTab("account");
          return;
        }
      }

      const storedCookie = await SecureStore.getItemAsync(sessionCookieKey);
      if (!storedCookie) return;

      let cachedUser: MobileUser | null = null;
      try {
        const rawSnapshot = await SecureStore.getItemAsync(offlineSessionSnapshotKey);
        cachedUser = parseOfflineSessionSnapshot(rawSnapshot, { apiBaseUrl })?.user ?? null;
      } catch {
        cachedUser = null;
      }

      let me;
      try {
        me = await fetchCurrentUser(apiBaseUrl, storedCookie);
      } catch (error) {
        if (sessionRestoreFailureDisposition(error) === "invalidate") {
          await Promise.allSettled([
            SecureStore.deleteItemAsync(sessionCookieKey),
            SecureStore.deleteItemAsync(offlineSessionSnapshotKey),
          ]);
          return;
        }

        if (cachedUser) {
          syncSessionGenerationRef.current += 1;
          setSessionCookie(storedCookie);
          setCurrentUser(cachedUser);
          setAccountUsage(null);
          setOfflineSessionRestored(true);
          setAutoSyncMessage(t("auth.offlineSessionActive"), "warning");
          activatePendingRecording(restoredRecordings, cachedUser.id);
          setActiveTab("record");
        } else {
          setAuthMessage(t("auth.offlineLoginRequired"));
        }
        return;
      }

      syncSessionGenerationRef.current += 1;
      setSessionCookie(storedCookie);
      setCurrentUser(me.user ?? null);
      setAccountUsage(me.usage ?? null);
      setOfflineSessionRestored(false);
      setAutoSyncMessage(null);
      if (me.user) {
        try {
          await SecureStore.setItemAsync(
            offlineSessionSnapshotKey,
            serializeOfflineSessionSnapshot({ apiBaseUrl, user: me.user }),
          );
        } catch {
          setLastError(t("auth.offlineSnapshotSaveFailed"));
        }
      }
      activatePendingRecording(restoredRecordings, me.user?.id);
      setActiveTab("record");
      await Promise.allSettled([
        refreshMeetings(storedCookie),
        refreshProviderCredentials(storedCookie),
        refreshProviderHealth(storedCookie),
      ]);
    } catch {
      setAuthMessage(t("auth.localSessionReadFailed"));
    } finally {
      setSessionRestoreComplete(true);
    }
  }, [activatePendingRecording, apiBaseUrl, refreshMeetings, refreshProviderCredentials, refreshProviderHealth, restorePendingRecording, setAutoSyncMessage, t]);

  function updateApiBaseUrl(value: string) {
    if (!CUSTOM_API_BASE_URL_EDITING_ENABLED) return;
    const normalized = normalizeApiBaseUrl(value);
    setApiBaseUrl(normalized);
    setBackendHealth(null);
    setReleaseSummary(null);
    setReleaseBlockers([]);
    setProviderDiagnostic(null);
  }

  async function persistApiBaseUrl(value = apiBaseUrl) {
    if (!CUSTOM_API_BASE_URL_EDITING_ENABLED) {
      await SecureStore.deleteItemAsync(apiBaseUrlKey);
      setApiBaseUrl(DEFAULT_API_BASE_URL);
      return;
    }
    const normalized = normalizeApiBaseUrl(value);
    if (normalized) {
      await SecureStore.setItemAsync(apiBaseUrlKey, normalized);
    } else {
      await SecureStore.deleteItemAsync(apiBaseUrlKey);
    }
  }

  async function resetApiBaseUrl() {
    await SecureStore.deleteItemAsync(apiBaseUrlKey);
    setApiBaseUrl(DEFAULT_API_BASE_URL);
    setBackendHealth(null);
    setReleaseSummary(null);
    setReleaseBlockers([]);
    setProviderDiagnostic(null);
  }

  async function persistPendingRecording(recording: Omit<PendingRecording, "updatedAt"> & { updatedAt?: string }) {
    const next = await upsertPendingRecording(recording);
    pendingRecordingsRef.current = next;
    setPendingRecordings(next);
  }

  async function resolveDelayedRecordingUri(input: {
    consent: RecordingConsentMetadata;
    createdAt: string;
    generation: number;
    meetingId: string;
    processingMode: UserProcessingMode;
    title: string;
    userId?: string;
  }) {
    try {
      const uri = await waitForRecorderUri(recorder, {
        attempts: delayedRecordingUriAttempts,
        delayMs: delayedRecordingUriIntervalMs,
        isCancelled: () => recordingGenerationRef.current !== input.generation,
      });
      if (!uri || recordingGenerationRef.current !== input.generation) return;

      setActiveRecordingUri(uri);
      activeRecordingUriRef.current = uri;
      setRecordingFileHealth(createRecordingFileHealth());
      let realtimeSession: Awaited<ReturnType<typeof attachPendingRealtimeSessionUri>> = null;
      try {
        realtimeSession = await attachPendingRealtimeSessionUri(input.meetingId, uri);
      } catch {
        // The normal recording index below remains a durable URI source.
      }
      await persistPendingRecording({
        activeRecording: true,
        ...input.consent,
        createdAt: input.createdAt,
        meetingId: input.meetingId,
        mimeType: audioMimeTypeForUri(uri),
        processingMode: input.processingMode,
        realtimeClosePendingAt: realtimeSession?.realtimeClosePendingAt,
        title: input.title,
        userId: input.userId,
        uri,
      });
      setRealtimeUploadDiagnostic(t("runtime.recordingIndexConfirmed"));
    } catch {
      if (recordingGenerationRef.current === input.generation) {
        setRealtimeUploadDiagnostic(t("runtime.recordingIndexDeferred"));
      }
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void restoreApiBaseUrl();
    }, 0);
    return () => clearTimeout(timer);
  }, [restoreApiBaseUrl]);

  useEffect(() => {
    if (!i18nReady || !apiBaseUrlRestored || sessionRestoreStartedRef.current) return;
    sessionRestoreStartedRef.current = true;
    void restoreSession();
  }, [apiBaseUrlRestored, i18nReady, restoreSession]);

  useEffect(() => {
    if (!emailVerificationVisible || emailVerificationResendSeconds <= 0) return;
    const timer = setTimeout(() => {
      setEmailVerificationResendSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [emailVerificationResendSeconds, emailVerificationVisible]);

  useEffect(() => {
    if (
      !sessionRestoreComplete ||
      !offlineSessionRestored ||
      networkStatus !== "online" ||
      !sessionCookie ||
      offlineSessionRevalidationInFlightRef.current
    ) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    offlineSessionRevalidationInFlightRef.current = true;
    void (async () => {
      try {
        const me = await fetchCurrentUser(apiBaseUrl, sessionCookie);
        if (cancelled || !me.user) return;
        try {
          await SecureStore.setItemAsync(
            offlineSessionSnapshotKey,
            serializeOfflineSessionSnapshot({ apiBaseUrl, user: me.user }),
          );
        } catch {
          // Online authentication remains authoritative even if the optional offline snapshot cannot be refreshed.
        }
        if (cancelled) return;
        setCurrentUser(me.user);
        setAccountUsage(me.usage ?? null);
        setOfflineSessionRestored(false);
        setOfflineSessionRetryTick(0);
        setAutoSyncMessage(t("runtime.sessionReconnected"));
        await Promise.allSettled([
          refreshMeetings(sessionCookie),
          refreshProviderCredentials(sessionCookie),
          refreshProviderHealth(sessionCookie),
        ]);
      } catch (error) {
        if (cancelled) return;
        if (sessionRestoreFailureDisposition(error) !== "invalidate") {
          retryTimer = setTimeout(() => {
            if (!cancelled) setOfflineSessionRetryTick((value) => value + 1);
          }, 30_000);
          return;
        }
        noteAuthenticatedSessionFailure(error);
      } finally {
        offlineSessionRevalidationInFlightRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [apiBaseUrl, networkStatus, noteAuthenticatedSessionFailure, offlineSessionRestored, offlineSessionRetryTick, refreshMeetings, refreshProviderCredentials, refreshProviderHealth, sessionCookie, sessionRestoreComplete, setAutoSyncMessage, t]);

  useEffect(() => {
    if (
      !sessionRestoreComplete ||
      offlineSessionRestored ||
      networkStatus !== "online" ||
      !sessionCookie ||
      !currentUser ||
      sessionReauthenticationRequired
    ) return;

    let cancelled = false;
    const validate = async () => {
      if (activeSessionRevalidationInFlightRef.current) return;
      activeSessionRevalidationInFlightRef.current = true;
      markOfficialProcessingUnknown();
      try {
        const me = await fetchCurrentUser(apiBaseUrl, sessionCookie);
        if (cancelled || !me.user) return;
        setCurrentUser(me.user);
        setAccountUsage(me.usage ?? null);
        try {
          await SecureStore.setItemAsync(
            offlineSessionSnapshotKey,
            serializeOfflineSessionSnapshot({ apiBaseUrl, user: me.user }),
          );
        } catch {
          // The verified online session stays usable if the optional cache refresh fails.
        }
      } catch (error) {
        if (!cancelled) {
          markOfficialProcessingUnknown();
          noteAuthenticatedSessionFailure(error);
        }
      } finally {
        activeSessionRevalidationInFlightRef.current = false;
      }
    };
    const timer = setInterval(() => void validate(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiBaseUrl, currentUser, markOfficialProcessingUnknown, networkStatus, noteAuthenticatedSessionFailure, offlineSessionRestored, sessionCookie, sessionReauthenticationRequired, sessionRestoreComplete]);

  useEffect(() => {
    pendingRecordingsRef.current = pendingRecordings;
  }, [pendingRecordings]);

  useEffect(() => {
    autoSyncRequestRef.current = () => {
      const deferredOptions = deferredSyncOptionsRef.current;
      deferredSyncOptionsRef.current = null;
      void syncPendingRecordings(deferredOptions ?? {});
    };
  });

  useEffect(() => {
    if (!shouldDrainDeferredSync({
      hasDeferredOptions: Boolean(deferredSyncOptionsRef.current),
      recordingLifecycleBusy,
      syncInFlight: autoSyncInFlightRef.current,
      uploadInFlight: uploadInFlightRef.current,
    })) return;

    const timer = setTimeout(() => autoSyncRequestRef.current(), 0);
    return () => clearTimeout(timer);
  }, [recordingLifecycleBusy]);

  useEffect(
    () => () => {
      if (autoSyncWakeTimerRef.current) clearTimeout(autoSyncWakeTimerRef.current);
      autoSyncWakeTimerRef.current = null;
      deferredSyncOptionsRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const syncBlocked = status === "recording" || status === "paused" || status === "requesting" || status === "processing";
    const ownedRecordings = currentUser
      ? selectAccountLocalRecordings(pendingRecordings, currentUser.id).filter(
          (recording) =>
            !recording.finalizedAt &&
            Boolean(recording.processingMode) &&
            recording.activeRecording !== true,
        )
      : [];
    if (networkStatus !== "online" || !sessionCookie || !currentUser || syncBlocked || ownedRecordings.length === 0) return;

    const nextRetryAt = ownedRecordings.reduce((earliest, recording) => {
      const retryAt = Date.parse(recording.nextRetryAt ?? "");
      if (!Number.isFinite(retryAt)) return Math.min(earliest, Date.now());
      return Math.min(earliest, retryAt);
    }, Number.POSITIVE_INFINITY);
    const delay = Math.min(15 * 60 * 1000, Math.max(250, nextRetryAt - Date.now()));
    const timer = setTimeout(() => autoSyncRequestRef.current(), delay);
    return () => clearTimeout(timer);
  }, [currentUser, networkStatus, pendingRecordings, sessionCookie, status]);

  async function refreshNetworkState() {
    const state = await Network.getNetworkStateAsync();
    setNetworkStatus(networkStateIsOnline(state) ? "online" : "offline");
  }

  function accumulateRealtimePcmBuffer(buffer: { data: ArrayBuffer; sampleRate: number; channels: number }) {
    if (buffer.data.byteLength <= 0) return;

    realtimePendingBuffersRef.current.push(new Uint8Array(buffer.data.slice(0)));
    realtimeChunkBufferBytesRef.current += buffer.data.byteLength;
    setRealtimePendingBytes(realtimeChunkBufferBytesRef.current);

    while (realtimeChunkBufferBytesRef.current >= realtimeChunkTargetBytes) {
      const chunkBytes = takeRealtimePendingBytes(realtimeChunkTargetBytes);
      appendRealtimePcmChunk(chunkBytes, buffer.sampleRate, buffer.channels, realtimeChunkTargetMs);
    }
  }

  function flushRealtimePcmBuffer() {
    const pendingBytes = realtimeChunkBufferBytesRef.current;
    if (pendingBytes <= 0) return;

    const chunkBytes = takeRealtimePendingBytes(pendingBytes);
    appendRealtimePcmChunk(chunkBytes, 16000, 1, Math.max(1, Math.round((pendingBytes / realtimePcmBytesPerSecond) * 1000)));
  }
  flushRealtimePcmBufferRef.current = flushRealtimePcmBuffer;

  function resetRealtimePcmBuffer(
    nextMeetingId: string | null = null,
    processingMode: UserProcessingMode | null = null,
  ) {
    realtimeUploadQueueRef.current.cancelPending();
    activeRealtimeMeetingIdRef.current = nextMeetingId;
    activeRecordingProcessingModeRef.current = processingMode;
    realtimeFailureStreakRef.current = 0;
    realtimeRetryNotBeforeRef.current = 0;
    realtimeChunkBufferBytesRef.current = 0;
    realtimePendingBuffersRef.current = [];
    realtimeChunkSequenceRef.current = 0;
    pcmBuffersRef.current = 0;
    pcmBytesRef.current = 0;
    pcmUiUpdatedAtRef.current = 0;
    setRealtimeChunks(0);
    setRealtimeChunkBytes(0);
    setRealtimePendingBytes(0);
    setRealtimeRetainedChunks(0);
    setRealtimeDroppedChunks(0);
    setRealtimeUploadedChunks(0);
    setRealtimeRejectedChunks(0);
    setRealtimeMaxByteDrift(0);
    setRealtimePendingUploads(0);
    setRealtimeFailedUploads(0);
    setRealtimeUploadDiagnostic(null);
    setLastRealtimeChunkAt(null);
  }

  function takeRealtimePendingBytes(byteLength: number) {
    const output = new Uint8Array(byteLength);
    let offset = 0;

    while (offset < byteLength && realtimePendingBuffersRef.current.length > 0) {
      const next = realtimePendingBuffersRef.current[0];
      const remaining = byteLength - offset;
      const take = Math.min(remaining, next.byteLength);
      output.set(next.subarray(0, take), offset);
      offset += take;

      if (take === next.byteLength) {
        realtimePendingBuffersRef.current.shift();
      } else {
        realtimePendingBuffersRef.current[0] = next.subarray(take);
      }
    }

    realtimeChunkBufferBytesRef.current = Math.max(0, realtimeChunkBufferBytesRef.current - offset);
    setRealtimePendingBytes(realtimeChunkBufferBytesRef.current);
    return output.buffer;
  }

  function appendRealtimePcmChunk(bytes: ArrayBuffer, sampleRate: number, channels: number, durationMs: number) {
    if (bytes.byteLength <= 0) return;

    const createdAt = new Date().toISOString();
    setRealtimeChunks((value) => value + 1);
    setRealtimeChunkBytes((value) => value + bytes.byteLength);
    setLastRealtimeChunkAt(createdAt);
    const targetMeetingId = activeRealtimeMeetingIdRef.current;
    const processingMode = activeRecordingProcessingModeRef.current;
    const authCookie = sessionCookie;
    const targetApiBaseUrl = apiBaseUrl;
    if (!targetMeetingId || !authCookie || !processingMode) return;

    const queue = realtimeUploadQueueRef.current;
    const sequence = nextRealtimeUploadSequence(
      realtimeChunkSequenceRef.current,
      queue.pendingCount(),
      realtimeChunkQueueLimit,
    );
    if (sequence === null) {
      setRealtimeDroppedChunks((value) => value + 1);
      setRealtimeUploadDiagnostic(t("runtime.realtimeQueueCongested"));
      return;
    }
    const chunk: RealtimePcmChunk = {
      bytes,
      byteLength: bytes.byteLength,
      channels,
      createdAt,
      durationMs,
      sampleRate,
      sequence,
    };
    realtimeChunkSequenceRef.current = sequence;
    const generation = queue.currentGeneration();
    setRealtimePendingUploads((value) => value + 1);
    const upload = queue.enqueue(async () => {
      try {
        await pushRealtimePcmChunk(chunk, {
          apiBaseUrl: targetApiBaseUrl,
          authCookie,
          generation,
          meetingId: targetMeetingId,
          processingMode,
        });
      } catch (error) {
        if (!queue.isCurrentGeneration(generation)) throw new RealtimeUploadQueueCancelledError();
        throw error;
      }
    });
    setRealtimeRetainedChunks(queue.pendingCount());
    void upload.then(
      () => {
        realtimeFailureStreakRef.current = 0;
        realtimeRetryNotBeforeRef.current = 0;
        setRealtimePendingUploads((value) => Math.max(0, value - 1));
        setRealtimeRetainedChunks(queue.pendingCount());
      },
      (error) => {
        setRealtimePendingUploads((value) => Math.max(0, value - 1));
        setRealtimeRetainedChunks(queue.pendingCount());
        if (isRealtimeUploadQueueCancelledError(error)) return;
        const authenticationRejected = noteAuthenticatedSessionFailure(error);
        queue.cancelPending();
        realtimePendingBuffersRef.current = [];
        realtimeChunkBufferBytesRef.current = 0;
        setRealtimePendingBytes(0);
        if (authenticationRejected) {
          if (activeRealtimeMeetingIdRef.current === targetMeetingId) activeRealtimeMeetingIdRef.current = null;
        } else {
          const failureStreak = realtimeFailureStreakRef.current + 1;
          realtimeFailureStreakRef.current = failureStreak;
          realtimeRetryNotBeforeRef.current = Date.now() + realtimeFailureCooldownMs(failureStreak);
          realtimeChunkSequenceRef.current = realtimeSequenceAfterFailure(
            realtimeChunkSequenceRef.current,
            chunk.sequence,
          );
        }
        setRealtimeRetainedChunks(0);
        setRealtimeFailedUploads((value) => value + 1);
        setRealtimeUploadDiagnostic(
          authenticationRejected ? t("runtime.realtimeAuthExpired") : t("runtime.realtimeUploadFailed"),
        );
      },
    );
  }

  async function pushRealtimePcmChunk(
    chunk: RealtimePcmChunk,
    context: {
      apiBaseUrl: string;
      authCookie: string;
      generation: number;
      meetingId: string;
      processingMode: UserProcessingMode;
    },
  ) {
    const queue = realtimeUploadQueueRef.current;
    const result = await retryRealtimeUpload(
      () => uploadRealtimePcmChunk({
        apiBaseUrl: context.apiBaseUrl,
        authCookie: context.authCookie,
        meetingId: context.meetingId,
        sequence: chunk.sequence,
        bytes: chunk.bytes,
        durationMs: chunk.durationMs,
        sampleRate: chunk.sampleRate,
        channels: chunk.channels,
        processingMode: context.processingMode,
      }),
      isRetryableRealtimeChunkUploadError,
      // The live draft is disposable and must not monopolize the serial queue
      // for a full minute. A later chunk retries after the bounded cooldown;
      // the durable recording continues independently.
      { attempts: 1 },
    );
    if (!queue.isCurrentGeneration(context.generation)) throw new RealtimeUploadQueueCancelledError();
    const ack = result.value;

    if (ack.code === "official_quota_insufficient") {
      if (activeRealtimeMeetingIdRef.current === context.meetingId) {
        activeRealtimeMeetingIdRef.current = null;
      }
      queue.cancelPending();
      realtimePendingBuffersRef.current = [];
      realtimeChunkBufferBytesRef.current = 0;
      setRealtimePendingBytes(0);
      setRealtimeRetainedChunks(0);
      setRealtimeFailedUploads((value) => value + 1);
      setRealtimeUploadDiagnostic(t("runtime.realtimeQuotaExhausted"));
      return;
    }

    if (ack.providerStatus === "rejected_format" || ack.realtime?.formatOk === false) {
      setRealtimeRejectedChunks((value) => value + 1);
      setRealtimeMaxByteDrift((value) => Math.max(value, Math.abs(ack.realtime?.byteDrift ?? 0)));
      setRealtimeUploadDiagnostic(t("runtime.realtimeFormatRejected"));
      return;
    }

    if (ack.providerStatus === "provider_error") {
      setRealtimeFailedUploads((value) => value + 1);
      setRealtimeUploadDiagnostic(t("runtime.realtimeUnavailable"));
      return;
    }

    setRealtimeUploadedChunks((value) => value + 1);
    setRealtimeUploadDiagnostic(
      result.attempts > 1 ? t("runtime.realtimeRecovered", { count: result.attempts }) : null,
    );
    if (ack.transcriptSegment) {
      setSegments((current) => {
        const segment = ack.transcriptSegment!;
        const existingIndex = current.findIndex((item) => item.id === segment.id);
        if (existingIndex < 0) return [...current, segment];
        const next = [...current];
        next[existingIndex] = segment;
        return next;
      });
    }
  }

  async function settleRealtimePcmSession(
    targetMeetingId: string,
    generation: number,
    processingMode: UserProcessingMode,
  ) {
    const queue = realtimeUploadQueueRef.current;
    if (!queue.isCurrentGeneration(generation)) return;
    const drained = await queue.drain(20_000);
    if (!queue.isCurrentGeneration(generation)) return;
    if (!drained) {
      queue.cancelPending();
      throw new Error("实时分片队列未能在 20 秒内排空");
    }
    if (!sessionCookie) return;
    const result = await finishRealtimePcmSession({
      apiBaseUrl,
      authCookie: sessionCookie,
      meetingId: targetMeetingId,
      processingMode,
    });
    if (!queue.isCurrentGeneration(generation)) return;
    if (activeRealtimeMeetingIdRef.current === targetMeetingId) {
      activeRealtimeMeetingIdRef.current = null;
    }
    const pendingRecording = pendingRecordingsRef.current.find(
      (recording) => recording.meetingId === targetMeetingId,
    );
    if (pendingRecording?.realtimeClosePendingAt) {
      await persistPendingRecording({
        ...pendingRecording,
        realtimeClosePendingAt: undefined,
      });
    }
    await completePendingRealtimeSession(targetMeetingId);
    if (activeRealtimeJournalMeetingIdRef.current === targetMeetingId) {
      activeRealtimeJournalMeetingIdRef.current = null;
    }
    setRealtimeUploadDiagnostic(result.diagnostic ? t("runtime.realtimeComplete") : null);
    if (result.transcriptSegment) {
      setSegments((current) => {
        const existingIndex = current.findIndex((item) => item.id === result.transcriptSegment?.id);
        if (existingIndex < 0) return [...current, result.transcriptSegment!];
        const next = [...current];
        next[existingIndex] = result.transcriptSegment!;
        return next;
      });
    }
  }

  async function submitAuth() {
    const normalizedEmail = authEmail.trim().toLowerCase();
    const password = authPassword;
    const name = authName.trim();

    if (!normalizedEmail.includes("@") || password.length < 8 || (authMode === "register" && name.length < 2)) {
      setAuthMessage(authMode === "register" ? t("auth.invalidRegistration") : t("auth.invalidLogin"));
      return;
    }
    if (authMode === "register" && !authAcceptedTerms) {
      setAuthMessage(t("auth.termsRequired"));
      return;
    }

    setAuthLoading(true);
    setAuthMessage(null);

    try {
      const result =
        authMode === "register"
          ? await registerAccount({ apiBaseUrl, name, email: normalizedEmail, password })
          : await loginAccount({ apiBaseUrl, email: normalizedEmail, password });

      if (result.payload.verificationRequired) {
        const verificationState = initialEmailVerificationState(result.payload, {
          defaultResendSeconds: emailVerificationResendDurationSeconds,
        });
        setEmailVerificationToken(result.payload.verificationToken || "");
        setEmailVerificationCode("");
        setEmailVerificationMessage(verificationState.deliveryFailed ? verificationCopy.deliveryFailed : null);
        setEmailVerificationResendSeconds(verificationState.resendSeconds);
        emailVerificationSubmitLockRef.current = false;
        setEmailVerificationVisible(true);
        setAuthPassword("");
        return;
      }
      if (!result.sessionCookie || !result.payload.user) throw new Error(t("auth.sessionMissing"));
      const registered = authMode === "register";
      await activateAuthenticatedSession(result.sessionCookie, result.payload);
      setAuthMessage(registered ? t("auth.registrationSuccess") : t("auth.loginSuccess"));
      if (registered) Alert.alert(t("auth.registrationAlertTitle"), t("auth.registrationAlertBody"));
    } catch (error) {
      if (readAuthError(error).code === "email_verification_required") {
        setEmailVerificationCode("");
        setEmailVerificationToken("");
        setEmailVerificationMessage(verificationCopy.verificationRequired);
        setEmailVerificationResendSeconds(0);
        emailVerificationSubmitLockRef.current = false;
        setEmailVerificationVisible(true);
        void sendEmailVerificationCode(normalizedEmail, false);
        return;
      }
      setAuthMessage(localizedAuthFailure(locale, error, authMode));
    } finally {
      setAuthLoading(false);
    }
  }

  async function activateAuthenticatedSession(nextSessionCookie: string, payload: AuthResponse) {
    authNameInputRef.current?.blur();
    authEmailInputRef.current?.blur();
    authPasswordInputRef.current?.blur();
    Keyboard.dismiss();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await SecureStore.setItemAsync(sessionCookieKey, nextSessionCookie);
    if (payload.user) {
      try {
        await SecureStore.setItemAsync(
          offlineSessionSnapshotKey,
          serializeOfflineSessionSnapshot({ apiBaseUrl, user: payload.user }),
        );
      } catch {
        // The normal online session is still usable without an offline snapshot.
      }
    }
    syncSessionGenerationRef.current += 1;
    setSessionCookie(nextSessionCookie);
    setCurrentUser(payload.user ?? null);
    setAccountUsage(payload.usage ?? null);
    sessionReauthenticationRequiredRef.current = false;
    setSessionReauthenticationRequired(false);
    setOfflineSessionRestored(false);
    setLastError(null);
    activatePendingRecording(pendingRecordings, payload.user?.id);
    setAuthPassword("");
    setAuthPasswordVisible(false);
    setAuthAcceptedTerms(false);
    setActiveTab("record");
    requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: false }));
    await refreshMeetings(nextSessionCookie);
    await refreshProviderCredentials(nextSessionCookie);
    await refreshProviderHealth(nextSessionCookie);
    await refreshAccountUsage(nextSessionCookie);
  }

  async function sendEmailVerificationCode(email: string, announceSuccess = true) {
    if (!email.includes("@")) {
      setEmailVerificationMessage(t("verification.emailRequired"));
      return;
    }
    setEmailVerificationResending(true);
    try {
      await requestAccountEmailVerificationCode(apiBaseUrl, email);
      setEmailVerificationResendSeconds(emailVerificationResendDurationSeconds);
      if (announceSuccess) setEmailVerificationMessage(verificationCopy.sentAgain);
    } catch (error) {
      const details = readAuthError(error);
      setEmailVerificationMessage(
        details.status === 404
          ? verificationCopy.legacyLinkRequired
          : details.status === 429 || details.code === "email_verification_code_rate_limited"
          ? verificationCopy.tooManyAttempts
          : verificationCopy.resendFailed,
      );
      if (details.retryAfterSeconds) {
        setEmailVerificationResendSeconds(Math.max(1, details.retryAfterSeconds));
      }
    } finally {
      setEmailVerificationResending(false);
    }
  }

  async function resendEmailVerificationCode() {
    if (emailVerificationResendSeconds > 0 || emailVerificationResending || emailVerificationSubmitting) return;
    await sendEmailVerificationCode(authEmail.trim().toLowerCase());
  }

  function changeEmailForVerification() {
    if (emailVerificationSubmitting) return;
    emailVerificationSubmitLockRef.current = false;
    setEmailVerificationVisible(false);
    setEmailVerificationCode("");
    setEmailVerificationToken("");
    setEmailVerificationMessage(null);
    setEmailVerificationResendSeconds(0);
    requestAnimationFrame(() => authEmailInputRef.current?.focus());
  }

  function updateEmailVerificationCode(value: string) {
    const code = value.replace(/\D/g, "").slice(0, emailVerificationCodeLength);
    setEmailVerificationCode(code);
    setEmailVerificationMessage(null);
    if (code.length < emailVerificationCodeLength) {
      emailVerificationSubmitLockRef.current = false;
      return;
    }
    if (!emailVerificationSubmitting && !emailVerificationSubmitLockRef.current) {
      requestAnimationFrame(() => void submitEmailVerificationCode(code));
    }
  }

  async function submitEmailVerificationCode(codeOverride = emailVerificationCode) {
    const code = codeOverride.replace(/\D/g, "").slice(0, emailVerificationCodeLength);
    if (code.length !== emailVerificationCodeLength || emailVerificationSubmitLockRef.current) {
      if (code.length !== emailVerificationCodeLength) setEmailVerificationMessage(verificationCopy.invalidCode);
      return;
    }

    emailVerificationSubmitLockRef.current = true;
    setEmailVerificationSubmitting(true);
    setEmailVerificationMessage(null);
    try {
      let result;
      try {
        result = await confirmAccountEmailVerificationCode(apiBaseUrl, authEmail.trim().toLowerCase(), code);
      } catch (error) {
        const details = readAuthError(error);
        if (details.status !== 404 || !emailVerificationToken) throw error;
        // Compatibility only: a Build 9 server may expose a one-time link token
        // but not the code endpoint. The new UI never asks users to paste links.
        result = await confirmAccountEmailVerification(apiBaseUrl, emailVerificationToken);
      }
      await activateAuthenticatedSession(result.sessionCookie, result.payload);
      setEmailVerificationVisible(false);
      setEmailVerificationCode("");
      setEmailVerificationToken("");
      setEmailVerificationMessage(verificationCopy.success);
      setEmailVerificationResendSeconds(0);
    } catch (error) {
      const details = readAuthError(error);
      setEmailVerificationCode("");
      setEmailVerificationMessage(
        details.status === 404 && !emailVerificationToken
          ? verificationCopy.legacyLinkRequired
          : details.status === 429 || details.code === "email_verification_code_rate_limited"
          ? verificationCopy.tooManyAttempts
          : verificationCopy.invalidCode,
      );
    } finally {
      emailVerificationSubmitLockRef.current = false;
      setEmailVerificationSubmitting(false);
    }
  }

  async function logout() {
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      Alert.alert(t("runtime.accountMutationBlockedTitle"), t("runtime.accountMutationBlockedBody"));
      return;
    }
    if (accountSessionMutationInFlightRef.current) return;

    accountSessionMutationInFlightRef.current = true;
    try {
      if (sessionCookie) {
        try {
          await logoutAccount(apiBaseUrl, sessionCookie);
        } catch {
          // Local sign-out must remain available while the service is unreachable.
        }
      }
      await clearLocalSession();
    } finally {
      accountSessionMutationInFlightRef.current = false;
    }
  }

  function switchAuthMode(mode: "login" | "register") {
    if (authLoading || mode === authMode) return;
    setAuthMode(mode);
    setAuthMessage(null);
    setAuthPassword("");
    setAuthPasswordVisible(false);
    if (mode === "login") setAuthAcceptedTerms(false);
  }

  async function requestPasswordReset() {
    const email = authEmail.trim().toLowerCase();
    if (!email.includes("@")) {
      setAuthMessage(t("verification.emailRequired"));
      return;
    }

    setPasswordResetRequesting(true);
    setAuthMessage(null);
    try {
      const result = await requestAccountPasswordReset(apiBaseUrl, email);
      setAuthMessage(t("passwordReset.requestSent"));
      setPasswordResetToken(result.resetToken || "");
      setPasswordResetNewPassword("");
      setPasswordResetConfirmPassword("");
      setPasswordResetPasswordVisible(false);
      setPasswordResetMessage(
        result.resetToken
          ? t("passwordReset.localCredentialReady")
          : t("passwordReset.pasteInstruction"),
      );
      setPasswordResetVisible(true);
    } catch {
      setAuthMessage(t("passwordReset.requestFailed"));
    } finally {
      setPasswordResetRequesting(false);
    }
  }

  async function pastePasswordResetLink() {
    const clipboardValue = (await Clipboard.getStringAsync()).trim();
    const token = extractPasswordResetToken(clipboardValue);
    if (!token) {
      setPasswordResetMessage(t("passwordReset.invalidClipboard"));
      return;
    }
    setPasswordResetToken(token);
    setPasswordResetMessage(t("passwordReset.linkReadyMessage"));
  }

  async function submitPasswordReset() {
    if (!passwordResetToken) {
      setPasswordResetMessage(t("passwordReset.pasteRequired"));
      return;
    }
    if (passwordResetNewPassword.length < 8) {
      setPasswordResetMessage(t("passwordReset.tooShort"));
      return;
    }
    if (passwordResetNewPassword !== passwordResetConfirmPassword) {
      setPasswordResetMessage(t("passwordReset.mismatch"));
      return;
    }

    setPasswordResetSubmitting(true);
    setPasswordResetMessage(null);
    try {
      await confirmAccountPasswordReset({
        apiBaseUrl,
        token: passwordResetToken,
        newPassword: passwordResetNewPassword,
      });
      setPasswordResetVisible(false);
      setPasswordResetToken("");
      setPasswordResetNewPassword("");
      setPasswordResetConfirmPassword("");
      setPasswordResetPasswordVisible(false);
      setAuthPassword("");
      setAuthMode("login");
      setAuthMessage(t("passwordReset.success"));
    } catch {
      setPasswordResetMessage(t("passwordReset.failed"));
    } finally {
      setPasswordResetSubmitting(false);
    }
  }

  function closePasswordReset() {
    if (passwordResetSubmitting) return;
    setPasswordResetVisible(false);
    setPasswordResetToken("");
    setPasswordResetNewPassword("");
    setPasswordResetConfirmPassword("");
    setPasswordResetPasswordVisible(false);
    setPasswordResetMessage(null);
  }

  function resetPasswordChangeForm() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordChangeVisible(false);
    setPasswordChangeMessage(null);
  }

  async function submitPasswordChange() {
    if (!sessionCookie) return;
    if (currentPassword.length < 8 || newPassword.length < 8) {
      setPasswordChangeMessage(t("account.passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordChangeMessage(t("account.passwordMismatch"));
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordChangeMessage(t("account.passwordSame"));
      return;
    }

    setPasswordChanging(true);
    setPasswordChangeMessage(null);
    try {
      const user = await changeAccountPassword({
        apiBaseUrl,
        authCookie: sessionCookie,
        currentPassword,
        newPassword,
      });
      setCurrentUser(user);
      let offlineSnapshotUpdated = true;
      try {
        await SecureStore.setItemAsync(
          offlineSessionSnapshotKey,
          serializeOfflineSessionSnapshot({ apiBaseUrl, user }),
        );
      } catch {
        offlineSnapshotUpdated = false;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordChangeVisible(false);
      setPasswordChangeMessage(
        offlineSnapshotUpdated
          ? t("account.passwordChanged")
          : t("account.passwordChangedSnapshotWarning"),
      );
    } catch {
      setPasswordChangeMessage(t("account.passwordChangeFailed"));
    } finally {
      setPasswordChanging(false);
    }
  }

  const clearLocalSession = useCallback(async (message: string | null = null) => {
    syncSessionGenerationRef.current += 1;
    // Invalidates a consent dialog or native permission/storage preflight that
    // was opened by the session being cleared. Active recordings never reach
    // this path because session clearing is deferred while the lifecycle is busy.
    recordingGenerationRef.current += 1;
    deferredSyncOptionsRef.current = null;
    if (autoSyncWakeTimerRef.current) clearTimeout(autoSyncWakeTimerRef.current);
    autoSyncWakeTimerRef.current = null;
    await Promise.allSettled([
      SecureStore.deleteItemAsync(sessionCookieKey),
      SecureStore.deleteItemAsync(offlineSessionSnapshotKey),
    ]);
    sessionReauthenticationRequiredRef.current = false;
    setSessionCookie(null);
    setCurrentUser(null);
    setAccountUsage(null);
    setOfflineSessionRestored(false);
    setOfflineSessionRetryTick(0);
    setSessionReauthenticationRequired(false);
    setMeetings([]);
    setSelectedMeeting(null);
    setSelectedLocalRecordingId(null);
    setFinalMeetingResult(null);
    setFormalMarkdown(null);
    setShareMessage(null);
    setExportMessage(null);
    setSpeakerNameDrafts({});
    setSpeakerMessage(null);
    clearProviderDrafts();
    setProviderCredentials([]);
    setProviderHealth([]);
    setStatus("idle");
    setRecordedUri(null);
    recordingDurationRef.current = 0;
    setCompletedDurationMs(0);
    setLastError(null);
    setAutoSyncMessage(null);
    setAuthMessage(message);
    setShowPasswordChange(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordChangeVisible(false);
    setPasswordChangeMessage(null);
    setActiveTab("account");
    requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: false }));
  }, [clearProviderDrafts, setAutoSyncMessage]);

  useEffect(() => {
    if (!sessionReauthenticationRequired || recordingLifecycleBusy) return;
    void clearLocalSession(t("auth.sessionExpiredIdle"));
  }, [clearLocalSession, recordingLifecycleBusy, sessionReauthenticationRequired, t]);

  async function openAppleSubscriptionManagement() {
    try {
      await deepLinkToSubscriptions();
    } catch {
      Alert.alert(t("accountActions.manageAppleSubscriptionFailedTitle"), t("accountActions.manageAppleSubscriptionFailedBody"));
    }
  }

  async function confirmDeleteAccount() {
    if (!sessionCookie) return;
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      Alert.alert(t("runtime.accountMutationBlockedTitle"), t("runtime.accountMutationBlockedBody"));
      return;
    }
    if (accountSessionMutationInFlightRef.current) return;

    const body =
      Platform.OS === "ios"
        ? `${t("accountActions.deleteBody")}\n\n${t("accountActions.appleSubscriptionWarning")}`
        : t("accountActions.deleteBody");
    const actions = [
      { text: t("common.cancel"), style: "cancel" as const },
      ...(Platform.OS === "ios"
        ? [
            {
              text: t("accountActions.manageAppleSubscription"),
              onPress: () => {
                void openAppleSubscriptionManagement();
              },
            },
          ]
        : []),
      {
        text: t("accountActions.confirmDelete"),
        style: "destructive" as const,
        onPress: () => {
          void deleteCurrentAccount();
        },
      },
    ];
    Alert.alert(t("accountActions.deleteTitle"), body, actions);
  }

  async function deleteCurrentAccount() {
    if (!sessionCookie || !currentUser) return;
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      Alert.alert(t("runtime.accountMutationBlockedTitle"), t("runtime.accountMutationBlockedBody"));
      return;
    }
    if (accountSessionMutationInFlightRef.current) return;

    accountSessionMutationInFlightRef.current = true;
    try {
      setLastError(null);
      const resolution = await deleteAccountWithConfirmation({
        checkStatus: (ticket) => checkAccountDeletionStatus(apiBaseUrl, ticket),
        persistReceipt: (receipt: AccountDeletionReceipt) =>
          SecureStore.setItemAsync(pendingAccountDeletionKey, serializeAccountDeletionReceipt(receipt)),
        prepareTicket: () => prepareAccountDeletion(apiBaseUrl, sessionCookie),
        requestDelete: () => deleteAccount(apiBaseUrl, sessionCookie),
        userId: currentUser.id,
      });
      if (resolution.status === "pending_confirmation") {
        const cleanupPending = resolution.serverStatus === "pending_cleanup";
        const message = cleanupPending
          ? t("accountActions.deleteCleanupPendingBody")
          : t("accountActions.deleteConfirmationOffline");
        // The server may already have invalidated the account even when the
        // destructive response was lost. Sign out, but keep both the durable
        // confirmation receipt and every local recording until deletion is
        // explicitly confirmed on a later launch.
        await clearLocalSession(message);
        Alert.alert(
          cleanupPending
            ? t("accountActions.deleteCleanupPendingTitle")
            : t("accountActions.deletePendingTitle"),
          message,
        );
        return;
      }
      if (resolution.status === "failed") {
        // A deterministic rejection plus an explicit active status proves that
        // no destructive transition happened, so this receipt must not shadow
        // subsequent launches.
        if (resolution.receipt) {
          await SecureStore.deleteItemAsync(pendingAccountDeletionKey);
        }
        setLastError(t("accountActions.deleteFailed"));
        return;
      }
      const result = resolution.deletion;

      // The account is already gone once the server succeeds. Local cleanup is
      // deliberately reported separately so a protected/unreadable local index
      // can never turn a successful account deletion into a false failure.
      let localCleanupPending = false;
      try {
        const cleanup = await deleteLocalRecordingsForUser(currentUser.id);
        pendingRecordingsRef.current = cleanup.recordings;
        setPendingRecordings(cleanup.recordings);
        localCleanupPending = cleanup.pendingCount > 0;
      } catch {
        localCleanupPending = true;
      }

      await clearLocalSession();
      await SecureStore.deleteItemAsync(pendingAccountDeletionKey);
      Alert.alert(
        t("accountActions.deletedTitle"),
        localCleanupPending
          ? t("accountActions.deletedLocalCleanupPending", { count: result.deletedMeetings ?? 0 })
          : t("accountActions.deletedBody", { count: result.deletedMeetings ?? 0 }),
      );
    } finally {
      accountSessionMutationInFlightRef.current = false;
    }
  }

  async function shareAccountExport() {
    if (!sessionCookie) {
      Alert.alert(t("accountActions.signInTitle"), t("accountActions.exportSignInBody"));
      return;
    }

    let temporaryExportUri: string | null = null;
    try {
      const { payload, text } = await exportAccountData(apiBaseUrl, sessionCookie);
      const fileName = `ownminutes-account-export-${payload.generatedAt.slice(0, 10)}.json`;
      if (!FileSystem.cacheDirectory) throw new Error("account export cache unavailable");
      temporaryExportUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(temporaryExportUri, text);

      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert(t("accountActions.shareUnavailableTitle"), t("accountActions.shareUnavailableBody"));
        return;
      }

      await Sharing.shareAsync(temporaryExportUri, {
        mimeType: "application/json",
        dialogTitle: t("accountActions.exportDialog"),
        UTI: "public.json",
      });
    } catch {
      Alert.alert(t("accountActions.exportFailedTitle"), t("accountActions.exportFailedBody"));
    } finally {
      if (temporaryExportUri) {
        await FileSystem.deleteAsync(temporaryExportUri, { idempotent: true }).catch(() => undefined);
      }
    }
  }

  async function saveProviderConfig() {
    if (!sessionCookie) return;
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      setProviderMessage(t("runtime.providerMutationBlockedBody"));
      return;
    }
    if (providerMutationInFlightRef.current) return;

    const asrApiKey = providerAsrApiKey.trim();
    const asrAppId = providerAppId.trim();
    const asrToken = providerAsrToken.trim();
    const arkApiKey = providerArkApiKey.trim();

    if (providerMode === "volcano-ark" && (!providerModel.trim() || !arkApiKey)) {
      setProviderMessage(t("providerSetup.arkFieldsRequired"));
      return;
    }

    if (providerMode === "volcano-asr" && !asrApiKey && !(asrAppId && asrToken)) {
      setProviderMessage(t("providerSetup.asrFieldsRequired"));
      return;
    }

    providerMutationInFlightRef.current = true;
    setProviderSaving(true);
    setProviderMessage(null);

    try {
      await saveProviderCredential({
        apiBaseUrl,
        authCookie: sessionCookie,
        providerId: providerMode,
        label: providerMode === "volcano-ark" ? "火山方舟" : "火山语音识别",
        fields:
          providerMode === "volcano-ark"
            ? {
                ARK_CHAT_MODEL: providerModel,
                ARK_BASE_URL: providerBaseUrl,
              }
            : {
                VOLCANO_ASR_APP_ID: providerAppId,
                VOLCANO_ASR_RESOURCE_ID: providerAsrResourceId,
                VOLCANO_REALTIME_ASR_RESOURCE_ID: providerRealtimeAsrResourceId,
                VOLCANO_ASR_WS_URL: providerAsrWsUrl,
              },
        secrets:
          providerMode === "volcano-ark"
            ? {
                ARK_API_KEY: arkApiKey,
              }
            : {
                VOLCANO_ASR_API_KEY: asrApiKey,
                VOLCANO_ASR_TOKEN: asrToken,
              },
        removeSecrets:
          providerMode === "volcano-asr"
            ? asrApiKey
              ? ["VOLCANO_ASR_TOKEN"]
              : ["VOLCANO_ASR_API_KEY"]
            : [],
      });
      setProviderMessage(t("providerSetup.providerSaved"));
      await refreshProviderCredentials();
      await refreshProviderHealth();
      await refreshAccountUsage();
    } catch {
      setProviderMessage(t("providerSetup.providerSaveFailed"));
    } finally {
      providerMutationInFlightRef.current = false;
      setProviderSaving(false);
      clearProviderDrafts(true);
    }
  }

  async function selectMeetingProcessingMode(processingMode: UserProcessingMode) {
    if (!sessionCookie || !currentUser || processingModeSaving) return;
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      setProcessingModeMessage(t("processingMode.meetingInProgress"));
      return;
    }
    if (processingMode === "byok" && !mobileByokCoverage.complete) {
      setProcessingModeMessage(t("processingMode.byokNotReady"));
      return;
    }
    if (providerMutationInFlightRef.current) return;

    providerMutationInFlightRef.current = true;
    setProcessingModeSaving(true);
    setProcessingModeMessage(null);
    try {
      const payload = await updateProcessingMode({ apiBaseUrl, authCookie: sessionCookie, processingMode });
      setCurrentUser(payload.user);
      try {
        await SecureStore.setItemAsync(
          offlineSessionSnapshotKey,
          serializeOfflineSessionSnapshot({ apiBaseUrl, user: payload.user }),
        );
      } catch {
        // The online selection remains authoritative even if the offline cache cannot be refreshed.
      }
      await refreshAccountUsage();
      setProcessingModeMessage(
        t(processingMode === "byok" ? "processingMode.savedByok" : "processingMode.savedOfficial"),
      );
    } catch {
      setProcessingModeMessage(
        t(processingMode === "byok" ? "processingMode.byokHealthFailed" : "processingMode.saveFailed"),
      );
    } finally {
      providerMutationInFlightRef.current = false;
      setProcessingModeSaving(false);
    }
  }

  function beginProviderSetup() {
    clearProviderDrafts();
    setProviderMode(providerSetupState.fileAsrReady ? "volcano-ark" : "volcano-asr");
    setProviderMessage(null);
    setShowProviderEditor(true);

    if (!currentUser) {
      setAuthMode("register");
      setAuthMessage(t("providerSetup.signInToConfigure"));
      setActiveTab("account");
      requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: false }));
      return;
    }

    setActiveTab("settings");
    requestAnimationFrame(() => {
      mainScrollRef.current?.scrollTo({ y: Math.max(0, providerPanelYRef.current - 12), animated: true });
    });
  }

  function selectProviderMode(mode: "volcano-asr" | "volcano-ark") {
    setProviderMode(mode);
    setProviderMessage(null);
    setShowProviderAdvancedFields(false);
  }

  function toggleProviderEditor() {
    if (showProviderEditor) {
      clearProviderDrafts();
      return;
    }
    clearProviderDrafts();
    setShowProviderEditor(true);
  }

  function handleFirstRunAction(action: FirstRunAction) {
    if (recordingLifecycleBusyRef.current || recordingStopInFlightRef.current) return;
    if (action === "start") {
      void startRecording();
      return;
    }
    if (action === "configure") {
      beginProviderSetup();
      return;
    }
    if (action === "plans") {
      setShowMembership(true);
      setActiveTab("account");
      requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: false }));
      return;
    }
    void refreshProviderHealth();
  }

  function confirmDeleteProviderCredential(providerId: string, label: string) {
    if (!sessionCookie || (providerId !== "volcano-asr" && providerId !== "volcano-ark")) return;
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      Alert.alert(t("runtime.providerMutationBlockedTitle"), t("runtime.providerMutationBlockedBody"));
      return;
    }
    Alert.alert(t("providerSetup.deleteProviderTitle"), t("providerSetup.deleteProviderBody", { label }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: () => void removeProviderCredential(providerId),
      },
    ]);
  }

  async function removeProviderCredential(providerId: "volcano-asr" | "volcano-ark") {
    if (!sessionCookie || providerDeleting) return;
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      setProviderMessage(t("runtime.providerMutationBlockedBody"));
      return;
    }
    if (providerMutationInFlightRef.current) return;
    providerMutationInFlightRef.current = true;
    setProviderDeleting(providerId);
    setProviderMessage(null);
    try {
      const credentials = await deleteProviderCredential(apiBaseUrl, sessionCookie, providerId);
      setProviderCredentials(credentials);
      setProviderMessage(t("providerSetup.providerDeleted"));
      await refreshProviderHealth();
      await refreshAccountUsage();
      const session = await fetchCurrentUser(apiBaseUrl, sessionCookie);
      if (session.user) {
        setCurrentUser(session.user);
        try {
          await SecureStore.setItemAsync(
            offlineSessionSnapshotKey,
            serializeOfflineSessionSnapshot({ apiBaseUrl, user: session.user }),
          );
        } catch {
          // The server-side fallback remains authoritative.
        }
      }
    } catch {
      setProviderMessage(t("providerSetup.providerDeleteFailed"));
    } finally {
      providerMutationInFlightRef.current = false;
      setProviderDeleting(null);
    }
  }

  async function openProviderUrl(url: string) {
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) throw new Error(t("providerSetup.deviceCannotOpenLink"));
      await Linking.openURL(url);
    } catch (error) {
      Alert.alert(t("providerSetup.cannotOpenLinkTitle"), error instanceof Error ? error.message : t("providerSetup.cannotOpenLinkDetail"));
    }
  }

  async function openOwnMinutesPage(pathname: "/privacy" | "/terms" | "/support" | "/data-deletion") {
    const origin = apiBaseUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(origin)) {
      Alert.alert(t("providerSetup.cannotOpenLinkTitle"), t("providerSetup.deviceCannotOpenLink"));
      return;
    }
    const localizedPathname = localizedOwnMinutesWebPath(locale, pathname);
    try {
      await openProviderUrl(assertSafeMobileApiUrl(`${origin}${localizedPathname}`));
    } catch (error) {
      Alert.alert(t("providerSetup.cannotOpenLinkTitle"), error instanceof Error ? error.message : t("providerSetup.cannotOpenLinkDetail"));
    }
  }

  async function runMobileAsrSubmitTest() {
    if (!sessionCookie) {
      setProviderMessage(t("providerSetup.signInForAsrTest"));
      return;
    }

    setAsrSubmitTesting(true);
    setAsrSubmitMessage(null);

    try {
      const result = await runAsrSubmitTest(apiBaseUrl, sessionCookie);
      setAsrSubmitMessage(formatAsrTestMessage(result, locale));
      await refreshProviderHealth();
    } catch {
      setAsrSubmitMessage(t("providerSetup.asrSubmitFailed"));
    } finally {
      setAsrSubmitTesting(false);
    }
  }

  async function runMobileRealtimeAsrTest() {
    if (!sessionCookie) {
      setProviderMessage(t("providerSetup.signInForRealtimeTest"));
      return;
    }

    setRealtimeAsrTesting(true);
    setRealtimeAsrTestMessage(null);
    try {
      const result = await runRealtimeAsrAuthTest(apiBaseUrl, sessionCookie);
      setRealtimeAsrTestMessage(formatRealtimeAsrTestMessage(result, locale));
      await refreshProviderHealth();
    } catch {
      setRealtimeAsrTestMessage(t("providerSetup.realtimeTestFailed"));
    } finally {
      setRealtimeAsrTesting(false);
    }
  }

  async function openMeetingDetail(item: MeetingListItem) {
    if (!sessionCookie) return;

    const localRecording = userBrowsableLocalRecordings.find(
      (recording) => recording.meetingId === item.meetingId,
    );
    if (networkStatus !== "online" && localRecording) {
      openLocalRecording(localRecording);
      return;
    }

    setHistoryLoading(true);
    setLastError(null);
    setSelectedLocalRecordingId(null);
    try {
      const detail = await fetchMeetingDetail(apiBaseUrl, item.meetingId, sessionCookie);
      setSelectedMeeting(detail);
      setSpeakerNameDrafts(buildSpeakerDrafts(detail.result));
      setSpeakerMessage(null);
      setTranscriptSpeakerDrafts(buildTranscriptSpeakerDrafts(detail.result));
      setTranscriptSpeakerMessage(null);
      setTranscriptVisibleCount(transcriptReviewPageSize);
      setSummaryDraft(detail.result?.summary.summary ?? "");
      setTopicsDraft(formatLineDraft(detail.result?.summary.topics));
      setRisksDraft(formatLineDraft(detail.result?.summary.risks));
      setOpenQuestionsDraft(formatLineDraft(detail.result?.summary.openQuestions));
      setKnowledgeDraft(formatLineDraft(detail.result?.summary.knowledgePoints));
      setSpeakerViewsDraft(formatSpeakerViewsDraft(detail.result));
      setDecisionDraft(formatDecisionDraft(detail.result));
      setActionDraft(formatActionDraft(detail.result));
      setMetadataTitleDraft(detail.title);
      setMetadataProjectDraft(detail.metadata.project || "");
      setMetadataParticipantsDraft(formatLineDraft(detail.metadata.participants));
      setMetadataTagsDraft(detail.metadata.tags.join(", "));
      setMetadataMessage(null);
      setSummaryMessage(null);
      setShowMetadataEditor(false);
      setShowMeetingEditor(false);
      setShowSpeakerEditor(false);
      setShowTranscriptReview(false);
      setShowTranscriptCorrection(false);
      setShowShareControls(false);
      setShowMeetingTools(false);
      setShareMessage(null);
      setExportMessage(null);
      requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: true }));
    } catch {
      if (localRecording) {
        openLocalRecording(localRecording);
        setHistoryError(t("runtime.historyRefreshNotice"));
      } else {
        setLastError(t("meetingDetail.detailLoadFailed"));
      }
    } finally {
      setHistoryLoading(false);
    }
  }

  function closeMeetingDetail() {
    meetingAudioControllerRef.current?.pause();
    setSelectedMeeting(null);
    setShowMetadataEditor(false);
    setShowMeetingEditor(false);
    setShowSpeakerEditor(false);
    setShowTranscriptReview(false);
    setShowTranscriptCorrection(false);
    setShowShareControls(false);
    setShowMeetingTools(false);
    setMetadataMessage(null);
    setSummaryMessage(null);
    setSpeakerMessage(null);
    setTranscriptSpeakerMessage(null);
    setTranscriptVisibleCount(transcriptReviewPageSize);
    setShareMessage(null);
    setExportMessage(null);
    requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: true }));
  }

  function openLocalRecording(recording: PendingRecording) {
    meetingAudioControllerRef.current?.pause();
    setSelectedMeeting(null);
    setSelectedLocalRecordingId(recording.meetingId);
    setSelectedMeetingAudioAvailability("checking");
    setSelectedMeetingAudioProbeVersion((version) => version + 1);
    setLastError(null);
    requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: true }));
  }

  function closeLocalRecording() {
    meetingAudioControllerRef.current?.pause();
    setSelectedLocalRecordingId(null);
    setSelectedMeetingAudioAvailability("idle");
    requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: true }));
  }

  function confirmDeleteSelectedLocalRecording() {
    const target = selectedLocalRecording;
    if (!target || localRecordingDeleting || localRecordingDeleteInFlightRef.current) return;
    if (target.meetingId === currentMeetingIdRef.current && recordingLifecycleBusyRef.current) {
      Alert.alert(t("runtime.localDeleteTitle"), t("runtime.localDeleteBlocked"));
      return;
    }
    Alert.alert(
      t("runtime.localDeleteTitle"),
      t(target.localRecoveryOnly ? "runtime.localRecoveryDeleteBody" : "runtime.localDeleteBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("runtime.localDeleteConfirm"),
          style: "destructive",
          onPress: () => {
            void deleteSelectedLocalRecording(target);
          },
        },
      ],
    );
  }

  async function deleteSelectedLocalRecording(target: PendingRecording) {
    if (localRecordingDeleting || localRecordingDeleteInFlightRef.current) return;
    if (target.meetingId === currentMeetingIdRef.current && recordingLifecycleBusyRef.current) {
      Alert.alert(t("runtime.localDeleteTitle"), t("runtime.localDeleteBlocked"));
      return;
    }

    meetingAudioControllerRef.current?.pause();
    localRecordingDeleteInFlightRef.current = true;
    setLocalRecordingDeleting(true);
    try {
      const result = await deleteLocalRecordingFromDevice({
        expectedUserId: target.userId ?? null,
        meetingId: target.meetingId,
        uri: target.uri,
      });
      pendingRecordingsRef.current = result.recordings;
      setPendingRecordings(result.recordings);
      if (currentMeetingIdRef.current === target.meetingId) {
        setRecordedUri(null);
        setActiveRecordingUri(null);
        activeRecordingUriRef.current = null;
        setFinalMeetingResult(null);
        setFormalMarkdown(null);
        setSegments([]);
      }
      setSelectedLocalRecordingId(null);
      setSelectedMeetingAudioAvailability("idle");
      requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: true }));
      Alert.alert(
        t(result.pending ? "runtime.localDeletePendingTitle" : "runtime.localDeleteSuccessTitle"),
        t(result.pending ? "runtime.localDeletePendingBody" : "runtime.localDeleteSuccessBody"),
      );
    } catch {
      Alert.alert(t("runtime.localDeleteFailedTitle"), t("runtime.localDeleteFailedBody"));
    } finally {
      localRecordingDeleteInFlightRef.current = false;
      setLocalRecordingDeleting(false);
    }
  }

  function syncCurrentMeetingOutput(targetMeetingId: string, result: MeetingResult | null, markdown: string | null) {
    if (targetMeetingId !== meetingId) return;
    setFinalMeetingResult(result);
    setFormalMarkdown(markdown);
    setSegments(result?.transcript ?? []);
  }

  async function saveSelectedMeetingMetadata() {
    if (!sessionCookie || !selectedMeeting || metadataSaving) return;

    const title = normalizeMeetingTitleDraft(metadataTitleDraft);
    if (!title) {
      setMetadataMessage(t("meetingDetail.titleRequired"));
      return;
    }

    setMetadataSaving(true);
    setMetadataMessage(null);
    setLastError(null);
    try {
      const response = await updateMeetingMetadata({
        apiBaseUrl,
        authCookie: sessionCookie,
        meetingId: selectedMeeting.meetingId,
        title,
        project: metadataProjectDraft,
        participants: parseParticipantDraft(metadataParticipantsDraft),
        tags: parseTagDraft(metadataTagsDraft),
      });
      const nextResult = response.result ?? selectedMeeting.result;
      const nextMarkdown = response.obsidianMarkdown ?? nextResult?.obsidianMarkdown ?? null;
      const nextMeeting: MeetingDetail = {
        ...selectedMeeting,
        title,
        metadata: response.metadata ?? selectedMeeting.metadata,
        result: nextResult,
        obsidianMarkdown: nextMarkdown,
        humanReview: response.humanReview ?? selectedMeeting.humanReview,
        share: response.share ?? selectedMeeting.share,
      };
      setSelectedMeeting(nextMeeting);
      setMeetings((items) => items.map((item) => item.meetingId === nextMeeting.meetingId ? { ...item, title, metadata: nextMeeting.metadata, humanReview: nextMeeting.humanReview, share: nextMeeting.share } : item));
      syncCurrentMeetingOutput(nextMeeting.meetingId, nextResult, nextMarkdown);
      setMetadataTitleDraft(title);
      setMetadataParticipantsDraft(formatLineDraft(nextMeeting.metadata.participants));
      setMetadataTagsDraft(nextMeeting.metadata.tags.join(", "));
      setMetadataMessage(response.humanReview?.needsReconfirmation ? t("meetingDetail.titleUpdatedNeedsReview") : t("meetingDetail.infoSaved"));
    } catch {
      setMetadataMessage(t("meetingDetail.infoSaveFailed"));
    } finally {
      setMetadataSaving(false);
    }
  }

  async function changeSelectedMeetingShare(input: { visibility: "private" | "public"; includeTranscript: boolean }) {
    if (!sessionCookie || !selectedMeeting) return;

    setShareUpdating(true);
    setShareMessage(null);
    setLastError(null);
    try {
      const expiresAt = input.visibility === "public"
        ? createDefaultMeetingShareExpiresAt()
        : undefined;
      const result = await updateMeetingShare({
        apiBaseUrl,
        authCookie: sessionCookie,
        meetingId: selectedMeeting.meetingId,
        visibility: input.visibility,
        includeTranscript: input.includeTranscript,
        expiresAt,
        confirmUnverified: input.visibility === "public" && selectedMeetingQuality.status !== "verified",
      });
      const nextMeeting = {
        ...selectedMeeting,
        share: result.share ?? {
          ...selectedMeeting.share,
          expiresAt,
          includeTranscript: input.includeTranscript,
          visibility: input.visibility,
        },
      };
      setSelectedMeeting(nextMeeting);
      setMeetings((items) =>
        items.map((item) =>
          item.meetingId === selectedMeeting.meetingId
            ? {
                ...item,
                share: nextMeeting.share,
              }
            : item,
        ),
      );
      if (input.visibility === "public") {
        const visibilityDetail = input.includeTranscript ? t("meetingDetail.shareSummaryTranscriptPublic") : t("meetingDetail.shareSummaryPublic");
        const shareExpiresAt = result.share?.expiresAt ?? expiresAt ?? createDefaultMeetingShareExpiresAt();
        const expiryDetail = t("meetingShare.expiresAt", {
          date: formatShortDate(shareExpiresAt, locale),
        });
        setShareMessage(t("meetingDetail.shareReadyMessage", {
          detail: `${visibilityDetail}. ${expiryDetail}`,
        }));
        Alert.alert(t("meetingDetail.sharePublishedTitle"), `${visibilityDetail}\n${expiryDetail}`, [
          { text: t("common.done"), style: "cancel" },
          { text: t("meetingDetail.copyShareLink"), onPress: () => void copyShareLink() },
          { text: t("meetingDetail.systemShareLink"), onPress: () => void sharePublicLink() },
        ]);
      } else {
        setShareMessage(t("meetingDetail.shareRevokedMessage"));
        Alert.alert(t("meetingDetail.shareRevokedTitle"), t("meetingDetail.shareRevokedBody"), [{ text: t("common.done") }]);
      }
    } catch {
      const message = t("meetingDetail.shareSettingsFailed");
      setShareMessage(t("meetingDetail.shareSettingsFailedMessage", { message }));
      setLastError(message);
    } finally {
      setShareUpdating(false);
    }
  }

  async function changeSelectedMeetingHumanReview(confirmed: boolean) {
    if (!sessionCookie || !selectedMeeting) return;
    setReviewUpdating(true);
    setShareMessage(null);
    setLastError(null);
    try {
      const response = await updateMeetingHumanReview({
        apiBaseUrl,
        authCookie: sessionCookie,
        confirmed,
        meetingId: selectedMeeting.meetingId,
      });
      const humanReview = response.humanReview ?? selectedMeeting.humanReview;
      const share = response.share ?? (confirmed ? selectedMeeting.share : { ...selectedMeeting.share, visibility: "private" as const, includeTranscript: false });
      const nextMeeting = { ...selectedMeeting, humanReview, share };
      setSelectedMeeting(nextMeeting);
      setMeetings((items) => items.map((item) => item.meetingId === nextMeeting.meetingId ? { ...item, humanReview, share } : item));
      setShareMessage(confirmed ? t("meetingDetail.reviewConfirmedMessage") : t("meetingDetail.reviewRevokedMessage"));
    } catch {
      const message = t("meetingDetail.reviewSaveFailed");
      setShareMessage(t("meetingDetail.reviewSaveFailedMessage", { message }));
      setLastError(message);
    } finally {
      setReviewUpdating(false);
    }
  }

  function confirmSelectedMeetingHumanReview() {
    if (!selectedMeeting) return;
    if (selectedMeeting.humanReview.status === "confirmed") {
      Alert.alert(t("meetingDetail.revokeReviewTitle"), t("meetingDetail.revokeReviewBody"), [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("meetingDetail.revokeReview"), style: "destructive", onPress: () => void changeSelectedMeetingHumanReview(false) },
      ]);
      return;
    }
    Alert.alert(t("meetingDetail.confirmReviewTitle"), t("meetingDetail.confirmReviewBody"), [
      { text: t("meetingDetail.reviewContinue"), style: "cancel" },
      { text: t("meetingDetail.reviewDone"), onPress: () => void changeSelectedMeetingHumanReview(true) },
    ]);
  }

  function confirmSelectedMeetingShare(input: { visibility: "private" | "public"; includeTranscript: boolean }) {
    if (input.visibility !== "public") {
      void changeSelectedMeetingShare(input);
      return;
    }

    if (selectedMeeting?.humanReview.status !== "confirmed") {
      Alert.alert(t("meetingDetail.reviewRequiredTitle"), t("meetingDetail.reviewRequiredBody"));
      return;
    }

    const qualityWarning =
      selectedMeetingQuality.status !== "verified"
        ? `\n\n${t("meetingDetail.qualityWarning", { detail: selectedMeetingQualityDetail, quality: selectedMeetingQualityLabel })}`
        : "";

    if (input.includeTranscript) {
      Alert.alert(t("meetingDetail.publishTranscriptTitle"), t("meetingDetail.publishTranscriptBody", { warning: qualityWarning }), [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("meetingDetail.confirmPublic"),
          style: "destructive",
          onPress: () => {
            void changeSelectedMeetingShare(input);
          },
        },
      ]);
      return;
    }

    Alert.alert(t("meetingDetail.publishShareTitle"), t("meetingDetail.publishShareBody", { warning: qualityWarning }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("meetingDetail.confirmPublish"),
        onPress: () => {
          void changeSelectedMeetingShare(input);
        },
      },
    ]);
  }

  async function saveSelectedMeetingSpeakers() {
    if (!sessionCookie || !selectedMeeting?.result) return;

    const speakerNames = Object.fromEntries(
      selectedMeetingSpeakers
        .map((speaker) => [speaker, normalizeSpeakerNameDraft(speakerNameDrafts[speaker] ?? speaker)] as const)
        .filter(([speaker, name]) => name && speaker !== name),
    );

    setSpeakerSaving(true);
    setSpeakerMessage(null);
    setLastError(null);

    try {
      const response = await updateMeetingSpeakers({
        apiBaseUrl,
        authCookie: sessionCookie,
        meetingId: selectedMeeting.meetingId,
        speakerNames,
      });
      const nextResult = response.result;
      if (!nextResult) {
        throw new Error(t("meetingDetail.speakerResultMissing"));
      }
      const nextMarkdown = response.obsidianMarkdown ?? nextResult.obsidianMarkdown;
      const nextMeeting: MeetingDetail = {
        ...selectedMeeting,
        result: nextResult,
        obsidianMarkdown: nextMarkdown,
        transcriptCount: nextResult.transcript.length,
        humanReview: response.humanReview ?? selectedMeeting.humanReview,
        share: response.share ?? selectedMeeting.share,
      };

      setSelectedMeeting(nextMeeting);
      syncCurrentMeetingOutput(nextMeeting.meetingId, nextResult, nextMarkdown);
      setSpeakerNameDrafts(buildSpeakerDrafts(nextResult));
      setTranscriptSpeakerDrafts(buildTranscriptSpeakerDrafts(nextResult));
      setSpeakerMessage(Object.keys(speakerNames).length > 0 ? t("meetingDetail.speakerUpdated") : t("meetingDetail.speakerNoChanges"));
      void refreshMeetings();
    } catch (error) {
      setSpeakerMessage(error instanceof Error && error.message === t("meetingDetail.speakerResultMissing") ? error.message : t("meetingDetail.speakerSaveFailed"));
    } finally {
      setSpeakerSaving(false);
    }
  }

  async function saveSelectedTranscriptSpeakers() {
    if (!sessionCookie || !selectedMeeting?.result || transcriptSpeakerSaving) return;

    const invalidSegment = selectedMeeting.result.transcript.find((segment) => {
      const draft = transcriptSpeakerDrafts[segment.id];
      return draft !== undefined && !normalizeSpeakerNameDraft(draft);
    });
    if (invalidSegment) {
      setTranscriptSpeakerError(true);
      setTranscriptSpeakerMessage(t("meetingDetail.transcriptSpeakerRequired", { timestamp: invalidSegment.timestamp }));
      return;
    }

    const speakerAssignments = selectedMeeting.result.transcript.reduce<Record<string, string>>((output, segment) => {
      const speaker = normalizeSpeakerNameDraft(transcriptSpeakerDrafts[segment.id] ?? segment.speaker);
      if (speaker && speaker !== segment.speaker) output[segment.id] = speaker;
      return output;
    }, {});

    if (Object.keys(speakerAssignments).length === 0) {
      setTranscriptSpeakerError(false);
      setTranscriptSpeakerMessage(t("meetingDetail.transcriptNoChanges"));
      return;
    }

    setTranscriptSpeakerSaving(true);
    setTranscriptSpeakerMessage(null);
    setLastError(null);

    try {
      const response = await updateMeetingTranscriptSpeakers({
        apiBaseUrl,
        authCookie: sessionCookie,
        meetingId: selectedMeeting.meetingId,
        speakerAssignments,
      });
      const nextResult = response.result;
      if (!nextResult) {
        throw new Error(t("meetingDetail.transcriptResultMissing"));
      }
      const nextMarkdown = response.obsidianMarkdown ?? nextResult.obsidianMarkdown;
      const nextMeeting: MeetingDetail = {
        ...selectedMeeting,
        result: nextResult,
        obsidianMarkdown: nextMarkdown,
        transcriptCount: nextResult.transcript.length,
        humanReview: response.humanReview ?? selectedMeeting.humanReview,
        share: response.share ?? selectedMeeting.share,
      };

      setSelectedMeeting(nextMeeting);
      syncCurrentMeetingOutput(nextMeeting.meetingId, nextResult, nextMarkdown);
      setSpeakerNameDrafts(buildSpeakerDrafts(nextResult));
      setTranscriptSpeakerDrafts(buildTranscriptSpeakerDrafts(nextResult));
      setTranscriptSpeakerError(false);
      setTranscriptSpeakerMessage(t("meetingDetail.transcriptUpdated", { count: Object.keys(speakerAssignments).length }));
      void refreshMeetings();
    } catch (error) {
      setTranscriptSpeakerError(true);
      setTranscriptSpeakerMessage(error instanceof Error && error.message === t("meetingDetail.transcriptResultMissing") ? error.message : t("meetingDetail.transcriptSaveFailed"));
    } finally {
      setTranscriptSpeakerSaving(false);
    }
  }

  async function saveSelectedMeetingSummary() {
    if (!sessionCookie || !selectedMeeting?.result) return;

    setSummarySaving(true);
    setSummaryMessage(null);
    setLastError(null);

    try {
      const response = await updateMeetingSummary({
        apiBaseUrl,
        authCookie: sessionCookie,
        meetingId: selectedMeeting.meetingId,
        summaryPatch: {
          summary: summaryDraft.trim(),
          topics: parseLineDraft(topicsDraft),
          speakerViews: parseSpeakerViewsDraft(speakerViewsDraft),
          decisions: parseDecisionDraft(decisionDraft),
          actionItems: parseActionDraft(actionDraft),
          risks: parseLineDraft(risksDraft),
          openQuestions: parseLineDraft(openQuestionsDraft),
          knowledgePoints: parseLineDraft(knowledgeDraft),
        },
      });
      const nextResult = response.result;
      if (!nextResult) {
        throw new Error(t("meetingDetail.summaryResultMissing"));
      }
      const nextMarkdown = response.obsidianMarkdown ?? nextResult.obsidianMarkdown;
      const nextMeeting: MeetingDetail = {
        ...selectedMeeting,
        result: nextResult,
        obsidianMarkdown: nextMarkdown,
        transcriptCount: nextResult.transcript.length,
        humanReview: response.humanReview ?? selectedMeeting.humanReview,
        share: response.share ?? selectedMeeting.share,
      };

      setSelectedMeeting(nextMeeting);
      syncCurrentMeetingOutput(nextMeeting.meetingId, nextResult, nextMarkdown);
      setSummaryDraft(nextResult.summary.summary);
      setTopicsDraft(formatLineDraft(nextResult.summary.topics));
      setRisksDraft(formatLineDraft(nextResult.summary.risks));
      setOpenQuestionsDraft(formatLineDraft(nextResult.summary.openQuestions));
      setKnowledgeDraft(formatLineDraft(nextResult.summary.knowledgePoints));
      setSpeakerViewsDraft(formatSpeakerViewsDraft(nextResult));
      setDecisionDraft(formatDecisionDraft(nextResult));
      setActionDraft(formatActionDraft(nextResult));
      setSummaryMessage(t("meetingDetail.summaryUpdated"));
      void refreshMeetings();
    } catch (error) {
      setSummaryMessage(error instanceof Error && error.message === t("meetingDetail.summaryResultMissing") ? error.message : t("meetingDetail.summarySaveFailed"));
    } finally {
      setSummarySaving(false);
    }
  }

  function confirmDeleteMeeting() {
    if (!sessionCookie || !selectedMeeting) return;
    if (selectedMeetingDeletionBlocked) {
      Alert.alert(t("meetingDetail.deleteTitle"), t("ux.finishRecordingBeforeDelete"));
      return;
    }

    Alert.alert(t("meetingDetail.deleteTitle"), t("meetingDetail.deleteConfirmBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("meetingDetail.confirmDelete"),
        style: "destructive",
        onPress: () => {
          void deleteSelectedMeeting();
        },
      },
    ]);
  }

  async function deleteSelectedMeeting() {
    if (!sessionCookie || !selectedMeeting) return;

    const targetMeetingId = selectedMeeting.meetingId;
    if (isMeetingDeletionBlocked({
      currentMeetingId: currentMeetingIdRef.current,
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      targetMeetingId,
    })) {
      Alert.alert(t("meetingDetail.deleteTitle"), t("ux.finishRecordingBeforeDelete"));
      return;
    }
    meetingAudioControllerRef.current?.pause();
    setShareUpdating(true);
    setLastError(null);
    try {
      const resolution = await deleteMeetingWithConfirmation({
        meetingId: targetMeetingId,
        requestDelete: () => deleteMeeting(apiBaseUrl, targetMeetingId, sessionCookie),
        listMeetingIds: async () => (await fetchMeetings(apiBaseUrl, sessionCookie)).map((item) => item.meetingId),
      });
      if (resolution.status === "pending_confirmation") {
        Alert.alert(t("ux.deleteConfirmationPendingTitle"), t("ux.deleteConfirmationPending"));
        return;
      }
      if (resolution.status === "failed") {
        setLastError(t("meetingDetail.deleteFailed"));
        return;
      }
      const deletion = resolution.deletion;
      const localRecording = pendingRecordingsRef.current.find(
        (recording) => recording.meetingId === targetMeetingId && recording.userId === currentUser?.id,
      );
      let localCleanupPending = false;
      if (localRecording) {
        const inMemoryDeletionFence: PendingRecording = {
          ...localRecording,
          activeRecording: false,
          localDeletionPendingAt: localRecording.localDeletionPendingAt ?? new Date().toISOString(),
          nextRetryAt: undefined,
        };
        const fencedRecordings = pendingRecordingsRef.current.map((recording) =>
          recording.meetingId === targetMeetingId ? inMemoryDeletionFence : recording,
        );
        pendingRecordingsRef.current = fencedRecordings;
        setPendingRecordings(fencedRecordings);
      }
      try {
        const cleanup = await deletePendingRecordingAfterRemoteDelete(targetMeetingId, currentUser?.id);
        pendingRecordingsRef.current = cleanup.recordings;
        setPendingRecordings(cleanup.recordings);
        localCleanupPending = cleanup.pending;
      } catch {
        localCleanupPending = true;
      }
      if (meetingId === targetMeetingId) {
        setRecordedUri(null);
        setActiveRecordingUri(null);
        activeRecordingUriRef.current = null;
        setFinalMeetingResult(null);
        setFormalMarkdown(null);
        setSegments([]);
      }
      setSelectedMeeting(null);
      setShareMessage(null);
      setExportMessage(null);
      setSpeakerNameDrafts({});
      setSpeakerMessage(null);
      setMeetings((items) => items.filter((item) => item.meetingId !== targetMeetingId));
      void refreshMeetings();
      const deletedBody = deletion.cleanupPending && localCleanupPending
        ? t("ux.deletedCleanupPending")
        : deletion.cleanupPending
          ? t("ux.deletedServerCleanupPending")
          : localCleanupPending
            ? t("ux.deletedLocalCleanupPending")
            : t("meetingDetail.deletedBody");
      Alert.alert(t("meetingDetail.deletedTitle"), deletedBody);
    } catch {
      setLastError(t("meetingDetail.deleteFailed"));
    } finally {
      setShareUpdating(false);
    }
  }

  async function startRecording() {
    setLastError(null);
    if (recordingLifecycleBusyRef.current || recordingStopInFlightRef.current) return;
    if (accountSessionMutationInFlightRef.current) {
      Alert.alert(t("runtime.accountMutationInProgressTitle"), t("runtime.accountMutationInProgressBody"));
      return;
    }
    if (providerMutationInFlightRef.current) {
      Alert.alert(t("runtime.providerMutationInProgressTitle"), t("runtime.providerMutationInProgressBody"));
      return;
    }
    if (!sessionCookie || !currentUser || sessionReauthenticationRequired) {
      setAuthMode("login");
      setAuthMessage(sessionReauthenticationRequired ? t("recordingFlow.sessionExpiredNewMeeting") : t("recordingFlow.signInToStart"));
      setActiveTab("account");
      requestAnimationFrame(() => mainScrollRef.current?.scrollTo({ y: 0, animated: false }));
      return;
    }
    const recordingStartFence: RecordingStartSessionFence = {
      generation: syncSessionGenerationRef.current,
      userId: currentUser.id,
    };

    const normalizedTitle = normalizeMeetingTitleDraft(meetingTitle);
    if (!normalizedTitle) {
      setLastError(t("recordingFlow.titleRequired"));
      return;
    }
    setMeetingTitle(normalizedTitle);

    Alert.alert(t("recordingFlow.consentTitle"), t("recordingFlow.consentBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("recordingFlow.consentStart"),
        style: "default",
        onPress: () => {
          if (!recordingStartSessionIsCurrent(recordingStartFence)) return;
          void doStartRecording({
            consentConfirmedAt: new Date().toISOString(),
            consentMethod: "in_app_confirmation",
            consentPolicyVersion: recordingConsentPolicyVersion,
          }, recordingStartFence);
        },
      },
    ]);
  }

  function recordingStartSessionIsCurrent(fence: RecordingStartSessionFence) {
    return isRecordingStartSessionCurrent(fence, {
      generation: syncSessionGenerationRef.current,
      reauthenticationRequired: sessionReauthenticationRequiredRef.current,
      userId: currentUser?.id,
    });
  }

  async function doStartRecording(
    consent: RecordingConsentMetadata,
    recordingStartFence: RecordingStartSessionFence,
  ) {
    if (
      !recordingStartSessionIsCurrent(recordingStartFence) ||
      recordingLifecycleBusyRef.current ||
      recordingStopInFlightRef.current
    ) return;
    recordingLifecycleBusyRef.current = true;
    setRecordingStartPreflightBusy(true);
    meetingAudioControllerRef.current?.pause();
    let nextMeetingId = meetingId;
    let recordingUri: string | null = null;
    let durableRecorderPrepared = false;
    let durableRecorderStarted = false;
    let recordingResourcesPrepared = false;
    const frozenProcessingMode = selectedProcessingMode;
    const recordingGeneration = recordingGenerationRef.current + 1;
    recordingGenerationRef.current = recordingGeneration;
    const recordingCreatedAt = new Date().toISOString();
    activeRecordingConsentRef.current = consent;
    const recordingStartIsCurrent = () =>
      recordingGenerationRef.current === recordingGeneration &&
      currentMeetingIdRef.current === nextMeetingId &&
      recordingStatusRef.current === "recording" &&
      !recordingStopInFlightRef.current &&
      !recordingTransitionInFlightRef.current;
    const abandonRealtimeJournal = async () => {
      await completePendingRealtimeSession(nextMeetingId).catch(() => undefined);
      if (activeRealtimeJournalMeetingIdRef.current === nextMeetingId) {
        activeRealtimeJournalMeetingIdRef.current = null;
      }
      if (activeRealtimeMeetingIdRef.current === nextMeetingId) {
        resetRealtimePcmBuffer(null);
      }
    };
    const abandonStaleRecordingStart = async () => {
      recordingGenerationRef.current += 1;
      recordingStopInFlightRef.current = true;
      try {
        await Promise.allSettled([
          ...(durableRecorderPrepared
            ? [withTimeout(
                recorder.stop(),
                8_000,
                "释放已失效的原生录音准备会话超时。",
              )]
            : []),
          ...(recordingResourcesPrepared
            ? [
            deactivateKeepAwake(keepAwakeTag),
            withTimeout(
              setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }),
              2_000,
              "清理已失效的录音启动会话超时。",
            ),
              ]
            : []),
        ]);
        durableRecorderPrepared = false;
      } finally {
        recordingStatusRef.current = "idle";
        recordingLifecycleBusyRef.current = false;
        recordingStopInFlightRef.current = false;
        setRecordingStartPreflightBusy(false);
        setStatus("idle");
        activeRecordingConsentRef.current = null;
        if (recordingResourcesPrepared) setKeepAwakeActive(false);
      }
    };
    try {
      const storageHealth = await readRecordingStorageHealth("preflight");
      setRecordingStorageHealth(storageHealth);
      if (!recordingStartSessionIsCurrent(recordingStartFence)) {
        await abandonStaleRecordingStart();
        return;
      }
      if (!storageHealth.canStart) {
        recordingStatusRef.current = "idle";
        recordingLifecycleBusyRef.current = false;
        setRecordingStartPreflightBusy(false);
        setStatus("idle");
        activeRecordingConsentRef.current = null;
        setLastError(
          t("recordingFlow.storageBlocked", {
            bytes: formatBytes(storageHealth.freeBytes ?? 0),
            minimum: formatBytes(recordingStorageStartMinimumBytes),
          }),
        );
        return;
      }
      recordingStatusRef.current = "requesting";
      setRecordingStartPreflightBusy(false);
      setStatus("requesting");
      const permission = await requestRecordingPermissionsAsync();
      setMicrophonePermission(permission.granted ? "granted" : "denied");

      if (!recordingStartSessionIsCurrent(recordingStartFence)) {
        await abandonStaleRecordingStart();
        return;
      }
      if (!permission.granted) {
        recordingStatusRef.current = "idle";
        recordingLifecycleBusyRef.current = false;
        setStatus("idle");
        activeRecordingConsentRef.current = null;
        setLastError(t("recordingFlow.microphoneDenied"));
        return;
      }

      nextMeetingId = createMeetingId();
      currentMeetingIdRef.current = nextMeetingId;
      setMeetingId(nextMeetingId);
      setUploadState(initialUploadState);
      setAutoSyncMessage(null);
      setRecordedUri(null);
      recordingDurationRef.current = 0;
      setCompletedDurationMs(0);
      setRecordingSessionElapsedMs(0);
      setActiveRecordingUri(null);
      activeRecordingUriRef.current = null;
      setRecordingFileHealth(createRecordingFileHealth());
      recordingStorageEmergencyStopRef.current = false;
      recordingDurationLimitStopRef.current = false;
      recordingFileWatchdogFailuresRef.current = 0;
      recordingFileWatchdogStopRef.current = false;
      setSegments([]);
      setSelectedMeeting(null);
      setFinalMeetingResult(null);
      setFormalMarkdown(null);
      setShareMessage(null);
      setExportMessage(null);
      setSpeakerNameDrafts({});
      setSpeakerMessage(null);
      setRecordSegment("transcript");
      setPcmBuffers(0);
      setPcmBytes(0);
      setBackgroundInterruptions(0);
      setLastBackgroundAt(null);
      setAppStateLabel(appStateStatusLabel(AppState.currentState));
      activeRealtimeJournalMeetingIdRef.current = null;
      resetRealtimePcmBuffer(null);

      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: true,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      await activateKeepAwakeAsync(keepAwakeTag);
      setKeepAwakeActive(true);
      recordingResourcesPrepared = true;
      await withTimeout(
        recorder.prepareToRecordAsync(),
        8000,
        t("recordingFlow.prepareTimeout"),
      );
      durableRecorderPrepared = true;
      if (!recordingStartSessionIsCurrent(recordingStartFence)) {
        await abandonStaleRecordingStart();
        return;
      }
      recorder.record({ forDuration: remainingRecordingDurationSeconds(0) });
      if (!recorder.getStatus().isRecording) throw new Error("native recorder did not start");
      nativeDurationLimitArmedRef.current = true;
      durableRecorderStarted = true;
      recordingStartedAtRef.current = Date.now();
      mediaServicesResetHandledRef.current = false;
      recordingStatusRef.current = "recording";
      setStatus("recording");
      try {
        await preparePendingRealtimeSession({
          ...consent,
          createdAt: recordingCreatedAt,
          meetingId: nextMeetingId,
          processingMode: frozenProcessingMode,
          title: meetingTitle,
          userId: currentUser?.id,
        });
        if (!recordingStartIsCurrent()) {
          await abandonRealtimeJournal();
          return;
        }
        activeRealtimeJournalMeetingIdRef.current = nextMeetingId;
        resetRealtimePcmBuffer(nextMeetingId, frozenProcessingMode);
      } catch {
        resetRealtimePcmBuffer(null);
        setRealtimeUploadDiagnostic(t("runtime.realtimeJournalUnavailable"));
      }
      recordingUri = await waitForRecorderUri(recorder);
      if (!recordingStartIsCurrent()) {
        await abandonRealtimeJournal();
        return;
      }
      if (recordingUri) {
        setActiveRecordingUri(recordingUri);
        activeRecordingUriRef.current = recordingUri;
        setRecordingFileHealth(createRecordingFileHealth());
        let realtimeSession: Awaited<ReturnType<typeof attachPendingRealtimeSessionUri>> = null;
        if (activeRealtimeJournalMeetingIdRef.current === nextMeetingId) {
          try {
            realtimeSession = await attachPendingRealtimeSessionUri(nextMeetingId, recordingUri);
          } catch {
            // The normal recording index below remains a durable URI source.
          }
        }
        if (!recordingStartIsCurrent()) {
          await abandonRealtimeJournal();
          return;
        }
        await persistPendingRecording({
          activeRecording: true,
          ...consent,
          createdAt: recordingCreatedAt,
          meetingId: nextMeetingId,
          mimeType: audioMimeTypeForUri(recordingUri),
          processingMode: frozenProcessingMode,
          realtimeClosePendingAt:
            activeRealtimeJournalMeetingIdRef.current === nextMeetingId
              ? realtimeSession?.realtimeClosePendingAt ?? recordingCreatedAt
              : undefined,
          title: meetingTitle,
          userId: currentUser?.id,
          uri: recordingUri,
        });
      } else {
        setRealtimeUploadDiagnostic(t("recordingFlow.delayedPath"));
        void resolveDelayedRecordingUri({
          consent,
          createdAt: recordingCreatedAt,
          generation: recordingGeneration,
          meetingId: nextMeetingId,
          processingMode: frozenProcessingMode,
          title: meetingTitle,
          userId: currentUser?.id,
        });
      }
      try {
        if (activeRealtimeJournalMeetingIdRef.current !== nextMeetingId) return;
        if (!recordingStartIsCurrent()) {
          await abandonRealtimeJournal();
          return;
        }
        realtimeStreamRestartInFlightRef.current = true;
        await audioStream.stream.start();
        if (!recordingStartIsCurrent()) {
          try {
            audioStream.stream.stop();
          } catch {
            // A queued stop or pause may already have closed the secondary stream.
          }
          await abandonRealtimeJournal();
        }
      } catch {
        if (recordingStartIsCurrent()) {
          setRealtimeUploadDiagnostic(t("recordingFlow.realtimeStartFailed"));
        } else {
          await abandonRealtimeJournal();
        }
      } finally {
        realtimeStreamRestartInFlightRef.current = false;
      }
    } catch {
      nativeDurationLimitArmedRef.current = false;
      recordingGenerationRef.current += 1;
      recordingStopInFlightRef.current = true;
      recordingStatusRef.current = "processing";
      setRecordingStartPreflightBusy(false);
      setStatus("processing");
      try {
        if (durableRecorderPrepared) {
          if (durableRecorderStarted) {
            try {
              recordingUri = recordingUri || activeRecordingUriRef.current || recorder.uri || recorder.getStatus().url;
            } catch {
              recordingUri = recordingUri || activeRecordingUriRef.current;
            }
          }
          try {
            await withTimeout(recorder.stop(), 8_000, "启动失败后的录音收口超时。");
            if (durableRecorderStarted) {
              recordingUri = recordingUri || recorder.uri || recorder.getStatus().url;
            }
          } catch {
            // Continue cleanup even when the native recorder cannot stop cleanly.
          }
          durableRecorderPrepared = false;
        }
        if (recordingUri) {
          activeRecordingUriRef.current = recordingUri;
          setActiveRecordingUri(recordingUri);
          try {
            let realtimeSession: Awaited<ReturnType<typeof attachPendingRealtimeSessionUri>> = null;
            try {
              realtimeSession = await attachPendingRealtimeSessionUri(nextMeetingId, recordingUri);
            } catch {
              // The fallback recording index below still preserves the URI.
            }
            await persistPendingRecording({
              activeRecording: true,
              ...consent,
              createdAt: new Date().toISOString(),
              meetingId: nextMeetingId,
              mimeType: audioMimeTypeForUri(recordingUri),
              processingMode: frozenProcessingMode,
              realtimeClosePendingAt: realtimeSession?.realtimeClosePendingAt,
              title: meetingTitle,
              userId: currentUser?.id,
              uri: recordingUri,
            });
          } catch {
            setRealtimeUploadDiagnostic(t("recordingFlow.startRecoveryScan"));
          }
        }
        await Promise.allSettled([
          deactivateKeepAwake(keepAwakeTag),
          withTimeout(
            setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }),
            2000,
            t("recordingFlow.cleanupTimeout"),
          ),
        ]);
      } finally {
        setKeepAwakeActive(false);
        recordingStatusRef.current = "error";
        recordingLifecycleBusyRef.current = false;
        recordingStopInFlightRef.current = false;
        setRecordingStartPreflightBusy(false);
        setStatus("error");
        activeRecordingConsentRef.current = null;
        setLastError(t("recordingFlow.startFailed"));
      }
    }
  }

  async function pauseRecording() {
    if (recordingTransitionInFlightRef.current || recordingStopInFlightRef.current) return;
    recordingTransitionInFlightRef.current = true;
    setRecordingTransitionBusy(true);
    try {
      recorder.pause();
      try {
        audioStream.stream.stop();
      } catch {
        // Realtime input is secondary to the durable recorder.
      }
      flushRealtimePcmBuffer();
      recordingStatusRef.current = "paused";
      setStatus("paused");
    } catch {
      setLastError(t("recordingFlow.pauseFailed"));
    } finally {
      recordingTransitionInFlightRef.current = false;
      setRecordingTransitionBusy(false);
      const pendingStop = pendingRecordingStopRef.current;
      pendingRecordingStopRef.current = null;
      if (pendingStop) void stopRecordingRef.current(pendingStop.reason);
    }
  }

  async function resumeRecording() {
    if (recordingTransitionInFlightRef.current || recordingStopInFlightRef.current) return;
    const generation = recordingGenerationRef.current;
    recordingTransitionInFlightRef.current = true;
    setRecordingTransitionBusy(true);
    try {
      const elapsedMs = Math.max(recordingDurationRef.current, recorderState.durationMillis ?? 0);
      const remainingSeconds = remainingRecordingDurationSeconds(elapsedMs);
      if (remainingSeconds <= 0) {
        recordingDurationLimitStopRef.current = true;
        setLastError(t("recordingFlow.durationLimit"));
        await stopRecording("duration-limit");
        return;
      }
      // AudioStream.stop() deactivates the shared iOS audio session while
      // paused. Start the stream first so AVAudioRecorder resumes on an active
      // session instead of silently reporting "recording" without writing.
      try {
        realtimeStreamRestartInFlightRef.current = true;
        await audioStream.stream.start();
      } catch {
        setRealtimeUploadDiagnostic(t("recordingFlow.realtimeResumeFailed"));
      } finally {
        realtimeStreamRestartInFlightRef.current = false;
      }
      if (
        generation !== recordingGenerationRef.current ||
        recordingStatusRef.current !== "paused" ||
        pendingRecordingStopRef.current
      ) return;
      recorder.record({ forDuration: remainingSeconds });
      if (!recorder.getStatus().isRecording) throw new Error("native recorder did not resume");
      nativeDurationLimitArmedRef.current = true;
      recordingStartedAtRef.current = Date.now();
      setRecordingFileHealth((current) => ({
        ...current,
        lastCheckedAt: Date.now(),
        lastGrowthAt: Date.now(),
        status: "waiting",
      }));
      recordingStatusRef.current = "recording";
      setStatus("recording");
    } catch {
      setLastError(t("recordingFlow.resumeFailed"));
    } finally {
      recordingTransitionInFlightRef.current = false;
      setRecordingTransitionBusy(false);
      const pendingStop = pendingRecordingStopRef.current;
      pendingRecordingStopRef.current = null;
      if (pendingStop) void stopRecordingRef.current(pendingStop.reason);
    }
  }

  async function resetMeeting() {
    if (status === "requesting" || status === "recording" || status === "paused" || status === "processing") {
      Alert.alert(t("recordingFlow.meetingInProgressTitle"), t("recordingFlow.meetingInProgressBody"));
      return;
    }

    setStatus("idle");
    recordingGenerationRef.current += 1;
    const nextMeetingId = createMeetingId();
    currentMeetingIdRef.current = nextMeetingId;
    setMeetingId(nextMeetingId);
    const localizedTitle = createDefaultMeetingTitle(locale);
    defaultMeetingTitleRef.current = localizedTitle;
    setMeetingTitle(localizedTitle);
    setRecordedUri(null);
    recordingDurationRef.current = 0;
    setCompletedDurationMs(0);
    setRecordingSessionElapsedMs(0);
    setActiveRecordingUri(null);
    activeRecordingUriRef.current = null;
    setRecordingFileHealth({ bytes: 0, lastCheckedAt: 0, lastGrowthAt: 0, status: "idle" });
    setRecordingStorageHealth(createUnknownRecordingStorageHealth());
    recordingStorageEmergencyStopRef.current = false;
    recordingDurationLimitStopRef.current = false;
    recordingFileWatchdogFailuresRef.current = 0;
    recordingFileWatchdogStopRef.current = false;
    nativeDurationLimitArmedRef.current = false;
    setUploadState(initialUploadState);
    setSegments([]);
    setSelectedMeeting(null);
    setFinalMeetingResult(null);
    setFormalMarkdown(null);
    setShareMessage(null);
    setExportMessage(null);
    setSpeakerNameDrafts({});
    setSpeakerMessage(null);
    setLastError(null);
    setAutoSyncMessage(null);
    setPcmBuffers(0);
    setPcmBytes(0);
    setBackgroundInterruptions(0);
    setLastBackgroundAt(null);
    setAppStateLabel(appStateStatusLabel(AppState.currentState));
    activeRecordingConsentRef.current = null;
    resetRealtimePcmBuffer(null);
  }

  async function handleMediaServicesReset() {
    if (mediaServicesResetHandledRef.current) return;
    if (recordingTransitionInFlightRef.current) {
      mediaServicesResetHandledRef.current = true;
      pendingRecordingStopRef.current = { reason: "native-error" };
      setRealtimeUploadDiagnostic(t("runtime.mediaResetFinishing"));
      return;
    }
    if (recordingStopInFlightRef.current) {
      mediaServicesResetHandledRef.current = true;
      setRealtimeUploadDiagnostic(t("runtime.mediaResetFinishing"));
      return;
    }
    mediaServicesResetHandledRef.current = true;
    recordingStopInFlightRef.current = true;
    recordingFileWatchdogStopRef.current = true;
    nativeDurationLimitArmedRef.current = false;
    recordingGenerationRef.current += 1;
    // Keep recovery actions disabled until the original URI is durably indexed.
    setStatus("processing");

    const recoveryUri = activeRecordingUriRef.current || activeRecordingUri;
    const existing = pendingRecordingsRef.current.find((recording) => recording.meetingId === meetingId);
    const recoveredDurationMs = Math.max(1_000, recordingDurationRef.current, recorderState.durationMillis ?? 0);

    activeRealtimeMeetingIdRef.current = null;
    realtimeUploadQueueRef.current.cancelPending();
    realtimePendingBuffersRef.current = [];
    realtimeChunkBufferBytesRef.current = 0;
    setRealtimePendingBytes(0);
    try {
      audioStream.stream.stop();
    } catch {
      // iOS may already have invalidated the secondary realtime stream.
    }
    await Promise.allSettled([
      deactivateKeepAwake(keepAwakeTag),
      withTimeout(
        setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }),
        2_000,
        "重置录音会话超时。",
      ),
    ]);
    setKeepAwakeActive(false);

    if (recoveryUri) {
      activeRecordingUriRef.current = recoveryUri;
      setActiveRecordingUri(recoveryUri);
      setRecordedUri(recoveryUri);
      recordingDurationRef.current = recoveredDurationMs;
      setCompletedDurationMs(recoveredDurationMs);
      try {
        let realtimeClosePendingAt =
          existing?.realtimeClosePendingAt ??
          (activeRealtimeJournalMeetingIdRef.current === meetingId
            ? new Date().toISOString()
            : undefined);
        try {
          const realtimeSession = await attachPendingRealtimeSessionUri(meetingId, recoveryUri);
          realtimeClosePendingAt = realtimeSession?.realtimeClosePendingAt ?? realtimeClosePendingAt;
        } catch {
          // The recording index below remains the durable fallback.
        }
        await persistPendingRecording({
          ...existing,
          activeRecording: true,
          ...normalizeRecordingConsent(existing ?? activeRecordingConsentRef.current),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          durationMs: recoveredDurationMs,
          meetingId,
          mimeType: audioMimeTypeForUri(recoveryUri),
          processingMode: existing?.processingMode ?? activeRecordingProcessingModeRef.current ?? undefined,
          realtimeClosePendingAt,
          title: existing?.title || meetingTitle,
          userId: existing?.userId || currentUser?.id,
          uri: recoveryUri,
        });
      } catch {
        // The original file remains in Documents and the orphan scanner will
        // recover it on next launch even if the index write is interrupted.
      }
    }

    setStatus("error");
    setLastError(
      recoveryUri
        ? t("runtime.mediaResetRecovered")
        : t("runtime.mediaResetNeedsScan"),
    );
    recordingStopInFlightRef.current = false;
  }
  handleMediaServicesResetRef.current = handleMediaServicesReset;

  async function stopRecording(reason?: RecordingStopReason) {
    if (recordingTransitionInFlightRef.current) {
      pendingRecordingStopRef.current = { reason };
      return;
    }
    if (recordingStopInFlightRef.current) return;
    recordingStopInFlightRef.current = true;
    nativeDurationLimitArmedRef.current = false;
    let localRecordingIndexed = false;
    const targetMeetingId = meetingId;
    const targetTitle = meetingTitle;
    const targetUserId = currentUser?.id;
    const targetPendingRecording = pendingRecordingsRef.current.find(
      (recording) => recording.meetingId === meetingId,
    );
    const targetProcessingMode =
      targetPendingRecording?.processingMode ??
      activeRecordingProcessingModeRef.current;
    const targetConsent = normalizeRecordingConsent(
      targetPendingRecording ?? activeRecordingConsentRef.current,
    );
    const realtimeGeneration = realtimeUploadQueueRef.current.currentGeneration();
    const frozenSourceUri = activeRecordingUriRef.current;
    let frozenFallbackUri = activeRecordingUri || recorder.uri;
    try {
      frozenFallbackUri = frozenFallbackUri || recorder.getStatus().url;
    } catch {
      // The durable ref remains authoritative if native status is unavailable.
    }
    try {
      const stoppedDurationMs = Math.max(1_000, recordingDurationRef.current, recorderState.durationMillis ?? 0);
      recordingDurationRef.current = stoppedDurationMs;
      setCompletedDurationMs(stoppedDurationMs);
      setStatus("processing");
      setRecordSegment("notes");
      recordingGenerationRef.current += 1;

      let recorderStopError: unknown = null;
      try {
        await withTimeout(recorder.stop(), 8_000, "结束本地录音超时，已转入恢复模式。");
      } catch (error) {
        recorderStopError = error;
      }

      // AVAudioRecorder owns the durable file. Stop it before the secondary
      // AudioStream because AudioStream.stop() deactivates the shared session.
      try {
        audioStream.stream.stop();
      } catch {
        // The secondary live draft must never prevent saving the durable file.
      }
      flushRealtimePcmBuffer();
      setPcmBuffers(pcmBuffersRef.current);
      setPcmBytes(pcmBytesRef.current);
      await Promise.allSettled([
        deactivateKeepAwake(keepAwakeTag),
        withTimeout(
          setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }),
          2_000,
          "清理录音会话超时。",
        ),
      ]);
      setKeepAwakeActive(false);

      const uri = frozenSourceUri || frozenFallbackUri || recorder.uri || recorder.getStatus().url;
      if (!uri) {
        throw new Error("录音文件 URI 为空。");
      }
      if (recorderStopError) throw recorderStopError;

      // Keep the recorder's Documents URI authoritative. Moving a completed
      // file before atomically updating the recovery index creates a crash
      // window where the index points at a vanished source. The root orphan
      // scanner can recover this URI even if the next index write fails.
      const durableUri = uri;
      setRecordedUri(durableUri);
      setActiveRecordingUri(durableUri);
      activeRecordingUriRef.current = durableUri;
      const durableInfo = await FileSystem.getInfoAsync(durableUri);
      setRecordingFileHealth({
        bytes: durableInfo.exists ? durableInfo.size : recordingFileHealth.bytes,
        lastCheckedAt: Date.now(),
        lastGrowthAt: Date.now(),
        status: durableInfo.exists ? "healthy" : "missing",
      });
      const localMediaDurationMs = await readLocalRecordingDurationMs(durableUri);
      const durableDurationMs = Math.max(stoppedDurationMs, localMediaDurationMs ?? 0);
      recordingDurationRef.current = durableDurationMs;
      setCompletedDurationMs(durableDurationMs);
      let realtimeClosePendingAt =
        activeRealtimeJournalMeetingIdRef.current === targetMeetingId
          ? new Date().toISOString()
          : undefined;
      try {
        const realtimeSession = await attachPendingRealtimeSessionUri(targetMeetingId, durableUri);
        realtimeClosePendingAt = realtimeSession?.realtimeClosePendingAt ?? realtimeClosePendingAt;
      } catch {
        // The recording index below still preserves the close-pending fence.
      }
      await persistPendingRecording({
        activeRecording: false,
        ...targetConsent,
        createdAt: new Date().toISOString(),
        durationMs: durableDurationMs,
        meetingId: targetMeetingId,
        mimeType: audioMimeTypeForUri(durableUri),
        processingMode: targetProcessingMode ?? undefined,
        realtimeClosePendingAt,
        title: targetTitle,
        userId: targetUserId,
        uri: durableUri,
      });
      localRecordingIndexed = true;
      setStatus("complete");
      setAutoSyncMessage(t("runtime.localSavedSyncing"));

      void (async () => {
        try {
          if (!targetProcessingMode) return;
          await settleRealtimePcmSession(targetMeetingId, realtimeGeneration, targetProcessingMode);
        } catch (error) {
          noteAuthenticatedSessionFailure(error);
          if (currentMeetingIdRef.current === targetMeetingId) {
            setRealtimeUploadDiagnostic(t("runtime.realtimeFinishFailed"));
          }
        }
        await syncPendingRecordings({
          force: true,
          onlyMeetingId: targetMeetingId,
          showActiveResult: currentMeetingIdRef.current === targetMeetingId,
        });
      })();
    } catch {
      setStatus("error");
      const recoveryUri = frozenSourceUri || frozenFallbackUri || activeRecordingUriRef.current;
      if (recoveryUri) {
        activeRecordingUriRef.current = recoveryUri;
        setActiveRecordingUri(recoveryUri);
        setRecordedUri(recoveryUri);
        try {
          const existing = pendingRecordingsRef.current.find((recording) => recording.meetingId === targetMeetingId);
          let realtimeClosePendingAt =
            existing?.realtimeClosePendingAt ??
            (activeRealtimeJournalMeetingIdRef.current === targetMeetingId
              ? new Date().toISOString()
              : undefined);
          try {
            const realtimeSession = await attachPendingRealtimeSessionUri(targetMeetingId, recoveryUri);
            realtimeClosePendingAt = realtimeSession?.realtimeClosePendingAt ?? realtimeClosePendingAt;
          } catch {
            // The emergency index below remains the durable fallback.
          }
          await persistPendingRecording({
            ...existing,
            activeRecording: true,
            ...targetConsent,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            durationMs: Math.max(1_000, recordingDurationRef.current),
            meetingId: targetMeetingId,
            mimeType: audioMimeTypeForUri(recoveryUri),
            processingMode: existing?.processingMode ?? targetProcessingMode ?? undefined,
            realtimeClosePendingAt,
            title: existing?.title || targetTitle,
            userId: existing?.userId || targetUserId,
            uri: recoveryUri,
          });
          localRecordingIndexed = true;
        } catch {
          // The orphan scanner will recover the original Documents file on
          // next launch even if this emergency index write cannot complete.
        }
      }
      setLastError(t("runtime.stopFailedPreserved"));
      await Promise.allSettled([
        deactivateKeepAwake(keepAwakeTag),
        withTimeout(
          setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false }),
          2_000,
          "清理录音会话超时。",
        ),
      ]);
      setKeepAwakeActive(false);
    } finally {
      recordingStopInFlightRef.current = false;
      if (reason === "low-storage") {
        setRealtimeUploadDiagnostic(
          t(localRecordingIndexed ? "runtime.recordingIndexedSafely" : "runtime.recordingIndexUnconfirmed"),
        );
      } else if (reason === "duration-limit") {
        setRealtimeUploadDiagnostic(
          t(localRecordingIndexed ? "runtime.recordingIndexedSafely" : "runtime.recordingIndexUnconfirmed"),
        );
      } else if (reason === "native-error") {
        setRealtimeUploadDiagnostic(
          t(localRecordingIndexed ? "runtime.recordingIndexedSafely" : "runtime.recordingIndexUnconfirmed"),
        );
      } else if (reason === "file-stalled" || reason === "file-missing") {
        setRealtimeUploadDiagnostic(
          t(localRecordingIndexed ? "runtime.recordingIndexedSafely" : "runtime.recordingIndexUnconfirmed"),
        );
      }
    }
  }

  stopRecordingRef.current = stopRecording;
  nativeRecorderStatusRef.current = (event) => {
    const disposition = classifyNativeRecordingCompletion({
      armed: nativeDurationLimitArmedRef.current,
      durationMs: Math.max(recordingDurationRef.current, recorderState.durationMillis ?? 0),
      hasError: event.hasError,
      isFinished: event.isFinished,
      mediaServicesDidReset: event.mediaServicesDidReset,
      stopInFlight: recordingStopInFlightRef.current,
    });
    if (disposition === "ignore") return;

    nativeDurationLimitArmedRef.current = false;
    if (disposition === "media-services-reset") {
      void handleMediaServicesReset();
      return;
    }
    if (disposition === "native-error") {
      setLastError(t("runtime.nativeRecordingStopped"));
    } else {
      recordingDurationLimitStopRef.current = true;
      setLastError(t("recordingFlow.durationLimit"));
    }
    void stopRecordingRef.current(disposition);
  };

  async function syncPendingRecordings(options: PendingSyncOptions = {}): Promise<PendingSyncResult> {
    const syncSessionGeneration = syncSessionGenerationRef.current;
    const syncCookie = sessionCookie;
    const syncUserId = currentUser?.id;
    const isCurrentSyncSession = () => syncSessionGenerationRef.current === syncSessionGeneration;
    const shouldPresentSyncMessage = (targetMeetingId?: string) =>
      Boolean(
        isCurrentSyncSession() &&
        targetMeetingId &&
        targetMeetingId === currentMeetingIdRef.current &&
        !recordingLifecycleBusyRef.current,
      );
    const updateActiveUploadState = (
      targetMeetingId: string,
      update: (current: UploadState) => UploadState,
    ) => {
      if (isCurrentSyncSession() && targetMeetingId === currentMeetingIdRef.current) setUploadState(update);
    };
    const explicitCurrentMeetingRetry =
      options.force === true &&
      Boolean(options.onlyMeetingId) &&
      options.onlyMeetingId === currentMeetingIdRef.current;
    if (recordingLifecycleBusyRef.current && !explicitCurrentMeetingRetry) {
      deferredSyncOptionsRef.current = mergeDeferredSyncOptions(deferredSyncOptionsRef.current, options);
      return { deferred: true, failed: 0, succeeded: 0 };
    }
    if (autoSyncInFlightRef.current || uploadInFlightRef.current) {
      deferredSyncOptionsRef.current = mergeDeferredSyncOptions(deferredSyncOptionsRef.current, options);
      if (!autoSyncWakeTimerRef.current) {
        autoSyncWakeTimerRef.current = setTimeout(() => {
          autoSyncWakeTimerRef.current = null;
          if (recordingLifecycleBusyRef.current) return;
          autoSyncRequestRef.current();
        }, 1_000);
      }
      return { deferred: true, failed: 0, succeeded: 0 };
    }
    if (sessionReauthenticationRequiredRef.current) {
      if (shouldPresentSyncMessage(options.onlyMeetingId)) {
        setAutoSyncMessage(t("runtime.syncAuthRequired"), "warning");
      }
      return { deferred: false, failed: 0, succeeded: 0 };
    }
    if (!syncCookie || !syncUserId || networkStatus !== "online") {
      if (shouldPresentSyncMessage(options.onlyMeetingId)) {
        setAutoSyncMessage(t("runtime.syncOffline"), "warning");
      }
      return { deferred: false, failed: 0, succeeded: 0 };
    }

    const targets = selectPendingSyncTargets(pendingRecordingsRef.current, {
      force: options.force,
      onlyMeetingId: options.onlyMeetingId,
      userId: syncUserId,
    }).filter(hasFrozenProcessingMode);
    if (targets.length === 0) return { deferred: false, failed: 0, succeeded: 0 };
    const visibleTargetMeetingId = targets.find(
      (recording) => recording.meetingId === currentMeetingIdRef.current,
    )?.meetingId;

    autoSyncInFlightRef.current = true;
    uploadInFlightRef.current = true;
    if (shouldPresentSyncMessage(options.onlyMeetingId)) {
      setAutoSyncMessage(t("runtime.syncStarting", { count: targets.length }));
    }
    if (isCurrentSyncSession() && targets.some((recording) => recording.meetingId === currentMeetingIdRef.current)) {
      setUploadState((current) => ({ ...current, pending: current.pending + 1, lastError: null }));
    }
    let failed = 0;
    let succeeded = 0;
    let authenticationRejected = false;

    try {
      for (let index = 0; index < targets.length; index += 1) {
        let working = targets[index];
        if (shouldPresentSyncMessage(working.meetingId)) {
          setAutoSyncMessage(t("runtime.syncProgress", { current: index + 1, total: targets.length }));
        }

        try {
          if (working.realtimeClosePendingAt) {
            await finishRealtimePcmSessionIfPresent({
              apiBaseUrl,
              authCookie: syncCookie,
              meetingId: working.meetingId,
              processingMode: working.processingMode,
            });
            working = {
              ...working,
              realtimeClosePendingAt: undefined,
              updatedAt: new Date().toISOString(),
            };
            await persistPendingRecording(working);
            await completePendingRealtimeSession(working.meetingId);
          }

          if (!working.audioUploadedAt) {
            const recordingUploadId = working.recordingUploadId ?? createRecordingUploadId();
            const parsedCreatedAt = Date.parse(working.createdAt);
            const recordingRecordedAt = working.recordingRecordedAt ?? (Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now());
            if (!working.recordingUploadId || !working.recordingRecordedAt) {
              working = { ...working, recordingRecordedAt, recordingUploadId, recordingUploadedParts: 0 };
              await persistPendingRecording(working);
            }
            const ack = await uploadMeetingAudio({
              apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
              meetingId: working.meetingId,
              audioUri: working.uri,
              consentConfirmedAt: working.consentConfirmedAt,
              consentMethod: working.consentMethod ?? "legacy_unknown",
              consentPolicyVersion: working.consentPolicyVersion,
              mimeType: working.mimeType ?? audioMimeTypeForUri(working.uri),
              durationMs: Math.max(1_000, working.durationMs ?? 1_000),
              recordedAt: recordingRecordedAt,
              authCookie: syncCookie,
              uploadId: recordingUploadId,
              onProgress: async ({ totalParts, uploadedParts }) => {
                working = {
                  ...working,
                  recordingUploadId,
                  recordingUploadedParts: uploadedParts,
                  recordingTotalParts: totalParts,
                  updatedAt: new Date().toISOString(),
                };
                await persistPendingRecording(working);
                if (shouldPresentSyncMessage(working.meetingId)) {
                  setAutoSyncMessage(t("runtime.syncParts", { uploaded: uploadedParts, total: totalParts }));
                }
              },
            });
            working = {
              ...working,
              activeRecording: false,
              audioUploadedAt: ack.receivedAt,
              lastUploadError: undefined,
              nextRetryAt: undefined,
              recordingUploadedParts: working.recordingTotalParts,
              updatedAt: new Date().toISOString(),
              uploadAttempts: 0,
            };
            await persistPendingRecording(working);
            if (
              isCurrentSyncSession() &&
              options.showActiveResult === true &&
              working.meetingId === currentMeetingIdRef.current &&
              ack.durationMs
            ) {
              recordingDurationRef.current = ack.durationMs;
              setCompletedDurationMs(ack.durationMs);
            }
            updateActiveUploadState(working.meetingId, (current) => ({
              ...current,
              uploaded: current.uploaded + 1,
              savedBytes: ack.totalBytes,
              provider: ack.provider,
              adapter: ack.adapter,
              diagnostic: toUserFacingMeetingDiagnostic(ack.diagnostic, locale) ?? current.diagnostic,
              lastAckAt: ack.receivedAt,
              lastError: null,
            }));
            if (
              isCurrentSyncSession() &&
              options.showActiveResult === true &&
              working.meetingId === currentMeetingIdRef.current &&
              ack.transcriptSegment
            ) {
              setSegments((current) => [...current, ack.transcriptSegment!]);
            }
          }

          const finalized = await finalizeMeeting({
            apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
            meetingId: working.meetingId,
            processingMode: working.processingMode,
            title: working.title || createDefaultMeetingTitle(locale, new Date(working.createdAt)),
            authCookie: syncCookie,
          });
          if (
            isCurrentSyncSession() &&
            options.showActiveResult === true &&
            working.meetingId === currentMeetingIdRef.current
          ) {
            if (finalized.result?.transcript.length) setSegments(finalized.result.transcript);
            if (finalized.result) setFinalMeetingResult(finalized.result);
            if (finalized.result?.obsidianMarkdown) setFormalMarkdown(finalized.result.obsidianMarkdown);
            if (finalized.result?.diagnostics.length) {
              const visibleDiagnostic = meetingResultHasNoSpeech(finalized.result.diagnostics)
                ? null
                : toUserFacingMeetingDiagnostic(finalized.result.diagnostics, locale);
              updateActiveUploadState(working.meetingId, (current) => ({
                ...current,
                diagnostic: visibleDiagnostic,
              }));
            }
            setRecordSegment("notes");
          }
          working = {
            ...working,
            activeRecording: false,
            finalizedAt: finalized.result?.generatedAt ?? new Date().toISOString(),
            lastUploadError: undefined,
            nextRetryAt: undefined,
            updatedAt: new Date().toISOString(),
            uploadAttempts: 0,
          };
          await persistPendingRecording(working);
          succeeded += 1;
        } catch (error) {
          failed += 1;
          const message = t("runtime.syncFailed");
          if (isCurrentSyncSession() && noteAuthenticatedSessionFailure(error)) {
            authenticationRejected = true;
            await persistPendingRecording({
              ...working,
              activeRecording: false,
              lastUploadError: t("runtime.syncAuthRequired"),
              nextRetryAt: undefined,
            });
            updateActiveUploadState(working.meetingId, (current) => ({
              ...current,
              failed: current.failed + 1,
              lastError: t("runtime.syncAuthRequired"),
            }));
            break;
          }
          const uploadAttempts = (working.uploadAttempts ?? 0) + 1;
          const retryAfterSeconds =
            error && typeof error === "object" && "retryAfterSeconds" in error ? Number(error.retryAfterSeconds) : 0;
          const nextRetryAt = new Date(Date.now() + pendingRetryDelayMs(uploadAttempts, retryAfterSeconds)).toISOString();
          await persistPendingRecording({
            ...working,
            activeRecording: false,
            lastUploadError: message,
            nextRetryAt,
            uploadAttempts,
          });
          updateActiveUploadState(working.meetingId, (current) => ({
            ...current,
            failed: current.failed + 1,
            lastError: message,
          }));
        } finally {
          updateActiveUploadState(working.meetingId, (current) => ({
            ...current,
            pending: Math.max(0, current.pending - 1),
          }));
        }
      }

      if (authenticationRejected) {
        if (shouldPresentSyncMessage(options.onlyMeetingId)) {
          setAutoSyncMessage(t("runtime.syncAuthRequired"), "warning");
        }
        return { deferred: false, failed, succeeded };
      }
      if (isCurrentSyncSession()) {
        markOfficialProcessingUnknown();
        const [meetingListResult, accountUsageResult] = await Promise.allSettled([
          fetchMeetings(apiBaseUrl, syncCookie),
          fetchAccountUsage(apiBaseUrl, syncCookie),
        ]);
        if (isCurrentSyncSession()) {
          if (meetingListResult.status === "fulfilled") {
            setMeetings(meetingListResult.value);
            setHistoryVisibleCount(historyPageSize);
            setHistoryError(null);
          } else {
            noteAuthenticatedSessionFailure(meetingListResult.reason);
          }
          if (accountUsageResult.status === "fulfilled") {
            setAccountUsage(accountUsageResult.value);
          } else {
            markOfficialProcessingUnknown();
            noteAuthenticatedSessionFailure(accountUsageResult.reason);
          }
        }
      }
      if (shouldPresentSyncMessage(visibleTargetMeetingId)) {
        setAutoSyncMessage(
          failed > 0
            ? t("runtime.syncPartial", { failed, succeeded })
            : t("runtime.syncComplete", { count: succeeded }),
          failed > 0 ? "warning" : "info",
        );
      }
      return { deferred: false, failed, succeeded };
    } finally {
      autoSyncInFlightRef.current = false;
      uploadInFlightRef.current = false;
      if (isCurrentSyncSession() && options.onlyMeetingId === currentMeetingIdRef.current) {
        setUploadState((current) => ({ ...current, pending: 0 }));
      }
      if (deferredSyncOptionsRef.current || autoSyncWakeTimerRef.current) {
        if (autoSyncWakeTimerRef.current) clearTimeout(autoSyncWakeTimerRef.current);
        autoSyncWakeTimerRef.current = setTimeout(() => {
          autoSyncWakeTimerRef.current = null;
          if (recordingLifecycleBusyRef.current) return;
          autoSyncRequestRef.current();
        }, 0);
      }
    }
  }

  async function retryUpload(recordingOverride?: PendingRecording) {
    let target = recordingOverride ?? pendingRecording ?? pendingRecordingsRef.current.find((recording) => recording.uri === recordedUri);
    let retryUri = target?.uri ?? recordedUri;
    let retryMeetingId = target?.meetingId ?? meetingId;

    if (!retryUri) {
      Alert.alert(t("recordingFlow.noUploadTitle"), t("recordingFlow.noUploadBody"));
      return;
    }

    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      const historical = retryMeetingId !== currentMeetingIdRef.current;
      const title = t(historical ? "runtime.historySyncBlockedTitle" : "runtime.recordingActionBlockedTitle");
      const body = t(historical ? "runtime.historySyncBlockedBody" : "runtime.recordingActionBlockedBody");
      setAutoSyncMessage(body, "warning");
      Alert.alert(title, body);
      return;
    }

    if (target?.localRecoveryOnly) {
      setStatus("error");
      setAutoSyncMessage(t("runtime.isolatedFound"), "warning");
      setLastError(t("runtime.isolatedBackup"));
      return;
    }

    if (target && !hasFrozenProcessingMode(target)) {
      const legacyTarget = target;
      const buttons = [
        {
          text: t("processingMode.legacyUseOfficial"),
          onPress: () => {
            void (async () => {
              const resolved: PendingRecording = { ...legacyTarget, processingMode: "official_quota" };
              await persistPendingRecording(resolved);
              await retryUpload(resolved);
            })();
          },
        },
        ...(mobileByokCoverage.complete
          ? [{
              text: t("processingMode.legacyUseByok"),
              onPress: () => {
                void (async () => {
                  const resolved: PendingRecording = { ...legacyTarget, processingMode: "byok" };
                  await persistPendingRecording(resolved);
                  await retryUpload(resolved);
                })();
              },
            }]
          : []),
        { text: t("common.cancel"), style: "cancel" as const },
      ];
      Alert.alert(
        t("processingMode.legacyTitle"),
        t(mobileByokCoverage.complete ? "processingMode.legacyDetail" : "processingMode.legacyOfficialOnly"),
        buttons,
      );
      return;
    }

    if (target?.activeRecording) {
      setStatus("processing");
      setAutoSyncMessage(t("runtime.interruptedChecking"));
      const assessment = await inspectInterruptedRecording(target);
      if (!assessment.recoverable || !assessment.durationMs) {
        setStatus("error");
        setAutoSyncMessage(t("runtime.interruptedUnavailable"), "warning");
        setUploadState((current) => ({ ...current, lastError: t("runtime.interruptedUnavailable") }));
        return;
      }
      await persistPendingRecording({
        ...target,
        activeRecording: false,
        durationMs: assessment.durationMs,
        lastUploadError: undefined,
        nextRetryAt: undefined,
        realtimeClosePendingAt: target.realtimeClosePendingAt ?? target.createdAt,
      });
      target = pendingRecordingsRef.current.find((recording) => recording.meetingId === target?.meetingId) ?? {
        ...target,
        activeRecording: false,
        durationMs: assessment.durationMs,
      };
      retryUri = target.uri;
      retryMeetingId = target.meetingId;
      recordingDurationRef.current = assessment.durationMs;
      setCompletedDurationMs(assessment.durationMs);
      setAutoSyncMessage(t("runtime.interruptedReady"));
    }

    if (!target) {
      await persistPendingRecording({
        activeRecording: false,
        createdAt: new Date().toISOString(),
        meetingId: retryMeetingId,
        mimeType: audioMimeTypeForUri(retryUri),
        processingMode: selectedProcessingMode,
        title: meetingTitle,
        userId: currentUser?.id,
        uri: retryUri,
      });
    }
    if (retryMeetingId !== meetingId) {
      currentMeetingIdRef.current = retryMeetingId;
      setMeetingId(retryMeetingId);
      setMeetingTitle(target?.title || createDefaultMeetingTitle(locale, new Date(target?.createdAt || Date.now())));
      setRecordedUri(retryUri);
      setSegments([]);
      setFinalMeetingResult(null);
      setFormalMarkdown(null);
    }
    if (recordingOverride) closeLocalRecording();

    setStatus("processing");
    const result = await syncPendingRecordings({ force: true, onlyMeetingId: retryMeetingId, showActiveResult: true });
    if (result.deferred) {
      setStatus("complete");
      setAutoSyncMessage(t("runtime.syncQueued"));
      return;
    }
    setStatus(result.failed > 0 ? "error" : "complete");
  }

  async function retrySelectedMeetingFinalization() {
    if (!sessionCookie || !selectedMeeting || selectedFinalizing) return;
    setSelectedFinalizing(true);
    setLastError(null);
    try {
      await finalizeMeeting({
        apiBaseUrl: apiBaseUrl.replace(/\/$/, ""),
        meetingId: selectedMeeting.meetingId,
        processingMode:
          selectedMeetingLocalRecording?.processingMode ??
          meetingResultProcessingMode(selectedMeeting.result),
        title: selectedMeeting.title,
        authCookie: sessionCookie,
        force: Boolean(selectedMeeting.result),
      });
      const detail = await fetchMeetingDetail(apiBaseUrl, selectedMeeting.meetingId, sessionCookie);
      setSelectedMeeting(detail);
      syncCurrentMeetingOutput(detail.meetingId, detail.result, detail.obsidianMarkdown || detail.result?.obsidianMarkdown || null);
      await refreshMeetings();
      await refreshAccountUsage();
      Alert.alert(t("meetingDetail.finalizationUpdated"), detail.qualityStatus === "verified" ? t("meetingDetail.finalResultGenerated") : t("meetingDetail.finalResultNeedsReview"));
    } catch {
      setLastError(t("meetingDetail.finalizationFailed"));
    } finally {
      setSelectedFinalizing(false);
    }
  }

  async function retrySelectedMeetingLocalAudio() {
    setSelectedMeetingAudioAvailability("checking");
    try {
      // Re-read the durable index so a TestFlight container migration can
      // repair the URI before probing the same stale path again.
      await restorePendingRecording();
    } catch {
      setSelectedMeetingAudioAvailability("unavailable");
    } finally {
      setSelectedMeetingAudioProbeVersion((version) => version + 1);
    }
  }

  async function shareAudioFile(localUri: string | null) {
    if (shouldBlockRecordingSensitiveMutation({
      recordingLifecycleBusy: recordingLifecycleBusyRef.current,
      recordingStopInFlight: recordingStopInFlightRef.current,
    })) {
      Alert.alert(t("runtime.recordingActionBlockedTitle"), t("runtime.recordingActionBlockedBody"));
      return;
    }
    if (!localUri) {
      Alert.alert(t("meetingDetail.localAudioMissingTitle"), t("meetingDetail.localAudioMissingBody"));
      return;
    }

    let fileInfo: Awaited<ReturnType<typeof FileSystem.getInfoAsync>>;
    try {
      fileInfo = await withTimeout(FileSystem.getInfoAsync(localUri), 2500, "local audio export probe timeout");
    } catch {
      Alert.alert(t("meetingDetail.audioFileMissingTitle"), t("meetingDetail.audioFileMissingBody"));
      return;
    }
    if (!fileInfo.exists || fileInfo.isDirectory || fileInfo.size <= 0) {
      Alert.alert(t("meetingDetail.audioFileMissingTitle"), t("meetingDetail.audioFileMissingBody"));
      return;
    }

    let sharingAvailable = false;
    try {
      sharingAvailable = await Sharing.isAvailableAsync();
    } catch {
      // Fall through to the same safe, localized unavailable message.
    }
    if (!sharingAvailable) {
      Alert.alert(t("meetingDetail.noSystemShareTitle"), t("meetingDetail.noSystemShareAudio"));
      return;
    }

    try {
      await Sharing.shareAsync(localUri, {
        mimeType: audioMimeTypeForUri(localUri),
        dialogTitle: t("meetingDetail.exportAudioDialog"),
        UTI: audioMimeTypeForUri(localUri) === "audio/wav" ? "com.microsoft.waveform-audio" : "public.audio",
      });
    } catch {
      Alert.alert(t("meetingDetail.noSystemShareTitle"), t("meetingDetail.noSystemShareAudio"));
    }
  }

  async function shareLocalRecording() {
    await shareAudioFile(recordedUri ?? pendingRecording?.uri ?? null);
  }

  async function shareSelectedMeetingRecording() {
    meetingAudioControllerRef.current?.pause();
    await shareAudioFile(selectedPlaybackRecording?.uri ?? null);
  }

  function playTranscriptAt(timestamp: string) {
    if (
      selectedMeetingAudioAvailability !== "available" ||
      recordingLifecycleBusyRef.current ||
      recordingStopInFlightRef.current
    ) return;
    const seconds = parseTranscriptTimestampSeconds(timestamp);
    if (seconds === null) return;
    void meetingAudioControllerRef.current?.seekAndPlay(seconds);
  }

  async function copyMarkdown() {
    try {
      const content = await getExportMarkdown();
      await Clipboard.setStringAsync(content);
      setExportMessage(t("meetingDetail.markdownCopiedMessage"));
      Alert.alert(t("meetingDetail.markdownCopiedTitle"), t("meetingDetail.markdownCopiedBody"));
    } catch {
      setExportMessage(null);
      Alert.alert(t("meetingDetail.noFormalNotesTitle"), t("meetingDetail.noFormalNotesBody"));
    }
  }

  async function shareMarkdown() {
    try {
      const content = await getExportMarkdown();
      const exportMeetingId = selectedMeeting?.meetingId ?? meetingId;
      const exportTitle = selectedMeeting?.title ?? meetingTitle;
      const fileName = buildMarkdownExportFileName(exportTitle, exportMeetingId);
      const target = `${FileSystem.documentDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(target, content);

      if (!(await Sharing.isAvailableAsync())) {
        setExportMessage(t("meetingDetail.markdownSavedNoShare", { fileName }));
        Alert.alert(t("meetingDetail.noSystemShareTitle"), t("meetingDetail.noSystemShareMarkdown"));
        return;
      }

      setExportMessage(t("meetingDetail.markdownPrepared", { fileName }));
      await Sharing.shareAsync(target, {
        mimeType: "text/markdown",
        dialogTitle: t("meetingDetail.exportDialog"),
        UTI: "net.daringfireball.markdown",
      });
    } catch {
      setExportMessage(null);
      Alert.alert(t("meetingDetail.noFormalNotesTitle"), t("meetingDetail.noFormalNotesBody"));
    }
  }

  async function copyShareLink() {
    if (!selectedMeeting) return;
    try {
      await Clipboard.setStringAsync(buildShareUrl(selectedMeeting.meetingId));
      setShareMessage(t("meetingDetail.shareLinkCopiedMessage"));
      Alert.alert(t("meetingDetail.markdownCopiedTitle"), t("meetingDetail.shareLinkCopiedBody"));
    } catch {
      const message = t("meetingDetail.clipboardUnavailable");
      setShareMessage(t("meetingDetail.copyLinkFailed", { message }));
      Alert.alert(t("meetingDetail.copyFailedTitle"), message);
    }
  }

  async function sharePublicLink() {
    if (!selectedMeeting) return;
    const url = buildShareUrl(selectedMeeting.meetingId);
    try {
      await Share.share({
        message: `${selectedMeeting.title}\n${url}`,
        title: selectedMeeting.title,
        url,
      });
      setShareMessage(t("meetingDetail.systemShareClosed"));
    } catch {
      const shareError = t("meetingDetail.systemShareFailed");
      try {
        await Clipboard.setStringAsync(url);
        setShareMessage(t("meetingDetail.systemShareCopied"));
        Alert.alert(t("meetingDetail.copiedLinkTitle"), t("meetingDetail.copiedLinkBody", { message: shareError }));
      } catch {
        const copyMessage = t("meetingDetail.clipboardUnavailable");
        setShareMessage(t("meetingDetail.shareAndCopyFailed", { message: copyMessage }));
        Alert.alert(t("meetingDetail.unableShareTitle"), `${shareError}\n\n${copyMessage}`);
      }
    }
  }

  function buildShareUrl(id: string) {
    return `${apiBaseUrl.replace(/\/$/, "")}/share/${id}`;
  }

  async function getExportMarkdown() {
    if (officialMarkdown) return officialMarkdown;
    if (!sessionCookie || !canExportMarkdown) {
      throw new Error(t("meetingDetail.markdownNotReady"));
    }

    try {
      const exported = await fetchMeetingMarkdown(apiBaseUrl, selectedMeeting?.meetingId ?? meetingId, sessionCookie);
      if (selectedMeeting) {
        setSelectedMeeting((current) => current?.meetingId === selectedMeeting.meetingId ? { ...current, obsidianMarkdown: exported } : current);
      } else {
        setFormalMarkdown(exported);
      }
      return exported;
    } catch {
      throw new Error(t("meetingDetail.markdownFetchFailed"));
    }
  }

  async function checkAdminDiagnostics(value = apiBaseUrl) {
    if (!sessionCookie || currentUser?.role !== "admin") {
      setLastError(t("runtime.adminDiagnosticsPermission"));
      return;
    }
    const targetApiBaseUrl = normalizeApiBaseUrl(value);
    updateApiBaseUrl(targetApiBaseUrl);
    setBackendChecking(true);
    try {
      setLastError(null);
      await persistApiBaseUrl(targetApiBaseUrl);
      const health = await fetchBackendHealth(targetApiBaseUrl);
      setBackendHealth(health);
      const [readiness, diagnostic] = await Promise.all([
        fetchReleaseReadinessSummary(targetApiBaseUrl, sessionCookie),
        fetchProviderDiagnostic(targetApiBaseUrl, sessionCookie),
      ]);
      setReleaseSummary(readiness.summary);
      setReleaseBlockers(readiness.blockers);
      setProviderDiagnostic(diagnostic);
    } catch (error) {
      setReleaseSummary(null);
      setReleaseBlockers([]);
      setProviderDiagnostic(null);
      setLastError(t(
        error instanceof AdminDiagnosticsAccessError
          ? "runtime.adminDiagnosticsPermission"
          : "runtime.adminDiagnosticsFailed",
      ));
    } finally {
      setBackendChecking(false);
    }
  }

  async function checkBackend(value = apiBaseUrl) {
    const targetApiBaseUrl = normalizeApiBaseUrl(value);
    updateApiBaseUrl(targetApiBaseUrl);
    setBackendChecking(true);
    setLastError(null);

    try {
      await persistApiBaseUrl(targetApiBaseUrl);
      const health = await fetchBackendHealth(targetApiBaseUrl);
      setBackendHealth(health);
      setReleaseSummary(null);
      setReleaseBlockers([]);
      setProviderDiagnostic(null);
    } catch {
      setBackendHealth(null);
      setReleaseSummary(null);
      setReleaseBlockers([]);
      setProviderDiagnostic(null);
      setLastError(t("runtime.backendCheckFailed"));
    } finally {
      setBackendChecking(false);
    }
  }

  const historyFilterOptions: Array<{ id: MeetingHistoryFilter; label: string }> = [
    { id: "all", label: t("meetings.all") },
    { id: "completed", label: t("meetings.completed") },
    { id: "pending", label: t("meetings.pending") },
    { id: "shared", label: t("meetings.shared") },
  ];
  const heroActionLabel =
    !currentUser
      ? t("record.signInToRecord")
      : hasIsolatedRecovery
        ? t("record.newMeeting")
      : hasInterruptedRecording
        ? t("record.recover")
      : canResetMeeting
        ? t("record.newMeeting")
      : status === "recording" || status === "paused"
        ? t("record.endMeeting")
        : recordingStartPreflightBusy || status === "requesting"
          ? t("record.preparing")
        : status === "processing"
          ? t("record.processing")
          : t("record.startRecording");
  const heroActionDisabled =
    recordingStartPreflightBusy ||
    status === "requesting" ||
    status === "processing" ||
    recordingTransitionBusy;
  const activeTabTitle = activeTab === "meetings"
    ? t("nav.meetings")
    : activeTab === "settings"
      ? t("nav.settings")
      : activeTab === "account"
        ? t("nav.account")
        : t("record.title");
  const showPrimaryNavigation = Boolean(currentUser);
  const heroAction = () => {
    if (heroActionDisabled) return;
    if (hasIsolatedRecovery) {
      void resetMeeting();
      return;
    }
    if (hasInterruptedRecording) {
      void retryUpload();
      return;
    }
    if (status === "recording" || status === "paused") {
      void stopRecording();
      return;
    }
    if (canResetMeeting) {
      void resetMeeting();
      return;
    }
    void startRecording();
  };

  if (!i18nReady || !apiBaseUrlRestored || !sessionRestoreComplete) {
    return <AppLaunchScreen />;
  }

  return (
    <SafeAreaProvider>
      <IapPlanStoreProvider
        session={currentUser && sessionCookie
          ? {
              apiBaseUrl,
              authCookie: sessionCookie,
              currentUser,
              onEntitlementUpdated: handleEntitlementUpdated,
              onError: handlePaymentError,
            }
          : null}
      >
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <ScrollView
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          key={currentUser ? `authenticated-${currentUser.id}` : "unauthenticated"}
          ref={mainScrollRef}
          contentContainerStyle={[styles.content, !showPrimaryNavigation ? styles.contentWithoutNavigation : null]}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {activeTab === "account" && !currentUser ? null : (
            <View style={styles.header}>
              <View style={styles.headerTitleBlock}>
                {activeTab === "settings" ? (
                  <Pressable
                    accessibilityLabel={t("nav.account")}
                    accessibilityRole="button"
                    onPress={() => setActiveTab("account")}
                    style={({ pressed }) => [styles.headerBackButton, pressed ? styles.buttonPressed : null]}
                  >
                    <Ionicons accessibilityElementsHidden color="#25322d" name="chevron-back" size={23} />
                  </Pressable>
                ) : null}
                <View style={styles.headerTitleText}>
                  {activeTab === "record" ? (
                    <>
                      <Text style={styles.eyebrow}>OwnMinutes</Text>
                      <Text accessibilityRole="header" style={styles.title}>{t("record.title")}</Text>
                    </>
                  ) : <Text accessibilityRole="header" style={styles.title}>{activeTabTitle}</Text>}
                </View>
              </View>
            </View>
          )}

        {activeTab === "record" ? (
          <>
            {sessionReauthenticationRequired ? (
              <View accessibilityRole="alert" style={[styles.offlineSessionBanner, styles.sessionExpiredBanner]}>
                <Ionicons accessibilityElementsHidden color="#a34432" name="lock-closed-outline" size={18} />
                <View style={styles.offlineSessionBannerTextBlock}>
                  <Text style={[styles.offlineSessionBannerTitle, styles.sessionExpiredBannerTitle]}>{t("auth.sessionExpired")}</Text>
                  <Text style={[styles.offlineSessionBannerText, styles.sessionExpiredBannerText]}>
                    {recordingLifecycleBusy
                      ? t("auth.sessionExpiredRecording")
                      : t("auth.sessionExpiredIdle")}
                  </Text>
                </View>
              </View>
            ) : null}
            {offlineSessionRestored ? (
              <View accessibilityRole="alert" style={styles.offlineSessionBanner}>
                <Ionicons accessibilityElementsHidden color="#8b642d" name="cloud-offline-outline" size={18} />
                <View style={styles.offlineSessionBannerTextBlock}>
                  <Text style={styles.offlineSessionBannerTitle}>{t("record.offlineTitle")}</Text>
                  <Text style={styles.offlineSessionBannerText}>{t("record.offlineDetail")}</Text>
                </View>
              </View>
            ) : null}
            {firstRunGuide && !recordingStartPreflightBusy && status === "idle" && !canShowMeetingProgress ? (
              <FirstRunGuideCard
                guide={firstRunGuide}
                onPrimary={() => handleFirstRunAction(firstRunGuide.primaryAction)}
                onSecondary={firstRunGuide.secondaryAction ? () => handleFirstRunAction(firstRunGuide.secondaryAction!) : undefined}
              />
            ) : null}
            <View style={styles.recorderHero}>
              <View style={styles.heroHeader}>
                <View style={styles.heroMeetingBlock}>
                  <View style={styles.heroStatusRow}>
                    <View style={[styles.liveDot, recordingActive ? styles.liveDotActive : null]} />
                    <Text style={styles.heroStatusText}>{postMeetingPresentation?.statusLabel ?? statusLabel(status, locale)}</Text>
                  </View>
                </View>
                <View style={[styles.heroLocalStatus, recordingFileHealthWarning ? styles.heroLocalStatusWarning : null]}>
                  <Ionicons accessibilityElementsHidden name={heroLocalStatusIcon} size={14} color={heroLocalStatusColor} />
                  <Text style={[styles.heroLocalStatusText, recordingFileHealthWarning ? styles.heroLocalStatusTextWarning : null]}>
                    {heroLocalStatusLabel}
                  </Text>
                </View>
              </View>

              {!recordingActive && !formalMarkdown && !activeMeetingResult && status !== "processing" ? (
                <TextInput
                  accessibilityLabel={t("record.meetingTitle")}
                  autoCapitalize="sentences"
                  autoComplete="off"
                  autoCorrect={false}
                  importantForAutofill="no"
                  maxLength={80}
                  onChangeText={setMeetingTitle}
                  placeholder={t("record.meetingTitlePlaceholder")}
                  placeholderTextColor="#87918c"
                  returnKeyType="done"
                  secureTextEntry={false}
                  selectTextOnFocus
                  style={styles.heroMeetingTitleInput}
                  textContentType="none"
                  value={meetingTitle}
                />
              ) : (
                <Text numberOfLines={2} style={styles.heroMeetingTitle}>{meetingTitle}</Text>
              )}
              <Text style={styles.heroMeetingSubtitle}>
                {recordingActive
                  ? t("record.recording")
                  : hasInterruptedRecording
                    ? t("record.interrupted")
                  : postMeetingPresentation
                    ? postMeetingPresentation.subtitle
                    : meetingFinalized
                    ? activeMeetingNoSpeech
                      ? t("record.noSpeech")
                      : activeMeetingQuality.status === "verified"
                      ? t("record.organized")
                      : activeMeetingResult
                        ? t("record.needsProcessing")
                        : t("record.completed")
                    : t("record.ready")}
              </Text>
              {activeMeetingBilling ? (
                <MeetingCostIndicator item={activeMeetingBilling} />
              ) : meetingCostPreview && !(firstRunGuide && status === "idle" && !canShowMeetingProgress) ? (
                <MeetingCostIndicator item={meetingCostPreview} />
              ) : null}
              <View style={styles.heroStage}>
                <View style={styles.heroTimerCard}>
                  <Text style={styles.timer}>{formatDuration(durationSeconds)}</Text>
                  <View style={styles.waveformStrip} accessibilityElementsHidden>
                    {Array.from({ length: 36 }).map((_, index) => (
                      <View
                        key={index}
                        style={[
                          styles.waveformBar,
                          recordingActive ? styles.waveformBarActive : null,
                          { height: 4 + ((index * 9) % 20) + (recordingActive ? Math.round(Math.min(100, Math.max(0, metering)) / 9) : 0) },
                        ]}
                      />
                    ))}
                  </View>
                </View>

                <View style={styles.heroActionButtons}>
                  {recordingActive ? (
                    <Pressable
                      accessibilityLabel={status === "recording" ? t("record.pause") : t("record.resume")}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: recordingTransitionBusy }}
                      disabled={recordingTransitionBusy}
                      onPress={status === "recording" ? pauseRecording : resumeRecording}
                      style={({ pressed }) => [
                        styles.heroSecondaryAction,
                        recordingTransitionBusy ? styles.buttonDisabled : null,
                        pressed ? styles.buttonPressed : null,
                      ]}
                    >
                      <Ionicons accessibilityElementsHidden name={status === "recording" ? "pause" : "play"} size={20} color="#31423a" />
                    </Pressable>
                  ) : <View style={styles.heroSidePlaceholder} />}
                  <Pressable
                    accessibilityLabel={heroActionLabel}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: heroActionDisabled }}
                    disabled={heroActionDisabled}
                    onPress={heroAction}
                    style={({ pressed }) => [
                      styles.heroPrimaryAction,
                      recordingActive ? styles.heroPrimaryActionStop : null,
                      heroActionDisabled ? styles.heroPrimaryButtonDisabled : null,
                      pressed ? styles.buttonPressed : null,
                    ]}
                  >
                    <Ionicons accessibilityElementsHidden name={recordingActive ? "stop" : hasInterruptedRecording ? "refresh" : canResetMeeting ? "add" : "mic"} size={32} color="#ffffff" />
                  </Pressable>
                  <View style={styles.heroSidePlaceholder} />
                </View>
                <Text style={[styles.heroPrimaryActionLabel, recordingActive ? styles.heroPrimaryActionLabelStop : null]}>
                  {recordingActive ? t("record.endMeeting") : heroActionLabel}
                </Text>
                <Text style={styles.heroHint}>{heroHint}</Text>
                {recordingActive && recordingFileHealthWarning ? (
                  <View style={[styles.heroFileHealth, recordingFileHealthWarning ? styles.heroFileHealthWarning : null]}>
                    <Ionicons
                      accessibilityElementsHidden
                      color={recordingFileHealthWarning ? "#b54735" : "#23745b"}
                      name={recordingFileHealthWarning ? "warning-outline" : "shield-checkmark-outline"}
                      size={15}
                    />
                    <Text style={[styles.heroFileHealthText, recordingFileHealthWarning ? styles.heroFileHealthTextWarning : null]}>
                      {recordingFileHealthMessage}
                    </Text>
                  </View>
                ) : null}
                {recordingActive && recordingStorageWarning ? (
                  <View accessibilityRole="alert" style={[styles.heroFileHealth, styles.heroFileHealthWarning]}>
                    <Ionicons accessibilityElementsHidden color="#b54735" name="warning-outline" size={15} />
                    <Text accessibilityLiveRegion="polite" style={[styles.heroFileHealthText, styles.heroFileHealthTextWarning]}>
                      {recordingStorageMessage}
                    </Text>
                  </View>
                ) : null}
                {recordingActive && recordingDurationLimit.shouldWarn ? (
                  <View accessibilityRole="alert" style={[styles.heroFileHealth, styles.heroFileHealthWarning]}>
                    <Ionicons accessibilityElementsHidden color="#b54735" name="time-outline" size={15} />
                    <Text accessibilityLiveRegion="polite" style={[styles.heroFileHealthText, styles.heroFileHealthTextWarning]}>
                      {recordingDurationMessage}
                    </Text>
                  </View>
                ) : null}
                {lastError ? <Text accessibilityLiveRegion="polite" style={styles.heroRecordingError}>{lastError}</Text> : null}
                {recordingRecoveryError ? <Text accessibilityLiveRegion="polite" style={styles.heroRecordingError}>{recordingRecoveryError}</Text> : null}
              </View>
            </View>

          {canShowMeetingProgress ? (
          <View style={styles.recordSegmentShell}>
            {!recordingActive ? <View style={styles.recordSegmentTabs}>
              <Pressable
                accessibilityLabel={t("record.transcript")}
                accessibilityRole="tab"
                accessibilityState={{ selected: recordSegment === "transcript" }}
                onPress={() => setRecordSegment("transcript")}
                style={({ pressed }) => [styles.recordSegmentButton, recordSegment === "transcript" ? styles.recordSegmentButtonActive : null, pressed ? styles.buttonPressed : null]}
              >
                <Ionicons accessibilityElementsHidden name="pulse-outline" size={17} color={recordSegment === "transcript" ? "#14795b" : "#6d7973"} />
                <Text style={[styles.recordSegmentText, recordSegment === "transcript" ? styles.recordSegmentTextActive : null]}>{t("record.transcript")}</Text>
              </Pressable>
              <Pressable
                accessibilityLabel={t("record.notes")}
                accessibilityRole="tab"
                accessibilityState={{ selected: recordSegment === "notes" }}
                onPress={() => setRecordSegment("notes")}
                style={({ pressed }) => [styles.recordSegmentButton, recordSegment === "notes" ? styles.recordSegmentButtonActive : null, pressed ? styles.buttonPressed : null]}
              >
                <Ionicons accessibilityElementsHidden name="sparkles-outline" size={17} color={recordSegment === "notes" ? "#14795b" : "#6d7973"} />
                <Text style={[styles.recordSegmentText, recordSegment === "notes" ? styles.recordSegmentTextActive : null]}>{t("record.notes")}</Text>
              </Pressable>
            </View> : null}

            <View style={styles.recordResultPanel}>
              {recordSegment === "transcript" ? (
                <>
                  <View style={styles.resultHeader}>
                    <View>
                      <Text style={styles.resultTitle}>{t("record.transcript")}</Text>
                      <Text style={styles.resultSubtitle}>{t("record.transcriptEmpty")}</Text>
                    </View>
                    <Text style={styles.resultBadge}>{t("record.transcriptCount", { count: transcriptCount })}</Text>
                  </View>
                  {segments.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Text accessibilityElementsHidden style={styles.emptyStateIcon}>◉</Text>
                      <Text style={styles.emptyStateTitle}>{status === "recording" || status === "paused" ? t("record.waitingForTranscript") : t("record.noTranscript")}</Text>
                      <Text style={styles.emptyStateText}>{t("record.transcriptHint")}</Text>
                    </View>
                  ) : (
                    segments.map((segment) => (
                      <View key={segment.id} style={styles.transcriptItem}>
                        <Text style={styles.transcriptMeta}>
                          {segment.timestamp} / {segment.speaker}
                        </Text>
                        <Text style={styles.transcriptText}>{segment.text}</Text>
                      </View>
                    ))
                  )}
                  {(status === "recording" || status === "paused") && realtimeTranscriptionWarning ? (
                    <Text accessibilityLiveRegion="polite" style={styles.warning}>
                      {realtimeTranscriptionWarning}
                    </Text>
                  ) : null}
                </>
              ) : (
                <>
                  <View style={styles.resultHeader}>
                    <View>
                      <Text style={styles.resultTitle}>{t("record.notes")}</Text>
                      <Text style={styles.resultSubtitle}>
                        {formalMarkdown || activeMeetingResult
                          ? activeMeetingQuality.status === "verified"
                            ? t("record.notesReady")
                            : activeMeetingNoSpeech
                              ? t("record.notesNoSpeech")
                            : t("record.notesModelMissing")
                          : t("record.notesPending")}
                      </Text>
                    </View>
                    <Text
                      style={
                        formalMarkdown || activeMeetingResult
                          ? activeMeetingQuality.status === "verified"
                            ? styles.publicBadge
                            : styles.warningBadge
                          : styles.privateBadge
                      }
                    >
                      {formalMarkdown || activeMeetingResult
                        ? activeMeetingQuality.status === "verified"
                          ? t("record.generated")
                          : activeMeetingNoSpeech
                            ? t("record.unrecognized")
                          : t("record.incomplete")
                        : t("record.pendingGeneration")}
                    </Text>
                  </View>
                  {activeMeetingResult ? (
                    <>
                      <Text style={styles.help}>{activeMeetingResult.summary.summary}</Text>
                      {activeMeetingResult.summary.speakerViews.length ? (
                        <View style={styles.notesSection}>
                          <Text style={styles.detailTitle}>{t("record.speakerViews")}</Text>
                          {activeMeetingResult.summary.speakerViews.slice(0, 3).map((item, index) => (
                            <View key={`${item.speaker}-${index}`} style={styles.detailBlock}>
                              <Text style={styles.detailTitle}>{item.speaker}</Text>
                              <Text style={styles.help}>{item.view}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                      {activeMeetingResult.summary.decisions.length ? (
                        <View style={styles.notesSection}>
                          <Text style={styles.detailTitle}>{t("record.decisions")}</Text>
                          {activeMeetingResult.summary.decisions.slice(0, 3).map((decision) => (
                            <View key={decision.id} style={styles.detailBlock}>
                              <Text style={styles.detailTitle}>{decision.title}</Text>
                              <Text style={styles.help}>{decision.detail}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                      {activeMeetingResult.summary.actionItems.length ? (
                        <View style={styles.notesSection}>
                          <Text style={styles.detailTitle}>{t("record.actions")}</Text>
                          {activeMeetingResult.summary.actionItems.slice(0, 3).map((item) => (
                            <View key={item.id} style={styles.detailBlock}>
                              <Text style={styles.detailTitle}>{item.task}</Text>
                              <Text style={styles.help}>{item.owner} / {item.due}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </>
                  ) : (
                    <View style={styles.emptyState}>
                      {status === "processing" && postMeetingPresentation?.progress ? (
                        <>
                          <ActivityIndicator color="#14795b" size="small" />
                          <Text style={styles.processingStepLabel}>{t("record.progressStep", { step: postMeetingPresentation.progress.step, total: 3 })}</Text>
                          <Text style={styles.emptyStateTitle}>{postMeetingPresentation.progress.title}</Text>
                          <Text style={styles.emptyStateText}>{postMeetingPresentation.progress.detail}</Text>
                          <View accessibilityLabel={t("record.progressAccessibility", { step: postMeetingPresentation.progress.step, total: 3 })} style={styles.processingStepTrack}>
                            {[1, 2, 3].map((step) => (
                              <View key={step} style={[styles.processingStepDot, step <= postMeetingPresentation.progress!.step ? styles.processingStepDotActive : null]} />
                            ))}
                          </View>
                        </>
                      ) : (
                        <>
                      <Ionicons accessibilityElementsHidden color="#718079" name="document-text-outline" size={28} />
                          <Text style={styles.emptyStateTitle}>{t("record.noFormalNotesTitle")}</Text>
                          <Text style={styles.emptyStateText}>{t("record.noFormalNotesDetail")}</Text>
                        </>
                      )}
                    </View>
                  )}
                  {uploadState.diagnostic ? <Text style={styles.warning}>{uploadState.diagnostic}</Text> : null}
                  {uploadState.lastError ? <Text style={styles.error}>{uploadState.lastError}</Text> : null}
                  <View style={styles.buttonRow}>
                    <ActionButton label={t("record.copyMarkdown")} kind="secondary" disabled={!canExportMarkdown} onPress={copyMarkdown} />
                    <ActionButton label={t("record.exportObsidian")} kind="primary" disabled={!canExportMarkdown} onPress={shareMarkdown} />
                  </View>
                  {exportMessage ? <Text style={styles.success}>{exportMessage}</Text> : null}
                  {hasInterruptedRecording && canResetMeeting ? (
                    <Text style={styles.help}>{t("record.interruptedNewMeetingKeepsAudio")}</Text>
                  ) : null}
                  {recordedUri || pendingRecording ? (
                    <View style={styles.buttonRow}>
                      {canResetMeeting ? <ActionButton label={t("record.newMeeting")} kind="secondary" onPress={resetMeeting} /> : null}
                      {!pendingRecording?.activeRecording || hasInterruptedRecording ? (
                        <ActionButton disabled={recordingLifecycleBusy} label={hasInterruptedRecording ? t("record.recover") : pendingRecording?.finalizedAt ? t("record.regenerate") : pendingRecording?.audioUploadedAt ? t("record.retryProcessing") : t("record.retryUpload")} kind="secondary" onPress={retryUpload} />
                      ) : null}
                      <ActionButton disabled={recordingLifecycleBusy} label={t("record.exportAudio")} kind="secondary" onPress={shareLocalRecording} />
                    </View>
                  ) : null}
                  {autoSyncMessage ? (
                    <View style={styles.autoSyncNotice}>
                      <Ionicons accessibilityElementsHidden color={autoSyncTone === "warning" ? "#9a6d35" : "#1f6f55"} name="cloud-upload-outline" size={17} />
                      <Text accessibilityLiveRegion="polite" style={styles.autoSyncNoticeText}>{autoSyncMessage}</Text>
                    </View>
                  ) : null}
                </>
              )}
            </View>
          </View>
          ) : null}
          </>
        ) : null}

        {activeTab === "meetings" ? (
          <>
            {!selectedMeeting && !selectedLocalRecording ? (
              <Panel title={t("meetings.title")}>
              {showDeviceLegacyRecovery ? (
                <View style={styles.localRecordingSection}>
                  <View style={styles.historyListHeader}>
                    <View>
                      <Text style={styles.meetingDetailSectionTitle}>
                        {t("runtime.localRecoveryHubTitle", { count: deviceLegacyRecoveryRecordings.length })}
                      </Text>
                      <Text style={styles.help}>{t("runtime.localRecoveryHubDetail")}</Text>
                    </View>
                  </View>
                  {deviceLegacyRecoveryRecordings.map((recording) => (
                    <Pressable
                      accessibilityLabel={t("runtime.openLocalRecording", { title: recording.title || t("runtime.untitledLocalRecording") })}
                      accessibilityRole="button"
                      key={`local-${recording.meetingId}`}
                      onPress={() => openLocalRecording(recording)}
                      style={styles.meetingItem}
                    >
                      <View style={styles.meetingHeader}>
                        <Text numberOfLines={1} style={styles.meetingTitle}>{recording.title || t("runtime.untitledLocalRecording")}</Text>
                        <Text style={styles.privateBadge}>{t("runtime.localRecoveryBadge")}</Text>
                      </View>
                      <Text style={styles.help}>
                        {formatShortDate(recording.createdAt, locale)} · {formatDuration(Math.round((recording.durationMs ?? 0) / 1000))}
                      </Text>
                      <Text style={styles.warning}>{t("runtime.localRecoveryReadOnly")}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {showStandaloneLocalRecordings ? (
                <View style={styles.localRecordingSection}>
                  <View style={styles.historyListHeader}>
                    <View>
                      <Text style={styles.meetingDetailSectionTitle}>{t("runtime.localRecordingsTitle")}</Text>
                      <Text style={styles.help}>{t("runtime.localRecordingsDetail", { count: standaloneLocalRecordings.length })}</Text>
                    </View>
                  </View>
                  {standaloneLocalRecordings.map((recording) => (
                    <Pressable
                      accessibilityLabel={t("runtime.openLocalRecording", { title: recording.title || t("runtime.untitledLocalRecording") })}
                      accessibilityRole="button"
                      key={`local-${recording.meetingId}`}
                      onPress={() => openLocalRecording(recording)}
                      style={styles.meetingItem}
                    >
                      <View style={styles.meetingHeader}>
                        <Text numberOfLines={1} style={styles.meetingTitle}>{recording.title || t("runtime.untitledLocalRecording")}</Text>
                        <Text style={styles.privateBadge}>{t("runtime.localOnlyBadge")}</Text>
                      </View>
                      <Text style={styles.help}>
                        {formatShortDate(recording.createdAt, locale)} · {formatDuration(Math.round((recording.durationMs ?? 0) / 1000))}
                      </Text>
                      <Text style={styles.help}>
                        {t(
                          recording.processingMode === "official_quota"
                            ? "processingMode.frozenOfficial"
                            : recording.processingMode === "byok"
                              ? "processingMode.frozenByok"
                              : "processingMode.legacyRequired",
                        )}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {showHistoryControls ? <>
              <View style={styles.historySearchField}>
                <Ionicons accessibilityElementsHidden color="#718079" name="search-outline" size={19} />
                <TextInput
                  accessibilityLabel={t("meetings.search")}
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  importantForAutofill="no"
                  onChangeText={(value) => {
                    setHistoryQuery(value);
                    setHistoryVisibleCount(historyPageSize);
                  }}
                  placeholder={t("meetings.searchPlaceholder")}
                  placeholderTextColor="#8b948f"
                  returnKeyType="search"
                  secureTextEntry={false}
                  style={styles.historySearchInput}
                  textContentType="none"
                  value={historyQuery}
                />
                {historyQuery ? (
                  <Pressable
                    accessibilityLabel={t("meetings.clearSearch")}
                    accessibilityRole="button"
                    hitSlop={8}
                    onPress={() => {
                      setHistoryQuery("");
                      setHistoryVisibleCount(historyPageSize);
                    }}
                    style={styles.historyClearButton}
                  >
                    <Ionicons accessibilityElementsHidden color="#718079" name="close-circle" size={20} />
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.historyFilterTabs}>
                {historyFilterOptions.map((option) => (
                  <Pressable
                    accessibilityLabel={option.label}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: historyFilter === option.id }}
                    key={option.id}
                    onPress={() => {
                      setHistoryFilter(option.id);
                      setHistoryVisibleCount(historyPageSize);
                    }}
                    style={[styles.historyFilterTab, historyFilter === option.id ? styles.historyFilterTabActive : null]}
                  >
                    <Text style={[styles.historyFilterText, historyFilter === option.id ? styles.historyFilterTextActive : null]}>{option.label}</Text>
                  </Pressable>
                ))}
              </View>
              </> : null}
              <View style={styles.historyListHeader}>
                <Text style={styles.historyResultCount}>
                  {filteredMeetings.length === meetings.length
                    ? t("meetings.meetingCount", { count: meetings.length })
                    : t("meetings.filteredCount", { filtered: filteredMeetings.length, total: meetings.length })}
                </Text>
                <Pressable accessibilityLabel={t("meetings.refreshHistory")} accessibilityRole="button" accessibilityState={{ disabled: historyLoading }} disabled={historyLoading} onPress={() => void refreshMeetings()} style={styles.historyRefreshButton}>
                  {historyLoading ? <ActivityIndicator color="#14795b" size="small" /> : <Ionicons accessibilityElementsHidden color="#14795b" name="refresh" size={19} />}
                </Pressable>
              </View>
              {historyError ? (
                <Text accessibilityLiveRegion="polite" style={styles.error}>
                  {t("runtime.historyRefreshNotice")}
                </Text>
              ) : null}
              {meetings.length === 0 ? (
                <Text style={styles.empty}>
                  {showStandaloneLocalRecordings || showDeviceLegacyRecovery
                    ? t("runtime.noSyncedMeetings")
                    : t("meetings.signInEmpty")}
                </Text>
              ) : filteredMeetings.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons accessibilityElementsHidden color="#718079" name="search-outline" size={28} />
                  <Text style={styles.emptyStateTitle}>{t("meetings.noResults")}</Text>
                  <Text style={styles.emptyStateText}>{t("meetings.noResultsDetail")}</Text>
                </View>
              ) : (
                visibleMeetings.map((item) => (
                  <Pressable accessibilityRole="button" key={item.meetingId} style={styles.meetingItem} onPress={() => void openMeetingDetail(item)}>
                    <View style={styles.meetingHeader}>
                      <Text style={styles.meetingTitle} numberOfLines={1}>{item.title}</Text>
                      <Text style={item.processing?.status === "failed" ? styles.dangerBadge : item.hasResult ? styles.publicBadge : styles.privateBadge}>
                        {mobileMeetingProcessingLabel(item, locale)}
                      </Text>
                    </View>
                    <Text style={styles.help}>
                      {formatShortDate(item.generatedAt ?? item.updatedAt, locale)} · {formatDuration(Math.round(item.durationMs / 1000))}
                    </Text>
                  </Pressable>
                ))
              )}
              {visibleMeetings.length < filteredMeetings.length ? (
                <View style={styles.historyLoadMore}>
                  <ActionButton
                    label={t("meetings.loadMore", { count: Math.min(historyPageSize, filteredMeetings.length - visibleMeetings.length) })}
                    kind="secondary"
                    onPress={() => setHistoryVisibleCount((count) => count + historyPageSize)}
                  />
                </View>
              ) : null}
              </Panel>
            ) : null}

            {selectedLocalRecording ? (
              <Panel title={t("runtime.localRecordingDetailTitle")}>
                <Pressable accessibilityLabel={t("runtime.backToRecordingList")} accessibilityRole="button" onPress={closeLocalRecording} style={({ pressed }) => [styles.meetingDetailBack, pressed ? styles.buttonPressed : null]}>
                  <Ionicons accessibilityElementsHidden color="#14795b" name="chevron-back" size={21} />
                  <Text style={styles.meetingDetailBackText}>{t("runtime.localRecordingsTitle")}</Text>
                </Pressable>
                <View style={styles.meetingHeader}>
                  <Text style={styles.meetingTitle}>{selectedLocalRecording.title || t("runtime.untitledLocalRecording")}</Text>
                  <Text style={styles.privateBadge}>
                    {selectedLocalRecording.localRecoveryOnly ? t("runtime.localRecoveryBadge") : t("runtime.localOnlyBadge")}
                  </Text>
                </View>
                <Text style={styles.meetingDetailMeta}>
                  {formatShortDate(selectedLocalRecording.createdAt, locale)} · {formatDuration(Math.round((selectedLocalRecording.durationMs ?? 0) / 1000))}
                </Text>
                <Text style={styles.meetingAudioUnavailable}>{t("runtime.localRecordingSafeDetail")}</Text>
                {selectedLocalRecording.localRecoveryOnly ? (
                  <Text style={styles.warning}>{t("runtime.localRecoveryReadOnly")}</Text>
                ) : (
                  <>
                    <Text style={selectedLocalRecording.processingMode ? styles.help : styles.warning}>
                      {t(
                        selectedLocalRecording.processingMode === "official_quota"
                          ? "processingMode.frozenOfficial"
                          : selectedLocalRecording.processingMode === "byok"
                            ? "processingMode.frozenByok"
                            : "processingMode.legacyRequired",
                      )}
                    </Text>
                    {!selectedLocalRecording.finalizedAt ? (
                      <View style={styles.buttonRow}>
                        <ActionButton
                          label={t(selectedLocalRecording.processingMode ? "runtime.reconnectAndProcess" : "processingMode.legacyChoose")}
                          kind="primary"
                          onPress={() => void retryUpload(selectedLocalRecording)}
                        />
                      </View>
                    ) : null}
                  </>
                )}
                {!recordingLifecycleBusy && selectedMeetingAudioAvailability === "available" ? (
                  <LocalAudioErrorBoundary
                    key={`${selectedLocalRecording.uri}:${selectedMeetingAudioProbeVersion}`}
                    fallback={(
                      <MeetingAudioUnavailableCard
                        message={t("ux.audioUnavailable")}
                        onRetry={() => void retrySelectedMeetingLocalAudio()}
                        retryLabel={t("common.retry")}
                      />
                    )}
                  >
                    <MeetingAudioPlayer
                      controllerRef={meetingAudioControllerRef}
                      canPlay={canPlayMeetingAudio}
                      durationFallbackSeconds={Math.max(0, (selectedLocalRecording.durationMs ?? 0) / 1000)}
                      labels={{
                        back: t("ux.audioBack"),
                        export: t("ux.audioExport"),
                        forward: t("ux.audioForward"),
                        pause: t("ux.audioPause"),
                        play: t("ux.audioPlay"),
                        rate: t("ux.audioRate"),
                        title: t("ux.localAudio"),
                        unavailable: t("ux.audioUnavailable"),
                      }}
                      onExport={() => void shareSelectedMeetingRecording()}
                      uri={selectedLocalRecording.uri}
                    />
                  </LocalAudioErrorBoundary>
                ) : !recordingLifecycleBusy ? (
                  <MeetingAudioUnavailableCard
                    message={selectedMeetingAudioAvailability === "checking" ? t("common.loading") : t("ux.audioUnavailable")}
                    onRetry={() => void retrySelectedMeetingLocalAudio()}
                    retryLabel={t("common.retry")}
                  />
                ) : null}
                {!selectedLocalRecording.localRecoveryOnly ? (
                  <View style={styles.speakerLimitationNotice}>
                    <Text style={styles.speakerLimitationTitle}>{t("runtime.speechEnhancementTitle")}</Text>
                    <Text style={styles.speakerLimitationText}>{t("runtime.speechEnhancementDetail")}</Text>
                  </View>
                ) : null}
                <View style={styles.separator} />
                <Text style={styles.label}>{t("runtime.localDeleteSection")}</Text>
                <Text style={styles.help}>{t("runtime.localDeleteDetail")}</Text>
                <View style={styles.buttonRow}>
                  <ActionButton
                    disabled={localRecordingDeleting || recordingLifecycleBusy}
                    label={localRecordingDeleting ? t("common.processing") : t("runtime.localDeleteTitle")}
                    kind="danger"
                    onPress={confirmDeleteSelectedLocalRecording}
                  />
                </View>
              </Panel>
            ) : null}

            {selectedMeeting ? (
              <Panel title={t("meetings.detail")}>
                <Pressable accessibilityLabel={t("meetings.back")} accessibilityRole="button" onPress={closeMeetingDetail} style={({ pressed }) => [styles.meetingDetailBack, pressed ? styles.buttonPressed : null]}>
                  <Ionicons accessibilityElementsHidden color="#14795b" name="chevron-back" size={21} />
                  <Text style={styles.meetingDetailBackText}>{t("meetings.list")}</Text>
                </Pressable>
                <View style={styles.meetingHeader}>
                  <Text style={styles.meetingTitle}>{selectedMeeting.title}</Text>
                  <Text style={selectedMeeting.share.visibility === "public" ? styles.publicBadge : styles.privateBadge}>
                    {selectedMeeting.share.visibility === "public" ? t("meetings.public") : t("meetings.private")}
                  </Text>
                </View>
                <Text style={styles.meetingDetailStatus}>{mobileMeetingProcessingLabel(selectedMeeting, locale)}</Text>
                <Text style={styles.meetingDetailMeta}>
                  {formatShortDate(selectedMeeting.generatedAt ?? selectedMeeting.updatedAt, locale)} · {formatDuration(Math.round(selectedMeeting.durationMs / 1000))} · {t("meetings.transcriptCount", { count: selectedMeeting.transcriptCount })}
                </Text>
                {selectedMeetingBilling ? <MeetingCostIndicator item={selectedMeetingBilling} /> : null}
                {selectedMeetingLocalRecording && !recordingLifecycleBusy && selectedMeetingAudioAvailability === "available" ? (
                  <LocalAudioErrorBoundary
                    key={`${selectedMeetingLocalRecording.uri}:${selectedMeetingAudioProbeVersion}`}
                    fallback={(
                      <MeetingAudioUnavailableCard
                        message={t("ux.audioUnavailable")}
                        onRetry={() => void retrySelectedMeetingLocalAudio()}
                        retryLabel={t("common.retry")}
                      />
                    )}
                  >
                    <MeetingAudioPlayer
                      controllerRef={meetingAudioControllerRef}
                      canPlay={canPlayMeetingAudio}
                      durationFallbackSeconds={Math.max(0, selectedMeeting.durationMs / 1000)}
                      labels={{
                        back: t("ux.audioBack"),
                        export: t("ux.audioExport"),
                        forward: t("ux.audioForward"),
                        pause: t("ux.audioPause"),
                        play: t("ux.audioPlay"),
                        rate: t("ux.audioRate"),
                        title: t("ux.localAudio"),
                        unavailable: t("ux.audioUnavailable"),
                      }}
                      onExport={() => void shareSelectedMeetingRecording()}
                      uri={selectedMeetingLocalRecording.uri}
                    />
                  </LocalAudioErrorBoundary>
                ) : selectedMeetingLocalRecording && !recordingLifecycleBusy ? (
                  <MeetingAudioUnavailableCard
                    message={selectedMeetingAudioAvailability === "checking" ? t("common.loading") : t("ux.audioUnavailable")}
                    onRetry={() => void retrySelectedMeetingLocalAudio()}
                    retryLabel={t("common.retry")}
                  />
                ) : selectedMeetingLocalRecording ? null : (
                  <Text style={styles.meetingAudioUnavailable}>{t("ux.audioThisDeviceOnly")}</Text>
                )}
                {selectedMeetingLocalRecording ? (
                  <View style={styles.speakerLimitationNotice}>
                    <Text style={styles.speakerLimitationTitle}>{t("runtime.speechEnhancementTitle")}</Text>
                    <Text style={styles.speakerLimitationText}>{t("runtime.speechEnhancementDetail")}</Text>
                  </View>
                ) : null}
                <View style={styles.meetingDetailSummary}>
                  <Text style={styles.detailTitle}>{t("meetings.summary")}</Text>
                  <Text style={styles.help}>{selectedMeeting.result?.summary.summary ?? t("meetings.resultPending")}</Text>
                </View>
                {!selectedMeeting.result || selectedMeeting.processing?.status === "failed" ? (
                  <View style={styles.buttonRow}>
                    <ActionButton
                      disabled={selectedFinalizing}
                      label={selectedFinalizing ? t("common.processing") : selectedMeeting.processing?.status === "failed" ? t("record.retryProcessing") : t("meetings.generateNotes")}
                      kind="primary"
                      onPress={() => void retrySelectedMeetingFinalization()}
                    />
                  </View>
                ) : null}
                {selectedMeeting.result?.summary.decisions.length ? (
                  <View style={styles.notesSection}>
                    <Text style={styles.meetingDetailSectionTitle}>{t("meetingDetail.keyDecisions")}</Text>
                    {selectedMeeting.result.summary.decisions.slice(0, 5).map((decision) => (
                      <View key={decision.id} style={styles.detailBlock}>
                        <Text style={styles.detailTitle}>{decision.title}</Text>
                        <Text style={styles.help}>{decision.detail}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {selectedMeeting.result?.summary.actionItems.length ? (
                  <View style={styles.notesSection}>
                    <Text style={styles.meetingDetailSectionTitle}>{t("meetingDetail.actionItems")}</Text>
                    {selectedMeeting.result.summary.actionItems.slice(0, 5).map((item) => (
                      <View key={item.id} style={styles.detailBlock}>
                        <Text style={styles.detailTitle}>{item.task}</Text>
                        <Text style={styles.help}>{item.owner} · {item.due}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {selectedMeetingTranscript.length > 0 ? (
                  <>
                    <SectionToggle
                      detail={t("ux.transcriptDetail", { count: selectedMeetingTranscript.length })}
                      expanded={showTranscriptReview}
                      icon="document-text-outline"
                      label={t("ux.transcript")}
                      onPress={() => setShowTranscriptReview((value) => !value)}
                    />
                    {showTranscriptReview ? (
                      <>
                        <View style={styles.transcriptReviewList}>
                          {visibleSelectedMeetingTranscript.map((segment) => (
                            <Pressable
                              accessibilityLabel={t("ux.playTranscriptAt", { timestamp: segment.timestamp })}
                              accessibilityRole="button"
                              accessibilityState={{ disabled: selectedMeetingAudioAvailability !== "available" || recordingLifecycleBusy }}
                              disabled={selectedMeetingAudioAvailability !== "available" || recordingLifecycleBusy}
                              key={segment.id}
                              onPress={() => playTranscriptAt(segment.timestamp)}
                              style={({ pressed }) => [styles.transcriptPlaybackItem, pressed ? styles.buttonPressed : null]}
                            >
                              <View style={styles.transcriptReviewHeader}>
                                <Text style={styles.transcriptReviewTime}>{segment.timestamp}</Text>
                                <Text style={styles.transcriptReviewCurrent}>{segment.speaker}</Text>
                              </View>
                              <Text style={styles.transcriptReviewText}>{segment.text}</Text>
                            </Pressable>
                          ))}
                        </View>
                        {transcriptVisibleCount < selectedMeetingTranscript.length ? (
                          <View style={styles.historyLoadMore}>
                            <ActionButton
                              label={t("meetingDetail.loadMoreTranscript", { count: Math.min(transcriptReviewPageSize, selectedMeetingTranscript.length - transcriptVisibleCount) })}
                              kind="secondary"
                              onPress={() => setTranscriptVisibleCount((count) => count + transcriptReviewPageSize)}
                            />
                          </View>
                        ) : null}
                      </>
                    ) : null}
                  </>
                ) : null}
                <SectionToggle
                  detail={selectedMeeting.share.visibility === "public" ? t("meetingDetail.sharePublicDetail") : t("meetingDetail.sharePrivateDetail")}
                  expanded={showShareControls}
                  icon="share-social-outline"
                  label={t("meetings.sharing")}
                  onPress={() => {
                    setShowMeetingTools(false);
                    setShowShareControls((value) => !value);
                  }}
                />
                {!showShareControls ? (
                  <SectionToggle
                    detail={t("ux.moreToolsDetail")}
                    expanded={showMeetingTools}
                    icon="ellipsis-horizontal-circle-outline"
                    label={t("ux.moreTools")}
                    onPress={() => {
                      setShowShareControls(false);
                      setShowMeetingTools((value) => !value);
                    }}
                  />
                ) : null}
                {showMeetingTools ? (
                  <>
                    <SectionToggle
                      detail={[
                        selectedMeeting.metadata.project || t("meetingDetail.unfiled"),
                        selectedMeeting.metadata.participants.length
                          ? t("meetingDetail.participantCount", { count: selectedMeeting.metadata.participants.length })
                          : t("meetingDetail.participantsMissing"),
                      ].join(" · ")}
                      expanded={showMetadataEditor}
                      icon="information-circle-outline"
                      label={t("meetings.meetingInfo")}
                      onPress={() => setShowMetadataEditor((value) => !value)}
                    />
                    {showMetadataEditor ? (
                      <View style={styles.meetingMetadataEditor}>
                        <Text style={styles.speakerEditLabel}>{t("meetingDetail.meetingTitle")}</Text>
                        <TextInput {...nonSensitiveTextInputProps} accessibilityLabel={t("meetingDetail.meetingTitle")} maxLength={80} onChangeText={setMetadataTitleDraft} style={styles.input} value={metadataTitleDraft} />
                        <Text style={styles.speakerEditLabel}>{t("meetings.project")}</Text>
                        <TextInput {...nonSensitiveTextInputProps} accessibilityLabel={t("meetings.project")} maxLength={60} onChangeText={setMetadataProjectDraft} placeholder={t("meetingDetail.projectPlaceholder")} style={styles.input} value={metadataProjectDraft} />
                        <Text style={styles.speakerEditLabel}>{t("meetings.participants")}</Text>
                        <Text style={styles.help}>{t("meetingDetail.participantsHint")}</Text>
                        <TextInput {...nonSensitiveTextInputProps} accessibilityLabel={t("meetings.participants")} onChangeText={setMetadataParticipantsDraft} placeholder={t("meetingDetail.participantsPlaceholder")} style={styles.input} value={metadataParticipantsDraft} />
                        <Text style={styles.speakerEditLabel}>{t("meetings.tags")}</Text>
                        <Text style={styles.help}>{t("meetingDetail.tagsHint")}</Text>
                        <TextInput {...nonSensitiveTextInputProps} accessibilityLabel={t("meetings.tags")} onChangeText={setMetadataTagsDraft} placeholder={t("meetingDetail.tagsPlaceholder")} style={styles.input} value={metadataTagsDraft} />
                        {metadataMessage ? <Text style={messageHasError(metadataMessage) ? styles.error : styles.success}>{metadataMessage}</Text> : null}
                        <ActionButton disabled={metadataSaving} label={metadataSaving ? t("common.saving") : t("meetings.saveInfo")} kind="primary" onPress={() => void saveSelectedMeetingMetadata()} />
                      </View>
                    ) : null}
                    {selectedMeeting.result?.summary.speakerViews.length ? (
                      <View style={styles.notesSection}>
                        <Text style={styles.meetingDetailSectionTitle}>{t("meetingDetail.speakerViews")}</Text>
                        {selectedMeeting.result.summary.speakerViews.slice(0, 3).map((item, index) => (
                          <View key={`${item.speaker}-${index}`} style={styles.detailBlock}>
                            <Text style={styles.detailTitle}>{item.speaker}</Text>
                            <Text style={styles.help}>{item.view}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </>
                ) : null}
                {showMeetingTools && selectedMeeting.result ? (
                  <>
                    <SectionToggle
                      detail={t("meetingDetail.editNotesDetail")}
                      expanded={showMeetingEditor}
                      icon="create-outline"
                      label={t("meetings.editNotes")}
                      onPress={() => setShowMeetingEditor((value) => !value)}
                    />
                    {showMeetingEditor ? (
                    <>
                    <View style={styles.separator} />
                    <Text style={styles.label}>{t("meetingDetail.manualRevision")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.revisionSyncDetail")}</Text>
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.summaryField")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.summaryField")}
                      multiline
                      onChangeText={setSummaryDraft}
                      style={[styles.input, styles.multilineInput]}
                      textAlignVertical="top"
                      value={summaryDraft}
                    />
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.keyTopics")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.oneTopicPerLine")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.keyTopics")}
                      multiline
                      onChangeText={setTopicsDraft}
                      style={[styles.input, styles.compactMultilineInput]}
                      textAlignVertical="top"
                      value={topicsDraft}
                    />
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.risks")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.oneRiskPerLine")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.risks")}
                      multiline
                      onChangeText={setRisksDraft}
                      style={[styles.input, styles.compactMultilineInput]}
                      textAlignVertical="top"
                      value={risksDraft}
                    />
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.openQuestions")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.oneQuestionPerLine")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.openQuestions")}
                      multiline
                      onChangeText={setOpenQuestionsDraft}
                      style={[styles.input, styles.compactMultilineInput]}
                      textAlignVertical="top"
                      value={openQuestionsDraft}
                    />
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.knowledgePoints")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.oneKnowledgePerLine")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.knowledgePoints")}
                      multiline
                      onChangeText={setKnowledgeDraft}
                      style={[styles.input, styles.compactMultilineInput]}
                      textAlignVertical="top"
                      value={knowledgeDraft}
                    />
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.speakerViews")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.speakerViewsLineHint")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.speakerViews")}
                      multiline
                      onChangeText={setSpeakerViewsDraft}
                      style={[styles.input, styles.compactMultilineInput]}
                      textAlignVertical="top"
                      value={speakerViewsDraft}
                    />
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.decisionLog")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.decisionLineHint")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.decisionLog")}
                      multiline
                      onChangeText={setDecisionDraft}
                      style={[styles.input, styles.multilineInput]}
                      textAlignVertical="top"
                      value={decisionDraft}
                    />
                    <Text style={styles.speakerEditLabel}>{t("meetingDetail.actionItems")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.actionLineHint")}</Text>
                    <TextInput
                      {...nonSensitiveTextInputProps}
                      accessibilityLabel={t("meetingDetail.actionItems")}
                      multiline
                      onChangeText={setActionDraft}
                      style={[styles.input, styles.multilineInput]}
                      textAlignVertical="top"
                      value={actionDraft}
                    />
                    {summaryMessage ? <Text style={messageHasError(summaryMessage) ? styles.error : styles.success}>{summaryMessage}</Text> : null}
                    <View style={styles.buttonRow}>
                      <ActionButton disabled={summarySaving} label={summarySaving ? t("common.saving") : t("meetingDetail.saveRevisions")} kind="primary" onPress={() => void saveSelectedMeetingSummary()} />
                    </View>
                    </>
                    ) : null}
                  </>
                ) : null}
                {showMeetingTools && selectedMeetingSpeakers.length > 0 ? (
                  <>
                    <SectionToggle
                      detail={t("meetingDetail.speakerCountDetail", { count: selectedMeetingSpeakers.length })}
                      expanded={showSpeakerEditor}
                      icon="people-outline"
                      label={t("meetings.speakers")}
                      onPress={() => setShowSpeakerEditor((value) => !value)}
                    />
                    {showSpeakerEditor ? (
                    <>
                    <View style={styles.separator} />
                    <Text style={styles.label}>{t("meetingDetail.speakerCorrection")}</Text>
                    <Text style={styles.help}>{t("meetingDetail.speakerSyncDetail")}</Text>
                    <View style={styles.speakerLimitationNotice}>
                      <Text style={styles.speakerLimitationTitle}>{t("meetingDetail.recognitionLimit")}</Text>
                      <Text style={styles.speakerLimitationText}>{t("meetingDetail.recognitionLimitDetail")}</Text>
                    </View>
                    {selectedMeetingSpeakers.map((speaker) => (
                      <View key={speaker} style={styles.speakerEditItem}>
                        <Text style={styles.speakerEditLabel}>{speaker}</Text>
                        <TextInput
                          {...nonSensitiveTextInputProps}
                          accessibilityLabel={t("meetingDetail.newSpeakerName", { speaker })}
                          autoCapitalize="words"
                          autoCorrect={false}
                          maxLength={48}
                          onChangeText={(value) =>
                            setSpeakerNameDrafts((current) => ({
                              ...current,
                              [speaker]: value,
                            }))
                          }
                          style={styles.input}
                          value={speakerNameDrafts[speaker] ?? speaker}
                        />
                      </View>
                    ))}
                    {speakerMessage ? <Text style={messageHasError(speakerMessage) ? styles.error : styles.success}>{speakerMessage}</Text> : null}
                    <View style={styles.buttonRow}>
                      <ActionButton disabled={speakerSaving} label={speakerSaving ? t("common.saving") : t("meetingDetail.saveSpeakerNames")} kind="primary" onPress={() => void saveSelectedMeetingSpeakers()} />
                    </View>
                    </>
                    ) : null}
                  </>
                ) : null}
                {showMeetingTools && selectedMeetingTranscript.length > 0 ? (
                  <>
                    <SectionToggle
                      detail={t("meetingDetail.transcriptDetail", { count: selectedMeetingTranscript.length })}
                      expanded={showTranscriptCorrection}
                      icon="document-text-outline"
                      label={t("ux.correctTranscript")}
                      onPress={() => setShowTranscriptCorrection((value) => !value)}
                    />
                    {showTranscriptCorrection ? (
                      <>
                        <View style={styles.separator} />
                        <Text style={styles.label}>{t("meetingDetail.formalTranscript")}</Text>
                        <Text style={styles.help}>{t("meetingDetail.transcriptReviewDetail")}</Text>
                        <View style={styles.transcriptReviewList}>
                          {visibleSelectedMeetingTranscript.map((segment) => {
                            const draftSpeaker = transcriptSpeakerDrafts[segment.id] ?? segment.speaker;
                            return (
                              <View key={segment.id} style={styles.transcriptReviewItem}>
                                <View style={styles.transcriptReviewHeader}>
                                  <Text style={styles.transcriptReviewTime}>{segment.timestamp}</Text>
                                  <Text style={styles.transcriptReviewCurrent}>{segment.speaker}</Text>
                                </View>
                                <Text style={styles.transcriptReviewText}>{segment.text}</Text>
                                {selectedMeetingSpeakers.length > 1 ? (
                                  <View style={styles.transcriptSpeakerChoices}>
                                    {selectedMeetingSpeakers.slice(0, 6).map((speaker) => {
                                      const selected = normalizeSpeakerNameDraft(draftSpeaker) === speaker;
                                      return (
                                        <Pressable
                                          accessibilityLabel={t("meetingDetail.assignSpeaker", { speaker, timestamp: segment.timestamp })}
                                          accessibilityRole="button"
                                          accessibilityState={{ selected }}
                                          key={`${segment.id}-${speaker}`}
                                          onPress={() => setTranscriptSpeakerDrafts((current) => ({ ...current, [segment.id]: speaker }))}
                                          style={({ pressed }) => [
                                            styles.transcriptSpeakerChoice,
                                            selected ? styles.transcriptSpeakerChoiceActive : null,
                                            pressed ? styles.buttonPressed : null,
                                          ]}
                                        >
                                          <Text style={selected ? styles.transcriptSpeakerChoiceTextActive : styles.transcriptSpeakerChoiceText}>{speaker}</Text>
                                        </Pressable>
                                      );
                                    })}
                                  </View>
                                ) : null}
                                <TextInput
                                  accessibilityLabel={t("meetingDetail.speakerName", { timestamp: segment.timestamp })}
                                  autoCapitalize="words"
                                  autoComplete="off"
                                  autoCorrect={false}
                                  importantForAutofill="no"
                                  maxLength={48}
                                  onChangeText={(value) => setTranscriptSpeakerDrafts((current) => ({ ...current, [segment.id]: value }))}
                                  placeholder={t("meetingDetail.speakerNamePlaceholder")}
                                  secureTextEntry={false}
                                  style={[styles.input, styles.transcriptSpeakerInput]}
                                  textContentType="none"
                                  value={draftSpeaker}
                                />
                              </View>
                            );
                          })}
                        </View>
                        {transcriptVisibleCount < selectedMeetingTranscript.length ? (
                          <View style={styles.historyLoadMore}>
                            <ActionButton
                              label={t("meetingDetail.loadMoreTranscript", { count: Math.min(transcriptReviewPageSize, selectedMeetingTranscript.length - transcriptVisibleCount) })}
                              kind="secondary"
                              onPress={() => setTranscriptVisibleCount((count) => count + transcriptReviewPageSize)}
                            />
                          </View>
                        ) : null}
                        {transcriptSpeakerMessage ? (
                          <Text accessibilityLiveRegion="polite" style={transcriptSpeakerError ? styles.error : styles.success}>
                            {transcriptSpeakerMessage}
                          </Text>
                        ) : null}
                        <View style={styles.buttonRow}>
                          <ActionButton
                            disabled={transcriptSpeakerSaving || transcriptSpeakerChangeCount === 0}
                            label={transcriptSpeakerSaving ? t("common.saving") : transcriptSpeakerChangeCount > 0 ? t("meetingDetail.saveCorrectionCount", { count: transcriptSpeakerChangeCount }) : t("meetingDetail.noCorrections")}
                            kind="primary"
                            onPress={() => void saveSelectedTranscriptSpeakers()}
                          />
                        </View>
                      </>
                    ) : null}
                  </>
                ) : null}
                {showMeetingTools ? (
                  <>
                    <View style={styles.buttonRow}>
                      <ActionButton label={t("meetingDetail.copyFormalMarkdown")} kind="secondary" onPress={copyMarkdown} />
                      <ActionButton label={t("meetingDetail.exportObsidian")} kind="primary" onPress={shareMarkdown} />
                    </View>
                    {exportMessage ? <Text style={styles.success}>{exportMessage}</Text> : null}
                  </>
                ) : null}
                <View style={styles.separator} />
                <Text style={styles.label}>{t("meetings.danger")}</Text>
                <Text style={styles.help}>{t("meetings.deleteDetail")}</Text>
                <View style={styles.buttonRow}>
                  <ActionButton
                    disabled={shareUpdating || selectedMeetingDeletionBlocked}
                    label={shareUpdating ? t("common.processing") : t("meetingDetail.deleteTitle")}
                    kind="danger"
                    onPress={confirmDeleteMeeting}
                  />
                </View>
                {showShareControls ? (
                <>
                <View style={styles.separator} />
                <Text style={styles.label}>{t("meetingDetail.sharePermissions")}</Text>
                <Text style={styles.help}>{t("meetingDetail.sharePermissionsDetail")}</Text>
                {selectedMeetingQuality.status !== "verified" ? (
                  <View style={styles.speakerLimitationNotice}>
                    <Text style={styles.speakerLimitationTitle}>{t("meetingDetail.resultQuality", { quality: selectedMeetingQualityLabel })}</Text>
                    <Text style={styles.speakerLimitationText}>{t("meetingDetail.reviewBeforeShare", { detail: selectedMeetingQualityDetail })}</Text>
                  </View>
                ) : null}
                <View style={selectedMeeting.humanReview.status === "confirmed" ? styles.humanReviewConfirmed : styles.speakerLimitationNotice}>
                  <Text style={selectedMeeting.humanReview.status === "confirmed" ? styles.humanReviewConfirmedTitle : styles.speakerLimitationTitle}>
                    {selectedMeeting.humanReview.status === "confirmed" ? t("meetingDetail.reviewConfirmed") : selectedMeeting.humanReview.needsReconfirmation ? t("meetingDetail.reviewChanged") : t("meetingDetail.reviewPending")}
                  </Text>
                  <Text style={selectedMeeting.humanReview.status === "confirmed" ? styles.humanReviewConfirmedText : styles.speakerLimitationText}>
                    {selectedMeeting.humanReview.status === "confirmed" ? t("meetingDetail.reviewConfirmedDetail") : t("meetingDetail.reviewPendingDetail")}
                  </Text>
                  <View style={styles.buttonRow}>
                    <ActionButton
                      disabled={reviewUpdating}
                      label={reviewUpdating ? t("common.saving") : selectedMeeting.humanReview.status === "confirmed" ? t("meetingDetail.revokeReview") : t("meetingDetail.confirmReview")}
                      kind="secondary"
                      onPress={confirmSelectedMeetingHumanReview}
                    />
                  </View>
                </View>
                <View style={styles.buttonRow}>
                  {selectedMeeting.share.visibility === "public" ? (
                    <ActionButton disabled={shareUpdating} label={shareUpdating ? t("common.processing") : t("meetingDetail.revokeShare")} kind="danger" onPress={() => void changeSelectedMeetingShare({ visibility: "private", includeTranscript: false })} />
                  ) : (
                    <ActionButton disabled={shareUpdating || selectedMeeting.humanReview.status !== "confirmed"} label={shareUpdating ? t("common.processing") : t("meetingDetail.publishShare")} kind="primary" onPress={() => confirmSelectedMeetingShare({ visibility: "public", includeTranscript: false })} />
                  )}
                  <ActionButton
                    disabled={shareUpdating || selectedMeeting.humanReview.status !== "confirmed"}
                    label={selectedMeeting.share.includeTranscript ? t("meetingDetail.hideTranscript") : selectedMeeting.share.visibility === "public" ? t("meetingDetail.publishTranscript") : t("meetingDetail.publishWithTranscript")}
                    kind="secondary"
                    onPress={() => confirmSelectedMeetingShare({ visibility: "public", includeTranscript: !selectedMeeting.share.includeTranscript })}
                  />
                </View>
                {shareMessage ? <Text style={messageHasError(shareMessage) ? styles.error : styles.success}>{shareMessage}</Text> : null}
                {selectedMeeting.share.visibility === "public" ? (
                  <>
                  {selectedMeeting.share.expiresAt ? (
                    <Text style={styles.help}>
                      {t("meetingShare.expiresAt", { date: formatShortDate(selectedMeeting.share.expiresAt, locale) })}
                    </Text>
                  ) : null}
                  <View style={styles.buttonRow}>
                    <ActionButton disabled={shareUpdating} label={t("meetingDetail.copyShareLink")} kind="secondary" onPress={copyShareLink} />
                    <ActionButton disabled={shareUpdating} label={t("meetingDetail.systemShareLink")} kind="secondary" onPress={sharePublicLink} />
                  </View>
                  </>
                ) : null}
                </>
                ) : null}
              </Panel>
            ) : null}
          </>
        ) : null}

        {activeTab === "settings" ? (
          <>
            <Panel>
              <LanguageSelector variant="settings" />
            </Panel>
            {currentUser ? (
              <Panel title={t("processingMode.title")}>
                <Text style={styles.help}>{t("processingMode.detail")}</Text>
                <View style={styles.processingModeOptions}>
                  <ProcessingModeOption
                    detail={t("processingMode.officialDetail", {
                      minutes: accountUsage?.officialMinutesRemaining ?? Math.max(0, currentUser.officialMinutesTotal - currentUser.officialMinutesUsed),
                    })}
                    disabled={processingModeSaving || recordingLifecycleBusy}
                    icon="sparkles-outline"
                    label={t("processingMode.official")}
                    onPress={() => void selectMeetingProcessingMode("official_quota")}
                    selected={selectedProcessingMode === "official_quota"}
                    status={selectedProcessingMode === "official_quota" ? t("processingMode.current") : undefined}
                  />
                  <ProcessingModeOption
                    detail={t(mobileByokCoverage.complete ? "processingMode.byokDetail" : "processingMode.byokNotReady")}
                    disabled={processingModeSaving || recordingLifecycleBusy || !mobileByokCoverage.complete}
                    icon="key-outline"
                    label={t("processingMode.byok")}
                    onPress={() => void selectMeetingProcessingMode("byok")}
                    selected={selectedProcessingMode === "byok"}
                    status={selectedProcessingMode === "byok" ? t("processingMode.current") : mobileByokCoverage.complete ? t("processingMode.ready") : t("processingMode.needsSetup")}
                  />
                </View>
                {selectedProcessingMode === "byok" && !mobileByokCoverage.complete ? (
                  <Text accessibilityLiveRegion="polite" style={styles.warning}>{t("processingMode.selectedByokInvalid")}</Text>
                ) : null}
                {!mobileByokCoverage.complete ? (
                  <View style={styles.buttonRow}>
                    <ActionButton label={t("processingMode.configure")} kind="secondary" onPress={beginProviderSetup} />
                  </View>
                ) : null}
                {processingModeSaving ? <Text style={styles.help}>{t("processingMode.saving")}</Text> : null}
                {processingModeMessage ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={processingModeMessage === t("processingMode.savedByok") || processingModeMessage === t("processingMode.savedOfficial") ? styles.success : styles.warning}
                  >
                    {processingModeMessage}
                  </Text>
                ) : null}
              </Panel>
            ) : null}
            <SectionToggle
              detail={t("settings.recordingPrivacyDetail")}
              expanded={showRecordingPrivacy}
              icon="shield-checkmark-outline"
              label={t("settings.recordingPrivacy")}
              onPress={() => setShowRecordingPrivacy((value) => !value)}
            />
            {showRecordingPrivacy ? (
              <Panel title={t("settings.recordingPrivacy")}>
                <Text style={styles.help}>{t("settings.recordingPrivacyBody")}</Text>
                <MenuAction detail={t("account.privacyDetail")} icon="shield-checkmark-outline" label={t("account.privacy")} onPress={() => void openOwnMinutesPage("/privacy")} />
              </Panel>
            ) : null}

            {CUSTOM_API_BASE_URL_EDITING_ENABLED ? (
            <>
            <SectionToggle
              detail={apiBaseUrlGuidance.tone === "success" ? "公网 HTTPS 已配置" : "本地开发地址与连接检查"}
              expanded={showConnectionSettings}
              icon="server-outline"
              label={t("settings.backend")}
              onPress={() => setShowConnectionSettings((value) => !value)}
            />
            {showConnectionSettings ? (
            <Panel title={t("settings.backend")}>
              <Text style={styles.label}>API Base URL</Text>
              <TextInput
                accessibilityLabel="API Base URL"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={status !== "recording" && status !== "paused"}
                importantForAutofill="no"
                keyboardType="url"
                onChangeText={updateApiBaseUrl}
                onEndEditing={(event) => void persistApiBaseUrl(event.nativeEvent.text)}
                onSubmitEditing={(event) => void checkBackend(event.nativeEvent.text)}
                placeholder="https://app.example.com"
                returnKeyType="go"
                secureTextEntry={false}
                style={styles.input}
                testID={DEFAULT_API_BASE_URL_BUILD_MARKER}
                textContentType="none"
                value={apiBaseUrl}
              />
              <Text style={styles.help}>
                本地模拟器可用 127.0.0.1；同一 Wi-Fi 真机开发可用电脑局域网地址；TestFlight 外部测试和 App Store 必须使用公网 HTTPS。当前地址{apiBaseUrlRestored ? "会保存在本机" : "正在恢复"}。
              </Text>
              <Text style={apiBaseUrlGuidance.tone === "success" ? styles.success : apiBaseUrlGuidance.tone === "error" ? styles.error : styles.warning}>
                {apiBaseUrlGuidance.detail}
              </Text>
              <View style={styles.buttonRow}>
                <ActionButton label={backendChecking ? "检查中" : "保存并检查"} kind="primary" onPress={() => void checkBackend()} />
                {currentUser?.role === "admin" ? (
                  <ActionButton label="管理员内部诊断（需要管理员权限）" kind="secondary" onPress={() => void checkAdminDiagnostics()} />
                ) : null}
                <ActionButton label="恢复默认地址" kind="secondary" onPress={resetApiBaseUrl} />
              </View>
              {backendHealth ? (
                <View style={styles.diagnosticBox}>
                  <View style={styles.meetingHeader}>
                    <Text style={styles.diagnosticTitle}>
                      {backendHealth.service || "OwnMinutes"}
                      {backendHealth.runtime ? ` / ${backendHealth.runtime}` : ""}
                    </Text>
                    <Text style={backendHealth.ok ? styles.publicBadge : styles.dangerBadge}>{backendHealth.ok ? t("settings.connected") : t("settings.unavailable")}</Text>
                  </View>
                  {currentUser?.role === "admin" && backendHealth.checks ? (
                    <Text style={styles.help}>
                      管理员内部详情（需要管理员权限） · 账号库：{backendHealth.checks.authRepository || "未提供"} / 存储：
                      {backendHealth.checks.storageProvider || "未提供"} / Provider：
                      {backendHealth.checks.providerConfigured === undefined ? "未提供" : backendHealth.checks.providerConfigured ? "ready" : "not ready"}
                    </Text>
                  ) : null}
                  {releaseSummary ? (
                    <View style={styles.mobileReadinessBox}>
                      <View style={styles.meetingHeader}>
                        <View style={styles.meetingHeaderText}>
                          <Text style={styles.diagnosticTitle}>当前阶段：{mobileReadinessStageLabel(releaseSummary)}</Text>
                          <Text style={styles.help}>本地 MVP 可测不等于 TestFlight 或公开商用可上架。</Text>
                        </View>
                        <Text style={releaseSummary.mvpReady ? styles.publicBadge : styles.privateBadge}>
                          {releaseSummary.mvpReady ? "MVP Ready" : "待补齐"}
                        </Text>
                      </View>
                      <View style={styles.statsRow}>
                        <Stat label="MVP" value={releaseSummary.mvpReady ? "是" : "否"} />
                        <Stat label="TestFlight" value={releaseSummary.testflightReady ? "是" : "否"} />
                        <Stat label="商用" value={releaseSummary.commercialReady ? "是" : "否"} />
                      </View>
                      <Text style={releaseSummary.commercialReady ? styles.success : styles.warning}>
                        上线状态：ready {releaseSummary.ready} / warning {releaseSummary.warning} / blocked {releaseSummary.blocked} / total {releaseSummary.total}
                      </Text>
                      {releaseBlockers.length > 0 ? (
                        <View style={styles.mobileBlockerList}>
                          <Text style={styles.diagnosticTitle}>关键阻塞</Text>
                          {releaseBlockers.slice(0, 3).map((blocker) => (
                            <View key={blocker.id} style={styles.mobileBlockerItem}>
                              <Text style={styles.mobileBlockerTitle}>{blocker.title}</Text>
                              <Text style={styles.mobileBlockerDetail} numberOfLines={2}>{blocker.nextAction}</Text>
                            </View>
                          ))}
                          {releaseBlockers.length > 3 ? <Text style={styles.help}>还有 {releaseBlockers.length - 3} 项阻塞，请在 Web `/checkup` 查看完整验收清单。</Text> : null}
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              ) : null}
              {providerDiagnostic ? (
                <View style={styles.diagnosticBox}>
                  <Text style={styles.help}>管理员内部详情（需要管理员权限）</Text>
                  <Text style={styles.diagnosticTitle}>
                    {providerDiagnostic.provider} / {providerDiagnostic.adapter} / {providerDiagnostic.ready ? "ready" : "not ready"}
                  </Text>
                  {providerDiagnostic.missing.length > 0 ? <Text style={styles.warning}>缺少：{providerDiagnostic.missing.join(", ")}</Text> : null}
                  {providerDiagnostic.notes.map((note) => <Text key={note} style={styles.help}>{note}</Text>)}
                </View>
              ) : null}
            </Panel>
            ) : null}
            </>
            ) : null}

            {currentUser ? (
              <View onLayout={(event) => { providerPanelYRef.current = event.nativeEvent.layout.y; }}>
              <SectionToggle
                detail={t("settings.ownModelsDetail")}
                expanded={showProviderEditor}
                icon="key-outline"
                label={t("settings.ownModels")}
                onPress={toggleProviderEditor}
              />
              {showProviderEditor ? (
              <Panel title={t("settings.provider")}>
                <Text style={styles.help}>{t("providerSetup.intro")}</Text>
                <View style={styles.providerExternalLinks}>
                  <ExternalLinkAction
                    label={providerMode === "volcano-asr" ? t("providerSetup.openSpeechConsole") : t("providerSetup.openArkConsole")}
                    onPress={() => void openProviderUrl(providerMode === "volcano-asr" ? volcanoSpeechConsoleUrl : volcanoArkConsoleUrl)}
                  />
                  {providerMode === "volcano-asr" ? (
                    <ExternalLinkAction label={t("providerSetup.viewAsrAuthDocs")} onPress={() => void openProviderUrl(volcanoSpeechApiDocsUrl)} />
                  ) : null}
                </View>
                <View style={styles.buttonRow}>
                  <ActionButton label={t("providerSetup.stepAsr")} kind={providerMode === "volcano-asr" ? "primary" : "secondary"} onPress={() => selectProviderMode("volcano-asr")} />
                  <ActionButton label={t("providerSetup.stepSummary")} kind={providerMode === "volcano-ark" ? "primary" : "secondary"} onPress={() => selectProviderMode("volcano-ark")} />
                  <ActionButton label={t("providerSetup.refreshConfig")} kind="secondary" onPress={() => void refreshProviderCredentials()} />
                  <ActionButton label={providerHealthLoading ? t("providerSetup.checking") : t("providerSetup.healthCheck")} kind="secondary" onPress={() => void refreshProviderHealth()} />
                </View>

                {providerMode === "volcano-asr" ? (
                  <>
                    <Text style={styles.providerStepTitle}>{t("providerSetup.asrStepTitle")}</Text>
                    <Text style={styles.help}>{t("providerSetup.asrStepDetail")}</Text>
                    <Text style={styles.label}>ASR API Key</Text>
                    <TextInput accessibilityLabel="ASR API Key" autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" onChangeText={setProviderAsrApiKey} placeholder={t("providerSetup.maskedSecretPlaceholder")} secureTextEntry style={styles.input} textContentType="none" value={providerAsrApiKey} />
                    <Pressable
                      accessibilityLabel={t("providerSetup.legacyAdvanced")}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: showProviderAdvancedFields }}
                      onPress={() => setShowProviderAdvancedFields((value) => !value)}
                      style={({ pressed }) => [styles.providerAdvancedToggle, pressed ? styles.buttonPressed : null]}
                    >
                      <Text style={styles.providerAdvancedToggleText}>{t("providerSetup.legacyAdvanced")}</Text>
                      <Ionicons accessibilityElementsHidden color="#6f7c75" name={showProviderAdvancedFields ? "chevron-up" : "chevron-down"} size={18} />
                    </Pressable>
                    {showProviderAdvancedFields ? (
                      <View style={styles.providerAdvancedFields}>
                        <Text style={styles.providerAlternative}>{t("providerSetup.legacyAdvancedDetail")}</Text>
                        <Text style={styles.label}>{t("providerSetup.legacyAppId")}</Text>
                        <TextInput accessibilityLabel={t("providerSetup.legacyAppId")} autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" onChangeText={setProviderAppId} placeholder={t("providerSetup.speechAppIdPlaceholder")} secureTextEntry={false} style={styles.input} textContentType="none" value={providerAppId} />
                        <Text style={styles.label}>{t("providerSetup.legacyAccessToken")}</Text>
                        <TextInput accessibilityLabel={t("providerSetup.legacyAccessToken")} autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" onChangeText={setProviderAsrToken} placeholder={t("providerSetup.maskedSecretPlaceholder")} secureTextEntry style={styles.input} textContentType="none" value={providerAsrToken} />
                        <Text style={styles.label}>{t("providerSetup.realtimeWebSocketUrl")}</Text>
                        <TextInput accessibilityLabel={t("providerSetup.realtimeWebSocketUrl")} autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" keyboardType="url" onChangeText={setProviderAsrWsUrl} placeholder="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async" secureTextEntry={false} style={styles.input} textContentType="none" value={providerAsrWsUrl} />
                        <Text style={styles.label}>{t("providerSetup.realtimeResourceId")}</Text>
                        <TextInput accessibilityLabel={t("providerSetup.realtimeResourceId")} autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" onChangeText={setProviderRealtimeAsrResourceId} placeholder="volc.seedasr.sauc.duration" secureTextEntry={false} style={styles.input} textContentType="none" value={providerRealtimeAsrResourceId} />
                        <Text style={styles.label}>{t("providerSetup.fileAsrResourceId")}</Text>
                        <TextInput accessibilityLabel={t("providerSetup.fileAsrResourceId")} autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" onChangeText={setProviderAsrResourceId} placeholder="volc.bigasr.auc_turbo" secureTextEntry={false} style={styles.input} textContentType="none" value={providerAsrResourceId} />
                      </View>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Text style={styles.providerStepTitle}>{t("providerSetup.summaryStepTitle")}</Text>
                    <Text style={styles.help}>{t("providerSetup.summaryStepDetail")}</Text>
                    <Text style={styles.label}>Endpoint ID</Text>
                    <TextInput accessibilityLabel="Endpoint ID" autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" onChangeText={setProviderModel} placeholder={t("providerSetup.endpointPlaceholder")} secureTextEntry={false} style={styles.input} textContentType="none" value={providerModel} />
                    <Text style={styles.label}>Ark API Key</Text>
                    <TextInput accessibilityLabel="Ark API Key" autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" onChangeText={setProviderArkApiKey} placeholder={t("providerSetup.maskedSecretPlaceholder")} secureTextEntry style={styles.input} textContentType="none" value={providerArkApiKey} />
                    <Pressable
                      accessibilityLabel={t("providerSetup.advancedParameters")}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: showProviderAdvancedFields }}
                      onPress={() => setShowProviderAdvancedFields((value) => !value)}
                      style={({ pressed }) => [styles.providerAdvancedToggle, pressed ? styles.buttonPressed : null]}
                    >
                      <Text style={styles.providerAdvancedToggleText}>{t("providerSetup.advancedParameters")}</Text>
                      <Ionicons accessibilityElementsHidden color="#6f7c75" name={showProviderAdvancedFields ? "chevron-up" : "chevron-down"} size={18} />
                    </Pressable>
                    {showProviderAdvancedFields ? (
                      <View style={styles.providerAdvancedFields}>
                        <Text style={styles.label}>Base URL</Text>
                        <TextInput accessibilityLabel="Ark Base URL" autoCapitalize="none" autoComplete="off" autoCorrect={false} importantForAutofill="no" keyboardType="url" onChangeText={setProviderBaseUrl} placeholder="https://ark.cn-beijing.volces.com/api/v3" secureTextEntry={false} style={styles.input} textContentType="none" value={providerBaseUrl} />
                      </View>
                    ) : null}
                  </>
                )}

                {providerMessage ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[
                      t("providerSetup.providerSaved"),
                      t("providerSetup.providerDeleted"),
                      t("providerSetup.liveHealthComplete"),
                    ].includes(providerMessage) ? styles.success : styles.warning}
                  >
                    {providerMessage}
                  </Text>
                ) : null}
                <View style={styles.buttonRow}>
                  <ActionButton disabled={providerSaving || Boolean(providerDeleting) || recordingLifecycleBusy} label={providerSaving ? t("common.saving") : t("providerSetup.saveAndCheck")} kind="primary" onPress={saveProviderConfig} />
                  {providerMode === "volcano-asr" ? (
                    <ActionButton disabled={asrSubmitTesting || providerSaving} label={asrSubmitTesting ? t("providerSetup.asrTesting") : t("providerSetup.asrSubmitTest")} kind="secondary" onPress={runMobileAsrSubmitTest} />
                  ) : null}
                  {providerMode === "volcano-asr" ? (
                    <ActionButton disabled={realtimeAsrTesting || providerSaving} label={realtimeAsrTesting ? t("providerSetup.realtimeConnecting") : t("providerSetup.realtimeConnectionTest")} kind="secondary" onPress={runMobileRealtimeAsrTest} />
                  ) : null}
                </View>
                {providerMode === "volcano-asr" ? (
                  <Text accessibilityLiveRegion="polite" style={asrSubmitMessage?.startsWith(t("providerSetup.asrTestPassed")) ? styles.success : styles.help}>
                    {asrSubmitMessage || t("providerSetup.asrSubmitHelp")}
                  </Text>
                ) : null}
                {providerMode === "volcano-asr" && realtimeAsrTestMessage ? (
                  <Text accessibilityLiveRegion="polite" style={realtimeAsrTestMessage.startsWith(t("providerSetup.realtimeTestPassed")) ? styles.success : styles.warning}>{realtimeAsrTestMessage}</Text>
                ) : null}
                <View style={styles.providerList}>
                  {providerCredentials.length > 0 ? providerCredentials.map((credential) => {
                    const credentialLabel = providerDisplayLabel(credential.providerId, credential.label, locale);
                    return (
                    <View key={credential.id} style={styles.providerItem}>
                      <View style={styles.meetingHeader}>
                        <View style={styles.meetingHeaderText}>
                          <Text style={styles.detailTitle}>{credentialLabel}</Text>
                          <Text style={styles.help}>{credential.configuredSecrets.length ? t("providerSetup.encryptedSecretsSaved") : t("providerSetup.secretsNotSaved")}</Text>
                        </View>
                        <Pressable
                          accessibilityLabel={t("providerSetup.deleteProviderAccessibility", { label: credentialLabel })}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: Boolean(providerDeleting) || recordingLifecycleBusy }}
                          disabled={Boolean(providerDeleting) || recordingLifecycleBusy}
                          onPress={() => confirmDeleteProviderCredential(credential.providerId, credentialLabel)}
                          style={({ pressed }) => [styles.providerDeleteButton, pressed ? styles.buttonPressed : null, providerDeleting || recordingLifecycleBusy ? styles.buttonDisabled : null]}
                        >
                          {providerDeleting === credential.providerId ? <ActivityIndicator color="#a33d35" size="small" /> : <Ionicons accessibilityElementsHidden color="#a33d35" name="trash-outline" size={18} />}
                        </Pressable>
                      </View>
                    </View>
                    );
                  }) : <Text style={styles.empty}>{t("providerSetup.noOwnModels")}</Text>}
                  {providerHealth.map((item) => (
                    <View key={item.providerId} style={styles.providerItem}>
                      <View style={styles.meetingHeader}>
                        <Text style={styles.detailTitle}>{providerDisplayLabel(item.providerId, item.label, locale)}</Text>
                        <Text style={providerHealthBadgeStyle(item.status)}>{providerHealthLabel(item.status, locale)}</Text>
                      </View>
                      <Text style={styles.help}>{t("providerSetup.usage")}: {item.canUseFor.length ? item.canUseFor.map((use) => providerUseLabel(use, locale)).join(" / ") : t("providerSetup.temporarilyUnavailable")}</Text>
                    </View>
                  ))}
                </View>
              </Panel>
              ) : null}
              </View>
            ) : null}

            {__DEV__ ? <>
            <SectionToggle
              detail="上传管道、录制稳定性与合规状态"
              expanded={showAdvancedSettings}
              icon="pulse-outline"
              label={t("settings.advanced")}
              onPress={() => setShowAdvancedSettings((value) => !value)}
            />

            {showAdvancedSettings ? (
              <>
            <Panel title="上传与识别管道">
              <View style={styles.statsRow}>
                <Stat label="已上传" value={`${uploadState.uploaded}`} />
                <Stat label="上传中" value={`${uploadState.pending}`} />
                <Stat label="失败" value={`${uploadState.failed}`} />
              </View>
              <View style={styles.statsRow}>
                <Stat label="服务端保存" value={formatBytes(uploadState.savedBytes)} />
                <Stat label="Provider" value={uploadState.provider} />
                <Stat label="Adapter" value={uploadState.adapter} />
              </View>
              <View style={styles.statsRow}>
                <Stat label="实时分片" value={`${realtimeChunks}`} />
                <Stat label="实时缓存字节" value={formatBytes(realtimeChunkBytes)} />
                <Stat label="最后切片" value={lastRealtimeChunkAt ? formatShortDate(lastRealtimeChunkAt, locale) : "待生成"} />
              </View>
              <View style={styles.statsRow}>
                <Stat label="保留分片" value={`${realtimeRetainedChunks}/${realtimeChunkQueueLimit}`} />
                <Stat label="已丢弃旧片" value={`${realtimeDroppedChunks}`} />
                <Stat label="待切片" value={formatBytes(realtimePendingBytes)} />
              </View>
              <View style={styles.statsRow}>
                <Stat label="实时已推送" value={`${realtimeUploadedChunks}`} />
                <Stat label="格式拒绝" value={`${realtimeRejectedChunks}`} />
                <Stat label="实时等待" value={`${realtimePendingUploads}`} />
              </View>
              <View style={styles.statsRow}>
                <Stat label="实时失败" value={`${realtimeFailedUploads}`} />
                <Stat label="最大漂移" value={formatBytes(realtimeMaxByteDrift)} />
                <Stat label="正式音频" value="不污染" />
              </View>
              {realtimeUploadDiagnostic ? <Text style={realtimeFailedUploads > 0 || realtimeRejectedChunks > 0 ? styles.warning : styles.help}>实时分片上传：{realtimeUploadDiagnostic}</Text> : null}
            </Panel>

            <Panel title="录制稳定性检查">
              <View style={styles.readinessList}>
                {stabilityChecks.map((item) => (
                  <ReadinessRow key={item.label} item={item} />
                ))}
              </View>
            </Panel>

            <Panel title="合规提示">
              <Text style={styles.help}>{t("recordingFlow.consentBody")}</Text>
              <Text style={styles.help}>默认不分享逐字稿和原始音频。后续分享页需要单独权限开关。</Text>
            </Panel>
              </>
            ) : null}
            </> : null}
          </>
        ) : null}

        {activeTab === "account" ? (
          <Panel plain={!currentUser} title={currentUser ? t("account.status") : undefined}>
            {currentUser ? (
              <>
                <View style={styles.accountSummaryCard}>
                  <View style={styles.meetingHeader}>
                    <View style={styles.accountSummaryIdentity}>
                      <Text style={styles.accountName}>{currentUser.name}</Text>
                      <Text numberOfLines={1} style={styles.help}>{currentUser.email}</Text>
                    </View>
                    <Text style={styles.publicBadge}>{currentUser.plan.toUpperCase()}</Text>
                  </View>
                  <View style={styles.accountSummaryUsage}>
                    <Text style={styles.accountSummaryLabel}>{t("account.remaining")}</Text>
                    <Text style={styles.accountSummaryValue}>
                      {t("common.minutes", { count: accountUsage?.officialMinutesRemaining ?? Math.max(0, currentUser.officialMinutesTotal - currentUser.officialMinutesUsed) })}
                    </Text>
                  </View>
                  <Text style={currentUser.emailVerifiedAt ? styles.success : styles.warning}>
                    {currentUser.emailVerifiedAt ? t("account.emailVerified") : t("account.emailPending")}
                  </Text>
                </View>
                <MenuAction
                  detail={t("ux.preferencesDetail")}
                  icon="options-outline"
                  label={t("ux.preferences")}
                  onPress={() => setActiveTab("settings")}
                />
                <SectionToggle
                  detail={accountUsage?.events.length ? t("account.usageRecords", { count: accountUsage.events.length }) : t("account.noUsage")}
                  expanded={showUsageHistory}
                  icon="receipt-outline"
                  label={t("account.recentUsage")}
                  onPress={() => setShowUsageHistory((value) => !value)}
                />
                {showUsageHistory ? (
                <View style={styles.providerList}>
                  <Text style={styles.detailTitle}>{t("account.recentUsage")}</Text>
                  {accountUsage?.events.length ? (
                    accountUsage.events.slice(0, 3).map((event) => (
                      <View key={event.id} style={styles.usageItem}>
                        <View style={styles.usageItemCopy}>
                          <Text style={styles.detailTitle}>{usageEventLabel(event.type, locale)}</Text>
                          <Text style={styles.help}>{formatUsageNote(event.note, event, locale)}</Text>
                        </View>
                        <View style={styles.usageItemMeta}>
                          <Text style={event.type === "meeting_finalize" ? styles.usageNegative : styles.usagePositive}>{formatUsageMinutes(event, locale)}</Text>
                          <Text style={styles.help}>{formatShortDate(event.createdAt, locale)}</Text>
                        </View>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.empty}>{t("account.noUsage")}</Text>
                  )}
                </View>
                ) : null}
                <SectionToggle
                  detail={t("account.membershipDetail", { plan: currentUser.plan.toUpperCase() })}
                  expanded={showMembership}
                  icon="diamond-outline"
                  label={t("account.membership")}
                  onPress={() => setShowMembership((value) => !value)}
                />
                {showMembership ? (
                <IapPlanStore />
                ) : null}
                <SectionToggle
                  detail={t("account.passwordChangeDetail")}
                  expanded={showPasswordChange}
                  icon="lock-closed-outline"
                  label={t("account.changePassword")}
                  onPress={() => {
                    setShowPasswordChange((visible) => !visible);
                    if (showPasswordChange) resetPasswordChangeForm();
                  }}
                />
                {showPasswordChange ? (
                  <View style={styles.passwordChangeSection}>
                    <View style={styles.meetingHeader}>
                      <View>
                        <Text style={styles.detailTitle}>{t("account.changePassword")}</Text>
                        <Text style={styles.help}>{t("account.passwordChangeDetail")}</Text>
                      </View>
                      <Pressable
                        accessibilityLabel={passwordChangeVisible ? t("auth.hidePassword") : t("auth.showPassword")}
                        accessibilityRole="button"
                        hitSlop={8}
                        onPress={() => setPasswordChangeVisible((visible) => !visible)}
                        style={styles.authPasswordToggle}
                      >
                        <Ionicons accessibilityElementsHidden color="#68736d" name={passwordChangeVisible ? "eye-off-outline" : "eye-outline"} size={21} />
                      </Pressable>
                    </View>
                    <View style={styles.authField}>
                      <Ionicons accessibilityElementsHidden color="#76817b" name="key-outline" size={20} />
                      <TextInput
                        accessibilityLabel={t("account.currentPassword")}
                        autoCapitalize="none"
                        autoComplete="current-password"
                        autoCorrect={false}
                        onChangeText={setCurrentPassword}
                        placeholder={t("account.currentPassword")}
                        placeholderTextColor="#8b948f"
                        secureTextEntry={!passwordChangeVisible}
                        style={styles.authInput}
                        textContentType="password"
                        value={currentPassword}
                      />
                    </View>
                    <View style={styles.authField}>
                      <Ionicons accessibilityElementsHidden color="#76817b" name="lock-closed-outline" size={20} />
                      <TextInput
                        accessibilityLabel={t("account.newPassword")}
                        autoCapitalize="none"
                        autoComplete="new-password"
                        autoCorrect={false}
                        onChangeText={setNewPassword}
                        placeholder={t("account.newPasswordPlaceholder")}
                        placeholderTextColor="#8b948f"
                        secureTextEntry={!passwordChangeVisible}
                        style={styles.authInput}
                        textContentType="newPassword"
                        value={newPassword}
                      />
                    </View>
                    <View style={styles.authField}>
                      <Ionicons accessibilityElementsHidden color="#76817b" name="checkmark-circle-outline" size={20} />
                      <TextInput
                        accessibilityLabel={t("account.confirmNewPassword")}
                        autoCapitalize="none"
                        autoComplete="new-password"
                        autoCorrect={false}
                        onChangeText={setConfirmPassword}
                        onSubmitEditing={() => {
                          if (!passwordChanging) void submitPasswordChange();
                        }}
                        placeholder={t("account.confirmNewPasswordPlaceholder")}
                        placeholderTextColor="#8b948f"
                        returnKeyType="done"
                        secureTextEntry={!passwordChangeVisible}
                        style={styles.authInput}
                        textContentType="newPassword"
                        value={confirmPassword}
                      />
                    </View>
                    {passwordChangeMessage ? <Text accessibilityLiveRegion="polite" style={authMessageStyle(passwordChangeMessage)}>{passwordChangeMessage}</Text> : null}
                    <View style={styles.buttonRow}>
                      <ActionButton disabled={passwordChanging} label={passwordChanging ? t("common.saving") : t("account.saveNewPassword")} kind="primary" onPress={submitPasswordChange} />
                      <ActionButton
                        disabled={passwordChanging}
                        label={t("common.cancel")}
                        kind="secondary"
                        onPress={() => {
                          setShowPasswordChange(false);
                          resetPasswordChangeForm();
                        }}
                      />
                    </View>
                  </View>
                ) : passwordChangeMessage ? (
                  <Text style={authMessageStyle(passwordChangeMessage)}>{passwordChangeMessage}</Text>
                ) : null}
                <SectionToggle
                  detail={t("account.helpLegalDetail")}
                  expanded={showHelpAndLegal}
                  icon="help-circle-outline"
                  label={t("account.helpAndLegal")}
                  onPress={() => setShowHelpAndLegal((value) => !value)}
                />
                {showHelpAndLegal ? (
                  <View style={styles.providerList}>
                    <MenuAction detail={t("account.supportDetail")} icon="help-buoy-outline" label={t("account.support")} onPress={() => void openOwnMinutesPage("/support")} />
                    <MenuAction detail={t("account.privacyDetail")} icon="shield-checkmark-outline" label={t("account.privacy")} onPress={() => void openOwnMinutesPage("/privacy")} />
                    <MenuAction detail={t("account.termsDetail")} icon="document-text-outline" label={t("account.terms")} onPress={() => void openOwnMinutesPage("/terms")} />
                    <MenuAction detail={t("account.dataDeletionDetail")} icon="trash-bin-outline" label={t("account.dataDeletion")} onPress={() => void openOwnMinutesPage("/data-deletion")} />
                  </View>
                ) : null}
                <MenuAction detail={t("account.exportDataDetail")} icon="download-outline" label={t("account.exportData")} onPress={shareAccountExport} />
                <MenuAction disabled={recordingLifecycleBusy} detail={t("account.signOutDetail")} icon="log-out-outline" label={t("account.signOut")} onPress={logout} />
                <MenuAction danger disabled={recordingLifecycleBusy} detail={t("account.deleteAccountDetail")} icon="trash-outline" label={t("account.deleteAccount")} onPress={confirmDeleteAccount} />
              </>
            ) : (
              <View style={styles.authScreen}>
                <View style={styles.authBrandRow}>
                  <View style={styles.authBrandIdentity}>
                    <View accessibilityElementsHidden style={styles.authBrandMark}>
                      <Image accessible={false} alt="" resizeMode="cover" source={appIcon} style={styles.authBrandImage} />
                    </View>
                    <Text style={styles.authBrandName}>OwnMinutes</Text>
                  </View>
                  <LanguageSelector variant="auth" />
                </View>

                <View style={styles.authHeading}>
                  <Text accessibilityRole="header" style={styles.authTitle}>{authMode === "register" ? t("auth.registerTitle") : t("auth.welcomeTitle")}</Text>
                  <Text style={styles.authSubtitle}>{authMode === "register" ? t("auth.registerSubtitle") : t("auth.loginSubtitle")}</Text>
                </View>

                <View style={styles.authModeSwitch}>
                  <Pressable
                    accessibilityLabel={t("auth.login")}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: authMode === "login" }}
                    onPress={() => switchAuthMode("login")}
                    style={[styles.authModeOption, authMode === "login" ? styles.authModeOptionActive : null]}
                  >
                    <Text style={[styles.authModeText, authMode === "login" ? styles.authModeTextActive : null]}>{t("auth.login")}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={t("auth.register")}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: authMode === "register" }}
                    onPress={() => switchAuthMode("register")}
                    style={[styles.authModeOption, authMode === "register" ? styles.authModeOptionActive : null]}
                  >
                    <Text style={[styles.authModeText, authMode === "register" ? styles.authModeTextActive : null]}>{t("auth.register")}</Text>
                  </Pressable>
                </View>

                <View style={styles.authForm}>
                  {authMode === "register" ? (
                    <View style={styles.authField}>
                      <Ionicons accessibilityElementsHidden color="#76817b" name="person-outline" size={20} />
                      <TextInput
                        accessibilityLabel={t("auth.name")}
                        autoCapitalize="words"
                        autoComplete="name"
                        onChangeText={setAuthName}
                        onSubmitEditing={() => authEmailInputRef.current?.focus()}
                        placeholder={t("auth.name")}
                        placeholderTextColor="#8b948f"
                        ref={authNameInputRef}
                        returnKeyType="next"
                        secureTextEntry={false}
                        style={styles.authInput}
                        submitBehavior="submit"
                        textContentType="name"
                        value={authName}
                      />
                    </View>
                  ) : null}

                  <View style={styles.authField}>
                    <Ionicons accessibilityElementsHidden color="#76817b" name="mail-outline" size={20} />
                    <TextInput
                      accessibilityLabel={t("auth.email")}
                      autoCapitalize="none"
                      autoComplete="email"
                      autoCorrect={false}
                      keyboardType="email-address"
                      onChangeText={setAuthEmail}
                      onSubmitEditing={() => authPasswordInputRef.current?.focus()}
                      placeholder={t("auth.email")}
                      placeholderTextColor="#8b948f"
                      ref={authEmailInputRef}
                      returnKeyType="next"
                      secureTextEntry={false}
                      style={styles.authInput}
                      submitBehavior="submit"
                      textContentType="username"
                      value={authEmail}
                    />
                  </View>

                  <View style={styles.authField}>
                    <Ionicons accessibilityElementsHidden color="#76817b" name="lock-closed-outline" size={20} />
                    <TextInput
                      accessibilityLabel={t("auth.password")}
                      autoCapitalize="none"
                      autoComplete={authMode === "register" ? "new-password" : "current-password"}
                      autoCorrect={false}
                      onChangeText={setAuthPassword}
                      onSubmitEditing={() => {
                        if (!authLoading) void submitAuth();
                      }}
                      placeholder={t("auth.passwordPlaceholder")}
                      placeholderTextColor="#8b948f"
                      ref={authPasswordInputRef}
                      returnKeyType="go"
                      secureTextEntry={!authPasswordVisible}
                      style={styles.authInput}
                      textContentType={authMode === "register" ? "newPassword" : "password"}
                      value={authPassword}
                    />
                    <Pressable
                      accessibilityLabel={authPasswordVisible ? t("auth.hidePassword") : t("auth.showPassword")}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => setAuthPasswordVisible((visible) => !visible)}
                      style={styles.authPasswordToggle}
                    >
                      <Ionicons accessibilityElementsHidden color="#76817b" name={authPasswordVisible ? "eye-off-outline" : "eye-outline"} size={21} />
                    </Pressable>
                  </View>

                  {authMode === "login" ? (
                    <Pressable
                      accessibilityLabel={t("auth.forgotPassword")}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: passwordResetRequesting }}
                      disabled={passwordResetRequesting}
                      onPress={() => void requestPasswordReset()}
                      style={styles.authForgotLink}
                    >
                      {passwordResetRequesting ? <ActivityIndicator color="#14795b" size="small" /> : null}
                      <Text style={styles.authForgotText}>{passwordResetRequesting ? t("auth.sending") : t("auth.forgotPassword")}</Text>
                    </Pressable>
                  ) : null}

                  {authMode === "register" ? (
                    <View style={styles.authConsentRow}>
                      <Pressable
                        accessibilityLabel={`${t("auth.privacyPolicy")} ${t("auth.conjunction")} ${t("auth.terms")}`}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: authAcceptedTerms }}
                        hitSlop={6}
                        onPress={() => setAuthAcceptedTerms((accepted) => !accepted)}
                        style={styles.authConsentCheckbox}
                      >
                        <Ionicons accessibilityElementsHidden color={authAcceptedTerms ? "#14795b" : "#87918c"} name={authAcceptedTerms ? "checkbox" : "square-outline"} size={21} />
                      </Pressable>
                      <Text style={styles.authConsentText}>{t("auth.consentPrefix")}</Text>
                      <Pressable accessibilityRole="link" onPress={() => void openOwnMinutesPage("/privacy")} style={styles.authLegalLinkButton}>
                        <Text style={styles.authLegalLink}>{t("auth.privacyPolicy")}</Text>
                      </Pressable>
                      <Text style={styles.authConsentText}>{t("auth.conjunction")}</Text>
                      <Pressable accessibilityRole="link" onPress={() => void openOwnMinutesPage("/terms")} style={styles.authLegalLinkButton}>
                        <Text style={styles.authLegalLink}>{t("auth.terms")}</Text>
                      </Pressable>
                    </View>
                  ) : null}

                  {authMessage ? <Text accessibilityLiveRegion="polite" style={authMessageStyle(authMessage)}>{authMessage}</Text> : null}

                  <Pressable
                    accessibilityLabel={authMode === "register" ? t("auth.createAccount") : t("auth.login")}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: authLoading }}
                    disabled={authLoading}
                    onPress={() => void submitAuth()}
                    style={({ pressed }) => [styles.authSubmit, authLoading ? styles.buttonDisabled : null, pressed && !authLoading ? styles.buttonPressed : null]}
                  >
                    {authLoading ? <ActivityIndicator color="#ffffff" size="small" /> : <Ionicons accessibilityElementsHidden color="#ffffff" name={authMode === "register" ? "person-add-outline" : "log-in-outline"} size={20} />}
                    <Text style={styles.authSubmitText}>{authLoading ? t("common.processing") : authMode === "register" ? t("auth.createAccount") : t("auth.login")}</Text>
                  </Pressable>

                  {CUSTOM_API_BASE_URL_EDITING_ENABLED ? (
                    <Pressable accessibilityRole="button" onPress={() => setActiveTab("settings")} style={styles.authSettingsLink}>
                      <Ionicons accessibilityElementsHidden color="#68736d" name="options-outline" size={17} />
                      <Text style={styles.authSettingsText}>{t("auth.developmentConnection")}</Text>
                    </Pressable>
                  ) : null}
                  <Pressable accessibilityRole="link" onPress={() => void openOwnMinutesPage("/support")} style={styles.authSettingsLink}>
                    <Ionicons accessibilityElementsHidden color="#68736d" name="help-circle-outline" size={17} />
                    <Text style={styles.authSettingsText}>{t("auth.supportAndDeletion")}</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </Panel>
        ) : null}

        {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
        {recordingRecoveryError ? <Text accessibilityLiveRegion="polite" style={styles.error}>{recordingRecoveryError}</Text> : null}
        </ScrollView>
        {showPrimaryNavigation ? (
          <View style={styles.quickTabs}>
            <TabButton active={activeTab === "record"} icon="record" label={t("nav.record")} onPress={() => setActiveTab("record")} />
            <TabButton active={activeTab === "meetings"} icon="meetings" label={t("nav.meetings")} onPress={() => setActiveTab("meetings")} />
            <TabButton active={activeTab === "account" || activeTab === "settings"} icon="account" label={t("nav.account")} onPress={() => setActiveTab("account")} />
          </View>
        ) : null}
      </SafeAreaView>
      <EmailVerificationModal
        code={emailVerificationCode}
        email={authEmail}
        message={emailVerificationMessage}
        onChangeCode={updateEmailVerificationCode}
        onChangeEmail={changeEmailForVerification}
        onClose={changeEmailForVerification}
        onResend={() => void resendEmailVerificationCode()}
        onSubmit={() => void submitEmailVerificationCode()}
        resendSeconds={emailVerificationResendSeconds}
        resending={emailVerificationResending}
        submitting={emailVerificationSubmitting}
        visible={emailVerificationVisible}
      />
      <PasswordResetModal
        canSubmit={Boolean(passwordResetToken) && passwordResetNewPassword.length >= 8 && passwordResetConfirmPassword.length >= 8}
        confirmPassword={passwordResetConfirmPassword}
        message={passwordResetMessage}
        newPassword={passwordResetNewPassword}
        onChangeConfirmPassword={setPasswordResetConfirmPassword}
        onChangeNewPassword={setPasswordResetNewPassword}
        onClose={closePasswordReset}
        onPasteLink={() => void pastePasswordResetLink()}
        onSubmit={() => void submitPasswordReset()}
        onTogglePasswordVisibility={() => setPasswordResetPasswordVisible((visible) => !visible)}
        passwordVisible={passwordResetPasswordVisible}
        submitting={passwordResetSubmitting}
        tokenReady={Boolean(passwordResetToken)}
        visible={passwordResetVisible}
      />
      </IapPlanStoreProvider>
    </SafeAreaProvider>
  );
}

function EmailVerificationModal({
  code,
  email,
  message,
  onChangeCode,
  onChangeEmail,
  onClose,
  onResend,
  onSubmit,
  resendSeconds,
  resending,
  submitting,
  visible,
}: {
  code: string;
  email: string;
  message: string | null;
  onChangeCode: (value: string) => void;
  onChangeEmail: () => void;
  onClose: () => void;
  onResend: () => void;
  onSubmit: () => void;
  resendSeconds: number;
  resending: boolean;
  submitting: boolean;
  visible: boolean;
}) {
  const { locale } = useI18n();
  const copy = emailVerificationCodeCopy[locale];
  const normalizedEmail = email.trim().toLowerCase();
  const codeReady = code.length === emailVerificationCodeLength;
  const resendDisabled = resendSeconds > 0 || resending || submitting;
  const resendLabel = resending
    ? copy.resending
    : resendSeconds > 0
      ? copy.resendIn(resendSeconds)
      : copy.resend;
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <SafeAreaView style={styles.passwordResetSafeArea}>
        <StatusBar style="dark" />
        <ScrollView
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          contentContainerStyle={styles.passwordResetContent}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.passwordResetHeader}>
            <View accessibilityElementsHidden style={styles.authBrandMark}>
              <Ionicons color="#ffffff" name="mail-outline" size={22} />
            </View>
            <Pressable accessibilityLabel={copy.close} accessibilityRole="button" accessibilityState={{ disabled: submitting }} disabled={submitting} hitSlop={8} onPress={onClose} style={styles.appIconButton}>
              <Ionicons accessibilityElementsHidden color="#53615a" name="close" size={22} />
            </Pressable>
          </View>
          <Text accessibilityRole="header" style={styles.authTitle}>{copy.title}</Text>
          <Text style={styles.passwordResetSubtitle}>{copy.subtitle(normalizedEmail)}</Text>
          <Pressable accessibilityLabel={copy.changeEmail} accessibilityRole="button" accessibilityState={{ disabled: submitting }} disabled={submitting} hitSlop={8} onPress={onChangeEmail} style={styles.emailVerificationChangeEmail}>
            <Ionicons accessibilityElementsHidden color="#14795b" name="pencil-outline" size={16} />
            <Text style={styles.emailVerificationChangeEmailText}>{copy.changeEmail}</Text>
          </Pressable>

          <View style={styles.emailVerificationCodeSection}>
            <Text style={styles.emailVerificationCodeLabel}>{copy.codeLabel}</Text>
            <TextInput
              accessibilityLabel={copy.codeLabel}
              autoComplete="one-time-code"
              autoFocus
              autoCorrect={false}
              inputMode="numeric"
              keyboardType="number-pad"
              maxLength={emailVerificationCodeLength}
              onChangeText={onChangeCode}
              onSubmitEditing={() => {
                if (codeReady && !submitting) onSubmit();
              }}
              placeholder="000000"
              placeholderTextColor="#bdc6c1"
              returnKeyType="done"
              selectTextOnFocus
              style={styles.emailVerificationCodeInput}
              textContentType="oneTimeCode"
              value={code}
            />
            <Text style={styles.emailVerificationCodeHint}>{copy.codeHint}</Text>
          </View>

          {message ? <Text accessibilityLiveRegion="polite" style={authMessageStyle(message)}>{message}</Text> : null}

          <Pressable accessibilityLabel={copy.verify} accessibilityRole="button" accessibilityState={{ disabled: submitting || !codeReady }} disabled={submitting || !codeReady} onPress={onSubmit} style={({ pressed }) => [styles.authSubmit, submitting || !codeReady ? styles.buttonDisabled : null, pressed && !submitting && codeReady ? styles.buttonPressed : null]}>
            {submitting ? <ActivityIndicator color="#ffffff" size="small" /> : <Ionicons accessibilityElementsHidden color="#ffffff" name="shield-checkmark-outline" size={20} />}
            <Text style={styles.authSubmitText}>{submitting ? copy.verifying : copy.verify}</Text>
          </Pressable>

          <Pressable accessibilityLabel={resendLabel} accessibilityRole="button" accessibilityState={{ disabled: resendDisabled }} disabled={resendDisabled} onPress={onResend} style={[styles.emailVerificationResend, resendDisabled ? styles.emailVerificationResendDisabled : null]}>
            {resending ? <ActivityIndicator color="#14795b" size="small" /> : <Ionicons accessibilityElementsHidden color="#14795b" name="refresh-outline" size={20} />}
            <Text style={styles.emailVerificationResendText}>{resendLabel}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function AppLaunchScreen() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.launchSafeArea}>
        <StatusBar style="dark" />
        <View style={styles.launchContent}>
          <Image
            accessibilityElementsHidden
            accessible={false}
            alt=""
            resizeMode="cover"
            source={appIcon}
            style={styles.launchMark}
          />
          <Text style={styles.launchBrand}>OwnMinutes</Text>
          <ActivityIndicator color="#14795b" size="small" />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function PasswordResetModal({
  canSubmit,
  confirmPassword,
  message,
  newPassword,
  onChangeConfirmPassword,
  onChangeNewPassword,
  onClose,
  onPasteLink,
  onSubmit,
  onTogglePasswordVisibility,
  passwordVisible,
  submitting,
  tokenReady,
  visible,
}: {
  canSubmit: boolean;
  confirmPassword: string;
  message: string | null;
  newPassword: string;
  onChangeConfirmPassword: (value: string) => void;
  onChangeNewPassword: (value: string) => void;
  onClose: () => void;
  onPasteLink: () => void;
  onSubmit: () => void;
  onTogglePasswordVisibility: () => void;
  passwordVisible: boolean;
  submitting: boolean;
  tokenReady: boolean;
  visible: boolean;
}) {
  const { t } = useI18n();
  const confirmPasswordInputRef = useRef<TextInput>(null);
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <SafeAreaView style={styles.passwordResetSafeArea}>
        <StatusBar style="dark" />
        <ScrollView
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          contentContainerStyle={styles.passwordResetContent}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.passwordResetHeader}>
            <View accessibilityElementsHidden style={styles.authBrandMark}>
              <Ionicons color="#ffffff" name="key-outline" size={22} />
            </View>
            <Pressable accessibilityLabel={t("passwordReset.close")} accessibilityRole="button" accessibilityState={{ disabled: submitting }} disabled={submitting} hitSlop={8} onPress={onClose} style={styles.appIconButton}>
              <Ionicons accessibilityElementsHidden color="#53615a" name="close" size={22} />
            </Pressable>
          </View>

          <Text accessibilityRole="header" style={styles.authTitle}>{t("passwordReset.title")}</Text>
          <Text style={styles.passwordResetSubtitle}>{t("passwordReset.detail")}</Text>

          <Pressable accessibilityLabel={tokenReady ? t("passwordReset.linkReady") : t("passwordReset.pasteLink")} accessibilityRole="button" accessibilityState={{ disabled: submitting }} disabled={submitting} onPress={onPasteLink} style={styles.passwordResetPasteAction}>
            <Ionicons accessibilityElementsHidden color="#14795b" name={tokenReady ? "checkmark-circle" : "clipboard-outline"} size={20} />
            <Text style={styles.passwordResetPasteText}>{tokenReady ? t("passwordReset.linkReady") : t("passwordReset.pasteLink")}</Text>
          </Pressable>

          <View style={styles.authForm}>
            <View style={styles.authField}>
              <Ionicons accessibilityElementsHidden color="#76817b" name="lock-closed-outline" size={20} />
              <TextInput
                accessibilityLabel={t("passwordReset.newPassword")}
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect={false}
                editable={!submitting}
                onChangeText={onChangeNewPassword}
                onSubmitEditing={() => confirmPasswordInputRef.current?.focus()}
                placeholder={t("passwordReset.newPasswordPlaceholder")}
                placeholderTextColor="#8b948f"
                returnKeyType="next"
                secureTextEntry={!passwordVisible}
                style={styles.authInput}
                submitBehavior="submit"
                textContentType="newPassword"
                value={newPassword}
              />
              <Pressable accessibilityLabel={passwordVisible ? t("auth.hidePassword") : t("auth.showPassword")} accessibilityRole="button" hitSlop={8} onPress={onTogglePasswordVisibility} style={styles.authPasswordToggle}>
                <Ionicons accessibilityElementsHidden color="#76817b" name={passwordVisible ? "eye-off-outline" : "eye-outline"} size={21} />
              </Pressable>
            </View>
            <View style={styles.authField}>
              <Ionicons accessibilityElementsHidden color="#76817b" name="checkmark-circle-outline" size={20} />
              <TextInput
                accessibilityLabel={t("passwordReset.confirmPassword")}
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect={false}
                editable={!submitting}
                onChangeText={onChangeConfirmPassword}
                onSubmitEditing={onSubmit}
                placeholder={t("passwordReset.confirmPasswordPlaceholder")}
                placeholderTextColor="#8b948f"
                ref={confirmPasswordInputRef}
                returnKeyType="done"
                secureTextEntry={!passwordVisible}
                style={styles.authInput}
                textContentType="newPassword"
                value={confirmPassword}
              />
            </View>
          </View>

          {message ? <Text accessibilityLiveRegion="polite" style={authMessageStyle(message)}>{message}</Text> : null}

          <Pressable accessibilityLabel={t("passwordReset.submit")} accessibilityRole="button" accessibilityState={{ disabled: submitting || !canSubmit }} disabled={submitting || !canSubmit} onPress={onSubmit} style={({ pressed }) => [styles.authSubmit, submitting || !canSubmit ? styles.buttonDisabled : null, pressed && !submitting && canSubmit ? styles.buttonPressed : null]}>
            {submitting ? <ActivityIndicator color="#ffffff" size="small" /> : <Ionicons accessibilityElementsHidden color="#ffffff" name="checkmark-circle-outline" size={20} />}
            <Text style={styles.authSubmitText}>{submitting ? t("passwordReset.submitting") : t("passwordReset.submit")}</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function readAuthError(error: unknown) {
  const value = error instanceof Error ? error : new Error(String(error));
  const details = value as Error & { code?: string; retryAfterSeconds?: number; status?: number };
  return {
    code: details.code,
    message: details.message,
    retryAfterSeconds: details.retryAfterSeconds,
    status: details.status,
  };
}

function localizedAuthFailure(locale: AppLocale, error: unknown, mode: "login" | "register") {
  const details = readAuthError(error);
  const copy = emailVerificationCodeCopy[locale];
  if (details.status === 429 || /rate_limited$/i.test(details.code || "")) return copy.tooManyAttempts;
  if (
    mode === "login" &&
    (details.status === 401 || details.code === "invalid_credentials" || /邮箱或密码不正确|電子郵件或密碼不正確|email or password is incorrect/i.test(details.message))
  ) {
    return copy.invalidCredentials;
  }
  if (
    mode === "register" &&
    (details.status === 409 || /already registered|已经注册|已註冊/i.test(details.message))
  ) {
    return copy.accountExists;
  }
  return mode === "register" ? copy.registrationFailed : copy.loginFailed;
}

function authMessageStyle(message: string) {
  if (/成功|success|signed in/i.test(message)) return styles.success;
  if (/失败|失敗|錯誤|错误|不正确|不正確|過多|过多|请输入|請輸入|请填写|請填寫|创建账号前|建立帳號前|未获得|failed|error|incorrect|invalid|enter |please |must |expired|too many/i.test(message)) return styles.error;
  return styles.help;
}

function messageHasError(message: string) {
  return /失败|失敗|錯誤|错误|不能为空|不能為空|failed|could not|cannot|unavailable|unable/i.test(message);
}

function statusLabel(status: MeetingStatus, locale: AppLocale) {
  if (status === "requesting") return translate(locale, "record.statusRequesting");
  if (status === "recording") return translate(locale, "record.statusRecording");
  if (status === "paused") return translate(locale, "record.statusPaused");
  if (status === "processing") return translate(locale, "record.statusProcessing");
  if (status === "complete") return translate(locale, "record.statusComplete");
  if (status === "error") return translate(locale, "record.statusError");
  return translate(locale, "record.statusIdle");
}

function localizedOwnMinutesWebPath(locale: AppLocale, pathname: "/privacy" | "/terms" | "/support" | "/data-deletion") {
  if (locale === "en") return `/en${pathname}`;
  if (locale === "zh-Hant") return `/zh-Hant${pathname}`;
  return pathname;
}

function createDefaultMeetingTitle(locale: AppLocale, date = new Date()) {
  const value = new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (locale === "en") return `${value} Meeting`;
  return `${value} ${locale === "zh-Hant" ? "會議" : "会议"}`;
}

function normalizeMeetingTitleDraft(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function parseTranscriptTimestampSeconds(value: string) {
  const parts = value.trim().split(":").map(Number);
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((item) => !Number.isFinite(item) || item < 0)) {
    return null;
  }
  if (parts.length === 2) {
    if (parts[1] >= 60) return null;
    return parts[0] * 60 + parts[1];
  }
  if (parts[1] >= 60 || parts[2] >= 60) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function networkStateIsOnline(state: { isConnected?: boolean | null; isInternetReachable?: boolean | null }) {
  return state.isConnected === true && state.isInternetReachable !== false;
}

async function waitForRecorderUri(
  recorder: ReturnType<typeof useAudioRecorder>,
  options: { attempts?: number; delayMs?: number; isCancelled?: () => boolean } = {},
) {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 25;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.isCancelled?.()) return null;
    const uri = recorder.uri || recorder.getStatus().url;
    if (uri) return uri;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function inspectInterruptedRecording(recording: PendingRecording) {
  const firstInfo = await FileSystem.getInfoAsync(recording.uri);
  const firstBytes = firstInfo.exists && "size" in firstInfo ? firstInfo.size : 0;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const secondInfo = await FileSystem.getInfoAsync(recording.uri);
  const secondBytes = secondInfo.exists && "size" in secondInfo ? secondInfo.size : 0;

  if (!firstInfo.exists || !secondInfo.exists || firstBytes < 1024 || secondBytes < 1024 || firstBytes !== secondBytes) {
    return assessInterruptedRecordingRecovery({
      exists: firstInfo.exists && secondInfo.exists,
      firstBytes,
      secondBytes,
      loaded: false,
      durationSeconds: 0,
    });
  }

  let player: ReturnType<typeof createAudioPlayer> | null = null;
  try {
    player = createAudioPlayer(recording.uri, { updateInterval: 100 });
    const deadline = Date.now() + 5_000;
    while (!player.currentStatus.isLoaded && !player.currentStatus.error && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const status = player.currentStatus;
    return assessInterruptedRecordingRecovery({
      exists: true,
      firstBytes,
      secondBytes,
      loaded: status.isLoaded,
      durationSeconds: status.duration,
      playbackError: status.error,
    });
  } catch (error) {
    return assessInterruptedRecordingRecovery({
      exists: true,
      firstBytes,
      secondBytes,
      loaded: false,
      durationSeconds: 0,
      playbackError: error instanceof Error ? error.message : "player-load-failed",
    });
  } finally {
    player?.remove();
  }
}

async function readLocalRecordingDurationMs(uri: string): Promise<number | null> {
  let player: ReturnType<typeof createAudioPlayer> | null = null;
  try {
    player = createAudioPlayer(uri, { updateInterval: 100 });
    const deadline = Date.now() + 5_000;
    while (!player.currentStatus.isLoaded && !player.currentStatus.error && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const durationSeconds = player.currentStatus.duration;
    return player.currentStatus.isLoaded && Number.isFinite(durationSeconds) && durationSeconds >= 0.5
      ? Math.max(1_000, Math.round(durationSeconds * 1000))
      : null;
  } catch {
    return null;
  } finally {
    player?.remove();
  }
}

async function readRecordingStorageHealth(phase: RecordingStoragePhase): Promise<RecordingStorageHealth> {
  try {
    const freeBytes = await withTimeout(
      FileSystem.getFreeDiskStorageAsync(),
      2000,
      "读取设备剩余空间超时。",
    );
    return assessRecordingStorageHealth(freeBytes, phase);
  } catch {
    return unavailableRecordingStorageHealth();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function mobileMeetingProcessingLabel(meeting: MeetingListItem, locale: AppLocale) {
  if (meeting.hasResult) return translate(locale, meeting.qualityStatus === "verified" ? "meetings.processingReady" : "meetings.processingUnverified");
  if (meeting.processing?.status === "queued") {
    return meeting.processing.attempt > 0
      ? translate(locale, "meetings.retryWaiting", { attempt: meeting.processing.attempt })
      : translate(locale, "meetings.queued");
  }
  if (meeting.processing?.status === "processing") return translate(locale, "meetings.processingAttempt", { attempt: meeting.processing.attempt });
  if (meeting.processing?.status === "failed") return translate(locale, "meetings.processingFailed");
  return translate(locale, "meetings.pendingGeneration");
}

function providerHealthLabel(status: ProviderHealthResult["status"], locale: AppLocale) {
  if (status === "ready") return translate(locale, "providerSetup.healthReady");
  if (status === "incomplete") return translate(locale, "providerSetup.healthIncomplete");
  if (status === "failed") return translate(locale, "providerSetup.healthFailed");
  return translate(locale, "providerSetup.healthUnconfigured");
}

function providerUseLabel(use: ProviderHealthResult["canUseFor"][number], locale: AppLocale) {
  if (use === "file_asr") return translate(locale, "providerSetup.useFileAsr");
  if (use === "realtime_asr") return translate(locale, "providerSetup.useRealtimeAsr");
  return translate(locale, "providerSetup.useSummary");
}

function providerDisplayLabel(providerId: string, fallback: string, locale: AppLocale) {
  if (providerId === "volcano-asr") return translate(locale, "providerSetup.providerAsr");
  if (providerId === "volcano-ark") return translate(locale, "providerSetup.providerArk");
  return fallback;
}

function providerHealthBadgeStyle(status: ProviderHealthResult["status"]) {
  if (status === "ready") return styles.publicBadge;
  if (status === "failed") return styles.dangerBadge;
  return styles.privateBadge;
}

function formatAsrTestMessage(result: AsrLiveTestResult, locale: AppLocale) {
  const status = {
    not_configured: "providerSetup.asrStatusNotConfigured",
    incomplete: "providerSetup.asrStatusIncomplete",
    preflight_pass: "providerSetup.asrStatusPreflightPass",
    submitted: "providerSetup.asrStatusSubmitted",
    transcribed: "providerSetup.asrStatusTranscribed",
    completed_empty: "providerSetup.asrStatusCompletedEmpty",
    failed: "providerSetup.asrStatusFailed",
  }[result.status];
  const verification = {
    none: "providerSetup.verificationNone",
    preflight: "providerSetup.verificationPreflight",
    provider_submit: "providerSetup.verificationSubmit",
    provider_transcript: "providerSetup.verificationTranscript",
  }[result.verificationLevel];
  const parts = [
    translate(locale, result.ok ? "providerSetup.asrTestPassed" : "providerSetup.asrTestFailed"),
    translate(locale, "providerSetup.asrTestDetails", {
      status: translate(locale, status),
      verification: translate(locale, verification),
    }),
    result.requestId ? translate(locale, "providerSetup.asrTestRequest", { requestId: result.requestId }) : "",
    translate(locale, result.ok ? "providerSetup.asrTestNextSuccess" : "providerSetup.asrTestNextFailure"),
  ].filter(Boolean);

  return parts.join(locale === "en" ? ". " : "。");
}

function formatRealtimeAsrTestMessage(result: RealtimeAsrAuthTestResult, locale: AppLocale) {
  const status = {
    not_configured: "providerSetup.realtimeStatusNotConfigured",
    connected: "providerSetup.realtimeStatusConnected",
    failed: "providerSetup.realtimeStatusFailed",
  }[result.status];
  const endpoint = `${result.endpointHost}${result.endpointPath}`;
  return [
    translate(locale, result.ok ? "providerSetup.realtimeTestPassed" : "providerSetup.realtimeTestRejected"),
    translate(locale, "providerSetup.realtimeTestDetails", {
      status: translate(locale, status),
      endpoint,
    }),
  ].join(locale === "en" ? ". " : "。");
}

function usageEventLabel(type: AccountUsage["events"][number]["type"], locale: AppLocale) {
  if (type === "register_bonus") return translate(locale, "account.registrationBonus");
  if (type === "meeting_finalize") return translate(locale, "account.meetingProcessing");
  return translate(locale, "account.planChanged");
}

function hasFrozenProcessingMode(
  recording: PendingRecording,
): recording is PendingRecording & { processingMode: UserProcessingMode } {
  return recording.processingMode === "official_quota" || recording.processingMode === "byok";
}

function meetingResultProcessingMode(result: MeetingResult | null | undefined): UserProcessingMode | undefined {
  return result?.processingRoute === "official_quota" || result?.processingRoute === "byok"
    ? result.processingRoute
    : undefined;
}

function formatUsageMinutes(event: AccountUsage["events"][number], locale: AppLocale) {
  if (event.type === "register_bonus") return locale === "en" ? `+${event.minutes} min` : `+${event.minutes} 分`;
  if (event.type === "meeting_finalize") {
    const minutes = event.officialMinutesCharged ?? event.minutes;
    if (event.officialMinutesCharged === 0) return locale === "en" ? "0 official min" : locale === "zh-Hant" ? "0 官方分鐘" : "0 官方分钟";
    return locale === "en" ? `-${minutes} min` : `-${minutes} 分`;
  }
  return locale === "en" ? "Recalculated" : locale === "zh-Hant" ? "重新計算" : "重算";
}

function formatUsageNote(note: string, event: AccountUsage["events"][number] | undefined, locale: AppLocale) {
  if (note.includes("Free plan official trial quota")) return locale === "en" ? "One-time Free official trial" : locale === "zh-Hant" ? "Free 一次性官方體驗額度" : "Free 一次性官方体验额度";
  if (note.startsWith("Changed plan to ")) {
    const plan = note.replace("Changed plan to ", "").toUpperCase();
    return locale === "en" ? `Changed to ${plan}` : locale === "zh-Hant" ? `切換至 ${plan}` : `切换到 ${plan}`;
  }
  if (note.includes("meeting:")) {
    const meetingId = note.match(/meeting:([^\s]+)/)?.[1] ?? "";
    const route = event?.processingRoute === "byok"
      ? locale === "en" ? "your models" : locale === "zh-Hant" ? "自己的模型" : "自己的模型"
      : event?.processingRoute === "hybrid"
        ? locale === "en" ? "hybrid processing" : locale === "zh-Hant" ? "混合處理" : "混合处理"
        : locale === "en" ? "official credits" : locale === "zh-Hant" ? "官方額度" : "官方额度";
    const minutes = event?.processedMinutes ?? event?.minutes ?? 0;
    if (locale === "en") return `Meeting ${meetingId} · ${route} · ${minutes} min`.trim();
    return `${locale === "zh-Hant" ? "會議" : "会议"} ${meetingId} · ${route} · ${locale === "zh-Hant" ? "處理" : "处理"} ${minutes} ${locale === "zh-Hant" ? "分鐘" : "分钟"}`.trim();
  }
  return note;
}

function formatShortDate(value: string, locale: AppLocale) {
  return formatLocalizedDate(locale, value);
}

function normalizeRecordingConsent(
  input: Partial<RecordingConsentMetadata> | null | undefined,
): RecordingConsentMetadata {
  if (
    input?.consentMethod === "in_app_confirmation" &&
    typeof input.consentConfirmedAt === "string" &&
    Number.isFinite(Date.parse(input.consentConfirmedAt)) &&
    typeof input.consentPolicyVersion === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(input.consentPolicyVersion)
  ) {
    return {
      consentConfirmedAt: input.consentConfirmedAt,
      consentMethod: "in_app_confirmation",
      consentPolicyVersion: input.consentPolicyVersion,
    };
  }
  return { consentMethod: "legacy_unknown" };
}

function appStateStatusLabel(state: AppStateStatus) {
  if (state === "active") return "前台";
  if (state === "background") return "后台";
  if (state === "inactive") return "切换中";
  return state;
}

function mobileReadinessStageLabel(summary: ReleaseReadinessSummary) {
  if (summary.commercialReady) return "公开商用准备";
  if (summary.testflightReady) return "TestFlight 准备";
  if (summary.mvpReady) return "本地 MVP 可测";
  return "基础能力未完成";
}

function mergeProviderHealth(current: ProviderHealthResult[], updates: ProviderHealthResult[]) {
  const updateMap = new Map(updates.map((item) => [item.providerId, item]));
  const currentIds = new Set(current.map((item) => item.providerId));

  return [
    ...current.map((item) => updateMap.get(item.providerId) ?? item),
    ...updates.filter((item) => !currentIds.has(item.providerId)),
  ];
}

function getMeetingSpeakers(result: MeetingResult | null | undefined) {
  if (!result) return [];

  return Array.from(
    new Set(
      [
        ...result.transcript.map((segment) => segment.speaker),
        ...result.summary.speakerViews.map((item) => item.speaker),
        ...result.summary.actionItems.map((item) => item.owner),
      ]
        .map((speaker) => speaker.trim())
        .filter((speaker) => speaker && speaker !== "System"),
    ),
  );
}

function buildSpeakerDrafts(result: MeetingResult | null | undefined) {
  return Object.fromEntries(getMeetingSpeakers(result).map((speaker) => [speaker, speaker]));
}

function buildTranscriptSpeakerDrafts(result: MeetingResult | null | undefined) {
  return Object.fromEntries(result?.transcript.map((segment) => [segment.id, segment.speaker]) ?? []);
}

function normalizeSpeakerNameDraft(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 48);
}

function formatLineDraft(values: string[] | null | undefined) {
  return values?.join("\n") ?? "";
}

function formatSpeakerViewsDraft(result: MeetingResult | null | undefined) {
  return result?.summary.speakerViews.map((item) => `${item.speaker}｜${item.view}`).join("\n") ?? "";
}

function formatDecisionDraft(result: MeetingResult | null | undefined) {
  return result?.summary.decisions.map((decision) => `${decision.title}｜${decision.detail}`).join("\n") ?? "";
}

function formatActionDraft(result: MeetingResult | null | undefined) {
  return result?.summary.actionItems.map((item) => `${item.task}｜${item.owner}｜${item.due}｜${item.status === "confirmed" ? "已确认" : "候选"}`).join("\n") ?? "";
}

function parseDecisionDraft(value: string) {
  return value
    .split(/\n+/)
    .map((line, index) => {
      const [title, detail = ""] = splitDraftColumns(line);
      if (!title) return null;
      return {
        id: `decision-${index + 1}`,
        title,
        detail,
        status: "confirmed",
      };
    })
    .filter((item): item is { id: string; title: string; detail: string; status: string } => Boolean(item));
}

function parseActionDraft(value: string) {
  return value
    .split(/\n+/)
    .map((line, index) => {
      const [task, owner = "待确认", due = "待确认", status = "候选"] = splitDraftColumns(line);
      if (!task) return null;
      return {
        id: `action-${index + 1}`,
        task,
        owner,
        due,
        status: status.includes("确认") ? "confirmed" : "candidate",
      };
    })
    .filter((item): item is { id: string; task: string; owner: string; due: string; status: string } => Boolean(item));
}

function parseLineDraft(value: string) {
  return value
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function parseParticipantDraft(value: string) {
  return uniqueDraftValues(value.split(/[\n,，、]+/), 30, 48);
}

function parseTagDraft(value: string) {
  return uniqueDraftValues(value.split(/[\s,，、]+/).map((item) => item.replace(/^#/, "")), 8, 24);
}

function uniqueDraftValues(values: string[], limit: number, maxLength: number) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  return output;
}

function parseSpeakerViewsDraft(value: string) {
  return value
    .split(/\n+/)
    .map((line) => {
      const [speaker, view = "不确定"] = splitDraftColumns(line);
      if (!speaker) return null;
      return {
        speaker,
        view,
      };
    })
    .filter((item): item is { speaker: string; view: string } => Boolean(item))
    .slice(0, 20);
}

function splitDraftColumns(line: string) {
  return line
    .split(/[｜|]/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function FirstRunGuideCard({
  guide,
  onPrimary,
  onSecondary,
}: {
  guide: FirstRunGuide;
  onPrimary: () => void;
  onSecondary?: () => void;
}) {
  const iconName = guide.tone === "blocked" ? "alert-circle-outline" : guide.tone === "attention" ? "construct-outline" : "sparkles-outline";
  const iconColor = guide.tone === "blocked" ? "#a33d35" : guide.tone === "attention" ? "#9a6300" : "#17664f";
  return (
    <View style={[styles.firstRunGuide, guide.tone === "blocked" ? styles.firstRunGuideBlocked : guide.tone === "attention" ? styles.firstRunGuideAttention : null]}>
      <View style={styles.firstRunGuideHeader}>
        <View style={styles.firstRunGuideIcon}>
          <Ionicons accessibilityElementsHidden color={iconColor} name={iconName} size={21} />
        </View>
        <View style={styles.firstRunGuideCopy}>
          <Text style={styles.firstRunGuideEyebrow}>{guide.eyebrow}</Text>
          <Text style={styles.firstRunGuideTitle}>{guide.title}</Text>
        </View>
      </View>
      <Text style={styles.firstRunGuideDetail}>{guide.detail}</Text>
      <View style={styles.firstRunGuideActions}>
        <ActionButton label={guide.primaryLabel} kind="primary" onPress={onPrimary} wide />
        {guide.secondaryLabel && onSecondary ? <ActionButton label={guide.secondaryLabel} kind="secondary" onPress={onSecondary} wide /> : null}
      </View>
    </View>
  );
}

type MeetingAudioController = {
  pause: () => void;
  seekAndPlay: (seconds: number) => Promise<void>;
};

type MeetingAudioLabels = {
  back: string;
  export: string;
  forward: string;
  pause: string;
  play: string;
  rate: string;
  title: string;
  unavailable: string;
};

function MeetingAudioUnavailableCard({
  message,
  onRetry,
  retryLabel,
}: {
  message: string;
  onRetry: () => void;
  retryLabel: string;
}) {
  return (
    <View>
      <Text accessibilityLiveRegion="polite" style={styles.meetingAudioUnavailable}>{message}</Text>
      <View style={styles.buttonRow}>
        <ActionButton label={retryLabel} kind="secondary" onPress={onRetry} />
      </View>
    </View>
  );
}

function MeetingAudioPlayer({
  canPlay,
  controllerRef,
  durationFallbackSeconds,
  labels,
  onExport,
  uri,
}: {
  canPlay: () => boolean;
  controllerRef: { current: MeetingAudioController | null };
  durationFallbackSeconds: number;
  labels: MeetingAudioLabels;
  onExport: () => void;
  uri: string;
}) {
  const player = useAudioPlayer(uri, { keepAudioSessionActive: false, updateInterval: 250 });
  const playback = useAudioPlayerStatus(player);
  const [rate, setRate] = useState(1);
  const duration = playback.duration > 0 ? playback.duration : durationFallbackSeconds;
  const progress = duration > 0 ? Math.min(100, Math.max(0, (playback.currentTime / duration) * 100)) : 0;

  const pauseSafely = useCallback(() => {
    try {
      const status = player.currentStatus;
      if (!status.isLoaded || status.error) return;
      player.pause();
    } catch {
      // A stale pre-upgrade file URI can unload the native player between
      // render and cleanup. Leaving the detail screen must still succeed.
    }
  }, [player]);

  const seekToSafe = useCallback(async (seconds: number, playAfterSeek: boolean) => {
    if (!canPlay()) return;
    try {
      const status = player.currentStatus;
      if (!status.isLoaded || status.error) return;
      const maximum = status.duration > 0 ? status.duration : durationFallbackSeconds;
      await player.seekTo(Math.max(0, Math.min(maximum, seconds)), 50, 50);
      const nextStatus = player.currentStatus;
      if (playAfterSeek && canPlay() && nextStatus.isLoaded && !nextStatus.error) player.play();
    } catch {
      // Native audio methods can reject after an iOS sandbox migration or
      // while the player is unloading. The visible unavailable state is safer
      // than escalating a recoverable playback failure to the app boundary.
    }
  }, [canPlay, durationFallbackSeconds, player]);

  useEffect(() => {
    const controller: MeetingAudioController = {
      pause: pauseSafely,
      seekAndPlay: (seconds) => seekToSafe(seconds, true),
    };
    controllerRef.current = controller;
    return () => {
      pauseSafely();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [controllerRef, pauseSafely, seekToSafe]);

  async function togglePlayback() {
    if (!canPlay()) return;
    try {
      const status = player.currentStatus;
      if (!status.isLoaded || status.error) return;
      if (status.playing) {
        pauseSafely();
        return;
      }
      if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.25)) {
        await player.seekTo(0);
      }
      const nextStatus = player.currentStatus;
      if (canPlay() && nextStatus.isLoaded && !nextStatus.error) player.play();
    } catch {
      // Keep a local playback problem scoped to this card.
    }
  }

  function cycleRate() {
    if (!canPlay()) return;
    const rates = [1, 1.5, 2] as const;
    const currentIndex = rates.findIndex((value) => Math.abs(value - rate) < 0.05);
    const nextRate = rates[(currentIndex + 1) % rates.length];
    try {
      const status = player.currentStatus;
      if (!status.isLoaded || status.error) return;
      player.setPlaybackRate(nextRate, "medium");
      setRate(nextRate);
    } catch {
      // The player may have unloaded after the button became enabled.
    }
  }

  const disabled = !playback.isLoaded || Boolean(playback.error);
  return (
    <View style={styles.meetingAudioCard}>
      <View style={styles.meetingAudioHeader}>
        <View style={styles.meetingAudioTitleRow}>
          <Ionicons accessibilityElementsHidden color="#14795b" name="headset-outline" size={19} />
          <Text style={styles.detailTitle}>{labels.title}</Text>
        </View>
        <ActionButton label={labels.export} kind="secondary" onPress={onExport} />
      </View>
      {playback.error ? <Text accessibilityLiveRegion="polite" style={styles.warning}>{labels.unavailable}</Text> : null}
      <View accessibilityElementsHidden style={styles.meetingAudioProgressTrack}>
        <View style={[styles.meetingAudioProgressFill, { width: `${progress}%` }]} />
      </View>
      <View style={styles.meetingAudioTimeRow}>
        <Text style={styles.meetingAudioTime}>{formatDuration(Math.floor(playback.currentTime))}</Text>
        <Text style={styles.meetingAudioTime}>{formatDuration(Math.floor(duration))}</Text>
      </View>
      <View style={styles.meetingAudioControls}>
        <Pressable
          accessibilityLabel={labels.back}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => void seekToSafe(player.currentStatus.currentTime - 15, false)}
          style={({ pressed }) => [styles.meetingAudioControl, disabled ? styles.buttonDisabled : null, pressed ? styles.buttonPressed : null]}
        >
          <Ionicons accessibilityElementsHidden color="#31423a" name="play-back" size={21} />
          <Text style={styles.meetingAudioControlText}>15</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={playback.playing ? labels.pause : labels.play}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => void togglePlayback()}
          style={({ pressed }) => [styles.meetingAudioPlayButton, disabled ? styles.buttonDisabled : null, pressed ? styles.buttonPressed : null]}
        >
          {playback.isBuffering ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Ionicons accessibilityElementsHidden color="#ffffff" name={playback.playing ? "pause" : "play"} size={24} />
          )}
        </Pressable>
        <Pressable
          accessibilityLabel={labels.forward}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => void seekToSafe(player.currentStatus.currentTime + 15, false)}
          style={({ pressed }) => [styles.meetingAudioControl, disabled ? styles.buttonDisabled : null, pressed ? styles.buttonPressed : null]}
        >
          <Ionicons accessibilityElementsHidden color="#31423a" name="play-forward" size={21} />
          <Text style={styles.meetingAudioControlText}>15</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={labels.rate}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={cycleRate}
          style={({ pressed }) => [styles.meetingAudioRateButton, disabled ? styles.buttonDisabled : null, pressed ? styles.buttonPressed : null]}
        >
          <Text style={styles.meetingAudioRateText}>{rate}×</Text>
        </Pressable>
      </View>
    </View>
  );
}

function MeetingCostIndicator({ item }: { item: Pick<MeetingCostPreview, "label" | "detail" | "tone"> }) {
  const warning = item.tone !== "ready";
  return (
    <View style={[styles.meetingCostIndicator, warning ? styles.meetingCostIndicatorWarning : null]}>
      <Ionicons accessibilityElementsHidden color={warning ? "#9a6300" : "#17664f"} name={warning ? "alert-circle-outline" : "wallet-outline"} size={16} />
      <View style={styles.meetingCostCopy}>
        <Text style={[styles.meetingCostLabel, warning ? styles.meetingCostLabelWarning : null]}>{item.label}</Text>
        <Text style={styles.meetingCostDetail}>{item.detail}</Text>
      </View>
    </View>
  );
}

function SectionToggle({
  detail,
  expanded,
  icon,
  label,
  onPress,
  tone = "default",
}: {
  detail: string;
  expanded: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
}) {
  const color = tone === "danger" ? "#a33d35" : "#254137";
  return (
    <Pressable
      accessible
      accessibilityHint={detail}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [styles.sectionToggle, pressed ? styles.buttonPressed : null]}
    >
      <View style={[styles.sectionToggleIcon, tone === "danger" ? styles.sectionToggleIconDanger : null]}>
        <Ionicons accessibilityElementsHidden color={color} name={icon} size={19} />
      </View>
      <View style={styles.sectionToggleCopy}>
        <Text style={[styles.sectionToggleLabel, tone === "danger" ? styles.sectionToggleLabelDanger : null]}>{label}</Text>
        <Text style={styles.sectionToggleDetail} numberOfLines={2}>{detail}</Text>
      </View>
      <Ionicons accessibilityElementsHidden color="#7b8881" name={expanded ? "chevron-up" : "chevron-down"} size={19} />
    </Pressable>
  );
}

function MenuAction({
  danger = false,
  disabled = false,
  detail,
  icon,
  label,
  onPress,
}: {
  danger?: boolean;
  disabled?: boolean;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessible
      accessibilityHint={detail}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuAction,
        disabled ? styles.buttonDisabled : null,
        pressed && !disabled ? styles.buttonPressed : null,
      ]}
    >
      <Ionicons accessibilityElementsHidden color={danger ? "#a33d35" : "#43534b"} name={icon} size={20} />
      <View style={styles.menuActionCopy}>
        <Text style={[styles.menuActionLabel, danger ? styles.menuActionLabelDanger : null]}>{label}</Text>
        <Text style={styles.menuActionDetail}>{detail}</Text>
      </View>
      <Ionicons accessibilityElementsHidden color="#9aa49f" name="chevron-forward" size={18} />
    </Pressable>
  );
}

function TabButton({ active, icon, label, onPress }: { active: boolean; icon: MobileTab; label: string; onPress: () => void }) {
  return (
    <Pressable accessible accessibilityLabel={label} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [styles.tabButton, active ? styles.tabButtonActive : null, pressed ? styles.buttonPressed : null]}>
      <TabGlyph active={active} icon={icon} />
      <Text style={[styles.tabButtonText, active ? styles.tabButtonTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function TabGlyph({ active, icon, tone = "dark" }: { active: boolean; icon: MobileTab; tone?: "dark" | "light" }) {
  const color = tone === "light" ? "#ffffff" : active ? "#07845f" : "#7b8580";
  if (icon === "record") return <Ionicons accessibilityElementsHidden name={active ? "mic" : "mic-outline"} size={22} color={color} />;
  if (icon === "meetings") return <Ionicons accessibilityElementsHidden name={active ? "document-text" : "document-text-outline"} size={22} color={color} />;
  if (icon === "settings") return <Ionicons accessibilityElementsHidden name={active ? "options" : "options-outline"} size={22} color={color} />;
  return <Ionicons accessibilityElementsHidden name={active ? "person" : "person-outline"} size={22} color={color} />;
}

function ProcessingModeOption({
  detail,
  disabled,
  icon,
  label,
  onPress,
  selected,
  status,
}: {
  detail: string;
  disabled: boolean;
  icon: ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  selected: boolean;
  status?: string;
}) {
  return (
    <Pressable
      accessible
      accessibilityHint={detail}
      accessibilityLabel={`${label}${status ? `, ${status}` : ""}`}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.processingModeOption,
        selected ? styles.processingModeOptionSelected : null,
        disabled && !selected ? styles.processingModeOptionDisabled : null,
        pressed && !disabled ? styles.buttonPressed : null,
      ]}
    >
      <View style={[styles.processingModeIcon, selected ? styles.processingModeIconSelected : null]}>
        <Ionicons accessibilityElementsHidden color={selected ? "#ffffff" : "#1f6f55"} name={icon} size={21} />
      </View>
      <View style={styles.processingModeCopy}>
        <View style={styles.processingModeHeading}>
          <Text style={styles.processingModeLabel}>{label}</Text>
          {status ? <Text style={selected ? styles.publicBadge : styles.privateBadge}>{status}</Text> : null}
        </View>
        <Text style={styles.menuActionDetail}>{detail}</Text>
      </View>
      <Ionicons accessibilityElementsHidden color={selected ? "#07845f" : "#aab3ae"} name={selected ? "checkmark-circle" : "ellipse-outline"} size={22} />
    </Pressable>
  );
}

function ActionButton({
  disabled = false,
  label,
  kind,
  onPress,
  surface = "light",
  wide = false,
}: {
  disabled?: boolean;
  label: string;
  kind: "primary" | "secondary" | "danger";
  onPress: () => void;
  surface?: "light" | "dark";
  wide?: boolean;
}) {
  return (
    <Pressable
      accessible
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        wide ? styles.buttonWide : null,
        kind === "primary" ? styles.primaryButton : null,
        kind === "secondary" ? styles.secondaryButton : null,
        kind === "secondary" && surface === "dark" ? styles.secondaryButtonDark : null,
        kind === "danger" ? styles.dangerButton : null,
        disabled ? styles.buttonDisabled : null,
        pressed && !disabled ? styles.buttonPressed : null,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          kind === "secondary" ? styles.secondaryButtonText : null,
          kind === "secondary" && surface === "dark" ? styles.secondaryButtonTextDark : null,
          disabled ? styles.buttonTextDisabled : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ExternalLinkAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessible
      accessibilityLabel={label}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.providerExternalLink, pressed ? styles.buttonPressed : null]}
    >
      <Ionicons accessibilityElementsHidden color="#1f6f55" name="open-outline" size={16} />
      <Text style={styles.providerExternalLinkText}>{label}</Text>
    </Pressable>
  );
}

function ReadinessRow({
  item,
}: {
  item: {
    label: string;
    state: "ready" | "warning" | "blocked" | "idle";
    detail: string;
  };
}) {
  return (
    <View style={styles.readinessItem}>
      <View style={styles.meetingHeader}>
        <Text style={styles.detailTitle}>{item.label}</Text>
        <Text style={readinessBadgeStyle(item.state)}>{readinessLabel(item.state)}</Text>
      </View>
      <Text style={styles.help}>{item.detail}</Text>
    </View>
  );
}

function readinessLabel(state: "ready" | "warning" | "blocked" | "idle") {
  if (state === "ready") return "正常";
  if (state === "warning") return "观察";
  if (state === "blocked") return "处理";
  return "待测";
}

function readinessBadgeStyle(state: "ready" | "warning" | "blocked" | "idle") {
  if (state === "ready") return styles.publicBadge;
  if (state === "blocked") return styles.dangerBadge;
  if (state === "warning") return styles.warningBadge;
  return styles.privateBadge;
}

type MobileMeetingQuality = {
  publishLabel: string;
  shareWarningDetail: string;
  status: "verified" | "unverified";
};

function assessMobileMeetingQuality(result: MeetingResult | null): MobileMeetingQuality {
  if (!result) return buildMobileMeetingQuality("unverified");

  const hasUsableTranscript = result.transcript.some((segment) => {
    const text = segment.text.trim();
    return text.length >= 8 && !isMobilePlaceholderTranscript(text);
  });
  const hasUnverifiedDiagnostic = result.diagnostics.some((diagnostic) =>
    /(fallback|not wired|missing|failed|not usable|low_confidence|empty|placeholder|deterministic local|等待正式识别|没有可用逐字稿|本地保守纪要|尚未|未完成)/i.test(diagnostic),
  );
  const isUnverified =
    !hasUsableTranscript ||
    result.provider === "mock" ||
    /fallback/i.test(result.adapter) ||
    result.transcript.some((segment) => isMobilePlaceholderTranscript(segment.text)) ||
    isMobilePlaceholderSummary(result.summary.summary) ||
    hasUnverifiedDiagnostic;

  return buildMobileMeetingQuality(isUnverified ? "unverified" : "verified");
}

function buildMobileMeetingQuality(status: MobileMeetingQuality["status"]): MobileMeetingQuality {
  if (status === "verified") {
    return {
      publishLabel: "正式纪要",
      shareWarningDetail: "",
      status,
    };
  }

  return {
    publishLabel: "未验证纪要",
    shareWarningDetail: "这份纪要尚未通过正式识别验收，可能包含兜底转写或本地保守纪要；请勿作为正式会议事实归档。",
    status,
  };
}

function isMobilePlaceholderTranscript(text: string) {
  return /等待正式识别|没有可用逐字稿|未检测到可用语音|placeholder|音频已保存/i.test(text);
}

function isMobilePlaceholderSummary(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return true;
  if (/^(?:不确定|暂无|无|none|null|n\/a)[。.!！]?$/i.test(normalized)) return true;
  if (/^(?:无|暂无|没有|未发现|未检测到|无法提取|无法生成).{0,12}(?:相关)?(?:会议|讨论|有效|可用)?(?:内容|信息|纪要)?[。.!！]?$/i.test(normalized)) return true;
  return /(当前没有可用逐字稿|音频已保存.*等待正式识别|无法根据.{0,10}逐字稿.{0,10}(?:总结|生成))/i.test(normalized);
}

const styles = StyleSheet.create({
  launchSafeArea: {
    backgroundColor: "#f7f9f8",
    flex: 1,
  },
  launchContent: {
    alignItems: "center",
    flex: 1,
    gap: 18,
    justifyContent: "center",
  },
  launchMark: {
    backgroundColor: "#004e46",
    borderRadius: 18,
    height: 72,
    width: 72,
  },
  launchBrand: {
    color: "#17201b",
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: 0,
  },
  authScreen: {
    minHeight: 620,
    paddingBottom: 28,
    paddingHorizontal: 8,
    paddingTop: 32,
  },
  authBrandRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  authBrandIdentity: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 1,
    gap: 10,
  },
  authBrandMark: {
    alignItems: "center",
    backgroundColor: "#173f34",
    borderRadius: 12,
    height: 44,
    justifyContent: "center",
    overflow: "hidden",
    width: 44,
  },
  authBrandImage: {
    height: 44,
    width: 44,
  },
  authBrandName: {
    color: "#17201b",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 0,
  },
  authHeading: {
    gap: 6,
    marginTop: 34,
  },
  authTitle: {
    color: "#17201b",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: 0,
    lineHeight: 42,
  },
  authSubtitle: {
    color: "#66726b",
    fontSize: 15,
    lineHeight: 22,
  },
  authModeSwitch: {
    backgroundColor: "#e8eeea",
    borderRadius: 10,
    flexDirection: "row",
    gap: 4,
    marginTop: 28,
    padding: 4,
  },
  authModeOption: {
    alignItems: "center",
    borderRadius: 7,
    flex: 1,
    minHeight: 44,
    justifyContent: "center",
  },
  authModeOptionActive: {
    backgroundColor: "#ffffff",
    shadowColor: "#17201b",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
  },
  authModeText: {
    color: "#5f6d66",
    fontSize: 15,
    fontWeight: "700",
  },
  authModeTextActive: {
    color: "#173f34",
  },
  authForm: {
    gap: 12,
    marginTop: 20,
  },
  authField: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#d9e1dc",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    height: 56,
    paddingHorizontal: 15,
  },
  authInput: {
    color: "#17201b",
    flex: 1,
    fontSize: 16,
    minWidth: 0,
    paddingVertical: 0,
  },
  authPasswordToggle: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  authForgotLink: {
    alignItems: "center",
    alignSelf: "flex-end",
    flexDirection: "row",
    gap: 7,
    minHeight: 44,
    paddingHorizontal: 2,
  },
  authForgotText: {
    color: "#14795b",
    fontSize: 14,
    fontWeight: "700",
  },
  authConsentRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    minHeight: 30,
  },
  authConsentCheckbox: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  authConsentText: {
    color: "#68736d",
    fontSize: 13,
    lineHeight: 20,
  },
  authLegalLink: {
    color: "#14795b",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 20,
  },
  authLegalLinkButton: {
    justifyContent: "center",
    minHeight: 44,
  },
  authSubmit: {
    alignItems: "center",
    backgroundColor: "#14795b",
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    height: 54,
    justifyContent: "center",
    marginTop: 2,
  },
  authSubmitText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  authSettingsLink: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: 6,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  authSettingsText: {
    color: "#68736d",
    fontSize: 14,
    fontWeight: "700",
  },
  passwordResetSafeArea: {
    backgroundColor: "#f7f9f8",
    flex: 1,
  },
  passwordResetContent: {
    paddingBottom: 36,
    paddingHorizontal: 22,
    paddingTop: 18,
  },
  passwordResetHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 34,
  },
  passwordResetSubtitle: {
    color: "#66726b",
    fontSize: 15,
    lineHeight: 23,
    marginTop: 10,
  },
  emailVerificationChangeEmail: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 6,
    minHeight: 44,
    paddingRight: 10,
  },
  emailVerificationChangeEmailText: {
    color: "#14795b",
    fontSize: 14,
    fontWeight: "800",
  },
  emailVerificationCodeSection: {
    gap: 10,
    marginBottom: 22,
    marginTop: 24,
  },
  emailVerificationCodeLabel: {
    color: "#33433b",
    fontSize: 14,
    fontWeight: "800",
  },
  emailVerificationCodeInput: {
    backgroundColor: "#ffffff",
    borderColor: "#cdd9d2",
    borderRadius: 10,
    borderWidth: 1,
    color: "#17201b",
    fontSize: 30,
    fontVariant: ["tabular-nums"],
    fontWeight: "800",
    height: 66,
    letterSpacing: 12,
    paddingHorizontal: 18,
    textAlign: "center",
  },
  emailVerificationCodeHint: {
    color: "#7b8780",
    fontSize: 13,
    lineHeight: 20,
  },
  emailVerificationResend: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginTop: 18,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  emailVerificationResendDisabled: {
    opacity: 0.52,
  },
  emailVerificationResendText: {
    color: "#14795b",
    fontSize: 14,
    fontWeight: "800",
  },
  passwordResetPasteAction: {
    alignItems: "center",
    backgroundColor: "#eaf2ed",
    borderRadius: 8,
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 28,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  passwordResetPasteText: {
    color: "#14795b",
    fontSize: 14,
    fontWeight: "800",
  },
  appIconButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#d9e1dc",
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  passwordChangeSection: {
    borderTopColor: "#e2e8e4",
    borderTopWidth: 1,
    gap: 12,
    marginTop: 18,
    paddingTop: 18,
  },
  safeArea: {
    backgroundColor: "#f7f8f6",
    flex: 1,
  },
  content: {
    backgroundColor: "#f7f8f6",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 96,
  },
  contentWithoutNavigation: {
    paddingBottom: 24,
  },
  header: {
    alignItems: "center",
    backgroundColor: "#f7f8f6",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 0,
    minHeight: 66,
  },
  headerTitleBlock: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 12,
    minWidth: 0,
    paddingRight: 12,
  },
  headerTitleText: {
    flex: 1,
    minWidth: 0,
  },
  brandMark: {
    alignItems: "center",
    backgroundColor: "#173f34",
    borderRadius: 16,
    flexDirection: "row",
    gap: 3,
    height: 44,
    justifyContent: "center",
    shadowColor: "#173f34",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.22,
    shadowRadius: 26,
    width: 44,
  },
  brandWaveShort: {
    backgroundColor: "#ffffff",
    borderRadius: 999,
    height: 11,
    width: 4,
  },
  brandWaveTall: {
    backgroundColor: "#ffffff",
    borderRadius: 999,
    height: 20,
    width: 4,
  },
  brandWaveMid: {
    backgroundColor: "#ffffff",
    borderRadius: 999,
    height: 15,
    width: 4,
  },
  eyebrow: {
    alignSelf: "flex-start",
    backgroundColor: "transparent",
    borderRadius: 999,
    color: "#718078",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0,
    marginBottom: 0,
    marginTop: 2,
    overflow: "hidden",
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  title: {
    color: "#17211d",
    fontSize: 19,
    fontWeight: "800",
    lineHeight: 23,
  },
  subtitle: {
    color: "#8a95a3",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 18,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: "row",
    gap: 9,
  },
  headerIconButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#d9e0dc",
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    shadowOpacity: 0,
    width: 44,
  },
  headerBackButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    marginLeft: -8,
    width: 44,
  },
  meetingBriefCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e5ece7",
    borderRadius: 26,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    marginBottom: 12,
    minHeight: 86,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: "#101828",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.055,
    shadowRadius: 30,
  },
  meetingBriefCopy: {
    flex: 1,
    minWidth: 0,
  },
  meetingBriefDate: {
    color: "#7a8793",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0,
    marginBottom: 4,
  },
  meetingBriefTitle: {
    color: "#111827",
    fontSize: 21,
    fontWeight: "900",
    lineHeight: 26,
  },
  meetingBriefText: {
    color: "#667085",
    fontSize: 12,
    fontWeight: "500",
    lineHeight: 18,
    marginTop: 3,
  },
  recorderHero: {
    backgroundColor: "#eaf2ed",
    borderBottomColor: "#dae5de",
    borderBottomWidth: 1,
    borderRadius: 0,
    marginBottom: 0,
    marginHorizontal: -16,
    minHeight: 350,
    paddingBottom: 18,
    paddingHorizontal: 16,
    paddingTop: 12,
    shadowOpacity: 0,
  },
  heroStage: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: 0,
    marginHorizontal: 0,
    marginTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 0,
    paddingTop: 0,
    shadowOpacity: 0,
  },
  statusBadge: {
    backgroundColor: "#eef2ef",
    borderColor: "#e3eae5",
    borderRadius: 999,
    borderWidth: 1,
    color: "#53615a",
    fontSize: 12,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  statusBadgeActive: {
    backgroundColor: "rgba(255,224,219,0.96)",
    borderColor: "rgba(255,224,219,0.96)",
    borderRadius: 999,
    borderWidth: 1,
    color: "#8f2f24",
    fontSize: 12,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  statusBadgeWarning: {
    backgroundColor: "#fff8e6",
    borderColor: "#ead28b",
    borderRadius: 999,
    borderWidth: 1,
    color: "#76530a",
    fontSize: 12,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  heroHeader: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderWidth: 0,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    minHeight: 28,
    padding: 0,
  },
  heroStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  heroStatusText: {
    color: "#66736c",
    fontSize: 11,
    fontWeight: "800",
  },
  heroMeetingBlock: {
    flex: 1,
    minWidth: 0,
    paddingRight: 12,
  },
  heroMeetingLabel: {
    color: "#97a8a0",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0,
    marginBottom: 4,
  },
  heroMeetingTitle: {
    color: "#1b2721",
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 21,
    marginTop: 22,
    textAlign: "center",
  },
  heroMeetingTitleInput: {
    alignSelf: "center",
    borderBottomColor: "#b9c9c1",
    borderBottomWidth: 1,
    color: "#1b2721",
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 21,
    marginTop: 18,
    maxWidth: 280,
    minHeight: 44,
    minWidth: 160,
    paddingBottom: 4,
    paddingHorizontal: 8,
    paddingTop: 0,
    textAlign: "center",
  },
  heroMeetingSubtitle: {
    color: "#7a8780",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 17,
    marginTop: 3,
    textAlign: "center",
  },
  heroLocalStatus: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderWidth: 0,
    flexDirection: "row",
    gap: 5,
    minHeight: 24,
    paddingHorizontal: 0,
  },
  heroLocalStatusWarning: {
    backgroundColor: "#fff0ed",
    borderRadius: 6,
    paddingHorizontal: 7,
  },
  heroLocalStatusText: {
    color: "#23745b",
    fontSize: 10,
    fontWeight: "800",
  },
  heroLocalStatusTextWarning: {
    color: "#b54735",
  },
  liveDot: {
    backgroundColor: "#9aa59f",
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  liveDotActive: {
    backgroundColor: "#ef6657",
    shadowColor: "#ef6657",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
  },
  heroTimerCard: {
    backgroundColor: "transparent",
    borderWidth: 0,
    marginTop: 10,
    padding: 0,
    shadowOpacity: 0,
    width: "100%",
  },
  timer: {
    color: "#13231c",
    fontSize: 64,
    fontVariant: ["tabular-nums"],
    fontWeight: "500",
    letterSpacing: 0,
    marginTop: 0,
    textAlign: "center",
  },
  heroHint: {
    alignSelf: "center",
    color: "#7b8881",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 20,
    marginTop: 6,
    maxWidth: 300,
    minHeight: 20,
    textAlign: "center",
  },
  waveformStrip: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: 0,
    flexDirection: "row",
    gap: 1.5,
    height: 42,
    justifyContent: "center",
    marginHorizontal: 0,
    marginTop: 8,
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  waveformBar: {
    backgroundColor: "#c8d5ce",
    borderRadius: 999,
    flex: 1,
    minWidth: 3,
  },
  waveformBarActive: {
    backgroundColor: "#2b9873",
  },
  heroActionButtons: {
    alignItems: "center",
    flexDirection: "row",
    gap: 22,
    justifyContent: "center",
    marginTop: 14,
    width: "100%",
  },
  heroActionButtonsRecording: {
    alignItems: "stretch",
  },
  heroPrimaryAction: {
    alignItems: "center",
    backgroundColor: "#087456",
    borderRadius: 999,
    borderColor: "#d7e9e1",
    borderWidth: 6,
    height: 82,
    justifyContent: "center",
    width: 82,
    shadowColor: "#087456",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
  },
  heroPrimaryActionStop: {
    backgroundColor: "#d94e45",
    borderColor: "#f3d2cf",
    shadowColor: "#d94e45",
    shadowOpacity: 0.2,
  },
  heroPrimaryActionLabel: {
    color: "#17241e",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 14,
  },
  heroPrimaryActionLabelStop: {
    color: "#b83c34",
  },
  heroFileHealth: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    gap: 6,
    marginTop: 4,
    maxWidth: 330,
    minHeight: 24,
    paddingHorizontal: 8,
  },
  heroFileHealthWarning: {
    backgroundColor: "#fff0ed",
    borderRadius: 6,
    paddingVertical: 6,
  },
  heroFileHealthText: {
    color: "#23745b",
    flexShrink: 1,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 16,
    textAlign: "center",
  },
  heroFileHealthTextWarning: {
    color: "#8e2c22",
  },
  heroRecordingError: {
    backgroundColor: "#fff0ed",
    borderRadius: 8,
    color: "#8e2c22",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    maxWidth: 320,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlign: "center",
  },
  heroActionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 20,
    justifyContent: "center",
    width: "100%",
  },
  heroRecordOrb: {
    alignItems: "center",
    backgroundColor: "#ff6b5d",
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 999,
    borderWidth: 7,
    height: 88,
    justifyContent: "center",
    width: 88,
    shadowColor: "#ff5a4c",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.2,
    shadowRadius: 30,
  },
  heroRecordOrbStop: {
    backgroundColor: "#f04f42",
    borderColor: "rgba(255,255,255,0.14)",
    shadowColor: "#f04f42",
  },
  heroRecordGlyphBubble: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  heroRecordButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900",
  },
  heroSideAction: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
    borderColor: "rgba(255,255,255,0.15)",
    borderRadius: 999,
    borderWidth: 1,
    height: 50,
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 22,
    width: 50,
  },
  heroSideActionDisabled: {
    opacity: 0.42,
  },
  heroSideActionIcon: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "900",
  },
  heroRecordGlyph: {
    alignItems: "center",
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  heroRecordGlyphHead: {
    backgroundColor: "#ffffff",
    borderRadius: 999,
    height: 29,
    width: 20,
  },
  heroRecordGlyphStem: {
    backgroundColor: "#ffffff",
    borderRadius: 999,
    height: 10,
    marginTop: 2,
    width: 5,
  },
  heroStopGlyph: {
    backgroundColor: "#ffffff",
    borderRadius: 5,
    height: 24,
    width: 24,
  },
  heroRecordGlyphDark: {
    backgroundColor: "#103326",
  },
  heroStopGlyphDark: {
    backgroundColor: "#ffffff",
  },
  heroOrbLabel: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
    marginTop: 10,
  },
  heroOrbLabelStop: {
    color: "#ffffff",
  },
  heroPrimaryButtonDisabled: {
    opacity: 0.65,
  },
  heroSecondaryRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    marginTop: 8,
    minHeight: 36,
  },
  heroSecondaryAction: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.82)",
    borderColor: "#d5dfd9",
    borderRadius: 999,
    borderWidth: 1,
    height: 48,
    justifyContent: "center",
    width: 48,
  },
  heroSidePlaceholder: {
    height: 48,
    width: 48,
  },
  heroSecondaryText: {
    color: "#34423b",
    fontSize: 14,
    fontWeight: "800",
  },
  heroStatusGrid: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    width: "100%",
  },
  heroStatusCard: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  heroStatusLabel: {
    color: "rgba(255,255,255,0.58)",
    fontSize: 11,
    fontWeight: "800",
  },
  heroStatusValue: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "900",
    marginTop: 3,
  },
  heroFootnote: {
    backgroundColor: "#fffaf0",
    borderColor: "#e9dfcb",
    borderRadius: 16,
    borderWidth: 1,
    color: "#75644a",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlign: "center",
    width: "100%",
  },
  flowHintCard: {
    alignItems: "flex-start",
    backgroundColor: "#fbfdfb",
    borderColor: "#e3ebe6",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    width: "100%",
  },
  flowHintIcon: {
    alignItems: "center",
    backgroundColor: "#e6f4ef",
    borderRadius: 999,
    height: 28,
    justifyContent: "center",
    shadowColor: "#101828",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 14,
    width: 28,
  },
  flowHintIconText: {
    color: "#0f766e",
    fontSize: 13,
    fontWeight: "900",
  },
  flowHintCopy: {
    flex: 1,
    minWidth: 0,
  },
  flowHintTitle: {
    color: "#101828",
    fontSize: 13,
    fontWeight: "900",
  },
  flowHintDetail: {
    color: "#667085",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 16,
    marginTop: 3,
  },
  providerWarningCard: {
    backgroundColor: "#fff7e7",
    borderColor: "#ead5a5",
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    shadowColor: "#101828",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.06,
    shadowRadius: 28,
  },
  firstRunGuide: {
    backgroundColor: "#f2f8f5",
    borderColor: "#cfe3d8",
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
    padding: 14,
  },
  firstRunGuideAttention: {
    backgroundColor: "#fff9ed",
    borderColor: "#ead9ba",
  },
  firstRunGuideBlocked: {
    backgroundColor: "#fff5f3",
    borderColor: "#eccbc5",
  },
  firstRunGuideHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  firstRunGuideIcon: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 8,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  firstRunGuideCopy: {
    flex: 1,
    minWidth: 0,
  },
  firstRunGuideEyebrow: {
    color: "#67756e",
    fontSize: 11,
    fontWeight: "800",
  },
  firstRunGuideTitle: {
    color: "#17211d",
    fontSize: 17,
    fontWeight: "900",
    marginTop: 2,
  },
  firstRunGuideDetail: {
    color: "#56645d",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 10,
  },
  firstRunGuideActions: {
    gap: 8,
    marginTop: 12,
  },
  meetingCostIndicator: {
    alignItems: "flex-start",
    alignSelf: "stretch",
    backgroundColor: "rgba(255,255,255,0.66)",
    borderColor: "#cfe1d7",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  meetingCostIndicatorWarning: {
    backgroundColor: "#fff9ed",
    borderColor: "#ead9ba",
  },
  meetingCostCopy: {
    flex: 1,
    minWidth: 0,
  },
  meetingCostLabel: {
    color: "#17664f",
    fontSize: 12,
    fontWeight: "900",
  },
  meetingCostLabelWarning: {
    color: "#8a5a00",
  },
  meetingCostDetail: {
    color: "#59675f",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  providerReadyCard: {
    backgroundColor: "#f3fbf6",
    borderColor: "#cbe7d6",
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    shadowColor: "#101828",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.05,
    shadowRadius: 24,
  },
  providerSetupHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 11,
  },
  providerSetupCopy: {
    flex: 1,
    minWidth: 0,
  },
  providerSetupTitle: {
    color: "#171713",
    fontSize: 15,
    fontWeight: "800",
  },
  providerSetupText: {
    color: "#655a4a",
    fontSize: 12,
    lineHeight: 19,
    marginTop: 2,
  },
  providerInlineLink: {
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 2,
    paddingVertical: 8,
  },
  providerInlineLinkText: {
    color: "#1f6f55",
    fontSize: 14,
    fontWeight: "800",
  },
  providerSetupActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  providerWarningIcon: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 8,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  providerReadyIcon: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 8,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  providerWarningIconText: {
    color: "#a15c00",
    fontSize: 18,
    fontWeight: "900",
  },
  providerReadyIconText: {
    color: "#17664f",
    fontSize: 18,
    fontWeight: "900",
  },
  settingsGuideWarning: {
    backgroundColor: "#fff9ed",
    borderColor: "#ead9ba",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  settingsGuideReady: {
    backgroundColor: "#f3fbf6",
    borderColor: "#cbe7d6",
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  settingsGuideTitle: {
    color: "#171713",
    fontSize: 16,
    fontWeight: "800",
  },
  settingsGuideText: {
    color: "#665b4c",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 6,
  },
  settingsGuideGrid: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  providerGuideStatusReady: {
    backgroundColor: "#ffffff",
    borderColor: "#cbe7d6",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  providerGuideStatusWarning: {
    backgroundColor: "#ffffff",
    borderColor: "#ead9ba",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  providerGuideStatusReadyText: {
    color: "#17664f",
    fontSize: 14,
    fontWeight: "800",
  },
  providerGuideStatusWarningText: {
    color: "#a15c00",
    fontSize: 14,
    fontWeight: "800",
  },
  providerGuideStatusLabel: {
    color: "#665b4c",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  quickTabs: {
    backgroundColor: "#ffffff",
    borderColor: "#e3e8e5",
    borderRadius: 0,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 8,
    paddingTop: 4,
    shadowOpacity: 0,
  },
  tabButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: 8,
    flex: 1,
    gap: 4,
    minHeight: 48,
    justifyContent: "center",
  },
  tabButtonActive: {
    backgroundColor: "transparent",
  },
  tabButtonText: {
    color: "#7b8580",
    fontSize: 11,
    fontWeight: "800",
  },
  tabButtonTextActive: {
    color: "#07845f",
  },
  tabIconFill: {
    backgroundColor: "#a89f96",
  },
  tabIconFillActive: {
    backgroundColor: "#ffffff",
  },
  tabIconStroke: {
    borderColor: "#a89f96",
  },
  tabIconStrokeActive: {
    borderColor: "#ffffff",
  },
  tabIconFillLight: {
    backgroundColor: "#ffffff",
  },
  tabIconStrokeLight: {
    borderColor: "#ffffff",
  },
  tabIconBox: {
    alignItems: "center",
    height: 18,
    justifyContent: "center",
    width: 22,
  },
  tabIconCircle: {
    borderRadius: 999,
    height: 12,
    width: 12,
  },
  tabIconStem: {
    borderRadius: 999,
    height: 5,
    marginTop: 1,
    width: 2,
  },
  tabDocumentIcon: {
    backgroundColor: "transparent",
    borderRadius: 4,
    borderWidth: 2,
    height: 18,
    justifyContent: "center",
    paddingHorizontal: 3,
    width: 17,
  },
  tabDocumentLine: {
    borderRadius: 999,
    height: 2,
    marginBottom: 3,
    width: 8,
  },
  tabDocumentLineShort: {
    borderRadius: 999,
    height: 2,
    width: 6,
  },
  tabSettingsIcon: {
    gap: 5,
    height: 18,
    justifyContent: "center",
    width: 22,
  },
  tabSliderLine: {
    borderRadius: 999,
    height: 2,
    width: 22,
  },
  tabSliderKnobLeft: {
    borderRadius: 999,
    height: 6,
    marginLeft: 4,
    marginTop: -11,
    width: 6,
  },
  tabSliderKnobRight: {
    alignSelf: "flex-end",
    borderRadius: 999,
    height: 6,
    marginRight: 4,
    marginTop: -11,
    width: 6,
  },
  tabAccountIcon: {
    alignItems: "center",
    height: 18,
    justifyContent: "center",
    width: 22,
  },
  tabAccountHead: {
    borderRadius: 999,
    height: 8,
    marginBottom: 2,
    width: 8,
  },
  tabAccountBody: {
    backgroundColor: "transparent",
    borderRadius: 999,
    borderWidth: 2,
    height: 8,
    width: 16,
  },
  recordSegmentShell: {
    backgroundColor: "#ffffff",
    borderColor: "transparent",
    borderRadius: 0,
    borderWidth: 0,
    marginBottom: 14,
    marginHorizontal: -16,
    paddingBottom: 18,
    paddingHorizontal: 16,
  },
  recordSegmentTabs: {
    backgroundColor: "#ffffff",
    borderBottomColor: "#e5e9e6",
    borderBottomWidth: 1,
    borderRadius: 0,
    flexDirection: "row",
    gap: 0,
    padding: 0,
  },
  recordSegmentButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderBottomColor: "transparent",
    borderBottomWidth: 2,
    borderRadius: 0,
    flex: 1,
    flexDirection: "row",
    gap: 7,
    minHeight: 46,
    justifyContent: "center",
  },
  recordSegmentButtonActive: {
    backgroundColor: "transparent",
    borderBottomColor: "#087456",
    shadowOpacity: 0,
  },
  recordSegmentText: {
    color: "#6d7973",
    fontSize: 14,
    fontWeight: "800",
  },
  recordSegmentTextActive: {
    color: "#14795b",
  },
  recordResultPanel: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 0,
    borderTopWidth: 0,
    marginTop: 16,
    minHeight: 190,
    paddingHorizontal: 0,
    paddingTop: 14,
    shadowOpacity: 0,
  },
  resultHeader: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    marginBottom: 10,
  },
  resultTitle: {
    color: "#171713",
    fontSize: 16,
    fontWeight: "800",
  },
  resultSubtitle: {
    color: "#69736d",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  resultBadge: {
    backgroundColor: "#eef6f1",
    borderRadius: 999,
    color: "#1f6f55",
    fontSize: 12,
    fontWeight: "800",
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  emptyState: {
    alignItems: "center",
    borderWidth: 0,
    justifyContent: "center",
    minHeight: 120,
    padding: 18,
  },
  emptyStateIcon: {
    color: "#1f6f55",
    fontSize: 30,
    fontWeight: "800",
  },
  emptyStateTitle: {
    color: "#344054",
    fontSize: 14,
    fontWeight: "800",
    marginTop: 8,
    textAlign: "center",
  },
  emptyStateText: {
    color: "#717b73",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
    textAlign: "center",
  },
  processingStepLabel: {
    color: "#14795b",
    fontSize: 11,
    fontWeight: "800",
    marginTop: 8,
  },
  processingStepTrack: {
    flexDirection: "row",
    gap: 7,
    marginTop: 14,
  },
  processingStepDot: {
    backgroundColor: "#d8e2dc",
    borderRadius: 999,
    height: 5,
    width: 32,
  },
  processingStepDotActive: {
    backgroundColor: "#14795b",
  },
  autoSyncNotice: {
    alignItems: "flex-start",
    backgroundColor: "#f4f8f5",
    borderRadius: 8,
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 11,
    paddingVertical: 10,
  },
  autoSyncNoticeText: {
    color: "#53645b",
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  offlineSessionBanner: {
    alignItems: "flex-start",
    backgroundColor: "#fff8ea",
    borderColor: "#ead8b7",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  offlineSessionBannerTextBlock: {
    flex: 1,
  },
  offlineSessionBannerTitle: {
    color: "#6f4f22",
    fontSize: 13,
    fontWeight: "800",
  },
  offlineSessionBannerText: {
    color: "#7d633f",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 2,
  },
  sessionExpiredBanner: {
    backgroundColor: "#fff1ee",
    borderColor: "#efc5bc",
  },
  sessionExpiredBannerTitle: {
    color: "#8f3426",
  },
  sessionExpiredBannerText: {
    color: "#7c463d",
  },
  label: {
    color: "#29251d",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 6,
    marginTop: 8,
  },
  accountName: {
    color: "#171713",
    fontSize: 18,
    fontWeight: "800",
  },
  accountSummaryCard: {
    backgroundColor: "#f3f8f5",
    borderColor: "#dce9e2",
    borderRadius: 14,
    borderWidth: 1,
    gap: 14,
    padding: 16,
  },
  accountSummaryIdentity: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  accountSummaryUsage: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 8,
  },
  accountSummaryLabel: {
    color: "#68736d",
    fontSize: 13,
    fontWeight: "600",
  },
  accountSummaryValue: {
    color: "#173f34",
    fontSize: 24,
    fontWeight: "800",
  },
  input: {
    backgroundColor: "#fbfaf6",
    borderColor: "#c9bfae",
    borderRadius: 8,
    borderWidth: 1,
    color: "#171713",
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 10,
  },
  multilineInput: {
    height: 120,
    paddingBottom: 10,
    paddingTop: 10,
  },
  compactMultilineInput: {
    height: 88,
    paddingBottom: 10,
    paddingTop: 10,
  },
  help: {
    color: "#665b4c",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 8,
  },
  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  processingModeOptions: {
    gap: 10,
    marginTop: 14,
  },
  processingModeOption: {
    alignItems: "center",
    backgroundColor: "#fbfaf6",
    borderColor: "#ded8cd",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 11,
    minHeight: 82,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  processingModeOptionSelected: {
    backgroundColor: "#eef7f2",
    borderColor: "#07845f",
    borderWidth: 2,
  },
  processingModeOptionDisabled: {
    opacity: 0.58,
  },
  processingModeIcon: {
    alignItems: "center",
    backgroundColor: "#e6f2eb",
    borderRadius: 10,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  processingModeIconSelected: {
    backgroundColor: "#07845f",
  },
  processingModeCopy: {
    flex: 1,
    minWidth: 0,
  },
  processingModeHeading: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  processingModeLabel: {
    color: "#173f34",
    fontSize: 15,
    fontWeight: "900",
  },
  providerExternalLinks: {
    gap: 8,
    marginTop: 12,
  },
  providerExternalLink: {
    alignItems: "center",
    backgroundColor: "#f2f8f4",
    borderColor: "#cfe2d6",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  providerExternalLinkText: {
    color: "#1f6f55",
    flex: 1,
    fontSize: 13,
    fontWeight: "800",
  },
  providerAlternative: {
    backgroundColor: "#f7faf8",
    borderRadius: 8,
    color: "#53645b",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  providerStepTitle: {
    color: "#17211d",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 5,
    marginTop: 8,
  },
  providerAdvancedToggle: {
    alignItems: "center",
    borderBottomColor: "#e6ebe8",
    borderBottomWidth: 1,
    borderTopColor: "#e6ebe8",
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 46,
    marginTop: 10,
  },
  providerAdvancedToggleText: {
    color: "#425149",
    fontSize: 14,
    fontWeight: "700",
  },
  providerAdvancedFields: {
    paddingTop: 10,
  },
  providerDeleteButton: {
    alignItems: "center",
    borderColor: "#ead7d2",
    borderRadius: 8,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  sectionToggle: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderBottomColor: "#e7ece9",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 68,
    paddingVertical: 10,
  },
  sectionToggleIcon: {
    alignItems: "center",
    backgroundColor: "#edf6f1",
    borderRadius: 8,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  sectionToggleIconDanger: {
    backgroundColor: "#fff0ee",
  },
  sectionToggleCopy: {
    flex: 1,
    minWidth: 0,
  },
  sectionToggleLabel: {
    color: "#1e3028",
    fontSize: 15,
    fontWeight: "800",
  },
  sectionToggleLabelDanger: {
    color: "#a33d35",
  },
  sectionToggleDetail: {
    color: "#5f6b65",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  menuAction: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderBottomColor: "#e7ece9",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 62,
    paddingVertical: 9,
  },
  menuActionCopy: {
    flex: 1,
    minWidth: 0,
  },
  menuActionLabel: {
    color: "#26362f",
    fontSize: 14,
    fontWeight: "800",
  },
  menuActionLabelDanger: {
    color: "#a33d35",
  },
  menuActionDetail: {
    color: "#5f6b65",
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  button: {
    alignItems: "center",
    borderRadius: 8,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  buttonWide: {
    flex: 1,
    minHeight: 64,
  },
  primaryButton: {
    backgroundColor: "#1f6f55",
  },
  secondaryButton: {
    backgroundColor: "#fff",
    borderColor: "#c9bfae",
    borderWidth: 1,
  },
  secondaryButtonDark: {
    backgroundColor: "rgba(255,255,255,0.1)",
    borderColor: "rgba(255,255,255,0.18)",
  },
  dangerButton: {
    backgroundColor: "#2b405f",
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonDisabled: {
    opacity: 0.48,
  },
  buttonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  buttonTextDisabled: {
    color: "#667085",
  },
  secondaryButtonText: {
    color: "#171713",
  },
  secondaryButtonTextDark: {
    color: "#ffffff",
  },
  warning: {
    backgroundColor: "#fff8e6",
    borderRadius: 8,
    color: "#73510e",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    padding: 10,
  },
  error: {
    backgroundColor: "#fff0ed",
    borderRadius: 8,
    color: "#8e2c22",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    padding: 10,
  },
  success: {
    backgroundColor: "#eef6f1",
    borderRadius: 8,
    color: "#1f6f55",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    padding: 10,
  },
  diagnosticBox: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 10,
    padding: 10,
  },
  mobileReadinessBox: {
    backgroundColor: "#ffffff",
    borderColor: "#ece6da",
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 10,
    padding: 10,
  },
  mobileBlockerList: {
    gap: 8,
    marginTop: 10,
  },
  mobileBlockerItem: {
    backgroundColor: "#fff8e6",
    borderColor: "#ead9ba",
    borderRadius: 8,
    borderWidth: 1,
    padding: 9,
  },
  mobileBlockerTitle: {
    color: "#171713",
    fontSize: 13,
    fontWeight: "800",
  },
  mobileBlockerDetail: {
    color: "#73510e",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 4,
  },
  diagnosticTitle: {
    color: "#171713",
    fontSize: 13,
    fontWeight: "700",
  },
  empty: {
    color: "#756c5f",
    fontSize: 13,
    lineHeight: 20,
  },
  transcriptItem: {
    backgroundColor: "#ffffff",
    borderBottomColor: "#e5e9e6",
    borderBottomWidth: 1,
    paddingVertical: 12,
  },
  transcriptMeta: {
    color: "#2b405f",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
  },
  transcriptText: {
    color: "#29251d",
    fontSize: 13,
    lineHeight: 20,
  },
  historySearchField: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#dce4df",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  historySearchInput: {
    color: "#1d2923",
    flex: 1,
    fontSize: 14,
    minHeight: 44,
    paddingVertical: 0,
  },
  historyClearButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    marginRight: -8,
    width: 44,
  },
  historyFilterTabs: {
    backgroundColor: "#e9efeb",
    borderRadius: 8,
    flexDirection: "row",
    gap: 3,
    marginTop: 10,
    padding: 3,
  },
  historyFilterTab: {
    alignItems: "center",
    borderRadius: 6,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 4,
  },
  historyFilterTabActive: {
    backgroundColor: "#ffffff",
  },
  historyFilterText: {
    color: "#718079",
    fontSize: 12,
    fontWeight: "700",
  },
  historyFilterTextActive: {
    color: "#14795b",
  },
  historyListHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
    marginTop: 12,
  },
  localRecordingSection: {
    borderBottomColor: "#e3e9e5",
    borderBottomWidth: 1,
    marginBottom: 14,
    paddingBottom: 6,
  },
  historyResultCount: {
    color: "#68736d",
    fontSize: 12,
    fontWeight: "700",
  },
  historyRefreshButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    marginRight: -8,
    width: 44,
  },
  historyLoadMore: {
    alignItems: "center",
    marginTop: 4,
  },
  meetingDetailBack: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 2,
    marginBottom: 8,
    marginLeft: -8,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  meetingDetailBackText: {
    color: "#14795b",
    fontSize: 14,
    fontWeight: "700",
  },
  meetingDetailStatus: {
    color: "#68736d",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 5,
  },
  meetingDetailMeta: {
    color: "#7b8580",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  meetingAudioUnavailable: {
    color: "#7b8580",
    fontSize: 12,
    lineHeight: 18,
    marginTop: 10,
  },
  meetingAudioCard: {
    backgroundColor: "#f3f8f5",
    borderColor: "#d6e5dc",
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 14,
    padding: 12,
  },
  meetingAudioHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  meetingAudioTitleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 7,
  },
  meetingAudioProgressTrack: {
    backgroundColor: "#dce8e1",
    borderRadius: 999,
    height: 4,
    marginTop: 14,
    overflow: "hidden",
  },
  meetingAudioProgressFill: {
    backgroundColor: "#14795b",
    borderRadius: 999,
    height: "100%",
  },
  meetingAudioTimeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  meetingAudioTime: {
    color: "#6c7872",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 10,
    fontWeight: "700",
  },
  meetingAudioControls: {
    alignItems: "center",
    flexDirection: "row",
    gap: 9,
    justifyContent: "center",
    marginTop: 10,
  },
  meetingAudioControl: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#d6e2db",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    height: 44,
    justifyContent: "center",
    minWidth: 54,
    paddingHorizontal: 8,
  },
  meetingAudioControlText: {
    color: "#31423a",
    fontSize: 10,
    fontWeight: "800",
    marginLeft: 2,
  },
  meetingAudioPlayButton: {
    alignItems: "center",
    backgroundColor: "#14795b",
    borderRadius: 999,
    height: 52,
    justifyContent: "center",
    width: 52,
  },
  meetingAudioRateButton: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#d6e2db",
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    minWidth: 50,
    paddingHorizontal: 9,
  },
  meetingAudioRateText: {
    color: "#14795b",
    fontSize: 12,
    fontWeight: "900",
  },
  meetingDetailSummary: {
    borderBottomColor: "#e3e9e5",
    borderBottomWidth: 1,
    borderTopColor: "#e3e9e5",
    borderTopWidth: 1,
    gap: 6,
    marginTop: 14,
    paddingVertical: 14,
  },
  meetingDetailSectionTitle: {
    color: "#17211d",
    fontSize: 15,
    fontWeight: "800",
    marginBottom: 2,
  },
  meetingItem: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
    padding: 10,
  },
  meetingMetadataPreview: {
    color: "#557067",
    fontSize: 11,
    fontWeight: "700",
    marginTop: 5,
  },
  meetingMetadataEditor: {
    borderTopColor: "#e2e8e4",
    borderTopWidth: 1,
    gap: 10,
    marginTop: 12,
    paddingTop: 14,
  },
  meetingHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
  },
  meetingHeaderText: {
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  meetingTitle: {
    color: "#171713",
    flex: 1,
    fontSize: 14,
    fontWeight: "800",
  },
  publicBadge: {
    backgroundColor: "#eef6f1",
    borderRadius: 6,
    color: "#1f6f55",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  privateBadge: {
    backgroundColor: "#edf0ed",
    borderRadius: 6,
    color: "#665b4c",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  warningBadge: {
    backgroundColor: "#fff8e6",
    borderRadius: 6,
    color: "#73510e",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dangerBadge: {
    backgroundColor: "#fff1f0",
    borderRadius: 6,
    color: "#a63a32",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  detailBlock: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    padding: 10,
  },
  speakerEditItem: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 10,
    padding: 10,
  },
  speakerEditLabel: {
    color: "#665b4c",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 7,
  },
  speakerLimitationNotice: {
    backgroundColor: "#fff8e8",
    borderColor: "#ead9ba",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 10,
    padding: 10,
  },
  speakerLimitationTitle: {
    color: "#6f4d13",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 4,
  },
  speakerLimitationText: {
    color: "#6f4d13",
    fontSize: 12,
    lineHeight: 18,
  },
  humanReviewConfirmed: {
    backgroundColor: "#eef8f2",
    borderColor: "#b9d8c9",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 10,
    padding: 10,
  },
  humanReviewConfirmedTitle: {
    color: "#1f6f55",
    fontSize: 12,
    fontWeight: "800",
    marginBottom: 4,
  },
  humanReviewConfirmedText: {
    color: "#315f4e",
    fontSize: 12,
    lineHeight: 18,
  },
  transcriptReviewList: {
    gap: 10,
    marginTop: 12,
  },
  transcriptReviewItem: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 12,
    borderWidth: 1,
    padding: 11,
  },
  transcriptPlaybackItem: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 12,
    borderWidth: 1,
    padding: 11,
  },
  transcriptReviewHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  transcriptReviewTime: {
    color: "#14795b",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 11,
    fontWeight: "800",
  },
  transcriptReviewCurrent: {
    color: "#68736d",
    fontSize: 11,
    fontWeight: "800",
  },
  transcriptReviewText: {
    color: "#27332e",
    fontSize: 14,
    lineHeight: 22,
    marginTop: 8,
  },
  transcriptSpeakerChoices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 10,
  },
  transcriptSpeakerChoice: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#dce5df",
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 11,
  },
  transcriptSpeakerChoiceActive: {
    backgroundColor: "#eaf2ed",
    borderColor: "#8db8a7",
  },
  transcriptSpeakerChoiceText: {
    color: "#68736d",
    fontSize: 12,
    fontWeight: "700",
  },
  transcriptSpeakerChoiceTextActive: {
    color: "#14795b",
    fontSize: 12,
    fontWeight: "800",
  },
  transcriptSpeakerInput: {
    marginTop: 9,
  },
  notesSection: {
    marginTop: 14,
  },
  detailTitle: {
    color: "#171713",
    fontSize: 13,
    fontWeight: "800",
  },
  providerList: {
    gap: 8,
    marginTop: 12,
  },
  providerItem: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
  },
  readinessList: {
    gap: 8,
    marginTop: 12,
  },
  readinessItem: {
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
  },
  costBox: {
    backgroundColor: "transparent",
    borderWidth: 0,
    gap: 10,
    marginTop: 18,
    padding: 0,
  },
  usageItem: {
    alignItems: "flex-start",
    backgroundColor: "#fbfaf6",
    borderColor: "#ece6da",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    padding: 10,
  },
  usageItemCopy: {
    flex: 1,
    minWidth: 0,
  },
  usageItemMeta: {
    alignItems: "flex-end",
    flexShrink: 0,
  },
  usageNegative: {
    color: "#a63a32",
    fontSize: 13,
    fontWeight: "800",
    textAlign: "right",
  },
  usagePositive: {
    color: "#1f6f55",
    fontSize: 13,
    fontWeight: "800",
    textAlign: "right",
  },
  separator: {
    backgroundColor: "#ece6da",
    height: 1,
    marginTop: 14,
  },
});
