export type MeetingStatus = "idle" | "requesting" | "recording" | "paused" | "processing" | "complete" | "error";

export type TranscriptSegment = {
  id: string;
  speaker: string;
  timestamp: string;
  text: string;
};

export type UploadState = {
  uploaded: number;
  pending: number;
  failed: number;
  savedBytes: number;
  provider: string;
  adapter: string;
  lastAckAt: string | null;
  lastError: string | null;
  diagnostic: string | null;
};

export type AudioChunkAck = {
  assembly?: "bounded-temp-file" | "legacy-buffer";
  assemblyMaxBufferedBytes?: number;
  ok: boolean;
  meetingId: string;
  sequence: number;
  savedBytes: number;
  totalChunks: number;
  totalBytes: number;
  durationMs?: number;
  receivedAt: string;
  provider: "mock" | "openai" | "volcano";
  adapter: string;
  diagnostic?: string;
  transcriptSegment?: TranscriptSegment;
};

export type RealtimeAudioChunkAck = {
  ok: boolean;
  code?: string;
  error?: string;
  meetingId: string;
  sequence: number;
  receivedBytes: number;
  receivedAt?: string;
  provider: "mock" | "openai" | "volcano";
  adapter: string;
  diagnostic?: string;
  providerStatus?: "accepted" | "draft" | "not_configured" | "pending_protocol" | "provider_error" | "reconnecting" | "completed" | "rejected_format" | "out_of_order";
  duplicate?: boolean;
  expectedSequence?: number;
  realtimeSessionId?: string;
  transcriptSegment?: TranscriptSegment;
  realtime: {
    byteDrift: number;
    channels: number;
    expectedBytes: number;
    formatOk: boolean;
    sampleRate: number;
    storedForFinalization: boolean;
  };
};

export type RealtimeSessionFinishAck = {
  ok: boolean;
  error?: string;
  meetingId: string;
  provider: "mock" | "openai" | "volcano";
  providerStatus: "completed" | "provider_error";
  realtimeSessionId?: string;
  transcriptSegment?: TranscriptSegment;
  diagnostic?: string;
  realtime: {
    storedForFinalization: boolean;
  };
};

export type ProviderDiagnostic = {
  provider: "mock" | "openai" | "volcano";
  adapter: string;
  ready: boolean;
  missing: string[];
  present: Record<string, boolean>;
  notes: string[];
  capabilities?: {
    realtimeConfigured?: boolean;
    realtimeProtocolReady?: boolean;
    realtimeReady: boolean;
    fileAsrReady: boolean;
    summaryReady: boolean;
  };
};

export type BackendHealthResponse = {
  ok: boolean;
  service?: string;
  generatedAt?: string;
  runtime?: string;
  checks?: {
    app?: string;
    authRepository?: string;
    deploymentConfigured?: boolean;
    finalizationMode?: "inline" | "postgres-queue";
    finalizationWorkerEnabled?: boolean;
    localLegalRoutes?: boolean;
    providerConfigured?: boolean;
    storageProvider?: string;
  };
};

export type ReleaseReadinessSummary = {
  ready: number;
  warning: number;
  blocked: number;
  criticalBlocked: number;
  total: number;
  mvpReady: boolean;
  testflightReady: boolean;
  commercialReady: boolean;
};

export type ReleaseReadinessBlocker = {
  id: string;
  groupTitle: string;
  title: string;
  detail: string;
  nextAction: string;
  priority: "critical" | "high" | "medium";
  verificationCommand?: string;
};

export type ReleaseReadinessResponse = {
  ok: boolean;
  report?: {
    summary: ReleaseReadinessSummary;
    blockers?: ReleaseReadinessBlocker[];
  };
};

export type MeetingSummary = {
  summary: string;
  topics: string[];
  speakerViews: Array<{
    speaker: string;
    view: string;
  }>;
  decisions: Array<{
    id: string;
    title: string;
    detail: string;
    status: string;
  }>;
  actionItems: Array<{
    id: string;
    owner: string;
    task: string;
    due: string;
    status: string;
  }>;
  risks: string[];
  openQuestions: string[];
  knowledgePoints: string[];
};

