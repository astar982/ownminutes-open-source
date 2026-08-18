import crypto from "node:crypto";
import type { MeetingResult } from "@/lib/meeting-processing";

export type MeetingHumanReview = {
  status: "pending" | "confirmed";
  confirmedAt?: string;
  needsReconfirmation: boolean;
};

export type MeetingReviewConfirmation = {
  confirmedAt: string;
  resultFingerprint: string;
};

export function createMeetingReviewConfirmation(result: MeetingResult, confirmedAt = new Date().toISOString()): MeetingReviewConfirmation {
  return {
    confirmedAt,
    resultFingerprint: fingerprintMeetingResult(result),
  };
}

export function resolveMeetingHumanReview(
  confirmation: MeetingReviewConfirmation | undefined,
  result: MeetingResult | null,
): MeetingHumanReview {
  if (!result || !confirmation) {
    return { status: "pending", needsReconfirmation: false };
  }

  if (confirmation.resultFingerprint !== fingerprintMeetingResult(result)) {
    return { status: "pending", confirmedAt: confirmation.confirmedAt, needsReconfirmation: true };
  }

  return {
    status: "confirmed",
    confirmedAt: confirmation.confirmedAt,
    needsReconfirmation: false,
  };
}

export function normalizeMeetingReviewConfirmation(value: unknown): MeetingReviewConfirmation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Partial<MeetingReviewConfirmation>;
  if (
    typeof input.confirmedAt !== "string" ||
    !Number.isFinite(Date.parse(input.confirmedAt)) ||
    typeof input.resultFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.resultFingerprint)
  ) {
    return undefined;
  }
  return { confirmedAt: input.confirmedAt, resultFingerprint: input.resultFingerprint };
}

function fingerprintMeetingResult(result: MeetingResult) {
  return crypto.createHash("sha256").update(JSON.stringify({
    adapter: result.adapter,
    diagnostics: result.diagnostics,
    generatedAt: result.generatedAt,
    meetingId: result.meetingId,
    obsidianMarkdown: result.obsidianMarkdown,
    provider: result.provider,
    summary: result.summary,
    title: result.title,
    transcript: result.transcript,
  })).digest("hex");
}
