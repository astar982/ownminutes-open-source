import crypto from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeetingObjectStore, isMissingMeetingObjectError } from "@/lib/server/meeting-object-store";
import {
  normalizeStoredRecordingConsentMetadata,
  type RecordingUploadMetadata,
} from "@/lib/server/recording-upload-protocol";

export class RecordingUploadConflictError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly status: number;

  constructor(code: string, message: string, status = 409, retryAfterSeconds?: number) {
    super(message);
    this.name = "RecordingUploadConflictError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
  }
}

type RecordingUploadPart = {
  bytes: number;
  index: number;
  receivedAt: string;
  sha256: string;
};

export type RecordingUploadManifest = RecordingUploadMetadata & {
  createdAt: string;
  meetingId: string;
  ownerUserId: string;
  parts: Record<string, RecordingUploadPart>;
  protocolVersion: 1;
  updatedAt: string;
};

export type RecordingUploadReceipt = {
  assemblyMaxBufferedBytes?: number;
  assemblyMethod?: "bounded-temp-file";
  audioRevision?: string;
  durationMs: number;
  meetingId: string;
  ownerUserId: string;
  receivedAt: string;
  savedBytes: number;
  sealed?: boolean;
  totalBytes: number;
  totalChunks: number;
  uploadMetadata: RecordingUploadMetadata;
  uploadId: string;
};

const objectStore = getMeetingObjectStore();

export async function readRecordingUploadState(meetingId: string, uploadId: string) {
  const storedReceipt = await readOptionalJson<RecordingUploadReceipt>(receiptKey(meetingId, uploadId));
  const receipt = storedReceipt
    ? {
        ...storedReceipt,
        uploadMetadata: {
          ...storedReceipt.uploadMetadata,
          ...normalizeStoredRecordingConsentMetadata(storedReceipt.uploadMetadata),
        },
      }
    : null;
  const storedManifest = receipt ? null : await readOptionalJson<RecordingUploadManifest>(manifestKey(meetingId, uploadId));
  const manifest = storedManifest
    ? {
        ...storedManifest,
        ...normalizeStoredRecordingConsentMetadata(storedManifest),
      }
    : null;
  return {
    committed: Boolean(receipt),
    exists: Boolean(receipt || manifest),
    manifest,
    receipt,
    receivedParts: manifest
      ? Object.values(manifest.parts).map((part) => part.index).sort((left, right) => left - right)
      : [],
  };
}

export async function putRecordingUploadPart(input: {
  buffer: Buffer;
  meetingId: string;
  metadata: RecordingUploadMetadata;
  ownerUserId: string;
  partIndex: number;
  sha256: string;
}) {
  const state = await readRecordingUploadState(input.meetingId, input.metadata.uploadId);
  if (state.receipt) {
    assertOwner(state.receipt.ownerUserId, input.ownerUserId);
    return { committed: true, duplicate: true, receivedParts: [], receipt: state.receipt, stagedBytes: 0 };
  }

  const now = new Date().toISOString();
  const manifest = state.manifest ?? {
    ...input.metadata,
    createdAt: now,
    meetingId: input.meetingId,
    ownerUserId: input.ownerUserId,
    parts: {},
    protocolVersion: 1 as const,
    updatedAt: now,
  };
  assertOwner(manifest.ownerUserId, input.ownerUserId);
  assertMetadataMatches(manifest, input.metadata);

  const existing = manifest.parts[String(input.partIndex)];
  if (existing) {
    if (existing.bytes !== input.buffer.byteLength || existing.sha256 !== input.sha256) {
      throw new RecordingUploadConflictError("RECORDING_PART_CONFLICT", "已上传分片与本地录音不一致，请重新开始上传。");
    }
    return {
      committed: false,
      duplicate: true,
      receivedParts: Object.values(manifest.parts).map((part) => part.index).sort((left, right) => left - right),
      receipt: null,
      stagedBytes: recordingUploadStagedBytes(manifest),
    };
  }

  await objectStore.putBuffer(partKey(input.meetingId, input.metadata.uploadId, input.partIndex), input.buffer);
  manifest.parts[String(input.partIndex)] = {
    bytes: input.buffer.byteLength,
    index: input.partIndex,
    receivedAt: now,
    sha256: input.sha256,
  };
  manifest.updatedAt = now;
  await objectStore.putText(manifestKey(input.meetingId, input.metadata.uploadId), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    committed: false,
    duplicate: false,
    receivedParts: Object.values(manifest.parts).map((part) => part.index).sort((left, right) => left - right),
    receipt: null,
    stagedBytes: recordingUploadStagedBytes(manifest),
  };
}

export function recordingUploadStagedBytes(manifest: RecordingUploadManifest) {
  return Object.values(manifest.parts).reduce((sum, part) => sum + part.bytes, 0);
}

export async function deleteRecordingUploadStaging(meetingId: string, uploadId: string) {
  await objectStore.deletePrefix(uploadPrefix(meetingId, uploadId));
}

