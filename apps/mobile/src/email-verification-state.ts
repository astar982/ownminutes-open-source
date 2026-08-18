export function initialEmailVerificationState(
  payload: {
    emailSent?: boolean;
    resendAvailableAt?: string;
    retryAfterSeconds?: number;
  },
  options: { defaultResendSeconds: number; nowMs?: number },
) {
  const nowMs = options.nowMs ?? Date.now();
  const retryAfterSeconds = normalizeRetrySeconds(payload.retryAfterSeconds);
  const resendAtMs = Date.parse(payload.resendAvailableAt ?? "");
  const resendAvailableSeconds = Number.isFinite(resendAtMs)
    ? Math.max(0, Math.ceil((resendAtMs - nowMs) / 1000))
    : 0;
  const fallbackSeconds = payload.emailSent === false ? 0 : options.defaultResendSeconds;

  return {
    deliveryFailed: payload.emailSent === false,
    resendSeconds: Math.max(retryAfterSeconds, resendAvailableSeconds, fallbackSeconds),
  };
}

function normalizeRetrySeconds(value: unknown) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}
