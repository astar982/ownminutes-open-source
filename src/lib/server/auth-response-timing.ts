import crypto from "crypto";

const PUBLIC_AUTH_RESPONSE_FLOOR_MS = 700;
const PUBLIC_AUTH_RESPONSE_JITTER_MS = 300;

export async function waitForPublicAuthResponseFloor(startedAtMs: number, publicResponse: boolean) {
  if (!publicResponse) return;
  const targetDurationMs = PUBLIC_AUTH_RESPONSE_FLOOR_MS + crypto.randomInt(PUBLIC_AUTH_RESPONSE_JITTER_MS + 1);
  const remainingMs = targetDurationMs - (Date.now() - startedAtMs);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
}
