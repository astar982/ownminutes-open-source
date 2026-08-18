const DAY_MS = 24 * 60 * 60 * 1000;

export const meetingShareLifetimeDays = 7;
export const meetingShareLifetimeMs = meetingShareLifetimeDays * DAY_MS;
const meetingShareClockSkewAllowanceMs = 5 * 60 * 1000;

export class MeetingSharePolicyError extends Error {
  readonly code: "share_expiry_invalid" | "share_expiry_out_of_range";

  constructor(code: MeetingSharePolicyError["code"], message: string) {
    super(message);
    this.name = "MeetingSharePolicyError";
    this.code = code;
  }
}

export function resolveMeetingShareExpiresAt(value: unknown, now = new Date()) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new MeetingSharePolicyError("share_expiry_invalid", "分享有效期基准时间无效。");
  }

  if (value === undefined || value === null || value === "") {
    return new Date(nowMs + meetingShareLifetimeMs).toISOString();
  }
  if (typeof value !== "string") {
    throw new MeetingSharePolicyError("share_expiry_invalid", "分享有效期格式无效。");
  }

  const expiresAt = new Date(value.trim());
  const expiresAtMs = expiresAt.getTime();
  if (!Number.isFinite(expiresAtMs)) {
    throw new MeetingSharePolicyError("share_expiry_invalid", "分享有效期格式无效。");
  }
  if (expiresAtMs <= nowMs || expiresAtMs > nowMs + meetingShareLifetimeMs + meetingShareClockSkewAllowanceMs) {
    throw new MeetingSharePolicyError(
      "share_expiry_out_of_range",
      `分享链接必须在未来 ${meetingShareLifetimeDays} 天内到期。`,
    );
  }

  return expiresAt.toISOString();
}
