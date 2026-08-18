export type MeetingAccessErrorOptions = {
  code?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
};

export class MeetingAccessError extends Error {
  code?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  status: number;

  constructor(message: string, status = 403, options: MeetingAccessErrorOptions = {}) {
    super(message);
    this.name = "MeetingAccessError";
    this.status = status;
    this.code = options.code;
    this.retryable = options.retryable ?? status >= 500;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function meetingAccessErrorBody(error: MeetingAccessError) {
  return {
    ok: false as const,
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.retryable ? { retryable: true } : {}),
  };
}

export function meetingAccessErrorHeaders(error: MeetingAccessError) {
  return error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined;
}

export function meetingHistoryUnavailableResponse() {
  return Response.json(
    {
      ok: false,
      code: "meeting_history_unavailable",
      error: "会议历史暂时不可用，请稍后重试。",
      retryable: true,
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "30",
      },
    },
  );
}
