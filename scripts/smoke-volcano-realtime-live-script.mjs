#!/usr/bin/env node

import { readFileSync } from "node:fs";

const source = readFileSync("scripts/run-volcano-realtime-live-acceptance.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const nextConfig = readFileSync("next.config.ts", "utf8");

const checks = {
  exposesLiveCommand: packageJson.scripts?.["volcano:realtime-live"] === "node scripts/run-volcano-realtime-live-acceptance.mjs",
  requiresExplicitSample: source.includes("OWNMINUTES_REALTIME_SAMPLE_PATH") && source.includes("5-180 seconds"),
  normalizesPcm: source.includes('"-f", "s16le"') && source.includes('"-ar", "16000"'),
  sendsThreeSecondChunks: source.includes("const chunkBytes = 96_000") && source.includes('formData.append("durationMs", "3000")'),
  upsertsCumulativeDrafts: source.includes("const segments = new Map()") && source.includes("segments.set(payload.transcriptSegment.id"),
  rejectsProviderFailure: source.includes('statuses.includes("provider_error")') && source.includes('statuses.includes("rejected_format")'),
  verifiesExpectedPhrase: source.includes("OWNMINUTES_REALTIME_EXPECTED_PHRASE") && source.includes("expectedPhraseMatched"),
  verifiesDraftUpsertCount: source.includes("OWNMINUTES_REALTIME_EXPECTED_SEGMENT_COUNT") && source.includes("expectedSegmentCount"),
  deletesTemporaryAccount: source.includes("deleteTemporaryAccount") && source.includes('method: "DELETE"'),
  keepsTranscriptPrivate: source.includes("transcriptStoredInEvidence: false") && !source.includes("transcript: transcript"),
  writesIgnoredEvidence: source.includes(".data/acceptance/realtime-asr-live-latest.json"),
  externalizesNodeWebSocket: nextConfig.includes('serverExternalPackages: ["ws"]'),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
