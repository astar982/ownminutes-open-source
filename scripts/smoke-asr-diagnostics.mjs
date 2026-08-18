#!/usr/bin/env node

const cases = [
  {
    name: "empty-env-blocks-file-asr",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
    },
    expect: {
      ready: false,
      fileAsrReady: false,
      realtimeReady: false,
      missingIncludes: "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
    },
  },
  {
    name: "account-ak-sk-not-runtime-asr",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ACCESS_KEY_ID: "ak-account-only",
      VOLCANO_SECRET_ACCESS_KEY: "sk-account-only",
    },
    expect: {
      ready: false,
      fileAsrReady: false,
      realtimeReady: false,
      missingIncludes: "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
    },
  },
  {
    name: "api-key-enables-file-asr",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_API_KEY: "asr-runtime-api-key",
    },
    expect: {
      ready: true,
      fileAsrReady: true,
      realtimeReady: false,
      missingIncludes: null,
    },
  },
  {
    name: "app-token-enables-file-asr",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_APP_ID: "asr-app-id",
      VOLCANO_ASR_TOKEN: "asr-runtime-token",
    },
    expect: {
      ready: true,
      fileAsrReady: true,
      realtimeReady: false,
      missingIncludes: null,
    },
  },
  {
    name: "ws-url-configures-realtime-but-does-not-enable-protocol",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_API_KEY: "asr-runtime-api-key",
      VOLCANO_ASR_WS_URL: "wss://example.invalid/asr",
    },
    expect: {
      ready: true,
      fileAsrReady: true,
      realtimeConfigured: true,
      realtimeProtocolReady: false,
      realtimeReady: false,
      missingIncludes: null,
    },
  },
  {
    name: "ws-url-with-protocol-flag-enables-realtime-capability",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_API_KEY: "asr-runtime-api-key",
      VOLCANO_ASR_WS_URL: "wss://example.invalid/asr",
      VOLCANO_REALTIME_ASR_RESOURCE_ID: "volc.seedasr.sauc.duration",
      OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED: "1",
    },
    expect: {
      ready: true,
      fileAsrReady: true,
      realtimeConfigured: true,
      realtimeProtocolReady: true,
      realtimeReady: true,
      missingIncludes: null,
    },
  },
  {
    name: "ws-token-only-does-not-mark-provider-ready",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_TOKEN: "asr-runtime-token",
      VOLCANO_ASR_WS_URL: "wss://example.invalid/asr",
    },
    expect: {
      ready: false,
      fileAsrReady: false,
      realtimeConfigured: true,
      realtimeProtocolReady: false,
      realtimeReady: false,
      missingIncludes: "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
    },
  },
  {
    name: "ark-only-does-not-enable-production-summary",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      ARK_API_KEY: "ark-secret-key",
      ARK_CHAT_MODEL: "ep-smoke",
    },
    expect: {
      ready: false,
      fileAsrReady: false,
      realtimeReady: false,
      summaryConfigured: true,
      summaryReady: false,
      summaryMissingIncludes: "OWNMINUTES_SUMMARY_JSON_ONLY=1",
      missingIncludes: "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
    },
  },
  {
    name: "ark-http-base-url-blocks-production-summary",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      ARK_API_KEY: "ark-secret-key",
      ARK_CHAT_MODEL: "ep-smoke",
      ARK_BASE_URL: "http://ark.invalid/api/v3",
      OWNMINUTES_SUMMARY_JSON_ONLY: "1",
      OWNMINUTES_SUMMARY_HALLUCINATION_POLICY: "transcript-only facts",
      OWNMINUTES_SUMMARY_RETRY_POLICY: "retry once on invalid JSON",
      OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY: "human review before sharing",
    },
    expect: {
      ready: false,
      fileAsrReady: false,
      realtimeReady: false,
      summaryConfigured: true,
      summaryReady: false,
      summaryMissingIncludes: "ARK_BASE_URL_OFFICIAL_HTTPS",
      missingIncludes: "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
    },
  },
  {
    name: "ark-with-summary-guardrails-enables-production-summary",
    env: {
      TRANSCRIPTION_PROVIDER: "volcano",
      ARK_API_KEY: "ark-secret-key",
      ARK_CHAT_MODEL: "ep-smoke",
      ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3",
      OWNMINUTES_SUMMARY_JSON_ONLY: "1",
      OWNMINUTES_SUMMARY_HALLUCINATION_POLICY: "transcript-only facts; missing owner/date/fact must be marked 不确定",
      OWNMINUTES_SUMMARY_RETRY_POLICY: "retry once on invalid JSON, then fall back to deterministic local summary",
      OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY: "user reviews summary before publishing share link or Obsidian export",
    },
    expect: {
      ready: false,
      fileAsrReady: false,
      realtimeReady: false,
      summaryConfigured: true,
      summaryReady: true,
      summaryMissingIncludes: null,
      missingIncludes: "VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN",
    },
  },
];

