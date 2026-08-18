import type { TranscriptSegment } from "@/lib/meeting";
import type { ProviderRuntimeConfig } from "@/lib/server/auth-repository";
import { validateArkBaseUrlStructure } from "@/lib/server/ark-endpoint-security";
import { getVolcanoRealtimeConfiguration, transcribeWithVolcanoRealtime } from "@/lib/server/volcano-realtime-asr";
import { getVolcanoFileAsrDiagnostic } from "@/lib/volcano-asr";

export type TranscriptionChunkInput = {
  buffer?: Buffer;
  channels?: number;
  providerRuntime?: ProviderRuntimeConfig | null;
  meetingId: string;
  ownerUserId?: string;
  sequence: number;
  mimeType: string;
  savedBytes: number;
  recordedAt: number;
  durationMs: number;
  sampleRate?: number;
};

export type TranscriptionChunkResult = {
  adapter: string;
  transcriptSegment?: TranscriptSegment;
  diagnostic?: string;
  providerStatus?: "accepted" | "draft" | "not_configured" | "pending_protocol" | "provider_error" | "reconnecting" | "completed";
  sessionId?: string;
};

export type RealtimeTranscriptionAdapter = {
  name: string;
  acceptChunk(input: TranscriptionChunkInput): Promise<TranscriptionChunkResult>;
};

export type TranscriptionProvider = "mock" | "openai" | "volcano";

export type ProviderDiagnostic = {
  provider: TranscriptionProvider;
  adapter: string;
  ready: boolean;
  missing: string[];
  present: Record<string, boolean>;
  notes: string[];
  capabilities?: {
    realtimeConfigured?: boolean;
    realtimeProtocolReady?: boolean;
    realtimeReady: boolean;
    fileAsrReady: boolean;
    summaryConfigured?: boolean;
    summaryMissing?: string[];
    summaryProductionReady?: boolean;
    summaryReady: boolean;
  };
};

export function getTranscriptionProvider(): TranscriptionProvider {
  const provider = process.env.TRANSCRIPTION_PROVIDER?.trim().toLowerCase();

  if (provider === "openai" || provider === "volcano" || provider === "mock") {
    return provider;
  }

  return "mock";
}

export function getRealtimeTranscriptionAdapter() {
  const provider = getTranscriptionProvider();

  if (provider === "openai") return openaiRealtimeTranscriptionAdapter;
  if (provider === "volcano") return volcanoRealtimeTranscriptionAdapter;
  return mockRealtimeTranscriptionAdapter;
}

export function getProviderDiagnostic(): ProviderDiagnostic {
  const provider = getTranscriptionProvider();

  if (provider === "openai") {
    const ready = Boolean(process.env.OPENAI_API_KEY);
    return {
      provider,
      adapter: openaiRealtimeTranscriptionAdapter.name,
      ready,
      missing: ready ? [] : ["OPENAI_API_KEY"],
      present: {
        OPENAI_API_KEY: ready,
      },
      notes: ["OpenAI adapter is an integration placeholder; live realtime transcription is not enabled yet."],
    };
  }

  if (provider === "volcano") {
    return getVolcanoDiagnostic();
  }

  return {
    provider,
    adapter: mockRealtimeTranscriptionAdapter.name,
    ready: true,
    missing: [],
    present: {},
    notes: ["Mock provider is active. No external transcription service will be called."],
  };
}

export const mockRealtimeTranscriptionAdapter: RealtimeTranscriptionAdapter = {
  name: "mock-realtime-adapter",
  async acceptChunk(input) {
    const sessionId = buildRealtimeSessionId(input.meetingId);

    if (input.sequence % 2 !== 0) {
      return {
        adapter: this.name,
        providerStatus: "accepted",
        sessionId,
      };
    }

    return {
      adapter: this.name,
      providerStatus: "draft",
      sessionId,
      transcriptSegment: {
        id: `live-${input.sequence}`,
        speaker: input.sequence % 4 === 0 ? "Speaker 2" : "Speaker 1",
        timestamp: formatChunkTimestamp(input.sequence, input.durationMs),
        text: `已接收第 ${input.sequence} 个音频分片，后续会在这里替换为真实实时转写结果。`,
      },
    };
  },
};

export const openaiRealtimeTranscriptionAdapter: RealtimeTranscriptionAdapter = {
  name: "openai-realtime-adapter",
  async acceptChunk(input) {
    if (!process.env.OPENAI_API_KEY) {
      return {
        adapter: this.name,
        diagnostic: "OPENAI_API_KEY is missing; falling back to saved audio only.",
        providerStatus: "not_configured",
        sessionId: buildRealtimeSessionId(input.meetingId),
      };
    }

    return {
      adapter: this.name,
      diagnostic: "OpenAI realtime transcription is not wired yet. Keep saved chunks for post-meeting processing.",
      providerStatus: "pending_protocol",
      sessionId: buildRealtimeSessionId(input.meetingId),
    };
  },
};