export async function assembleRecordingUpload(input: { meetingId: string; ownerUserId: string; uploadId: string }) {
  const state = await readRecordingUploadState(input.meetingId, input.uploadId);
  if (state.receipt) {
    assertOwner(state.receipt.ownerUserId, input.ownerUserId);
    return { alreadyCommitted: true as const, receipt: state.receipt };
  }
  const manifest = state.manifest;
  if (!manifest) throw new RecordingUploadConflictError("RECORDING_UPLOAD_NOT_FOUND", "未找到可恢复的录音上传，请重新开始。", 404);
  assertOwner(manifest.ownerUserId, input.ownerUserId);
  if (Object.keys(manifest.parts).length !== manifest.totalParts) {
    throw new RecordingUploadConflictError("RECORDING_UPLOAD_INCOMPLETE", "录音仍有分片未上传完成，请继续同步。", 409);
  }

  const directory = await mkdtemp(join(tmpdir(), "ownminutes-recording-assembly-"));
  const filePath = join(directory, "recording.audio");
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  let assembledBytes = 0;
  let maxBufferedBytes = 0;

  try {
    fileHandle = await open(filePath, "wx", 0o600);
    for (let index = 0; index < manifest.totalParts; index += 1) {
      const part = manifest.parts[String(index)];
      if (!part) throw new RecordingUploadConflictError("RECORDING_UPLOAD_INCOMPLETE", "录音仍有分片未上传完成，请继续同步。", 409);
      let buffer: Buffer;
      try {
        buffer = await objectStore.getBuffer(partKey(input.meetingId, input.uploadId, index));
      } catch (error) {
        if (isMissingMeetingObjectError(error)) {
          throw new RecordingUploadConflictError("RECORDING_UPLOAD_CORRUPT", "服务端录音分片缺失，请重新上传当前会议。", 422);
        }
        throw error;
      }
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
      if (buffer.byteLength !== part.bytes || sha256 !== part.sha256) {
        throw new RecordingUploadConflictError("RECORDING_UPLOAD_CORRUPT", "服务端录音分片校验失败，请重新上传当前会议。", 422);
      }
      await writeAll(fileHandle, buffer);
      assembledBytes += buffer.byteLength;
      maxBufferedBytes = Math.max(maxBufferedBytes, buffer.byteLength);
    }
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    if (assembledBytes !== manifest.totalBytes) {
      throw new RecordingUploadConflictError("RECORDING_UPLOAD_LENGTH_MISMATCH", "录音重组长度不一致，请重新上传。", 422);
    }
    return {
      alreadyCommitted: false as const,
      cleanup: () => rm(directory, { force: true, recursive: true }),
      filePath,
      manifest,
      maxBufferedBytes,
    };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

export async function finalizeRecordingUpload(input: {
  cleanupStaging?: boolean;
  meetingId: string;
  metadata: RecordingUploadMetadata;
  ownerUserId: string;
  receipt: Omit<RecordingUploadReceipt, "meetingId" | "ownerUserId" | "uploadId" | "uploadMetadata">;
  uploadId: string;
}) {
  const receipt: RecordingUploadReceipt = {
    ...input.receipt,
    meetingId: input.meetingId,
    ownerUserId: input.ownerUserId,
    uploadMetadata: {
      consentConfirmedAt: input.metadata.consentConfirmedAt,
      consentMethod: input.metadata.consentMethod,
      consentPolicyVersion: input.metadata.consentPolicyVersion,
      durationMs: input.metadata.durationMs,
      mimeType: input.metadata.mimeType,
      recordedAt: input.metadata.recordedAt,
      totalBytes: input.metadata.totalBytes,
      totalParts: input.metadata.totalParts,
      uploadId: input.metadata.uploadId,
    },
    uploadId: input.uploadId,
  };
  await objectStore.putText(receiptKey(input.meetingId, input.uploadId), `${JSON.stringify(receipt, null, 2)}\n`);
  if (input.cleanupStaging !== false) {
    try {
      await objectStore.deletePrefix(uploadPrefix(input.meetingId, input.uploadId));
    } catch {
      console.error("Committed recording upload staging cleanup failed; durable receipt retained.");
    }
  }
  return receipt;
}

async function writeAll(fileHandle: Awaited<ReturnType<typeof open>>, buffer: Buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await fileHandle.write(buffer, offset, buffer.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Failed to assemble the recording upload on disk.");
    offset += bytesWritten;
  }
}

function assertMetadataMatches(manifest: RecordingUploadManifest, metadata: RecordingUploadMetadata) {
  const fields: Array<keyof RecordingUploadMetadata> = [
    "consentConfirmedAt",
    "consentMethod",
    "consentPolicyVersion",
    "durationMs",
    "mimeType",
    "recordedAt",
    "totalBytes",
    "totalParts",
    "uploadId",
  ];
  if (fields.some((field) => manifest[field] !== metadata[field])) {
    throw new RecordingUploadConflictError("RECORDING_UPLOAD_METADATA_CONFLICT", "本地录音与已上传进度不一致，请重新开始上传。");
  }
}

function assertOwner(actual: string, expected: string) {
  if (actual !== expected) throw new RecordingUploadConflictError("RECORDING_UPLOAD_FORBIDDEN", "该录音上传属于其他账号。", 403);
}

async function readOptionalJson<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(await objectStore.getText(key)) as T;
  } catch (error) {
    if (isMissingMeetingObjectError(error)) return null;
    throw error;
  }
}

function uploadPrefix(meetingId: string, uploadId: string) {
  return `${segment(meetingId)}/uploads/${segment(uploadId)}`;
}

function manifestKey(meetingId: string, uploadId: string) {
  return `${uploadPrefix(meetingId, uploadId)}/manifest.json`;
}

function partKey(meetingId: string, uploadId: string, partIndex: number) {
  return `${uploadPrefix(meetingId, uploadId)}/parts/part-${String(partIndex).padStart(4, "0")}.bin`;
}

function receiptKey(meetingId: string, uploadId: string) {
  return `${segment(meetingId)}/upload-receipts/${segment(uploadId)}.json`;
}

function segment(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) {
    throw new RecordingUploadConflictError(
      "RECORDING_UPLOAD_INVALID_SEGMENT",
      "录音上传标识格式无效。",
      400,
    );
  }
  return value;
}
