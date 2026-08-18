import { translate, type AppLocale } from "./i18n/core";

export type MobileApiFailureKind =
  | "invalid-response"
  | "network"
  | "server-unavailable"
  | "timeout";

export class MobileApiError extends Error {
  readonly code?: string;
  readonly httpStatus: number;
  readonly kind: MobileApiFailureKind;
  readonly retryAfterSeconds?: number;
  readonly retryable: boolean;
  readonly status: number;

  constructor(message: string, options: {
    code?: string;
    kind: MobileApiFailureKind;
    retryAfterSeconds?: number;
    status?: number;
  }) {
    super(message);
    this.name = "MobileApiError";
    this.code = options.code;
    this.httpStatus = options.status ?? 0;
    this.kind = options.kind;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.status = options.kind === "invalid-response" ? 0 : this.httpStatus;
    this.retryable = true;
  }
}

export const defaultMobileApiTimeoutMs = 20_000;

type MobileApiRequestState = {
  abortFromCaller: () => void;
  callerAborted: boolean;
  callerSignal?: AbortSignal | null;
  cleanedUp: boolean;
  controller: AbortController;
  language: string;
  timedOut: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
};

const mobileApiRequestStates = new WeakMap<Response, MobileApiRequestState>();

export function resolveMobileApiLocale(language: string): AppLocale {
  const normalized = (language || "en").replaceAll("_", "-").toLowerCase();
  if (normalized.startsWith("zh")) {
    if (normalized.includes("hant") || /-(tw|hk|mo)(-|$)/.test(normalized)) return "zh-Hant";
    return "zh-Hans";
  }
  return "en";
}

export function mobileSessionExpiredMessage(language: string) {
  return translate(resolveMobileApiLocale(language), "apiErrors.sessionExpired");
}

export function mobileRegistrationUnavailableMessage(language: string) {
  return translate(resolveMobileApiLocale(language), "apiErrors.registrationUnavailable");
}

export function createMobileApiError(
  kind: MobileApiFailureKind,
  language: string,
  options: { code?: string; retryAfterSeconds?: number; status?: number } = {},
) {
  return buildMobileApiError(kind, language, options);
}

export async function parseMobileJsonResponse<T>(response: Response, language: string): Promise<T> {
  return (await readMobileJsonResponse<T>(response, language)).payload;
}

export async function readMobileJsonResponse<T>(response: Response, language: string) {
  const body = await readMobileTextResponse(response, language, { allowServerError: true });
  const payload = parseMobileJsonText<T>(body, response.status, language, {
    retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
  });
  return { body, payload };
}

export async function readMobileTextResponse(
  response: Response,
  language: string,
  options: { allowServerError?: boolean } = {},
) {
  const requestState = mobileApiRequestStates.get(response);
  let body = "";
  try {
    body = await response.text();
    if (requestState?.callerAborted) throw callerAbortError();
    if (requestState?.timedOut) throw buildMobileApiError("timeout", language, { status: response.status });
  } catch (error) {
    throw classifyMobileApiTransportError(error, language, requestState, response.status);
  } finally {
    cleanupMobileApiRequest(requestState);
  }
  if (response.status >= 500 && !options.allowServerError) {
    throw buildMobileApiError("server-unavailable", language, {
      retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
      status: response.status,
    });
  }
  return body;
}

export function parseMobileJsonText<T>(
  body: string,
  status: number,
  language: string,
  options: { retryAfterSeconds?: number } = {},
): T {
  let payload: unknown = null;
  let validJson = false;

  if (body.trim()) {
    try {
      payload = JSON.parse(body) as unknown;
      validJson = true;
    } catch {
      validJson = false;
    }
  }

  if (status >= 500) {
    throw buildMobileApiError("server-unavailable", language, {
      code: validJson ? safeResponseCode(payload) : undefined,
      retryAfterSeconds: options.retryAfterSeconds,
      status,
    });
  }
  if (!validJson || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw buildMobileApiError("invalid-response", language, { status });
  }
  return payload as T;
}

export async function fetchMobileApi(
  input: RequestInfo | URL,
  init: RequestInit,
  options: {
    language: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
) {
  const timeoutMs = options.timeoutMs ?? defaultMobileApiTimeoutMs;
  const controller = new AbortController();
  const callerSignal = init.signal;
  const requestState: MobileApiRequestState = {
    abortFromCaller: () => {
      requestState.callerAborted = true;
      requestState.controller.abort();
      cleanupMobileApiRequest(requestState);
    },
    callerAborted: Boolean(callerSignal?.aborted),
    callerSignal,
    cleanedUp: false,
    controller,
    language: options.language,
    timedOut: false,
    timeout: null,
  };

  if (requestState.callerAborted) controller.abort();
  else callerSignal?.addEventListener("abort", requestState.abortFromCaller, { once: true });

  if (!requestState.callerAborted) {
    requestState.timeout = setTimeout(() => {
      requestState.timedOut = true;
      requestState.controller.abort();
      cleanupMobileApiRequest(requestState);
    }, timeoutMs);
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(input, { ...init, signal: controller.signal });
    if (requestState.callerAborted) throw callerAbortError();
    if (requestState.timedOut) throw buildMobileApiError("timeout", options.language);
    mobileApiRequestStates.set(response, requestState);
    if (!response.body) cleanupMobileApiRequest(requestState);
    return response;
  } catch (error) {
    cleanupMobileApiRequest(requestState);
    throw classifyMobileApiTransportError(error, options.language, requestState);
  }
}

export async function runMobileApiOperationWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { language: string; timeoutMs?: number },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? defaultMobileApiTimeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(buildMobileApiError("timeout", options.language));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) throw buildMobileApiError("timeout", options.language);
    if (error instanceof MobileApiError) throw error;
    throw buildMobileApiError("network", options.language);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function classifyMobileApiTransportError(
  error: unknown,
  language: string,
  requestState?: MobileApiRequestState,
  status = 0,
): unknown {
  if (error instanceof MobileApiError) return error;
  if (requestState?.callerAborted) return error;
  return buildMobileApiError(requestState?.timedOut ? "timeout" : "network", language, { status });
}

function cleanupMobileApiRequest(requestState?: MobileApiRequestState) {
  if (!requestState || requestState.cleanedUp) return;
  requestState.cleanedUp = true;
  if (requestState.timeout) clearTimeout(requestState.timeout);
  requestState.timeout = null;
  requestState.callerSignal?.removeEventListener("abort", requestState.abortFromCaller);
}

function callerAbortError() {
  return Object.assign(new Error("The request was aborted by the caller."), { name: "AbortError" });
}

function buildMobileApiError(
  kind: MobileApiFailureKind,
  language: string,
  options: { code?: string; retryAfterSeconds?: number; status?: number } = {},
) {
  const status = options.status ?? 0;
  const locale = resolveMobileApiLocale(language);
  const key = kind === "server-unavailable"
    ? "apiErrors.serverUnavailable"
    : kind === "invalid-response"
      ? "apiErrors.invalidResponse"
      : kind === "timeout"
        ? "apiErrors.timeout"
        : "apiErrors.network";
  const message = translate(locale, key, { status: status || "-" });
  return new MobileApiError(message, { ...options, kind, status });
}

function safeResponseCode(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("code" in payload)) return undefined;
  const code = String(payload.code ?? "").trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : undefined;
}

function parseRetryAfterSeconds(raw: string | null) {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(15 * 60, Math.ceil(seconds)) : undefined;
}
