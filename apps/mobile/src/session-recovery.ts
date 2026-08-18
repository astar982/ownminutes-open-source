import { mobileSessionExpiredMessage, parseMobileJsonResponse } from "./mobile-http";

export class MobileApiResponseError extends Error {
  readonly authoritativeSessionRejection: boolean;
  readonly status: number;

  constructor(message: string, status: number, options: { authoritative?: boolean } = {}) {
    super(message);
    this.name = "MobileApiResponseError";
    this.authoritativeSessionRejection = status === 401 || (status === 403 && options.authoritative === true);
    this.status = status;
  }
}

export type RuntimeSessionFailureDisposition = "preserve" | "reauthenticate-now" | "reauthenticate-after-recording";

export type RecordingStartSessionFence = {
  generation: number;
  userId: string;
};

export function isRecordingStartSessionCurrent(
  fence: RecordingStartSessionFence,
  current: {
    generation: number;
    reauthenticationRequired: boolean;
    userId?: string | null;
  },
) {
  return (
    !current.reauthenticationRequired &&
    current.generation === fence.generation &&
    current.userId === fence.userId
  );
}

export function runtimeSessionFailureDisposition(
  error: unknown,
  recordingLifecycleBusy: boolean,
): RuntimeSessionFailureDisposition {
  if (!isAuthoritativeSessionRejection(error)) return "preserve";
  return recordingLifecycleBusy ? "reauthenticate-after-recording" : "reauthenticate-now";
}

export function shouldBlockRecordingSensitiveMutation(input: {
  recordingLifecycleBusy: boolean;
  recordingStopInFlight: boolean;
}) {
  return input.recordingLifecycleBusy || input.recordingStopInFlight;
}

export function isAuthoritativeSessionRejection(error: unknown) {
  return error instanceof MobileApiResponseError && error.authoritativeSessionRejection;
}

export async function assertNoAuthoritativeSessionRejection(
  response: Response,
  options: { forbiddenIsAuthoritative?: boolean; language?: string } = {},
) {
  const authoritative = response.status === 401 || (response.status === 403 && options.forbiddenIsAuthoritative);
  if (!authoritative) return response;

  let message = mobileSessionExpiredMessage(options.language ?? "en");
  try {
    const payload = await parseMobileJsonResponse<{ error?: unknown }>(response, options.language ?? "en");
    if (typeof payload.error === "string" && payload.error.trim()) message = payload.error.trim();
  } catch {
    // A malformed rejection is still authoritative because the HTTP status came from the configured service.
  }
  throw new MobileApiResponseError(message, response.status, { authoritative: true });
}
