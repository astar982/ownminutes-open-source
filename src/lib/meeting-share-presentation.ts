import { demoActions, demoDecisions, demoTranscript } from "@/lib/meeting";
import type { MeetingResult } from "@/lib/meeting-processing";

export function resolveMeetingSharePresentation(input: {
  durationMs: number;
  isDemo: boolean;
  result: MeetingResult | null;
}) {
  if (input.isDemo) {
    return {
      actions: demoActions,
      decisions: demoDecisions,
      displayDurationMs: 303_000,
      speakerViews: [],
      summary: undefined,
      title: "OwnMinutes 产品方案讨论",
      transcript: demoTranscript,
    };
  }

  return {
    actions: input.result?.summary.actionItems ?? [],
    decisions: input.result?.summary.decisions ?? [],
    displayDurationMs: Math.max(0, input.durationMs),
    speakerViews: input.result?.summary.speakerViews ?? [],
    summary: input.result?.summary.summary,
    title: input.result?.title || "会议纪要",
    transcript: input.result?.transcript ?? [],
  };
}
