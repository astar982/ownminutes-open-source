import { buildCheckupAcceptanceMarkdown } from "@/lib/checkup-acceptance";
import { buildProjectSummaries } from "@/lib/project-summaries";
import { getUserProviderHealth } from "@/lib/provider-health";
import { getReleaseReadinessReport } from "@/lib/release-readiness";
import { getRuntimeSecretDiagnostics } from "@/lib/secret-diagnostics";
import { getUserUsage, listProviderCredentials } from "@/lib/server/auth-repository";
import { isMeetingShareActive, listUserMeetings } from "@/lib/server/meeting-audio-store";

export type CheckupAcceptanceUser = {
  email: string;
  id: string;
  plan: string;
};

export async function buildCheckupAcceptanceReport(user: CheckupAcceptanceUser) {
  const [providerHealth, meetings, providerCredentials, usage, secretDiagnostics] = await Promise.all([
    getUserProviderHealth(user.id),
    listUserMeetings(user.id),
    listProviderCredentials(user.id),
    getUserUsage(user.id),
    getRuntimeSecretDiagnostics(),
  ]);
  const completedMeetings = meetings.filter((meeting) => meeting.hasResult);
  const sharedMeetings = meetings.filter((meeting) => isMeetingShareActive(meeting.share));
  const projects = buildProjectSummaries(meetings);
  const releaseReadiness = getReleaseReadinessReport(secretDiagnostics);
  const summaryModelBlocker = releaseReadiness.blockers.find((item) => item.id === "summary-model");
  const generatedAt = new Date().toISOString();

  return {
    generatedAt,
    markdown: buildCheckupAcceptanceMarkdown({
      generatedAt,
      user: {
        email: user.email,
        plan: user.plan,
      },
      counts: {
        blocked: releaseReadiness.summary.blocked,
        completedMeetings: completedMeetings.length,
        meetings: meetings.length,
        officialMinutesRemaining: usage.officialMinutesRemaining,
        projects: projects.length,
        sharedMeetings: sharedMeetings.length,
      },
      provider: {
        credentialCount: providerCredentials.length,
        fileAsrReady: providerHealth.some((item) => item.status === "ready" && item.canUseFor.includes("file_asr")),
        summaryProductionGateDetail: summaryModelBlocker?.nextAction ?? "无",
        summaryProductionReady: !summaryModelBlocker,
        summaryReady: providerHealth.some((item) => item.status === "ready" && item.canUseFor.includes("summary")),
      },
      releaseReadiness,
    }),
    releaseReadiness,
  };
}

export function buildCheckupAcceptanceFileName(userId: string, generatedAt: string) {
  const date = normalizeDate(generatedAt);
  const userSuffix = userId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-8) || "account";
  return `${date}-OwnMinutes-MVP-验收单-${userSuffix}.md`;
}

function normalizeDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}
