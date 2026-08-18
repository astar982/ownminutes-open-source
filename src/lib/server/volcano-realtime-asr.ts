import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import WebSocket, { type RawData } from "ws";
import type { TranscriptSegment } from "@/lib/meeting";
import type { ProviderRuntimeConfig } from "@/lib/server/auth-repository";

const DEFAULT_WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";
const CONNECT_TIMEOUT_MS = 8_000;
const INITIAL_RESPONSE_TIMEOUT_MS = 5_000;
const CHUNK_RESPONSE_GRACE_MS = 150;
const FINAL_RESPONSE_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_CONNECTION_MS = 45_000;
const IDLE_SESSION_MS = 90_000;

const MESSAGE_TYPE = {
  clientFullRequest: 0x1,
  clientAudioOnly: 0x2,
  serverFullResponse: 0x9,
  serverError: 0xf,
} as const;

const FLAGS = {
  none: 0x0,
  positiveSequence: 0x1,
  lastWithoutSequence: 0x2,
  negativeSequence: 0x3,
} as const;

type VolcanoRealtimeConfig = {
  apiKey?: string;
  appId?: string;
  accessKey?: string;
  resourceId: string;
  wsUrl: string;
};

export type VolcanoRealtimeChunkInput = {
  buffer: Buffer;
  channels: number;
  durationMs: number;
  meetingId: string;
  ownerUserId: string;
  providerRuntime?: ProviderRuntimeConfig | null;
  recordedAt: number;
  sampleRate: number;
  sequence: number;
};

export type VolcanoRealtimeChunkResult = {
  diagnostic?: string;
  providerStatus: "accepted" | "draft" | "provider_error" | "reconnecting";
  sessionId: string;
  transcriptSegment?: TranscriptSegment;
};

export type VolcanoProtocolResponse = {
  code: number;
  event?: number;
  isLast: boolean;
  messageType: number;
  payload?: unknown;
  payloadSize: number;
  sequence?: number;
};

export type VolcanoRealtimeAuthProbeResult = {
  diagnostic: string;
  endpointHost: string;
  endpointPath: string;
  httpStatus?: number;
  ok: boolean;
  resourceId: string;
};

