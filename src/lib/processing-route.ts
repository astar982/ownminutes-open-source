export type MeetingProcessingRoute = "byok" | "hybrid" | "official_quota";
export type UserProcessingMode = Exclude<MeetingProcessingRoute, "hybrid">;

export function isUserProcessingMode(value: unknown): value is UserProcessingMode {
  return value === "official_quota" || value === "byok";
}

export type MeetingProcessingReservation = {
  id: string;
  meetingId: string;
  operationKey: string;
  processingRoute: MeetingProcessingRoute;
  processedMinutes: number;
  officialMinutesReserved: number;
  officialMinutesSettled: number;
  realtimeDurationMs: number;
  realtimeHighestSequence: number;
  reservationExpiresAt: string;
  releasedAt?: string;
  status: "reserved" | "finalized";
};

export type RealtimeQuotaClaim = MeetingProcessingReservation & {
  duplicate: boolean;
  expectedSequence: number;
};

export type ReserveRealtimeQuotaInput = {
  durationMs: number;
  meetingId: string;
  operationKey: string;
  processingRoute: MeetingProcessingRoute;
  sequence: number;
};

export type ReserveFinalizationQuotaInput = {
  durationMs: number;
  meetingId: string;
  operationKey: string;
  processingRoute: MeetingProcessingRoute;
};

export const DEFAULT_MEETING_RESERVATION_LEASE_MS = 15 * 60 * 1000;
export const DEFAULT_PROVIDER_STEP_LEASE_MS = 2 * 60 * 1000;

export type MeetingProviderStage =
  | { type: "realtime_asr"; sequence: number }
  | { type: "finalization_asr" }
  | { type: "finalization_summary" };

export type MeetingProviderStepStatus = "claimed" | "started" | "completed" | "released";

export type MeetingProviderStep = {
  id: string;
  reservationId: string;
  stageKey: string;
  stageType: MeetingProviderStage["type"];
  sequence?: number;
  status: MeetingProviderStepStatus;
  leaseExpiresAt: string;
  officialMinutesSettled: number;
  freeTrialMinutesSettled: number;
  settlementPeriodIdentity?: string;
  startedAt?: string;
  completedAt?: string;
  releasedAt?: string;
};

export type ClaimMeetingProviderStepInput = {
  reservationId: string;
  stage: MeetingProviderStage;
  leaseMs?: number;
};

export type MeetingProviderStepClaimResult = {
  outcome: "claimed" | "busy" | "completed" | "uncertain";
  step: MeetingProviderStep;
  claimToken?: string;
};

export type StartMeetingProviderStepInput = {
  claimToken: string;
  stepId: string;
};

export type CompleteMeetingProviderStepInput = StartMeetingProviderStepInput;
export type ReleaseMeetingProviderStepInput = StartMeetingProviderStepInput;
export type RejectMeetingProviderStepInput = StartMeetingProviderStepInput;

export type ReconcileMeetingProviderStepInput = {
  reservationId: string;
  stage: Extract<MeetingProviderStage, { type: "finalization_asr" | "finalization_summary" }>;
};

export type MeetingProviderStepTransitionResult = {
  outcome: "started" | "completed" | "released" | "uncertain";
  step: MeetingProviderStep;
};

export type ReleaseMeetingProcessingReservationInput = {
  reservationId: string;
};

export function meetingProviderStageKey(stage: MeetingProviderStage) {
  if (stage.type === "realtime_asr") {
    if (!Number.isInteger(stage.sequence) || stage.sequence < 0) {
      throw new Error("Realtime provider stage sequence must be a non-negative integer.");
    }
    return `realtime:asr:${stage.sequence}`;
  }
  return stage.type === "finalization_asr" ? "finalization:asr" : "finalization:summary";
}

export function normalizeProviderStepLeaseMs(leaseMs?: number) {
  if (!Number.isFinite(leaseMs)) return DEFAULT_PROVIDER_STEP_LEASE_MS;
  return Math.max(30_000, Math.min(15 * 60 * 1000, Math.round(leaseMs!)));
}

export function initialMeetingOperationKey(meetingId: string) {
  return `meeting:${meetingId}:initial`;
}

export function reprocessMeetingOperationKey(meetingId: string, stableAttemptId: string) {
  return `meeting:${meetingId}:reprocess:${stableAttemptId}`;
}

export type ProviderCredentialDescriptor = {
  providerId: string;
  configuredFields: string[];
  configuredSecrets: string[];
};

export type ByokCoverage = {
  complete: boolean;
  hasAny: boolean;
  hasFileAsr: boolean;
  hasSummary: boolean;
};

export function getByokCoverage(credentials: ProviderCredentialDescriptor[]): ByokCoverage {
  const asr = credentials.find((credential) => credential.providerId === "volcano-asr");
  const ark = credentials.find((credential) => credential.providerId === "volcano-ark");
  const asrFields = new Set(asr?.configuredFields ?? []);
  const asrSecrets = new Set(asr?.configuredSecrets ?? []);
  const arkFields = new Set(ark?.configuredFields ?? []);
  const arkSecrets = new Set(ark?.configuredSecrets ?? []);
  const hasFileAsr =
    asrSecrets.has("VOLCANO_ASR_API_KEY") ||
    (asrFields.has("VOLCANO_ASR_APP_ID") && asrSecrets.has("VOLCANO_ASR_TOKEN"));
  const hasSummary = arkFields.has("ARK_CHAT_MODEL") && arkSecrets.has("ARK_API_KEY");

  return {
    complete: hasFileAsr && hasSummary,
    hasAny: Boolean(asr || ark),
    hasFileAsr,
    hasSummary,
  };
}

export function selectMeetingProcessingRoute(coverage: Pick<ByokCoverage, "hasFileAsr" | "hasSummary">): MeetingProcessingRoute {
  if (coverage.hasFileAsr && coverage.hasSummary) return "byok";
  if (coverage.hasFileAsr || coverage.hasSummary) return "hybrid";
  return "official_quota";
}

export function calculateMeetingUsage(input: { durationMs: number; route: MeetingProcessingRoute }) {
  const processedMinutes = Math.max(1, Math.ceil(input.durationMs / 60_000));
  const officialMinutesCharged = input.route === "byok" ? 0 : processedMinutes;
  return { processedMinutes, officialMinutesCharged };
}

export function buildMeetingUsageNote(input: {
  meetingId: string;
  resultGeneratedAt: string;
  route: MeetingProcessingRoute;
  processedMinutes: number;
  officialMinutesCharged: number;
}) {
  return `Finalized meeting:${input.meetingId} result:${input.resultGeneratedAt} route:${input.route} processed:${input.processedMinutes} charged:${input.officialMinutesCharged}`;
}

export function parseMeetingUsage(input: { minutes: number; note: string }) {
  const route = input.note.match(/(?:^|\s)route:(byok|hybrid|official_quota)(?:\s|$)/)?.[1] as MeetingProcessingRoute | undefined;
  const processed = Number(input.note.match(/(?:^|\s)processed:(\d+)(?:\s|$)/)?.[1]);
  const charged = Number(input.note.match(/(?:^|\s)charged:(\d+)(?:\s|$)/)?.[1]);
  return {
    processingRoute: route ?? "official_quota",
    processedMinutes: Number.isFinite(processed) && processed > 0 ? processed : Math.max(0, input.minutes),
    officialMinutesCharged: Number.isFinite(charged) && charged >= 0 ? charged : Math.max(0, input.minutes),
  };
}
