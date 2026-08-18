export type RecorderHealth = "ready" | "requesting" | "recording" | "paused" | "warning" | "error" | "complete";

export type RecorderStats = {
  chunks: number;
  bytes: number;
  mimeType: string;
  lastChunkAt: number | null;
  sampleRate: number | null;
};

const preferredMimeTypes = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/wav",
];

export function chooseSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") return "";

  return preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function recognitionReadiness(stats: RecorderStats, level: number) {
  if (!stats.mimeType) return "浏览器未确认可用录音格式";
  if (stats.chunks === 0) return "等待首个音频分片";
  if (level < 0.02) return "麦克风输入偏弱，可能影响识别";
  if (stats.chunks > 0 && stats.bytes > 0) return "录音分片稳定，适合推送实时识别";
  return "录制状态待确认";
}
