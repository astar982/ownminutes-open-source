const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 12;

type Entry = { count: number; windowStartedAt: number };

const entries = new Map<string, Entry>();

export function consumeAppleIapVerificationAttempt(userId: string, now = Date.now()) {
  prune(now);
  const existing = entries.get(userId);
  const entry = !existing || now - existing.windowStartedAt >= WINDOW_MS
    ? { count: 0, windowStartedAt: now }
    : existing;
  entry.count += 1;
  entries.set(userId, entry);
  const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStartedAt + WINDOW_MS - now) / 1000));
  return {
    allowed: entry.count <= MAX_ATTEMPTS,
    remaining: Math.max(0, MAX_ATTEMPTS - entry.count),
    retryAfterSeconds,
  };
}

function prune(now: number) {
  if (entries.size < 1_000) return;
  for (const [key, entry] of entries) {
    if (now - entry.windowStartedAt >= WINDOW_MS) entries.delete(key);
  }
}