export type MeetingResult = {
  meetingId: string;
  title: string;
  generatedAt: string;
  provider: string;
  adapter: string;
  transcript: TranscriptSegment[];
  summary: MeetingSummary;
  obsidianMarkdown: string;
  diagnostics: string[];
  processingRoute?: "byok" | "hybrid" | "official_quota";
  processedMinutes?: number;
  officialMinutesCharged?: number;
};

export type FinalizeMeetingResponse = {
  ok: boolean;
  result?: MeetingResult;
  processing?: MeetingFinalizationState;
  queued?: boolean;
  job?: {
    id: string;
    status: string;
    attempt: number;
    maxAttempts: number;
    availableAt: string;
  };
  idempotent?: boolean;
  retryable?: boolean;
  code?: string;
  error?: string;
  billing?: {
    processingRoute: "byok" | "hybrid" | "official_quota";
    processedMinutes: number;
    officialMinutesCharged: number;
  };
};

export type MeetingFinalizationState = {
  meetingId: string;
  ownerUserId: string;
  title: string;
  status: "queued" | "processing" | "completed" | "failed";
  attempt: number;
  jobId?: string;
  requestedAt: string;
  queuedAt?: string;
  startedAt?: string;
  updatedAt: string;
  nextAttemptAt?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  failedAt?: string;
  resultGeneratedAt?: string;
  qualityStatus?: "verified" | "unverified";
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

export type MeetingListItem = {
  meetingId: string;
  title: string;
  generatedAt?: string;
  updatedAt: string;
  durationMs: number;
  totalBytes: number;
  totalChunks: number;
  metadata: {
    participants: string[];
    project?: string;
    tags: string[];
    title?: string;
    updatedAt?: string;
  };
  share: {
    visibility: "private" | "public";
    includeTranscript: boolean;
    expiresAt?: string;
    updatedAt?: string;
  };
  hasResult: boolean;
  transcriptCount: number;
  processing: MeetingFinalizationState | null;
  qualityStatus: "verified" | "unverified";
  humanReview: {
    status: "pending" | "confirmed";
    confirmedAt?: string;
    needsReconfirmation: boolean;
  };
};

export type MeetingDetail = MeetingListItem & {
  result: MeetingResult | null;
  obsidianMarkdown: string | null;
};

export type MeetingsResponse = {
  ok: boolean;
  meetings?: MeetingListItem[];
  error?: string;
};

export type MeetingDetailResponse = {
  ok: boolean;
  meeting?: MeetingDetail;
  error?: string;
};

export type MeetingSpeakerUpdateResponse = {
  ok: boolean;
  meetingId?: string;
  speakerNames?: Record<string, string>;
  result?: MeetingResult;
  obsidianMarkdown?: string;
  humanReview?: MeetingListItem["humanReview"];
  share?: MeetingListItem["share"];
  error?: string;
};

export type MeetingTranscriptSpeakerUpdateResponse = {
  ok: boolean;
  meetingId?: string;
  speakerAssignments?: Record<string, string>;
  result?: MeetingResult;
  obsidianMarkdown?: string;
  humanReview?: MeetingListItem["humanReview"];
  share?: MeetingListItem["share"];
  error?: string;
};

export type MeetingSummaryUpdateResponse = {
  ok: boolean;
  meetingId?: string;
  result?: MeetingResult;
  obsidianMarkdown?: string;
  humanReview?: MeetingListItem["humanReview"];
  share?: MeetingListItem["share"];
  error?: string;
};

export type MeetingMetadataUpdateResponse = {
  ok: boolean;
  meetingId?: string;
  metadata?: MeetingListItem["metadata"];
  result?: MeetingResult | null;
  obsidianMarkdown?: string;
  humanReview?: MeetingListItem["humanReview"];
  share?: MeetingListItem["share"];
  error?: string;
};

export type DeleteMeetingResponse = {
  ok: boolean;
  meetingId?: string;
  cleanupPending?: boolean;
  error?: string;
};

export type ShareVisibility = "private" | "public";

export type MeetingShareResponse = {
  ok: boolean;
  meetingId?: string;
  share?: MeetingListItem["share"];
  shareUrl?: string;
  error?: string;
  code?: string;
  qualityConfirmationRequired?: boolean;
};

export type MeetingHumanReviewResponse = {
  ok: boolean;
  meetingId?: string;
  humanReview?: MeetingListItem["humanReview"];
  share?: MeetingListItem["share"];
  error?: string;
  code?: string;
};

export type BillingPlanId = "free" | "plus" | "pro";
export type UserProcessingMode = "official_quota" | "byok";
export type RecordingConsentMethod = "in_app_confirmation" | "legacy_unknown";

export type RecordingConsentMetadata = {
  consentConfirmedAt?: string;
  consentMethod: RecordingConsentMethod;
  consentPolicyVersion?: string;
};

export type PaymentDiagnostics = {
  acceptingPurchases: boolean;
  generatedAt: string;
  provider: "simulated" | "apple-iap" | "external-billing";
  productionReady: boolean;
  configured: {
    iapEnvironment: "auto" | "production" | "sandbox";
    idempotency: boolean;
    accountBinding: boolean;
    productIds: boolean;
  };
  capabilities: {
    grantsOfficialQuota: boolean;
    hasServerEndpoints: boolean;
    verifiesTransactions: boolean;
  };
  missing: string[];
};

export type PaymentDiagnosticsResponse = {
  ok: boolean;
  diagnostics?: PaymentDiagnostics;
  productIds?: string[];
  products?: Array<{ plan: BillingPlanId; productId: string }>;
  error?: string;
};

export type PaymentStorefront = {
  acceptingPurchases: boolean;
  provider: {
    id: "simulated" | "apple-iap" | "external-billing";
    status: "available" | "unavailable";
  };
  products: Array<{
    amountCents: number;
    currency: string;
    plan: BillingPlanId;
    productId: string;
  }>;
};

export type PaymentStorefrontResponse = {
  ok: boolean;
  storefront?: PaymentStorefront;
  code?: string;
  error?: string;
};

export type MobileUser = {
  id: string;
  email: string;
  emailVerifiedAt?: string;
  name: string;
  role: "admin" | "user";
  plan: BillingPlanId;
  officialMinutesTotal: number;
  officialMinutesUsed: number;
  processingMode: UserProcessingMode;
};

export type AuthMeResponse = {
  ok: boolean;
  user?: MobileUser | null;
  usage?: AccountUsage;
  error?: string;
};

export type AuthResponse = AuthMeResponse & {
  code?: string;
  emailSent?: boolean;
  message?: string;
  resendAvailableAt?: string;
  retryAfterSeconds?: number;
  verificationRequired?: boolean;
  verificationToken?: string;
  user?: MobileUser;
};

export type EmailVerificationResponse = AuthResponse & {
  delivery?: {
    provider: string;
    sent: boolean;
  };
  expiresAt?: string;
};

export type PasswordResetRequestResponse = {
  ok: boolean;
  emailSent?: boolean;
  expiresAt?: string;
  resetToken?: string;
  delivery?: {
    provider: string;
    sent: boolean;
  };
  message?: string;
  error?: string;
};

export type PasswordResetConfirmResponse = {
  ok: boolean;
  message?: string;
  error?: string;
};

export type PasswordChangeResponse = {
  ok: boolean;
  user?: MobileUser;
  error?: string;
};

export type AppleTransactionResponse = {
  ok: boolean;
  duplicate?: boolean;
  entitlementGranted?: boolean;
  user?: MobileUser;
  code?: string;
  error?: string;
};

export type AppleAccountTokenResponse = {
  ok: boolean;
  appAccountToken?: string;
  code?: string;
  error?: string;
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

export type ProviderCredentialsResponse = {
  ok: boolean;
  providerCredentials?: ProviderCredentialSummary[];
  credential?: ProviderCredentialSummary;
  error?: string;
};

export type ProviderHealthResult = {
  providerId: string;
  label: string;
  status: "not_configured" | "incomplete" | "ready" | "failed";
  canUseFor: Array<"file_asr" | "realtime_asr" | "summary">;
  liveChecked: boolean;
  checks: Array<{
    id: string;
    label: string;
    ok: boolean;
    detail: string;
  }>;
  missing: string[];
  nextActions: string[];
  updatedAt: string;
};

export type ProviderHealthResponse = {
  ok: boolean;
  live?: boolean;
  health?: ProviderHealthResult[];
  error?: string;
};

export type AsrLiveTestResult = {
  ok: boolean;
  live: boolean;
  mode: "submit" | "transcribe";
  status: "not_configured" | "incomplete" | "preflight_pass" | "submitted" | "transcribed" | "completed_empty" | "failed";
  verificationLevel: "none" | "preflight" | "provider_submit" | "provider_transcript";
  title: string;
  detail: string;
  requestId?: string;
  transcriptPreview?: string;
  missing: string[];
  nextAction: string;
  checkedAt: string;
};

export type AsrLiveTestResponse = {
  ok: boolean;
  result?: AsrLiveTestResult;
  error?: string;
};

export type RealtimeAsrAuthTestResult = {
  checkedAt: string;
  detail: string;
  endpointHost: string;
  endpointPath: string;
  httpStatus?: number;
  ok: boolean;
  resourceId: string;
  status: "not_configured" | "connected" | "failed";
  title: string;
};

export type RealtimeAsrAuthTestResponse = {
  error?: string;
  ok: boolean;
  result?: RealtimeAsrAuthTestResult;
};

export type UsageEvent = {
  id: string;
  type: "register_bonus" | "meeting_finalize" | "manual_adjustment";
  minutes: number;
  createdAt: string;
  note: string;
  processingRoute?: "byok" | "hybrid" | "official_quota";
  processedMinutes?: number;
  officialMinutesCharged?: number;
};

export type AccountUsage = {
  plan: BillingPlanId;
  officialMinutesTotal: number;
  officialMinutesUsed: number;
  officialMinutesRemaining: number;
  officialProcessing?: {
    status: "ready" | "unavailable" | "unknown";
  };
  events: UsageEvent[];
  costControl: {
    mode: "byok" | "official_quota" | "hybrid";
    selectedMode: UserProcessingMode;
    providerCredentialCount: number;
    currentPlanPrice: string;
    officialMinuteUnitPrice: string;
    recommendation: string;
  };
};

export type AccountUsageResponse = {
  ok: boolean;
  usage?: AccountUsage;
  error?: string;
};

export type ProcessingModeResponse = {
  ok: boolean;
  processingMode?: UserProcessingMode;
  user?: MobileUser;
  code?: string;
  error?: string;
};

export type AccountExportResponse = {
  ok: boolean;
  exportVersion: number;
  generatedAt: string;
  product: string;
  user: MobileUser & {
    createdAt: string;
    officialMinutesRemaining: number;
  };
  usage: AccountUsage;
  providerCredentials: ProviderCredentialSummary[];
  providerHealth: ProviderHealthResult[];
  meetings: Array<{
    meetingId: string;
    title: string;
    generatedAt?: string;
    updatedAt: string;
    durationMs: number;
    totalBytes: number;
    totalChunks: number;
    share: MeetingListItem["share"];
    hasResult: boolean;
    transcriptCount: number;
  }>;
  notes: string[];
  error?: string;
};

export type DeleteAccountResponse = {
  ok: boolean;
  deletedMeetings?: number;
  deletedMeetingIds?: string[];
  error?: string;
  status?: "active" | "pending_cleanup" | "deleted";
};

export type AccountDeletionTicketResponse = {
  error?: string;
  expiresAt?: string;
  ok: boolean;
  ticket?: string;
};

export type AccountDeletionStatusResponse = {
  error?: string;
  ok: boolean;
  status?: "active" | "pending_cleanup" | "deleted";
};

export const initialUploadState: UploadState = {
  uploaded: 0,
  pending: 0,
  failed: 0,
  savedBytes: 0,
  provider: "mock",
  adapter: "未连接",
  lastAckAt: null,
  lastError: null,
  diagnostic: null,
};
