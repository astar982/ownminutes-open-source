import fs from "fs/promises";
import path from "path";
import type { MeetingDetail } from "@/lib/server/meeting-audio-store";

export type ObsidianVaultWriteResult = {
  absolutePath: string;
  fileName: string;
  relativePath: string;
};

export class ObsidianVaultError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function getObsidianVaultPath() {
  return process.env.OWNMINUTES_OBSIDIAN_VAULT_PATH?.trim() || "";
}

export async function writeMeetingMarkdownToObsidianVault(input: {
  detail: Pick<MeetingDetail, "generatedAt" | "meetingId" | "metadata" | "title">;
  markdown: string;
}) {
  const projectSegment = input.detail.metadata.project ? safePathSegment(input.detail.metadata.project) : "未归档";
  return writeMarkdownToObsidianVault({
    directoryErrorMessage: "无法创建 Obsidian 项目目录。",
    directorySegments: ["OwnMinutes", projectSegment],
    fileName: buildMeetingFileName(input.detail),
    markdown: input.markdown,
  });
}

export async function writeMarkdownToObsidianVault(input: {
  directoryErrorMessage?: string;
  directorySegments: string[];
  fileName: string;
  markdown: string;
}) {
  const vaultPath = getObsidianVaultPath();
  if (!vaultPath) {
    throw new ObsidianVaultError("尚未配置 Obsidian Vault 路径。请设置 OWNMINUTES_OBSIDIAN_VAULT_PATH。", 503);
  }

  const resolvedVaultPath = path.resolve(vaultPath);
  await ensureDirectory(resolvedVaultPath, "Obsidian Vault 不存在或不可写。");

  const safeSegments = input.directorySegments.map((segment) => safePathSegment(segment)).filter(Boolean);
  if (safeSegments.length === 0) {
    throw new ObsidianVaultError("Obsidian 写入目录无效。", 400);
  }
  const targetDir = path.join(resolvedVaultPath, ...safeSegments);
  await ensureDirectory(targetDir, input.directoryErrorMessage ?? "无法创建 Obsidian 目录。");

  const fileName = ensureMarkdownFileName(input.fileName);
  const absolutePath = path.join(targetDir, fileName);
  assertInsideVault(resolvedVaultPath, absolutePath);

  await fs.writeFile(absolutePath, `${input.markdown.trim()}\n`, "utf8");

  return {
    absolutePath,
    fileName,
    relativePath: path.relative(resolvedVaultPath, absolutePath),
  } satisfies ObsidianVaultWriteResult;
}

async function ensureDirectory(directoryPath: string, errorMessage: string) {
  try {
    await fs.mkdir(directoryPath, { recursive: true });
  } catch {
    throw new ObsidianVaultError(errorMessage, 500);
  }
}

function buildMeetingFileName(detail: Pick<MeetingDetail, "generatedAt" | "meetingId" | "title">) {
  const date = normalizeDate(detail.generatedAt);
  const title = safePathSegment(detail.title || "会议纪要").slice(0, 72) || "会议纪要";
  const idSuffix = safePathSegment(detail.meetingId).slice(-10) || "meeting";
  return `${date}-${title}-${idSuffix}.md`;
}

function ensureMarkdownFileName(value: string) {
  const fileName = safePathSegment(value).slice(0, 120) || "OwnMinutes";
  return fileName.toLowerCase().endsWith(".md") ? fileName : `${fileName}.md`;
}

function normalizeDate(value?: string) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function safePathSegment(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|#\n\r\t]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .slice(0, 96)
    .trim();
}

function assertInsideVault(vaultPath: string, targetPath: string) {
  const relativePath = path.relative(vaultPath, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new ObsidianVaultError("Obsidian 写入路径越界，已拒绝。", 400);
  }
}
