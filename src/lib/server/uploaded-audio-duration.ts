import { probeAudioDurationMs } from "@/lib/audio-normalization";

export async function resolveUploadedAudioDurationMs(input: {
  buffer: Buffer;
  fullRecording: boolean;
  sequence: number;
  submittedDurationMs: number;
}) {
  if (!Number.isFinite(input.submittedDurationMs) || input.submittedDurationMs <= 0) {
    throw new Error("invalid durationMs");
  }
  if (!input.fullRecording) return input.submittedDurationMs;
  if (input.sequence !== 1) throw new Error("full recording must use sequence 1");
  return probeAudioDurationMs(input.buffer);
}
