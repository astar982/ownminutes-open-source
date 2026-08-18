import type { MeetingSummary } from "./meeting-processing.ts";
import { getMeetingContentCopy, type MeetingContentLocale } from "./meeting-content-locale.ts";

export function buildNoSpeechMeetingSummary(locale: MeetingContentLocale = "zh-Hans"): MeetingSummary {
  const copy = getMeetingContentCopy(locale).noSpeech;
  return {
    summary: copy.summary,
    topics: [...copy.topics],
    speakerViews: [],
    decisions: [],
    actionItems: [],
    risks: [...copy.risks],
    openQuestions: [...copy.openQuestions],
    knowledgePoints: [...copy.knowledgePoints],
  };
}
