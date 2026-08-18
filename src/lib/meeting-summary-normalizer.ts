import type { ActionItem, Decision } from "./meeting";
import { getMeetingContentCopy, type MeetingContentLocale } from "./meeting-content-locale.ts";

export type NormalizedMeetingSummary = {
  summary: string;
  topics: string[];
  speakerViews: Array<{
    speaker: string;
    view: string;
  }>;
  decisions: Decision[];
  actionItems: ActionItem[];
  risks: string[];
  openQuestions: string[];
  knowledgePoints: string[];
};

export function normalizeMeetingSummary(value: unknown, locale: MeetingContentLocale = "zh-Hans"): NormalizedMeetingSummary {
  const input = asRecord(value);
  const copy = getMeetingContentCopy(locale);
  const localFallback = buildEmptyFallbackSummary(locale);

  return {
    summary: normalizeText(input.summary, localFallback.summary),
    topics: withFallback(toStringArray(input.topics), localFallback.topics),
    speakerViews: withFallback(toSpeakerViews(input.speakerViews ?? input.speaker_views, copy.unknown), localFallback.speakerViews),
    decisions: withFallback(toDecisions(input.decisions, copy.unnamedDecision, copy.unknown), localFallback.decisions),
    actionItems: withFallback(toActionItems(input.actionItems ?? input.action_items, copy.unnamedAction, copy.unknown), localFallback.actionItems),
    risks: withFallback(toStringArray(input.risks), localFallback.risks),
    openQuestions: withFallback(toStringArray(input.openQuestions ?? input.open_questions), localFallback.openQuestions),
    knowledgePoints: withFallback(toStringArray(input.knowledgePoints ?? input.knowledge_points), localFallback.knowledgePoints),
  };
}

function buildEmptyFallbackSummary(locale: MeetingContentLocale): NormalizedMeetingSummary {
  const copy = getMeetingContentCopy(locale);
  return {
    summary: copy.noTranscriptSummary,
    topics: [...copy.defaultTopics],
    speakerViews: [{ speaker: "Speaker 1", view: copy.unknown }],
    decisions: [],
    actionItems: [],
    risks: [copy.conservativeRisk],
    openQuestions: [copy.setupQuestion],
    knowledgePoints: [copy.knowledgeFallback],
  };
}

function toStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => normalizeText(item)).filter(Boolean) : [];
}

function toSpeakerViews(value: unknown, unknownLabel: string): NormalizedMeetingSummary["speakerViews"] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      const row = asRecord(item);
      return {
        speaker: normalizeText(row.speaker, `Speaker ${index + 1}`),
        view: normalizeText(row.view ?? row.detail, unknownLabel),
      };
    })
    .filter((item) => item.view);
}

function toDecisions(value: unknown, unnamedDecision: string, unknownLabel: string): Decision[] {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const row = asRecord(item);
    return {
      id: normalizeText(row.id, `d${index + 1}`),
      title: normalizeText(row.title, unnamedDecision),
      detail: normalizeText(row.detail ?? row.description ?? row.reason, unknownLabel),
      status: row.status === "confirmed" ? "confirmed" : "candidate",
    };
  });
}

function toActionItems(value: unknown, unnamedAction: string, unknownLabel: string): ActionItem[] {
  if (!Array.isArray(value)) return [];

  return value.map((item, index) => {
    const row = asRecord(item);
    return {
      id: normalizeText(row.id, `a${index + 1}`),
      owner: normalizeText(row.owner ?? row.assignee, unknownLabel),
      task: normalizeText(row.task ?? row.title ?? row.action, unnamedAction),
      due: normalizeText(row.due ?? row.deadline, unknownLabel),
      status: row.status === "confirmed" ? "confirmed" : "candidate",
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function withFallback<T>(value: T[], fallback: T[]) {
  return value.length > 0 ? value : fallback;
}

function normalizeText(value: unknown, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || fallback;
}
