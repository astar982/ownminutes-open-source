#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
loadDotEnvLocal();
const processingPath = path.join(repoRoot, "src", "lib", "meeting-processing.ts");
const normalizerPath = path.join(repoRoot, "src", "lib", "meeting-summary-normalizer.ts");
const transcriptQualityPath = path.join(repoRoot, "src", "lib", "transcript-quality.ts");
const asrRunbookPath = path.join(repoRoot, "docs", "asr-runtime-runbook.md");
const strict = process.argv.includes("--strict") || process.env.OWNMINUTES_SUMMARY_PREFLIGHT_STRICT === "1";

const requiredEnv = [
  "ARK_API_KEY",
  "ARK_CHAT_MODEL",
  "ARK_BASE_URL or default Ark base URL",
  "OWNMINUTES_SUMMARY_JSON_ONLY=1",
  "OWNMINUTES_SUMMARY_HALLUCINATION_POLICY",
  "OWNMINUTES_SUMMARY_RETRY_POLICY",
  "OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY",
];

function main() {
  const processingSource = readFile(processingPath);
  const normalizerSource = readFile(normalizerPath);
  const transcriptQualitySource = readFile(transcriptQualityPath);
  const checks = [
    check(
      "ark-api-key",
      Boolean(process.env.ARK_API_KEY),
      "ARK_API_KEY is configured.",
      "Missing ARK_API_KEY.",
    ),
    check(
      "ark-model",
      Boolean(process.env.ARK_CHAT_MODEL),
      "ARK_CHAT_MODEL is configured.",
      "Missing ARK_CHAT_MODEL.",
    ),
    check(
      "ark-base-url",
      isOfficialArkBaseUrl(process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3"),
      "Ark Base URL is the official credential-free HTTPS endpoint.",
      "ARK_BASE_URL must be the official credential-free Ark HTTPS API path or omitted to use the default.",
    ),
    check(
      "json-only-policy",
      process.env.OWNMINUTES_SUMMARY_JSON_ONLY === "1",
      "JSON-only summary output policy is declared.",
      "Missing OWNMINUTES_SUMMARY_JSON_ONLY=1.",
    ),
    check(
      "hallucination-policy",
      Boolean(process.env.OWNMINUTES_SUMMARY_HALLUCINATION_POLICY),
      "Hallucination handling policy is declared.",
      "Missing OWNMINUTES_SUMMARY_HALLUCINATION_POLICY.",
    ),
    check(
      "retry-policy",
      Boolean(process.env.OWNMINUTES_SUMMARY_RETRY_POLICY),
      "Summary retry policy is declared.",
      "Missing OWNMINUTES_SUMMARY_RETRY_POLICY.",
    ),
    check(
      "human-review-policy",
      Boolean(process.env.OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY),
      "Human review policy is declared.",
      "Missing OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY.",
    ),
    check(
      "prompt-requires-json",
      processingSource.includes("只基于逐字稿输出纯 JSON") &&
        processingSource.includes("不要 Markdown") &&
        processingSource.includes("不编造没有依据的信息") &&
        processingSource.includes("不确定"),
      "Summary prompt requires JSON, transcript-only facts, and uncertainty labels.",
      "Summary prompt is missing JSON-only, transcript-only, or uncertainty instructions.",
    ),
    check(
      "transcript-quality-gate",
      processingSource.includes("Transcript quality is not usable enough for model summarization") &&
        processingSource.includes("diagnoseTranscriptQuality") &&
        transcriptQualitySource.includes("low_confidence") &&
        transcriptQualitySource.includes("placeholder"),
      "Transcript quality gate prevents low-quality transcript summarization.",
      "Transcript quality gate is missing or incomplete.",
    ),
    check(
      "normalizer-runtime",
      normalizerSource.includes("normalizeMeetingSummary") &&
        normalizerSource.includes("speaker_views") &&
        normalizerSource.includes("action_items") &&
        normalizerSource.includes("不确定"),
      "Summary normalizer supports schema drift and uncertainty defaults.",
      "Summary normalizer is missing schema compatibility or uncertainty defaults.",
    ),
    check(
      "local-fallback",
      processingSource.includes("buildLocalSummary") &&
        processingSource.includes("inferDecisions") &&
        processingSource.includes("inferActionItems") &&
        processingSource.includes("当前为本地保守纪要"),
      "Deterministic local fallback summary is present.",
      "Local fallback summary is missing.",
    ),
    check(
      "ark-retry-timeout",
      processingSource.includes("generateArkSummaryContent") &&
        processingSource.includes("OWNMINUTES_SUMMARY_MAX_ATTEMPTS") &&
        processingSource.includes("OWNMINUTES_SUMMARY_TIMEOUT_MS") &&
        processingSource.includes("isRetryableArkSummaryError") &&
        processingSource.includes("Ark summary attempt") &&
        processingSource.includes("AbortError"),
      "Ark summary call has bounded retry and timeout handling.",
      "Ark summary retry or timeout handling is missing.",
    ),
    check(
      "ark-cost-controls",
      processingSource.includes('thinking: {') &&
        processingSource.includes('type: "disabled"') &&
        processingSource.includes("max_tokens: getArkSummaryMaxTokens()") &&
        processingSource.includes("OWNMINUTES_SUMMARY_MAX_TOKENS") &&
        processingSource.includes("parseArkSummaryUsage") &&
        processingSource.includes("Ark summary token usage:"),
      "Ark summary disables thinking, caps output tokens, and records non-sensitive usage diagnostics.",
      "Ark summary thinking, output-token cap, or usage diagnostics are missing.",
    ),
    check("runbook", fs.existsSync(asrRunbookPath), "ASR runtime runbook exists.", "Missing docs/asr-runtime-runbook.md."),
  ];
  const missing = checks.filter((item) => item.status === "fail").map((item) => item.id);
  const summary = {
    ok: missing.length === 0,
    strict,
    provider: process.env.ARK_API_KEY && process.env.ARK_CHAT_MODEL ? "volcano-ark" : "none",
    productionCandidate: missing.length === 0,
    requiredEnv,
    configured: {
      arkApiKey: Boolean(process.env.ARK_API_KEY),
      arkModel: Boolean(process.env.ARK_CHAT_MODEL),
      arkBaseUrl: Boolean(process.env.ARK_BASE_URL),
      jsonOnlyPolicy: process.env.OWNMINUTES_SUMMARY_JSON_ONLY === "1",
      hallucinationPolicy: Boolean(process.env.OWNMINUTES_SUMMARY_HALLUCINATION_POLICY),
      retryPolicy: Boolean(process.env.OWNMINUTES_SUMMARY_RETRY_POLICY),
      humanReviewPolicy: Boolean(process.env.OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY),
    },
    missing,
    checks,
    nextAction:
      missing.length === 0
        ? "Run real Ark summary generation against a 1-3 minute Mandarin transcript and manually compare summary, decisions, action items, risks, and Markdown against the transcript."
        : "Set the missing summary production environment and rerun npm run summary:preflight.",
    leaksSecrets: leaksSecrets(JSON.stringify({ checks, missing, requiredEnv })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (summary.leaksSecrets || (strict && !summary.ok)) {
    process.exitCode = 1;
  }
}

function check(id, passed, passDetail, failDetail) {
  return {
    id,
    status: passed ? "pass" : "fail",
    detail: passed ? passDetail : failDetail,
  };
}

function readFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
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

function loadDotEnvLocal() {
  if (process.env.OWNMINUTES_SKIP_LOCAL_ENV === "1") return;
  const envPath = path.join(repoRoot, ".env.local");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("WVRCaE") ||
    text.includes("ark-live-key") ||
    text.includes("ARK_API_KEY=")
  );
}

main();