const moduleUrl = new URL("../src/lib/volcano-asr.ts", import.meta.url);
const secretFragments = [
  "asr-runtime-api-key",
  "asr-runtime-token",
  "ark-secret-key",
  "sk-account-only",
];
const results = [];
let parserResults = [];
let parserImport;

for (const testCase of cases) {
  clearRelevantEnv();
  Object.assign(process.env, testCase.env);

  const imported = await import(`${moduleUrl.href}?case=${encodeURIComponent(testCase.name)}-${Date.now()}`);
  parserImport = imported;
  const diagnostic = buildVolcanoProviderDiagnostic(imported.getVolcanoFileAsrDiagnostic());
  const serialized = JSON.stringify(diagnostic);
  const leaksSecrets = secretFragments.some((secret) => serialized.includes(secret));
  const capabilities = diagnostic.capabilities || {};
  const ok =
    diagnostic.provider === "volcano" &&
    diagnostic.ready === testCase.expect.ready &&
    Boolean(capabilities.fileAsrReady) === testCase.expect.fileAsrReady &&
    Boolean(capabilities.realtimeReady) === testCase.expect.realtimeReady &&
    (typeof testCase.expect.realtimeConfigured === "boolean" ? Boolean(capabilities.realtimeConfigured) === testCase.expect.realtimeConfigured : true) &&
    (typeof testCase.expect.realtimeProtocolReady === "boolean" ? Boolean(capabilities.realtimeProtocolReady) === testCase.expect.realtimeProtocolReady : true) &&
    (typeof testCase.expect.summaryConfigured === "boolean" ? Boolean(capabilities.summaryConfigured) === testCase.expect.summaryConfigured : true) &&
    (typeof testCase.expect.summaryReady === "boolean" ? Boolean(capabilities.summaryReady) === testCase.expect.summaryReady : true) &&
    (testCase.expect.summaryMissingIncludes ? capabilities.summaryMissing?.includes(testCase.expect.summaryMissingIncludes) : testCase.expect.summaryMissingIncludes === null ? (capabilities.summaryMissing?.length ?? 0) === 0 : true) &&
    (testCase.expect.missingIncludes ? diagnostic.missing.includes(testCase.expect.missingIncludes) : diagnostic.missing.length === 0) &&
    !leaksSecrets;

  results.push({
    name: testCase.name,
    ok,
    ready: diagnostic.ready,
    fileAsrReady: Boolean(capabilities.fileAsrReady),
    realtimeConfigured: Boolean(capabilities.realtimeConfigured),
    realtimeProtocolReady: Boolean(capabilities.realtimeProtocolReady),
    realtimeReady: Boolean(capabilities.realtimeReady),
    summaryConfigured: Boolean(capabilities.summaryConfigured),
    summaryReady: Boolean(capabilities.summaryReady),
    summaryMissing: capabilities.summaryMissing ?? [],
    missing: diagnostic.missing,
    leaksSecrets,
  });
}

if (parserImport?.normalizeVolcanoTranscript && parserImport?.inspectVolcanoTranscriptStructure) {
  parserResults = runParserCases(parserImport.normalizeVolcanoTranscript, parserImport.inspectVolcanoTranscriptStructure);
}

console.log(JSON.stringify({ ok: results.every((result) => result.ok) && parserResults.every((result) => result.ok), results, parserResults }, null, 2));

if (!results.every((result) => result.ok) || !parserResults.every((result) => result.ok)) {
  process.exitCode = 1;
}

function buildVolcanoProviderDiagnostic(fileAsr) {
  const realtimeConfigured = Boolean(
    (process.env.VOLCANO_ASR_API_KEY || process.env.VOLCANO_ASR_TOKEN) &&
      (process.env.VOLCANO_ASR_WS_URL || process.env.VOLCANO_ASR_ENDPOINT),
  );
  const realtimeProtocolReady = realtimeConfigured && process.env.OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED === "1";
  const summaryDiagnostic = getSummaryRuntimeDiagnostic();

  return {
    provider: "volcano",
    ready: fileAsr.ready || realtimeProtocolReady,
    missing: fileAsr.ready ? [] : fileAsr.missing,
    capabilities: {
      realtimeConfigured,
      realtimeProtocolReady,
      realtimeReady: realtimeProtocolReady,
      fileAsrReady: fileAsr.ready,
      summaryConfigured: summaryDiagnostic.configured,
      summaryMissing: summaryDiagnostic.missing,
      summaryProductionReady: summaryDiagnostic.productionReady,
      summaryReady: summaryDiagnostic.productionReady,
    },
  };
}

function clearRelevantEnv() {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith("VOLCANO_") ||
      key.startsWith("ARK_") ||
      key.startsWith("OWNMINUTES_REALTIME_") ||
      key.startsWith("OWNMINUTES_SUMMARY_") ||
      key === "TRANSCRIPTION_PROVIDER" ||
      key === "OPENAI_API_KEY"
    ) {
      delete process.env[key];
    }
  }
}

