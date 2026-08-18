export const mobileMeetingShareLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

export function createDefaultMeetingShareExpiresAt(now: Date = new Date()) {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid meeting share creation time");
  }
  return new Date(timestamp + mobileMeetingShareLifetimeMs).toISOString();
}