export const volcanoRealtimeTranscriptionAdapter: RealtimeTranscriptionAdapter = {
  name: "volcano-realtime-adapter",
  async acceptChunk(input) {
    const diagnostic = getVolcanoDiagnostic(input.providerRuntime ?? undefined);

    if (!diagnostic.capabilities?.realtimeConfigured) {
      return {
        adapter: this.name,
        diagnostic: `Volcano realtime ASR is not enabled. Missing configuration: ${diagnostic.missing.join(
          ", ",
        ) || "speech runtime credentials"}. Audio chunks were saved for post-meeting file recognition.`,
        providerStatus: "not_configured",
        sessionId: buildRealtimeSessionId(input.meetingId),
      };
    }

    if (!input.buffer || !input.ownerUserId || !input.sampleRate || !input.channels) {
      return {
        adapter: this.name,
        diagnostic: "Realtime ASR input is incomplete. Local recording and post-meeting processing remain available.",
        providerStatus: "provider_error",
        sessionId: buildRealtimeSessionId(input.meetingId),
      };
    }

    const result = await transcribeWithVolcanoRealtime({
      buffer: input.buffer,
      channels: input.channels,
      durationMs: input.durationMs,
      meetingId: input.meetingId,
      ownerUserId: input.ownerUserId,
      providerRuntime: input.providerRuntime,
      recordedAt: input.recordedAt,
      sampleRate: input.sampleRate,
      sequence: input.sequence,
    });
    return {
      adapter: this.name,
      ...result,
    };
  },
};

function buildRealtimeSessionId(meetingId: string) {
  return `rt-${meetingId}`;
}