function getSummaryRuntimeDiagnostic() {
  const missing = [
    ...(!process.env.ARK_API_KEY ? ["ARK_API_KEY"] : []),
    ...(!process.env.ARK_CHAT_MODEL ? ["ARK_CHAT_MODEL"] : []),
    ...(!isOfficialArkBaseUrl(process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3") ? ["ARK_BASE_URL_OFFICIAL_HTTPS"] : []),
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

function isOfficialArkBaseUrl(value) {
  try {
    const url = new URL(value);
    const authority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)?.[1]?.toLowerCase() ?? "";
    return (
      url.protocol === "https:" &&
      url.hostname === "ark.cn-beijing.volces.com" &&
      authority === url.hostname &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.replace(/\/+$/, "") === "/api/v3"
    );
  } catch {
    return false;
  }
}

function runParserCases(normalizeVolcanoTranscript, inspectVolcanoTranscriptStructure) {
  const parserCases = [
    {
      name: "nested-utterances-with-zero-based-speakers",
      raw: {
        result: {
          additions: {
            utterances: [
              { start_time: 0, speaker_id: 0, text: "大家先确认产品边界。" },
              { start_time: 3200, speaker_id: 1, text: "我来负责整理待办。" },
            ],
          },
        },
      },
      expect: {
        length: 2,
        firstSpeaker: "Speaker 1",
        secondSpeaker: "Speaker 2",
        secondTimestamp: "00:03",
        textIncludes: "整理待办",
        providerSpeakerCount: 2,
        providerSpeakerInfoPresent: true,
      },
    },
    {
      name: "flash-utterances-with-additions-speakers",
      raw: {
        audio_info: { duration: 35803 },
        result: {
          additions: { duration: "35803" },
          text: "双声线会议识别结果",
          utterances: [
            { start_time: 0, additions: { speaker: "1" }, text: "第一位发言人确认录音稳定。" },
            { start_time: 6200, additions: { speaker: "2" }, text: "第二位发言人检查说话人标签。" },
            { start_time: 12000, additions: { speaker: "1" }, text: "第一位发言人继续确认上传恢复。" },
          ],
        },
      },
      expect: {
        length: 3,
        firstSpeaker: "Speaker 1",
        secondSpeaker: "Speaker 2",
        secondTimestamp: "00:06",
        textIncludes: "说话人标签",
        providerSpeakerCount: 2,
        providerSpeakerInfoPresent: true,
      },
    },
    {
      name: "utterances-without-speaker-do-not-invent-diarization",
      raw: {
        result: {
          utterances: [
            { start_time: 0, text: "没有返回说话人字段。" },
            { start_time: 3000, text: "后续发言段也必须安全降级。" },
          ],
        },
      },
      expect: {
        length: 2,
        firstSpeaker: "Speaker 1",
        secondSpeaker: "Speaker 1",
        secondTimestamp: "00:03",
        textIncludes: "安全降级",
        providerSpeakerCount: 0,
        providerSpeakerInfoPresent: false,
      },
    },
    {
      name: "word-list-segment-text",
      raw: {
        result: {
          utterance_list: [
            {
              begin_time: 65000,
              speakerId: "主持人",
              word_list: [{ word: "需要" }, { word: "下周" }, { word: "上线" }],
            },
          ],
        },
      },
      expect: {
        length: 1,
        firstSpeaker: "Speaker 主持人",
        firstTimestamp: "01:05",
        textIncludes: "需要下周上线",
        providerSpeakerCount: 1,
        providerSpeakerInfoPresent: true,
      },
    },
    {
      name: "plain-text-fallback",
      raw: {
        result: "只有一段纯文本识别结果",
      },
      expect: {
        length: 1,
        firstSpeaker: "Speaker 1",
        firstTimestamp: "00:00",
        textIncludes: "纯文本识别",
        providerSpeakerCount: 0,
        providerSpeakerInfoPresent: false,
      },
    },
  ];

  return parserCases.map((testCase) => {
    const transcript = normalizeVolcanoTranscript(testCase.raw);
    const structure = inspectVolcanoTranscriptStructure(testCase.raw);
    const first = transcript[0] || {};
    const second = transcript[1] || {};
    const ok =
      transcript.length === testCase.expect.length &&
      (!testCase.expect.firstSpeaker || first.speaker === testCase.expect.firstSpeaker) &&
      (!testCase.expect.secondSpeaker || second.speaker === testCase.expect.secondSpeaker) &&
      (!testCase.expect.firstTimestamp || first.timestamp === testCase.expect.firstTimestamp) &&
      (!testCase.expect.secondTimestamp || second.timestamp === testCase.expect.secondTimestamp) &&
      structure.providerSpeakerCount === testCase.expect.providerSpeakerCount &&
      structure.providerSpeakerInfoPresent === testCase.expect.providerSpeakerInfoPresent &&
      transcript.some((segment) => segment.text.includes(testCase.expect.textIncludes));

    return {
      name: testCase.name,
      ok,
      transcript,
      structure,
    };
  });
}
