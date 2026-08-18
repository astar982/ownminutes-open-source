import type { MobileUser } from "./types";

export const offlineSessionSnapshotTtlMs = 24 * 60 * 60 * 1000;

const snapshotVersion = 1;
const maximumSnapshotBytes = 8 * 1024;

export type OfflineSessionSnapshot = {
  apiBaseUrl: string;
  cachedAt: string;
  expiresAt: string;
  user: MobileUser;
  version: typeof snapshotVersion;
};

export function createOfflineSessionSnapshot(input: {
  apiBaseUrl: string;
  user: MobileUser;
  now?: number;
}): OfflineSessionSnapshot {
  const now = input.now ?? Date.now();
  const apiBaseUrl = normalizeSnapshotApiBaseUrl(input.apiBaseUrl);
  if (!apiBaseUrl) throw new Error("无法为无效的服务地址保存离线会话。");
  const user = pickOfflineMobileUser(input.user);
  if (!user) throw new Error("无法为无效的用户资料保存离线会话。");

  return {
    apiBaseUrl,
    cachedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + offlineSessionSnapshotTtlMs).toISOString(),
    user,
    version: snapshotVersion,
  };
}

export function serializeOfflineSessionSnapshot(input: {
  apiBaseUrl: string;
  user: MobileUser;
  now?: number;
}) {
  return JSON.stringify(createOfflineSessionSnapshot(input));
}

export function parseOfflineSessionSnapshot(
  raw: string | null | undefined,
  input: { apiBaseUrl: string; now?: number },
): OfflineSessionSnapshot | null {
  if (!raw || raw.length > maximumSnapshotBytes) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(value) || !hasOnlyKeys(value, ["apiBaseUrl", "cachedAt", "expiresAt", "user", "version"])) return null;
  if (value.version !== snapshotVersion) return null;
  const expectedApiBaseUrl = normalizeSnapshotApiBaseUrl(input.apiBaseUrl);
  if (!expectedApiBaseUrl || value.apiBaseUrl !== expectedApiBaseUrl) return null;
  if (typeof value.cachedAt !== "string" || typeof value.expiresAt !== "string") return null;
  if (!isMobileUser(value.user)) return null;
  const user = pickOfflineMobileUser(value.user);
  if (!user) return null;

  const now = input.now ?? Date.now();
  const cachedAt = Date.parse(value.cachedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(cachedAt) || !Number.isFinite(expiresAt)) return null;
  if (cachedAt > now + 5 * 60 * 1000 || expiresAt <= now) return null;
  if (expiresAt - cachedAt !== offlineSessionSnapshotTtlMs) return null;

  return { ...value, user } as OfflineSessionSnapshot;
}

export function sessionRestoreFailureDisposition(error: unknown): "invalidate" | "preserve" {
  if (!isRecord(error) || typeof error.status !== "number") return "preserve";
  return error.status === 401 || error.status === 403 ? "invalidate" : "preserve";
}

function normalizeSnapshotApiBaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

function isMobileUser(value: unknown): value is MobileUser {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [
    "email",
    "emailVerifiedAt",
    "id",
    "name",
    "officialMinutesTotal",
    "officialMinutesUsed",
    "plan",
    "processingMode",
    "role",
  ])) return false;
  if (!isBoundedString(value.id, 1, 256)) return false;
  if (!isBoundedString(value.email, 3, 320) || !value.email.includes("@")) return false;
  if (!isBoundedString(value.name, 1, 200)) return false;
  if (value.role !== "admin" && value.role !== "user") return false;
  if (value.plan !== "free" && value.plan !== "plus" && value.plan !== "pro") return false;
  if (value.processingMode !== undefined && value.processingMode !== "official_quota" && value.processingMode !== "byok") return false;
  if (!isNonNegativeFiniteNumber(value.officialMinutesTotal)) return false;
  if (!isNonNegativeFiniteNumber(value.officialMinutesUsed)) return false;
  if (value.emailVerifiedAt !== undefined && !isBoundedString(value.emailVerifiedAt, 1, 64)) return false;
  return true;
}

function pickOfflineMobileUser(value: MobileUser): MobileUser | null {
  const user: MobileUser = {
    email: value.email,
    id: value.id,
    name: value.name,
    officialMinutesTotal: value.officialMinutesTotal,
    officialMinutesUsed: value.officialMinutesUsed,
    plan: value.plan,
    processingMode: value.processingMode === "byok" ? "byok" : "official_quota",
    role: value.role,
    ...(value.emailVerifiedAt ? { emailVerifiedAt: value.emailVerifiedAt } : {}),
  };
  return isMobileUser(user) ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
