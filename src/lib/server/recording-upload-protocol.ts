import crypto from "node:crypto";
import { AudioUploadPolicyError, getAudioUploadPolicy, validateUploadedAudio } from "@/lib/server/audio-upload-policy";
import { BoundedRequestError, readBoundedBody } from "@/lib/server/bounded-request";

export const recordingUploadPartBytes = 4 * 1024 * 1024;
export const recordingUploadProtocolVersion = 1;

export type RecordingConsentMetadata = {
  consentConfirmedAt?: string;
  consentMethod: "in_app_confirmation" | "legacy_unknown";
  consentPolicyVersion?: string;
};

export type RecordingUploadMetadata = RecordingConsentMetadata & {
  durationMs: number;
  mimeType: string;
  recordedAt: number;
  totalBytes: number;
  totalParts: number;
  uploadId: string;
};

export type ParsedRecordingPartUpload = {
  buffer: Buffer;
  clientSha256: string;
  metadata: RecordingUploadMetadata;
  partIndex: number;
  sha256: string;
};

export async function parseRecordingPartUpload(request: Request, input: { partIndex: number; uploadId: string }): Promise<ParsedRecordingPartUpload> {
  const metadata = parseRecordingUploadMetadata(request.headers, input.uploadId);
  const expectedBytes = expectedRecordingPartBytes(metadata, input.partIndex);
  const contentLength = parseIntegerHeader(request.headers, "content-length");
  if (contentLength !== expectedBytes) {
    throw policyError("RECORDING_PART_LENGTH_MISMATCH", "录音分片长度不一致，请重试当前分片。", 400);
  }
  const clientSha256 = String(request.headers.get("x-ownminutes-part-sha256") || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(clientSha256)) {
    throw policyError("INVALID_RECORDING_PART_DIGEST", "录音分片校验值无效，请重试上传。", 400);
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await readBoundedBody(request, expectedBytes));
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      throw policyError(
        "RECORDING_PART_LENGTH_MISMATCH",
        "录音分片长度不一致，请重试当前分片。",
        error.status,
      );
    }
    throw error;
  }
  if (buffer.byteLength !== expectedBytes) {
    throw policyError("RECORDING_PART_LENGTH_MISMATCH", "录音分片未完整到达，请重试当前分片。", 400);
  }
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== clientSha256) {
    throw policyError("RECORDING_PART_DIGEST_MISMATCH", "录音分片校验失败，请重新上传当前分片。", 422);
  }
  return { buffer, clientSha256, metadata, partIndex: input.partIndex, sha256 };
}

export function parseRecordingUploadMetadata(headers: Headers, uploadId: string): RecordingUploadMetadata {
  validateRecordingUploadId(uploadId);
  const consent = parseRecordingConsentMetadata(headers);
  const totalBytes = parseIntegerHeader(headers, "x-ownminutes-total-bytes");
  const totalParts = parseIntegerHeader(headers, "x-ownminutes-total-parts");
  const durationMs = parseIntegerHeader(headers, "x-ownminutes-duration-ms");
  const recordedAt = parseIntegerHeader(headers, "x-ownminutes-recorded-at");
  const mimeType = String(headers.get("x-ownminutes-mime-type") || "").trim().toLowerCase();
  const expectedParts = Math.ceil(totalBytes / recordingUploadPartBytes);

  validateUploadedAudio({ fullRecording: true, mimeType, size: totalBytes, policy: getAudioUploadPolicy() });
  if (totalParts !== expectedParts || totalParts < 1 || totalParts > 256) {
    throw policyError("INVALID_RECORDING_PART_COUNT", "录音分片数量无效，请重新开始上传。", 400);
  }
  if (durationMs <= 0 || recordedAt <= 0) {
    throw policyError("INVALID_RECORDING_METADATA", "录音上传信息无效，请重新开始上传。", 400);
  }
  return { ...consent, durationMs, mimeType, recordedAt, totalBytes, totalParts, uploadId };
}

export function parseRecordingConsentMetadata(headers: Headers): RecordingConsentMetadata {
  const rawMethod = String(headers.get("x-ownminutes-consent-method") || "legacy_unknown").trim();
  if (rawMethod !== "in_app_confirmation" && rawMethod !== "legacy_unknown") {
    throw policyError("INVALID_RECORDING_CONSENT_METADATA", "录音知情确认信息无效，请重新开始录音。", 400);
  }

  const consentConfirmedAt = String(headers.get("x-ownminutes-consent-confirmed-at") || "").trim();
  const consentPolicyVersion = String(headers.get("x-ownminutes-consent-policy-version") || "").trim();
  if (rawMethod === "legacy_unknown") {
    if (consentConfirmedAt || consentPolicyVersion) {
      throw policyError("INVALID_RECORDING_CONSENT_METADATA", "旧版录音知情状态与确认信息不一致。", 400);
    }
    return { consentMethod: "legacy_unknown" };
  }

  if (
    !consentConfirmedAt ||
    !Number.isFinite(Date.parse(consentConfirmedAt)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(consentPolicyVersion)
  ) {
    throw policyError("INVALID_RECORDING_CONSENT_METADATA", "录音知情确认时间或政策版本无效，请重新确认。", 400);
  }

  return {
    consentConfirmedAt: new Date(consentConfirmedAt).toISOString(),
    consentMethod: "in_app_confirmation",
    consentPolicyVersion,
  };
}

export function normalizeStoredRecordingConsentMetadata(
  input: Partial<RecordingConsentMetadata> | undefined,
): RecordingConsentMetadata {
  if (
    input?.consentMethod === "in_app_confirmation" &&
    typeof input.consentConfirmedAt === "string" &&
    Number.isFinite(Date.parse(input.consentConfirmedAt)) &&
    typeof input.consentPolicyVersion === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(input.consentPolicyVersion)
  ) {
    return {
      consentConfirmedAt: new Date(input.consentConfirmedAt).toISOString(),
      consentMethod: "in_app_confirmation",
      consentPolicyVersion: input.consentPolicyVersion,
    };
  }
  return { consentMethod: "legacy_unknown" };
}

export function expectedRecordingPartBytes(metadata: RecordingUploadMetadata, partIndex: number) {
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= metadata.totalParts) {
    throw policyError("INVALID_RECORDING_PART_INDEX", "录音分片序号无效，请重试上传。", 400);
  }
  const start = partIndex * recordingUploadPartBytes;
  return Math.min(recordingUploadPartBytes, metadata.totalBytes - start);
}

export function validateRecordingUploadId(uploadId: string) {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(uploadId)) {
    throw policyError("INVALID_RECORDING_UPLOAD_ID", "录音上传标识无效，请重新开始上传。", 400);
  }
}

function parseIntegerHeader(headers: Headers, name: string) {
  const value = Number(headers.get(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw policyError("INVALID_RECORDING_METADATA", "录音上传信息不完整，请重新开始上传。", 400);
  }
  return value;
}

function policyError(code: string, message: string, status: number) {
  return new AudioUploadPolicyError({ code, message, status });
}