type ResponseWaiter = {
  accepts: (response: VolcanoProtocolResponse) => boolean;
  reject: (error: Error) => void;
  resolve: (response: VolcanoProtocolResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, VolcanoRealtimeSession>();
const recentlyClosedSessions = new Map<string, number>();

export async function transcribeWithVolcanoRealtime(input: VolcanoRealtimeChunkInput): Promise<VolcanoRealtimeChunkResult> {
  const runtimeSmokeResult = await callRuntimeSmokeRealtimeProvider({
    meetingId: input.meetingId,
    operation: "accept",
    ownerUserId: input.ownerUserId,
    sequence: input.sequence,
  });
  if (runtimeSmokeResult) return runtimeSmokeResult;
  const config = resolveVolcanoRealtimeConfig(input.providerRuntime);
  if (!isVolcanoRealtimeConfigured(config)) {
    return {
      diagnostic: "Volcano realtime ASR needs an API Key or AppId+Token plus a secure WebSocket endpoint.",
      providerStatus: "provider_error",
      sessionId: buildPublicSessionId(input.meetingId),
    };
  }

  if (input.sampleRate !== 16_000 || input.channels !== 1) {
    return {
      diagnostic: "Volcano realtime ASR currently requires 16 kHz mono signed 16-bit PCM.",
      providerStatus: "provider_error",
      sessionId: buildPublicSessionId(input.meetingId),
    };
  }

  const key = sessionKey(input.ownerUserId, input.meetingId);
  const fingerprint = configFingerprint(config);
  let session = sessions.get(key);
  let reconnecting = Date.now() - Number(recentlyClosedSessions.get(key) || 0) < 120_000;

  if (!session || !session.isUsable(fingerprint)) {
    reconnecting = reconnecting || Boolean(session);
    session?.close("replaced");
    session = new VolcanoRealtimeSession({
      config,
      fingerprint,
      meetingId: input.meetingId,
      ownerUserId: input.ownerUserId,
      onClosed: () => {
        recentlyClosedSessions.set(key, Date.now());
        const cleanup = setTimeout(() => recentlyClosedSessions.delete(key), 120_000);
        cleanup.unref?.();
        if (sessions.get(key) === session) sessions.delete(key);
      },
    });
    sessions.set(key, session);
  }

  try {
    const result = await session.acceptChunk(input);
    if (reconnecting) {
      return {
        ...result,
        diagnostic: "Realtime ASR connection was recreated. Local recording and post-meeting processing remain active.",
        providerStatus: result.transcriptSegment ? result.providerStatus : "reconnecting",
      };
    }
    return result;
  } catch (error) {
    session.close("provider-error");
    if (sessions.get(key) === session) sessions.delete(key);
    return {
      diagnostic: scrubProviderError(error),
      providerStatus: "provider_error",
      sessionId: session.publicSessionId,
    };
  }
}

export async function finishVolcanoRealtimeSession(input: {
  meetingId: string;
  ownerUserId: string;
  providerRuntime?: ProviderRuntimeConfig | null;
}) {
  const runtimeSmokeResult = await callRuntimeSmokeRealtimeProvider({
    meetingId: input.meetingId,
    operation: "finish",
    ownerUserId: input.ownerUserId,
  });
  if (runtimeSmokeResult) {
    return {
      ...runtimeSmokeResult,
      providerStatus: "completed" as const,
    };
  }
  const key = sessionKey(input.ownerUserId, input.meetingId);
  const session = sessions.get(key);
  if (!session) {
    return {
      diagnostic: "No active Volcano realtime session was found. Post-meeting audio processing can continue.",
      providerStatus: "completed" as const,
      sessionId: buildPublicSessionId(input.meetingId),
      transcriptSegment: undefined,
    };
  }

  try {
    const result = await session.finish();
    return {
      ...result,
      providerStatus: "completed" as const,
    };
  } catch (error) {
    return {
      diagnostic: scrubProviderError(error),
      providerStatus: "provider_error" as const,
      sessionId: session.publicSessionId,
      transcriptSegment: undefined,
    };
  } finally {
    session.close("completed");
    if (sessions.get(key) === session) sessions.delete(key);
  }
}

async function callRuntimeSmokeRealtimeProvider(input: {
  meetingId: string;
  operation: "accept" | "finish";
  ownerUserId: string;
  sequence?: number;
}): Promise<VolcanoRealtimeChunkResult | null> {
  if (process.env.OWNMINUTES_RUNTIME_SMOKE !== "1") return null;
  const configured = process.env.OWNMINUTES_RUNTIME_SMOKE_REALTIME_PROVIDER_URL;
  if (!configured) return null;
  const url = new URL(configured);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("Runtime smoke realtime provider must use loopback HTTP.");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Runtime smoke realtime provider returned HTTP ${response.status}.`);
  const payload = await response.json() as {
    diagnostic?: string;
    providerStatus?: VolcanoRealtimeChunkResult["providerStatus"];
    sessionId?: string;
    transcriptSegment?: TranscriptSegment;
  };
  return {
    diagnostic: payload.diagnostic || "Runtime smoke realtime provider accepted the request.",
    providerStatus: payload.providerStatus || "accepted",
    sessionId: payload.sessionId || buildPublicSessionId(input.meetingId),
    transcriptSegment: payload.transcriptSegment,
  };
}

export function closeVolcanoRealtimeSession(ownerUserId: string, meetingId: string) {
  const key = sessionKey(ownerUserId, meetingId);
  const session = sessions.get(key);
  session?.close("meeting-deleted");
  sessions.delete(key);
  recentlyClosedSessions.delete(key);
}

export function closeVolcanoRealtimeSessionsForUser(ownerUserId: string) {
  const prefix = `${ownerUserId}:`;
  for (const [key, session] of sessions) {
    if (!key.startsWith(prefix)) continue;
    session.close("account-deleted");
    sessions.delete(key);
    recentlyClosedSessions.delete(key);
  }
}

export function createVolcanoRealtimeSession(input: {
  config: VolcanoRealtimeConfig;
  meetingId: string;
  ownerUserId: string;
}) {
  return new VolcanoRealtimeSession({
    ...input,
    fingerprint: configFingerprint(input.config),
    onClosed: () => undefined,
  });
}

export function getVolcanoRealtimeConfiguration(providerRuntime?: ProviderRuntimeConfig | null) {
  const config = resolveVolcanoRealtimeConfig(providerRuntime);
  return {
    configured: isVolcanoRealtimeConfigured(config),
    resourceId: config.resourceId,
    secureWebSocket: isSecureWebSocketUrl(config.wsUrl),
    usesApiKey: Boolean(config.apiKey),
    usesAppTokenPair: Boolean(config.appId && config.accessKey),
    wsUrl: config.wsUrl,
  };
}

export async function probeVolcanoRealtimeAuthentication(
  providerRuntime?: ProviderRuntimeConfig | null,
): Promise<VolcanoRealtimeAuthProbeResult> {
  const config = resolveVolcanoRealtimeConfig(providerRuntime);
  const url = safeWebSocketUrl(config.wsUrl);
  if (!isVolcanoRealtimeConfigured(config) || !url) {
    return {
      diagnostic: "实时识别需要 API Key 或 AppID + Token、wss:// 地址和 Resource ID。",
      endpointHost: url?.hostname || "",
      endpointPath: url?.pathname || "",
      ok: false,
      resourceId: config.resourceId,
    };
  }
  const endpointUrl = url;

  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(config.wsUrl, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      headers: buildAuthHeaders(config, requestId),
    });
    const timer = setTimeout(
      () => finish({ diagnostic: "实时识别连接超时，请检查网络和 WebSocket 地址。", ok: false }),
      CONNECT_TIMEOUT_MS + 1_000,
    );
    timer.unref?.();

    socket.once("open", () => finish({ diagnostic: "实时识别鉴权和 WebSocket 连接成功。", ok: true }));
    socket.once("unexpected-response", (_request, response) => {
      finish({
        diagnostic:
          response.statusCode === 403
            ? "实时识别鉴权或服务权限被拒绝，请确认已开通对应流式 Resource ID，并使用开通后的专用 Key。"
            : `实时识别握手返回 HTTP ${response.statusCode}。`,
        httpStatus: response.statusCode,
        ok: false,
      });
    });
    socket.once("error", (error) => finish({ diagnostic: scrubProviderError(error), ok: false }));

    function finish(result: { diagnostic: string; httpStatus?: number; ok: boolean }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        // The socket may not have reached an open state.
      }
      resolve({
        ...result,
        endpointHost: endpointUrl.hostname,
        endpointPath: endpointUrl.pathname,
        resourceId: config.resourceId,
      });
    }
  });
}

export function buildVolcanoProtocolFrame(input: {
  compression?: 0 | 1;
  flags: number;
  messageType: number;
  payload: Buffer;
  sequence?: number;
  serialization?: 0 | 1;
}) {
  const compression = input.compression ?? 1;
  const serialization = input.serialization ?? 0;
  const payload = compression === 1 ? gzipSync(input.payload) : input.payload;
  const includesSequence = Boolean(input.flags & 0x1);
  const header = Buffer.from([
    0x11,
    ((input.messageType & 0xf) << 4) | (input.flags & 0xf),
    ((serialization & 0xf) << 4) | (compression & 0xf),
    0x00,
  ]);
  const sequence = includesSequence ? int32(input.sequence ?? 0) : Buffer.alloc(0);
  return Buffer.concat([header, sequence, uint32(payload.byteLength), payload]);
}

export function parseVolcanoProtocolResponse(message: Buffer): VolcanoProtocolResponse {
  if (message.byteLength < 4) throw new Error("Volcano realtime response header is incomplete.");
  const headerSize = (message[0] & 0x0f) * 4;
  const messageType = message[1] >> 4;
  const flags = message[1] & 0x0f;
  const serialization = message[2] >> 4;
  const compression = message[2] & 0x0f;
  if (headerSize < 4 || message.byteLength < headerSize) throw new Error("Volcano realtime response header size is invalid.");

  let offset = headerSize;
  let sequence: number | undefined;
  let event: number | undefined;
  if (flags & 0x1) {
    ensureReadable(message, offset, 4);
    sequence = message.readInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x4) {
    ensureReadable(message, offset, 4);
    event = message.readInt32BE(offset);
    offset += 4;
  }

  let code = 0;
  let payloadSize = 0;
  if (messageType === MESSAGE_TYPE.serverError) {
    ensureReadable(message, offset, 8);
    code = message.readInt32BE(offset);
    payloadSize = message.readUInt32BE(offset + 4);
    offset += 8;
  } else if (messageType === MESSAGE_TYPE.serverFullResponse) {
    ensureReadable(message, offset, 4);
    payloadSize = message.readUInt32BE(offset);
    offset += 4;
  }

  ensureReadable(message, offset, payloadSize);
  let payloadBuffer = message.subarray(offset, offset + payloadSize);
  if (compression === 1 && payloadBuffer.byteLength > 0) payloadBuffer = gunzipSync(payloadBuffer);
  let payload: unknown;
  if (serialization === 1 && payloadBuffer.byteLength > 0) {
    payload = JSON.parse(payloadBuffer.toString("utf8"));
  }

  return {
    code,
    event,
    isLast: Boolean(flags & 0x2),
    messageType,
    payload,
    payloadSize,
    sequence,
  };
}

export function resetVolcanoRealtimeSessionsForTests() {
  for (const session of sessions.values()) session.close("test-reset");
  sessions.clear();
  recentlyClosedSessions.clear();
}

class VolcanoRealtimeSession {
  readonly publicSessionId: string;
  private readonly config: VolcanoRealtimeConfig;
  private readonly fingerprint: string;
  private readonly meetingId: string;
  private readonly ownerUserId: string;
  private readonly requestId = randomUUID();
  private readonly onClosed: () => void;
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private operation = Promise.resolve<unknown>(undefined);
  private waiters: ResponseWaiter[] = [];
  private responseBacklog: VolcanoProtocolResponse[] = [];
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastActivityAt = Date.now();
  private lastPongAt = Date.now();
  private nextSequence = 1;
  private closed = false;

  constructor(input: {
    config: VolcanoRealtimeConfig;
    fingerprint: string;
    meetingId: string;
    ownerUserId: string;
    onClosed: () => void;
  }) {
    this.config = input.config;
    this.fingerprint = input.fingerprint;
    this.meetingId = input.meetingId;
    this.ownerUserId = input.ownerUserId;
    this.onClosed = input.onClosed;
    this.publicSessionId = `rt-${sanitizeId(this.meetingId)}-${this.requestId.slice(0, 8)}`;
  }

  isUsable(fingerprint: string) {
    return !this.closed && this.fingerprint === fingerprint && Date.now() - this.lastActivityAt < IDLE_SESSION_MS;
  }

  async acceptChunk(input: VolcanoRealtimeChunkInput): Promise<VolcanoRealtimeChunkResult> {
    return this.enqueue(async () => {
      await this.connect();
      this.lastActivityAt = Date.now();
      const sequence = this.nextSequence++;
      this.send(
        buildVolcanoProtocolFrame({
          flags: FLAGS.positiveSequence,
          messageType: MESSAGE_TYPE.clientAudioOnly,
          payload: input.buffer,
          sequence,
        }),
      );
      const response = await this.waitForResponse(CHUNK_RESPONSE_GRACE_MS).catch((error) => {
        if (error instanceof ProviderResponseTimeoutError && this.socket?.readyState === WebSocket.OPEN) return null;
        throw error;
      });

      if (!response) {
        return {
          diagnostic: "Realtime audio was sent; the provider response is still pending. Local recording remains authoritative.",
          providerStatus: "accepted" as const,
          sessionId: this.publicSessionId,
        };
      }
      assertProviderResponse(response);
      const transcriptSegment = normalizeTranscriptSegment(response, input);
      return {
        providerStatus: transcriptSegment ? ("draft" as const) : ("accepted" as const),
        sessionId: this.publicSessionId,
        transcriptSegment,
      };
    });
  }

  async finish() {
    return this.enqueue(async () => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return { sessionId: this.publicSessionId };
      }
      const sequence = this.nextSequence++;
      const response = await this.sendAndWait(
        buildVolcanoProtocolFrame({
          flags: FLAGS.negativeSequence,
          messageType: MESSAGE_TYPE.clientAudioOnly,
          payload: Buffer.alloc(0),
          sequence: -sequence,
        }),
        FINAL_RESPONSE_TIMEOUT_MS,
        (candidate) => candidate.isLast || candidate.messageType === MESSAGE_TYPE.serverError,
      ).catch((error) => {
        if (error instanceof ProviderResponseTimeoutError) return null;
        throw error;
      });
      if (response) assertProviderResponse(response);
      const transcriptSegment = response
        ? normalizeTranscriptSegment(response, {
            buffer: Buffer.alloc(0),
            channels: 1,
            durationMs: 0,
            meetingId: this.meetingId,
            ownerUserId: this.ownerUserId,
            recordedAt: Date.now(),
            sampleRate: 16_000,
            sequence,
          })
        : undefined;
      return { sessionId: this.publicSessionId, transcriptSegment };
    });
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.rejectWaiters(new Error(`Volcano realtime session closed: ${reason}`));
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, reason.slice(0, 100));
    }
    this.onClosed();
  }

  private async connect() {
    if (this.closed) throw new Error("Volcano realtime session is closed.");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async openSocket() {
    const headers = buildAuthHeaders(this.config, this.requestId);
    const socket = new WebSocket(this.config.wsUrl, { headers, handshakeTimeout: CONNECT_TIMEOUT_MS });
    this.socket = socket;
    socket.binaryType = "nodebuffer";
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("pong", () => {
      this.lastPongAt = Date.now();
    });
    socket.on("error", (error) => this.rejectWaiters(new Error(`Volcano realtime socket error: ${scrubProviderError(error)}`)));
    socket.on("close", () => {
      this.rejectWaiters(new Error("Volcano realtime socket closed."));
      if (!this.closed) {
        this.closed = true;
        this.onClosed();
      }
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Volcano realtime WebSocket connection timed out.")), CONNECT_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.lastActivityAt = Date.now();
    this.lastPongAt = Date.now();
    this.startHeartbeat();
    const sequence = this.nextSequence++;
    const response = await this.sendAndWait(
      buildInitialRequestFrame(sequence, this.ownerUserId),
      INITIAL_RESPONSE_TIMEOUT_MS,
    );
    assertProviderResponse(response);
  }

  private sendAndWait(
    frame: Buffer,
    timeoutMs: number,
    accepts: (response: VolcanoProtocolResponse) => boolean = () => true,
  ) {
    this.send(frame);
    return this.waitForResponse(timeoutMs, accepts);
  }

  private send(frame: Buffer) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Volcano realtime WebSocket is not open.");
    this.socket.send(frame);
    this.lastActivityAt = Date.now();
  }

  private waitForResponse(
    timeoutMs: number,
    accepts: (response: VolcanoProtocolResponse) => boolean = () => true,
  ) {
    const bufferedIndex = this.responseBacklog.findIndex(accepts);
    if (bufferedIndex >= 0) {
      const [response] = this.responseBacklog.splice(bufferedIndex, 1);
      return Promise.resolve(response);
    }

    const responsePromise = new Promise<VolcanoProtocolResponse>((resolve, reject) => {
      const waiter: ResponseWaiter = {
        accepts,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ProviderResponseTimeoutError());
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
    return responsePromise;
  }

  private handleMessage(data: RawData) {
    const buffer = rawDataToBuffer(data);
    let response: VolcanoProtocolResponse;
    try {
      response = parseVolcanoProtocolResponse(buffer);
    } catch (error) {
      this.rejectWaiters(error instanceof Error ? error : new Error("Failed to parse Volcano realtime response."));
      return;
    }
    this.lastActivityAt = Date.now();
    const waiterIndex = this.waiters.findIndex((candidate) => candidate.accepts(response));
    if (waiterIndex < 0) {
      this.responseBacklog.push(response);
      if (this.responseBacklog.length > 32) this.responseBacklog.splice(0, this.responseBacklog.length - 32);
      return;
    }
    const [waiter] = this.waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }

  private rejectWaiters(error: Error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.responseBacklog = [];
  }

  private startHeartbeat() {
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      const now = Date.now();
      if (now - this.lastActivityAt > IDLE_SESSION_MS || now - this.lastPongAt > STALE_CONNECTION_MS) {
        this.close(now - this.lastActivityAt > IDLE_SESSION_MS ? "idle-timeout" : "heartbeat-timeout");
        return;
      }
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class ProviderResponseTimeoutError extends Error {
  constructor() {
    super("Volcano realtime provider response timed out.");
  }
}

function buildInitialRequestFrame(sequence: number, ownerUserId: string) {
  const payload = Buffer.from(
    JSON.stringify({
      user: { uid: createHash("sha256").update(ownerUserId).digest("hex").slice(0, 24) },
      audio: { format: "pcm", codec: "raw", rate: 16_000, bits: 16, channel: 1 },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        enable_nonstream: true,
        enable_speaker_info: true,
        ssd_version: "200",
      },
    }),
    "utf8",
  );
  return buildVolcanoProtocolFrame({
    flags: FLAGS.positiveSequence,
    messageType: MESSAGE_TYPE.clientFullRequest,
    payload,
    sequence,
    serialization: 1,
  });
}

function buildAuthHeaders(config: VolcanoRealtimeConfig, requestId: string) {
  const common = {
    "X-Api-Connect-Id": requestId,
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  };
  if (config.apiKey) return { ...common, "X-Api-Key": config.apiKey };
  return {
    ...common,
    "X-Api-App-Key": config.appId ?? "",
    "X-Api-Access-Key": config.accessKey ?? "",
  };
}

function normalizeTranscriptSegment(response: VolcanoProtocolResponse, input: VolcanoRealtimeChunkInput): TranscriptSegment | undefined {
  const payload = asRecord(response.payload);
  const rawResult = payload?.result;
  const result = Array.isArray(rawResult) ? asRecord(rawResult[0]) : asRecord(rawResult);
  if (!result) return undefined;
  const utterances = Array.isArray(result.utterances) ? result.utterances.map(asRecord).filter(Boolean) : [];
  const utterance = [...utterances].reverse().find((item) => typeof item?.text === "string" && item.text.trim());
  const text = String(utterance?.text ?? result.text ?? "").trim();
  if (!text) return undefined;
  const explicitStartMs = numberOrUndefined(utterance?.start_time);
  const startMs = explicitStartMs ?? 0;
  const speakerValue = utterance?.speaker_id ?? utterance?.speaker ?? utterance?.speakerId;
  const speaker = speakerValue === undefined ? "Speaker 1" : `Speaker ${String(speakerValue).replace(/^Speaker\s*/i, "")}`;
  return {
    id: `live-${sanitizeId(input.meetingId)}-${explicitStartMs === undefined ? "active" : Math.max(0, Math.round(startMs))}`,
    speaker,
    timestamp: formatTimestamp(startMs),
    text,
  };
}

function assertProviderResponse(response: VolcanoProtocolResponse) {
  if (response.messageType === MESSAGE_TYPE.serverError || response.code !== 0) {
    const payload = asRecord(response.payload);
    const message = typeof payload?.message === "string" ? payload.message : `provider code ${response.code}`;
    throw new Error(`Volcano realtime ASR rejected the request: ${message}`);
  }
  if (response.messageType !== MESSAGE_TYPE.serverFullResponse) {
    throw new Error(`Unexpected Volcano realtime message type: ${response.messageType}.`);
  }
}

function resolveVolcanoRealtimeConfig(providerRuntime?: ProviderRuntimeConfig | null): VolcanoRealtimeConfig {
  const runtime = providerRuntime?.providerId === "volcano-asr" ? providerRuntime : null;
  const fileResourceId = runtime?.fields.VOLCANO_ASR_RESOURCE_ID || process.env.VOLCANO_ASR_RESOURCE_ID;
  const realtimeResourceId = runtime?.fields.VOLCANO_REALTIME_ASR_RESOURCE_ID || process.env.VOLCANO_REALTIME_ASR_RESOURCE_ID;
  return {
    apiKey: runtime?.secrets.VOLCANO_ASR_API_KEY || process.env.VOLCANO_ASR_API_KEY,
    appId: runtime?.fields.VOLCANO_ASR_APP_ID || process.env.VOLCANO_ASR_APP_ID || process.env.VOLCANO_APP_ID,
    accessKey: runtime?.secrets.VOLCANO_ASR_TOKEN || process.env.VOLCANO_ASR_TOKEN,
    resourceId: realtimeResourceId || (fileResourceId?.includes(".sauc") ? fileResourceId : undefined) || DEFAULT_RESOURCE_ID,
    wsUrl: runtime?.fields.VOLCANO_ASR_WS_URL || runtime?.fields.VOLCANO_ASR_ENDPOINT || process.env.VOLCANO_ASR_WS_URL || process.env.VOLCANO_ASR_ENDPOINT || DEFAULT_WS_URL,
  };
}

function isVolcanoRealtimeConfigured(config: VolcanoRealtimeConfig) {
  return Boolean((config.apiKey || (config.appId && config.accessKey)) && isSecureWebSocketUrl(config.wsUrl) && config.resourceId);
}

function isSecureWebSocketUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      allowedVolcanoRealtimeHosts().has(url.hostname.toLowerCase())
    ) {
      return true;
    }
    return (
      process.env.OWNMINUTES_REALTIME_ASR_ALLOW_INSECURE_LOOPBACK_TEST === "1" &&
      url.protocol === "ws:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function allowedVolcanoRealtimeHosts() {
  return new Set([
    "openspeech.bytedance.com",
    ...(process.env.OWNMINUTES_VOLCANO_REALTIME_ALLOWED_HOSTS || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
}

function safeWebSocketUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function configFingerprint(config: VolcanoRealtimeConfig) {
  return createHash("sha256")
    .update([config.wsUrl, config.resourceId, config.apiKey, config.appId, config.accessKey].join("\u0000"))
    .digest("hex");
}

function sessionKey(ownerUserId: string, meetingId: string) {
  return `${ownerUserId}:${meetingId}`;
}

function buildPublicSessionId(meetingId: string) {
  return `rt-${sanitizeId(meetingId)}`;
}

function rawDataToBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new Error("Unsupported Volcano realtime WebSocket message type.");
}

function int32(value: number) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function uint32(value: number) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function ensureReadable(buffer: Buffer, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset + length > buffer.byteLength) {
    throw new Error("Volcano realtime response payload is truncated.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function numberOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function formatTimestamp(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 80);
}

function scrubProviderError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/AKL[A-Za-z0-9_-]+/g, "[redacted-access-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/(X-Api-(?:Key|Access-Key)[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 500);
}
