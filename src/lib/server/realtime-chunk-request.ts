import {
  BoundedRequestError,
  readBoundedBody,
  readBoundedFormData,
} from "./bounded-request.ts";

export const maxRealtimeChunkBytes = 2 * 1024 * 1024;
const maxRealtimeMultipartBytes = maxRealtimeChunkBytes + 64 * 1024;

export type RealtimeChunkRequestPayload = {
  buffer: Buffer;
  channels: number;
  durationMs: number;
  mimeType: string;
  recordedAt: number;
  sampleRate: number;
  sequence: number;
};

export class RealtimeChunkRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RealtimeChunkRequestError";
    this.status = status;
  }
}

export async function readRealtimeChunkRequest(request: Request): Promise<RealtimeChunkRequestPayload> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/form-data")) {
    return readMultipartRealtimeChunk(request);
  }
  if (contentType.startsWith("audio/pcm") || contentType.startsWith("application/octet-stream")) {
    return readBinaryRealtimeChunk(request, contentType);
  }
  throw new RealtimeChunkRequestError("unsupported realtime audio content type", 415);
}

async function readMultipartRealtimeChunk(request: Request): Promise<RealtimeChunkRequestPayload> {
  let formData: FormData;
  try {
    formData = await readBoundedFormData(request, maxRealtimeMultipartBytes);
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      throw new RealtimeChunkRequestError(error.message, error.status);
    }
    throw error;
  }
  const chunk = formData.get("chunk");
  if (!(chunk instanceof File)) throw new RealtimeChunkRequestError("missing realtime audio chunk", 400);
  if (chunk.size > maxRealtimeChunkBytes) throw new RealtimeChunkRequestError("realtime audio chunk is too large", 413);

  return {
    buffer: Buffer.from(await chunk.arrayBuffer()),
    channels: Number(formData.get("channels") ?? 1),
    durationMs: Number(formData.get("durationMs") ?? 3000),
    mimeType: String(formData.get("mimeType") || chunk.type || "audio/pcm"),
    recordedAt: Number(formData.get("recordedAt") ?? Date.now()),
    sampleRate: Number(formData.get("sampleRate") ?? 16000),
    sequence: Number(formData.get("sequence") ?? 0),
  };
}

async function readBinaryRealtimeChunk(request: Request, contentType: string): Promise<RealtimeChunkRequestPayload> {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await readBoundedBody(request, maxRealtimeChunkBytes));
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      throw new RealtimeChunkRequestError(
        error.code === "request_body_too_large" ? "realtime audio chunk is too large" : error.message,
        error.status,
      );
    }
    throw error;
  }

  return {
    buffer,
    channels: Number(request.headers.get("x-ownminutes-channels") ?? 0),
    durationMs: Number(request.headers.get("x-ownminutes-duration-ms") ?? 0),
    mimeType: request.headers.get("x-ownminutes-mime-type") || contentType || "audio/pcm",
    recordedAt: Number(request.headers.get("x-ownminutes-recorded-at") ?? Date.now()),
    sampleRate: Number(request.headers.get("x-ownminutes-sample-rate") ?? 0),
    sequence: Number(request.headers.get("x-ownminutes-sequence") ?? 0),
  };
}
