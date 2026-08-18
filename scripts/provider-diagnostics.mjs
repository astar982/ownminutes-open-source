import { existsSync, readFileSync } from "node:fs";

loadDotEnvLocal();

const provider = (process.env.TRANSCRIPTION_PROVIDER || "mock").trim().toLowerCase();

const diagnostics = {
  provider: ["mock", "openai", "volcano"].includes(provider) ? provider : "mock",
  ready: true,
  missing: [],
  present: {},
  notes: [],
};

if (diagnostics.provider === "openai") {
  diagnostics.present.OPENAI_API_KEY = Boolean(process.env.OPENAI_API_KEY);
  diagnostics.missing = diagnostics.present.OPENAI_API_KEY ? [] : ["OPENAI_API_KEY"];
  diagnostics.ready = diagnostics.missing.length === 0;
  diagnostics.notes.push("OpenAI adapter is not wired for live realtime transcription yet.");
}

if (diagnostics.provider === "volcano") {
  const fileAsrReady = Boolean(
    process.env.VOLCANO_ASR_API_KEY ||
      ((process.env.VOLCANO_ASR_APP_ID || process.env.VOLCANO_APP_ID) &&
        (process.env.VOLCANO_ASR_TOKEN || process.env.VOLCANO_ASR_ACCESS_KEY)),
  );
  const realtimeConfigured = Boolean(
    (process.env.VOLCANO_ASR_API_KEY || process.env.VOLCANO_ASR_TOKEN) &&
      (process.env.VOLCANO_ASR_WS_URL || process.env.VOLCANO_ASR_ENDPOINT),
  );
  const realtimeProtocolReady = true;
  const summaryDiagnostic = getSummaryRuntimeDiagnostic();
  diagnostics.present = {
    VOLCANO_ACCESS_KEY_ID: Boolean(process.env.VOLCANO_ACCESS_KEY_ID),
    VOLCANO_SECRET_ACCESS_KEY: Boolean(process.env.VOLCANO_SECRET_ACCESS_KEY),
    VOLCANO_ASR_API_KEY: Boolean(process.env.VOLCANO_ASR_API_KEY),
    VOLCANO_ASR_APP_ID: Boolean(process.env.VOLCANO_ASR_APP_ID || process.env.VOLCANO_APP_ID),
    VOLCANO_ASR_TOKEN: Boolean(process.env.VOLCANO_ASR_TOKEN),
    VOLCANO_ASR_MODE_FLASH: (process.env.VOLCANO_ASR_MODE || "flash") === "flash",
    VOLCANO_ASR_RECOGNIZE_URL: Boolean(process.env.VOLCANO_ASR_RECOGNIZE_URL),
    VOLCANO_ASR_CLUSTER: Boolean(process.env.VOLCANO_ASR_CLUSTER),
    VOLCANO_ASR_WS_URL: Boolean(process.env.VOLCANO_ASR_WS_URL || process.env.VOLCANO_ASR_ENDPOINT),
    VOLCANO_ASR_SUBMIT_URL: Boolean(process.env.VOLCANO_ASR_SUBMIT_URL),
    VOLCANO_ASR_QUERY_URL: Boolean(process.env.VOLCANO_ASR_QUERY_URL),
    ARK_API_KEY: Boolean(process.env.ARK_API_KEY),
    ARK_CHAT_MODEL: Boolean(process.env.ARK_CHAT_MODEL),
    ARK_BASE_URL_OFFICIAL_HTTPS: isOfficialArkBaseUrl(process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"),
    OWNMINUTES_SUMMARY_JSON_ONLY: process.env.OWNMINUTES_SUMMARY_JSON_ONLY === "1",
    OWNMINUTES_SUMMARY_HALLUCINATION_POLICY: Boolean(process.env.OWNMINUTES_SUMMARY_HALLUCINATION_POLICY),
    OWNMINUTES_SUMMARY_RETRY_POLICY: Boolean(process.env.OWNMINUTES_SUMMARY_RETRY_POLICY),
    OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY: Boolean(process.env.OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY),
  };
  diagnostics.capabilities = {
    realtimeConfigured,
    realtimeProtocolReady,
    realtimeReady: realtimeConfigured && realtimeProtocolReady,
    fileAsrReady,
    summaryConfigured: summaryDiagnostic.configured,
    summaryMissing: summaryDiagnostic.missing,
    summaryProductionReady: summaryDiagnostic.productionReady,
    summaryReady: summaryDiagnostic.productionReady,
  };
  diagnostics.missing = fileAsrReady ? [] : ["VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN"];
  diagnostics.ready = fileAsrReady || (realtimeConfigured && realtimeProtocolReady);
  diagnostics.notes.push("AK/SK are account-level credentials; speech runtime calls need VOLCANO_ASR_API_KEY or AppID+Token.");
  diagnostics.notes.push("Realtime WebSocket protocol is implemented, but realtimeReady still requires runtime credentials, endpoint configuration, and acceptance evidence.");
  diagnostics.notes.push("Ark summary production readiness additionally needs HTTPS base URL, JSON-only output, hallucination handling, retry, and human review policies.");
}

if (diagnostics.provider === "mock") {
  diagnostics.notes.push("Mock provider is active. No external service will be called.");
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

console.log(JSON.stringify(diagnostics, null, 2));

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return;

  const contents = readFileSync(".env.local", "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;

    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    process.env[key] = value;
  }
}