function getVolcanoDiagnostic(providerRuntime?: ProviderRuntimeConfig | null): ProviderDiagnostic {
  const config = providerRuntime?.providerId === "volcano-asr" ? providerRuntime : null;
  const fileAsr = getVolcanoFileAsrDiagnostic(
    config
      ? {
          apiKey: config.secrets.VOLCANO_ASR_API_KEY,
          appId: config.fields.VOLCANO_ASR_APP_ID,
          token: config.secrets.VOLCANO_ASR_TOKEN,
          mode: config.fields.VOLCANO_ASR_MODE === "standard" ? "standard" : "flash",
          recognizeUrl: config.fields.VOLCANO_ASR_RECOGNIZE_URL,
          submitUrl: config.fields.VOLCANO_ASR_SUBMIT_URL,
          queryUrl: config.fields.VOLCANO_ASR_QUERY_URL,
          resourceId: config.fields.VOLCANO_ASR_RESOURCE_ID,
          model: config.fields.VOLCANO_ASR_MODEL,
          vadSegmentDuration: config.fields.VOLCANO_ASR_VAD_SEGMENT_DURATION,
        }
      : undefined,
  );
  const realtimeConfiguration = getVolcanoRealtimeConfiguration(config);
  const realtimeConfigured = realtimeConfiguration.configured;
  const realtimeProtocolReady = true;
  const summaryDiagnostic = getSummaryRuntimeDiagnostic();
  const present = {
    VOLCANO_ACCESS_KEY_ID: Boolean(process.env.VOLCANO_ACCESS_KEY_ID),
    VOLCANO_SECRET_ACCESS_KEY: Boolean(process.env.VOLCANO_SECRET_ACCESS_KEY),
    VOLCANO_ASR_API_KEY: Boolean(config?.secrets.VOLCANO_ASR_API_KEY || process.env.VOLCANO_ASR_API_KEY),
    VOLCANO_ASR_APP_ID: Boolean(config?.fields.VOLCANO_ASR_APP_ID || process.env.VOLCANO_ASR_APP_ID || process.env.VOLCANO_APP_ID),
    VOLCANO_ASR_TOKEN: Boolean(config?.secrets.VOLCANO_ASR_TOKEN || process.env.VOLCANO_ASR_TOKEN),
    VOLCANO_ASR_MODE_FLASH: (config?.fields.VOLCANO_ASR_MODE || process.env.VOLCANO_ASR_MODE || "flash") === "flash",
    VOLCANO_ASR_RECOGNIZE_URL: Boolean(config?.fields.VOLCANO_ASR_RECOGNIZE_URL || process.env.VOLCANO_ASR_RECOGNIZE_URL),
    VOLCANO_ASR_CLUSTER: Boolean(config?.fields.VOLCANO_ASR_CLUSTER || process.env.VOLCANO_ASR_CLUSTER),
    VOLCANO_ASR_WS_URL: Boolean(config?.fields.VOLCANO_ASR_WS_URL || config?.fields.VOLCANO_ASR_ENDPOINT || process.env.VOLCANO_ASR_WS_URL || process.env.VOLCANO_ASR_ENDPOINT),
    VOLCANO_REALTIME_ASR_RESOURCE_ID: Boolean(config?.fields.VOLCANO_REALTIME_ASR_RESOURCE_ID || process.env.VOLCANO_REALTIME_ASR_RESOURCE_ID || realtimeConfiguration.resourceId),
    VOLCANO_ASR_SUBMIT_URL: Boolean(config?.fields.VOLCANO_ASR_SUBMIT_URL || process.env.VOLCANO_ASR_SUBMIT_URL),
    VOLCANO_ASR_QUERY_URL: Boolean(config?.fields.VOLCANO_ASR_QUERY_URL || process.env.VOLCANO_ASR_QUERY_URL),
    ARK_API_KEY: Boolean(process.env.ARK_API_KEY),
    ARK_CHAT_MODEL: Boolean(process.env.ARK_CHAT_MODEL),
    ARK_BASE_URL_OFFICIAL_HTTPS: validateArkBaseUrlStructure(process.env.ARK_BASE_URL).ok,
    OWNMINUTES_SUMMARY_JSON_ONLY: process.env.OWNMINUTES_SUMMARY_JSON_ONLY === "1",
    OWNMINUTES_SUMMARY_HALLUCINATION_POLICY: Boolean(process.env.OWNMINUTES_SUMMARY_HALLUCINATION_POLICY),
    OWNMINUTES_SUMMARY_RETRY_POLICY: Boolean(process.env.OWNMINUTES_SUMMARY_RETRY_POLICY),
    OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY: Boolean(process.env.OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY),
  };

  const missing = fileAsr.ready ? [] : fileAsr.missing;

  return {
    provider: "volcano",
    adapter: volcanoRealtimeTranscriptionAdapter.name,
    ready: fileAsr.ready || (realtimeConfigured && realtimeProtocolReady),
    missing,
    present,
    capabilities: {
      realtimeConfigured,
      realtimeProtocolReady,
      realtimeReady: realtimeConfigured && realtimeProtocolReady,
      fileAsrReady: fileAsr.ready,
      summaryConfigured: summaryDiagnostic.configured,
      summaryMissing: summaryDiagnostic.missing,
      summaryProductionReady: summaryDiagnostic.productionReady,
      summaryReady: summaryDiagnostic.productionReady,
    },
    notes: [
      "AccessKey/SecretKey are account-level credentials and are not sufficient by themselves for speech runtime calls.",
      config ? "Realtime adapter is using the current user's encrypted Volcano ASR BYOK runtime config." : "Realtime adapter is using process environment config because no user BYOK runtime config was provided.",
      "Post-meeting file ASR can run with VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN.",
      realtimeConfigured
        ? "Realtime ASR uses the official Volcano binary WebSocket protocol with heartbeat, bounded reconnect, and end-of-session framing."
        : "Realtime ASR protocol is implemented but still needs an API Key or AppId+Token runtime credential.",
      "Ark summary production readiness requires ARK_API_KEY, ARK_CHAT_MODEL, HTTPS base URL, JSON-only output, hallucination handling, retry, and human review policies.",
      "This project saves audio chunks even when the realtime provider is not ready.",
    ],
  };
}

function getSummaryRuntimeDiagnostic() {
  const missing = [
    ...(!process.env.ARK_API_KEY ? ["ARK_API_KEY"] : []),
    ...(!process.env.ARK_CHAT_MODEL ? ["ARK_CHAT_MODEL"] : []),
    ...(!validateArkBaseUrlStructure(process.env.ARK_BASE_URL).ok ? ["ARK_BASE_URL_OFFICIAL_HTTPS"] : []),
    ...(process.env.OWNMINUTES_SUMMARY_JSON_ONLY !== "1" ? ["OWNMINUTES_SUMMARY_JSON_ONLY=1"] : []),
    ...(!process.env.OWNMINUTES_SUMMARY_HALLUCINATION_POLICY ? ["OWNMINUTES_SUMMARY_HALLUCINATION_POLICY"] : []),
    ...(!process.env.OWNMINUTES_SUMMARY_RETRY_POLICY ? ["OWNMINUTES_SUMMARY_RETRY_POLICY"] : []),
    ...(!process.env.OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY ? ["OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY"] : []),
  ];

  return {
    configured: Boolean(process.env.ARK_API_KEY && process.env.ARK_CHAT_MODEL),
    missing,
    productionReady: missing.length === 0,
  };
}

function formatChunkTimestamp(sequence: number, durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(((sequence - 1) * durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
