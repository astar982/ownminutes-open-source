import type { TranscriptSegment } from "./meeting.ts";
import { diagnoseTranscriptQuality } from "./transcript-quality.ts";

export type RealtimeTranscriptReuseInput = {
  audioDurationMs: number;
  session: {
    adapter: string;
    formatMismatchCount: number;
    lastProviderStatus?: string;
    outOfOrderCount: number;
    provider: string;
    statusCounts: { provider_error?: number };
    totalDurationMs: number;
    transcriptSegments: TranscriptSegment[];
  } | null;
};

export type RealtimeTranscriptReuseDecision = {
  reusable: boolean;
  transcript: TranscriptSegment[];
  reason: string;
  coverageRatio: number;
};

export function selectReusableRealtimeTranscript(input: RealtimeTranscriptReuseInput): RealtimeTranscriptReuseDecision {
  const session = input.session;
  if (!session) return reject("realtime session is missing");
  if (session.provider !== "volcano" || !session.adapter.includes("volcano")) return reject("realtime provider is not Volcano");
  if (session.lastProviderStatus !== "completed") return reject("realtime provider session did not complete cleanly");
  if (session.formatMismatchCount > 0 || session.outOfOrderCount > 0 || Number(session.statusCounts.provider_error || 0) > 0) {
    return reject("realtime session contains format, ordering, or provider errors");
  }

  const audioDurationMs = Math.max(1, Math.round(input.audioDurationMs));
  const coverageRatio = Math.max(0, session.totalDurationMs) / audioDurationMs;
  if (coverageRatio < 0.9) return reject("realtime audio coverage is below 90 percent", coverageRatio);

  const transcript = deduplicateSegments(session.transcriptSegments);
  const quality = diagnoseTranscriptQuality(transcript);
  if (quality.status !== "usable") return reject("realtime transcript quality is not usable", coverageRatio);

  const meetingMinutes = Math.max(1, Math.ceil(audioDurationMs / 60_000));
  const minimumCharacters = Math.max(12, meetingMinutes * 20);
  if (quality.totalCharacters < minimumCharacters) {
    return reject("realtime transcript is too sparse for the recorded duration", coverageRatio);
  }

  return {
    reusable: true,
    transcript,
    reason: "clean realtime transcript covers the complete recording",
    coverageRatio,
  };
}

function deduplicateSegments(segments: TranscriptSegment[]) {
  const unique = new Map<string, TranscriptSegment>();
  for (const segment of segments) {
    if (!segment?.id || !segment.text?.trim()) continue;
    unique.set(segment.id, segment);
  }
  return [...unique.values()];
}

function reject(reason: string, coverageRatio = 0): RealtimeTranscriptReuseDecision {
  return { reusable: false, transcript: [], reason, coverageRatio };
}
