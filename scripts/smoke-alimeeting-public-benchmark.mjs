#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  calculateCharacterErrorRate,
  calculateSpeakerMetrics,
  clipReferenceIntervals,
  evaluateBenchmarkSample,
  extractVolcanoBenchmarkTranscript,
  parseAliMeetingTextGrid,
} from "./lib/alimeeting-public-benchmark.mjs";

const textGrid = `File type = "ooTextFile"
Object class = "TextGrid"
item []:
  item [1]:
    class = "IntervalTier"
    name = "SPK_A"
    intervals [1]:
      xmin = 10
      xmax = 12
      text = "你好，开始。"
    intervals [2]:
      xmin = 14
      xmax = 16
      text = "确认方案。"
  item [2]:
    class = "IntervalTier"
    name = "SPK_B"
    intervals [1]:
      xmin = 12
      xmax = 14
      text = "收到。"
`;

const parsed = parseAliMeetingTextGrid(textGrid);
const clipped = clipReferenceIntervals(parsed, 10, 6);
const provider = extractVolcanoBenchmarkTranscript({
  result: {
    text: "你好开始收到确认方案",
    utterances: [
      { start_time: 0, end_time: 2000, additions: { speaker: "1" }, text: "你好开始" },
      { start_time: 2000, end_time: 4000, additions: { speaker: "2" }, text: "收到" },
      { start_time: 4000, end_time: 6000, additions: { speaker: "1" }, text: "确认方案" },
    ],
  },
});
const cer = calculateCharacterErrorRate(clipped.map((interval) => interval.text).join(""), provider.transcriptText);
const speaker = calculateSpeakerMetrics(clipped, provider.utterances);
const assessment = evaluateBenchmarkSample(
  { ...cer, ...speaker, providerSpeakerInfoPresent: provider.speakerInfoPresent },
  { maxCerPct: 30, minMajorReferenceTurnAttributionPct: 80, requireExactSpeakerCount: true },
);
const missingSpeaker = extractVolcanoBenchmarkTranscript({
  result: { utterances: [{ start_time: 0, end_time: 1000, text: "no speaker field" }] },
});
const manifest = JSON.parse(readFileSync("scripts/fixtures/alimeeting-public-benchmark.json", "utf8"));
const runnerSource = readFileSync("scripts/run-alimeeting-public-benchmark.mjs", "utf8");
const prepareSource = readFileSync("scripts/prepare-alimeeting-public-benchmark.mjs", "utf8");

const checks = {
  parsesAllReferenceIntervals: parsed.length === 3 && new Set(parsed.map((interval) => interval.speaker)).size === 2,
  clipsWindowToRelativeTime: clipped.length === 3 && clipped[0].startMs === 0 && clipped[2].endMs === 6000,
  normalizesPunctuationForCer: cer.cerPct === 0 && cer.referenceCharacterCount === 10,
  mapsAnonymousSpeakersByTime: speaker.referenceTurnAttributionPct === 100 && speaker.speakerClusterPurityPct === 100,
  scoresMajorTurnsSeparately: speaker.majorReferenceTurnCount === 3 && speaker.majorReferenceTurnAttributionPct === 100,
  requiresExactSpeakerCount: speaker.speakerCountExactMatch && speaker.speakerCountDelta === 0,
  detectsProviderSpeakerInfo: provider.speakerInfoPresent && provider.speakerIds.length === 2,
  doesNotInventMissingSpeakerInfo: !missingSpeaker.speakerInfoPresent && missingSpeaker.speakerIds.length === 0,
  evaluatesFixedQualityTargets: assessment.meetsBenchmarkTargets,
  pinsOfficialSourceAndLicense:
    manifest.source.homepage === "https://www.openslr.org/119/" &&
    manifest.source.license === "CC BY-SA 4.0" &&
    /^[a-f0-9]{64}$/.test(manifest.archive.sha256),
  usesThreeProfiledFarFieldSamples:
    manifest.samples.length === 3 &&
    manifest.samples.every((sample) => sample.durationSeconds === 120) &&
    manifest.samples.map((sample) => sample.profile).join(",") === "normal,moderate,stress",
  excludesPublicBenchmarkFromReleaseGate:
    runnerSource.includes("releaseGateQualified: false") &&
    runnerSource.includes('sourceKind: "public_benchmark"') &&
    !runnerSource.includes('sourceKind: "real_meeting"'),
  excludesRawTranscriptFromReport: runnerSource.includes("rawTranscriptIncluded: false"),
  validatesArchiveBeforeExtraction:
    prepareSource.indexOf("archiveSha256 !== manifest.archive.sha256") < prepareSource.indexOf('["-xzf", archivePath'),
};

console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks, metrics: { cerPct: cer.cerPct, ...speaker } }, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
