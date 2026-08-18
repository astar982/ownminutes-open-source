import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type NormalizedAsrAudio = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  transcoded: boolean;
};

export type NormalizedAsrAudioFile = {
  filePath: string;
  fileName: string;
  mimeType: string;
  transcoded: boolean;
};

export const mildAsrSpeechFilter = [
  "highpass=f=80",
  "lowpass=f=7600",
  "afftdn=nr=6:nf=-35:tn=1:gs=5",
  "loudnorm=I=-20:TP=-2:LRA=11",
].join(",");

export const defaultAsrSpeechFilter = "loudnorm=I=-20:TP=-2:LRA=11";

export function asrSpeechFilter(mode = process.env.OWNMINUTES_AUDIO_DENOISE_MODE) {
  // Keep the switch finite and auditable. Arbitrary ffmpeg expressions from an
  // environment variable would turn configuration into command-like input and
  // make recognition quality impossible to reproduce.
  // Mild denoising remains available for controlled A/B runs, but it is opt-in:
  // a real far-field meeting sample regressed versus loudness-only processing.
  return mode?.trim().toLowerCase() === "mild"
    ? mildAsrSpeechFilter
    : defaultAsrSpeechFilter;
}

export async function probeAudioDurationMs(buffer: Buffer): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "ownminutes-audio-probe-"));
  const filePath = join(directory, "recording.audio");
  try {
    await writeFile(filePath, buffer, { mode: 0o600 });
    return await probeAudioFileDurationMs(filePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function probeAudioFileDurationMs(filePath: string): Promise<number> {
  const binary = process.env.OWNMINUTES_FFPROBE_PATH || "ffprobe";
  const timeoutMs = clampNumber(process.env.OWNMINUTES_AUDIO_PROBE_TIMEOUT_MS, 1_000, 60_000, 15_000);

  return new Promise<number>((resolve, reject) => {
    const child = spawn(binary, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("音频时长检测超时，请重试上传。"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.concat(output).byteLength < 1_024) output.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(new Error("服务端暂时无法校验音频时长，请稍后重试。")));
    child.on("close", (code) => {
      const seconds = Number(Buffer.concat(output).toString("utf8").trim());
      if (code !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
        finish(new Error("无法读取音频时长，请确认音频文件完整后重试。"));
        return;
      }
      finish(null, Math.max(1, Math.round(seconds * 1_000)));
    });
    function finish(error: Error | null, durationMs?: number) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(durationMs!);
    }
  });
}

export async function normalizeAudioForVolcanoAsr(input: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}): Promise<NormalizedAsrAudio> {
  const buffer = await standardizeMeetingAudio(input.buffer);
  return {
    buffer,
    fileName: replaceExtension(input.fileName, ".ogg"),
    mimeType: "audio/ogg",
    transcoded: true,
  };
}

export async function normalizeAudioFileForVolcanoAsr(input: {
  filePath: string;
  fileName: string;
  mimeType: string;
}): Promise<NormalizedAsrAudioFile> {
  const filePath = join(dirname(input.filePath), "normalized.ogg");
  await standardizeMeetingAudioFile(input.filePath, filePath);
  return {
    filePath,
    fileName: replaceExtension(input.fileName, ".ogg"),
    mimeType: "audio/ogg",
    transcoded: true,
  };
}

async function standardizeMeetingAudio(buffer: Buffer) {
  const binary = process.env.OWNMINUTES_FFMPEG_PATH || "ffmpeg";
  const timeoutMs = clampNumber(process.env.OWNMINUTES_AUDIO_TRANSCODE_TIMEOUT_MS, 10_000, 15 * 60 * 1000, 180_000);
  const maxOutputBytes = clampNumber(process.env.OWNMINUTES_AUDIO_TRANSCODE_MAX_BYTES, 1_000_000, 100_000_000, 80_000_000);

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(binary, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      asrSpeechFilter(),
      "-codec:a",
      "libopus",
      "-b:a",
      "48k",
      "-application",
      "voip",
      "-f",
      "ogg",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let errorBytes = 0;
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Audio normalization timed out before ASR upload."));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error("Normalized audio exceeds the ASR upload size limit."));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= 16_000) return;
      errors.push(chunk);
      errorBytes += chunk.byteLength;
    });
    child.on("error", (error) => {
      finish(new Error(`Audio normalization is unavailable: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim().slice(0, 500);
        finish(new Error(`Audio normalization failed${detail ? `: ${detail}` : ` with exit code ${code}`}.`));
        return;
      }
      const output = Buffer.concat(chunks);
      if (output.byteLength === 0) {
        finish(new Error("Audio normalization produced an empty file."));
        return;
      }
      finish(null, output);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(buffer);

    function finish(error: Error | null, output?: Buffer) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output!);
    }
  });
}

async function standardizeMeetingAudioFile(inputPath: string, outputPath: string) {
  const binary = process.env.OWNMINUTES_FFMPEG_PATH || "ffmpeg";
  const timeoutMs = clampNumber(process.env.OWNMINUTES_AUDIO_TRANSCODE_TIMEOUT_MS, 10_000, 15 * 60 * 1000, 180_000);
  const maxOutputBytes = clampNumber(process.env.OWNMINUTES_AUDIO_TRANSCODE_MAX_BYTES, 1_000_000, 100_000_000, 80_000_000);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      asrSpeechFilter(),
      "-codec:a",
      "libopus",
      "-b:a",
      "48k",
      "-application",
      "voip",
      outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    let errorBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Audio file normalization timed out before ASR upload."));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= 16_000) return;
      errors.push(chunk);
      errorBytes += chunk.byteLength;
    });
    child.on("error", (error) => finish(new Error(`Audio file normalization is unavailable: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim().slice(0, 500);
        finish(new Error(`Audio file normalization failed${detail ? `: ${detail}` : ` with exit code ${code}`}.`));
        return;
      }
      finish();
    });

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
  });

  const output = await stat(outputPath);
  if (!output.isFile() || output.size <= 0) throw new Error("Audio file normalization produced an empty file.");
  if (output.size > maxOutputBytes) throw new Error("Normalized audio exceeds the ASR upload size limit.");
  await chmod(outputPath, 0o600);
}

function replaceExtension(fileName: string, extension: string) {
  return fileName.replace(/\.[^.]+$/, "") + extension;
}

function clampNumber(value: string | undefined, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}
