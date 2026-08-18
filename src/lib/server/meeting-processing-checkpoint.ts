import crypto from "node:crypto";
import type { TranscriptSegment } from "@/lib/meeting";
import type { MeetingSummary } from "@/lib/meeting-processing";
import { buildMeetingObjectKey, getMeetingObjectStore, readOptionalMeetingObject } from "@/lib/server/meeting-object-store";
import { withMeetingWriteFence } from "@/lib/server/meeting-write-lock";

export type MeetingProcessingCheckpoint = {
  adapter: string;
  audioSha256: string;
  createdAt: string;
  meetingId: string;
  noSpeech: boolean;
  operationKey: string;
  ownerUserId: string;
  providerStages: Array<"asr" | "summary">;
  summary?: MeetingSummary;
  transcript: TranscriptSegment[];
};

const objectStore = getMeetingObjectStore();

export async function readMeetingProcessingCheckpoint(input: {
  audioSha256: string;
  meetingId: string;
  operationKey: string;
  ownerUserId: string;
}) {
  const checkpoint = await readOptionalMeetingObject(async () => {
    return JSON.parse(await objectStore.getText(checkpointKey(input))) as Partial<MeetingProcessingCheckpoint>;
  });
  if (!checkpoint) return null;
  if (
    checkpoint.audioSha256 !== input.audioSha256 ||
    checkpoint.meetingId !== input.meetingId ||
    checkpoint.operationKey !== input.operationKey ||
    checkpoint.ownerUserId !== input.ownerUserId
  ) {
    return null;
  }
  const transcript = Array.isArray(checkpoint.transcript)
    ? checkpoint.transcript.filter((item): item is TranscriptSegment => Boolean(item?.id && item?.text?.trim()))
    : [];
  const summary = normalizeSummary(checkpoint.summary);
  const providerStages = Array.isArray(checkpoint.providerStages)
    ? checkpoint.providerStages.filter((stage): stage is "asr" | "summary" => stage === "asr" || stage === "summary")
    : [];
  if (!checkpoint.adapter || providerStages.length === 0 || (checkpoint.noSpeech !== true && transcript.length === 0)) return null;
  return {
    adapter: checkpoint.adapter,
    audioSha256: input.audioSha256,
    createdAt: checkpoint.createdAt || new Date(0).toISOString(),
    meetingId: input.meetingId,
    noSpeech: checkpoint.noSpeech === true,
    operationKey: input.operationKey,
    ownerUserId: input.ownerUserId,
    providerStages: [...new Set(providerStages)],
    summary,
    transcript,
  } satisfies MeetingProcessingCheckpoint;
}

function normalizeSummary(value: unknown): MeetingSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const summary = value as Partial<MeetingSummary>;
  if (typeof summary.summary !== "string") return undefined;
  const array = <T>(candidate: T[] | undefined) => Array.isArray(candidate) ? candidate : [];
  return {
    summary: summary.summary,
    topics: array(summary.topics),
    speakerViews: array(summary.speakerViews),
    decisions: array(summary.decisions),
    actionItems: array(summary.actionItems),
    risks: array(summary.risks),
    openQuestions: array(summary.openQuestions),
    knowledgePoints: array(summary.knowledgePoints),
  };
}

export async function saveMeetingProcessingCheckpoint(input: MeetingProcessingCheckpoint) {
  if (!/^[a-f0-9]{64}$/.test(input.audioSha256)) {
    throw new Error("Meeting processing checkpoint requires the authoritative audio SHA-256.");
  }
  if (input.providerStages.length === 0) {
    throw new Error("Meeting processing checkpoint requires at least one completed provider stage.");
  }
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
    const key = checkpointKey({ ...input, meetingId });
    const canonicalCheckpoint = input.meetingId === meetingId ? input : { ...input, meetingId };
    const payload = `${JSON.stringify(canonicalCheckpoint, null, 2)}\n`;
    const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    await objectStore.putText(key, payload);

    let storedPayload: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        storedPayload = await objectStore.getText(key);
      } catch {
        storedPayload = null;
      }
      if (storedPayload === payload) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
    if (storedPayload !== payload) {
      throw new Error("Meeting processing checkpoint could not be verified after storage write.");
    }

    return { key, sha256 };
  });
}

function checkpointKey(input: Pick<MeetingProcessingCheckpoint, "audioSha256" | "meetingId" | "operationKey" | "ownerUserId">) {
  const prefix = buildMeetingObjectKey(input.meetingId, "prefix");
  const identityHash = crypto
    .createHash("sha256")
    .update(`${input.ownerUserId}\0${input.meetingId}\0${input.operationKey}\0${input.audioSha256}`)
    .digest("hex");
  return `${prefix}/processing-checkpoints/${identityHash}.json`;
}
