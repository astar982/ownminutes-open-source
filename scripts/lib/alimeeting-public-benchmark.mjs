import crypto from "node:crypto";
import fs from "node:fs";

export function parseAliMeetingTextGrid(text) {
  const intervals = [];
  let speaker = null;
  let current = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const tier = line.match(/^name\s*=\s*"(.*)"$/);
    if (tier) {
      speaker = decodePraatString(tier[1]);
      current = null;
      continue;
    }
    if (/^intervals\s*\[\d+\]:$/.test(line)) {
      current = { speaker, startSeconds: null, endSeconds: null, text: "" };
      continue;
    }
    if (!current) continue;

    const start = line.match(/^xmin\s*=\s*([\d.]+)$/);
    if (start) {
      current.startSeconds = Number(start[1]);
      continue;
    }
    const end = line.match(/^xmax\s*=\s*([\d.]+)$/);
    if (end) {
      current.endSeconds = Number(end[1]);
      continue;
    }
    const content = line.match(/^text\s*=\s*"(.*)"$/);
    if (!content) continue;
    current.text = decodePraatString(content[1]);
    if (
      current.speaker &&
      Number.isFinite(current.startSeconds) &&
      Number.isFinite(current.endSeconds) &&
      current.endSeconds > current.startSeconds &&
      current.text.trim()
    ) {
      intervals.push(current);
    }
    current = null;
  }

  return intervals;
}

export function clipReferenceIntervals(intervals, startSeconds, durationSeconds) {
  const windowEnd = startSeconds + durationSeconds;
  return intervals
    .filter((interval) => interval.endSeconds > startSeconds && interval.startSeconds < windowEnd)
    .map((interval) => ({
      speaker: interval.speaker,
      startMs: Math.max(0, interval.startSeconds - startSeconds) * 1000,
      endMs: Math.min(durationSeconds, interval.endSeconds - startSeconds) * 1000,
      text: interval.text,
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.speaker.localeCompare(right.speaker));
}

export function extractVolcanoBenchmarkTranscript(raw) {
  const root = asRecord(raw);
  const result = asRecord(root.result);
  const rows = findArray(root, ["utterances", "utterance", "segments", "sentences", "utterance_list"]);
  const utterances = rows.map((row, index) => {
    const item = asRecord(row);
    const startMs = readTimeMs(item, ["start_time", "startTime", "start_ms", "startMs", "begin_time", "beginTime", "begin_ms"]);
    const explicitEndMs = readTimeMs(item, ["end_time", "endTime", "end_ms", "endMs", "finish_time", "finishTime"]);
    return {
      index,
      speaker: readSpeaker(item),
      startMs,
      endMs: explicitEndMs,
      text: readText(item),
    };
  });

  for (let index = 0; index < utterances.length; index += 1) {
    const utterance = utterances[index];
    if (utterance.endMs > utterance.startMs) continue;
    const nextStart = utterances[index + 1]?.startMs;
    utterance.endMs = Number.isFinite(nextStart) && nextStart > utterance.startMs ? nextStart : utterance.startMs + 1;
  }

  const speakerIds = [...new Set(utterances.map((utterance) => utterance.speaker).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  const transcriptText = readText(result) || utterances.map((utterance) => utterance.text).join("");

  return {
    utterances,
    transcriptText,
    speakerIds,
    speakerInfoPresent: speakerIds.length > 0,
  };
}

export function calculateCharacterErrorRate(referenceText, hypothesisText) {
  const reference = [...normalizeForCer(referenceText)];
  const hypothesis = [...normalizeForCer(hypothesisText)];
  const editDistance = levenshteinDistance(reference, hypothesis);
  return {
    referenceCharacterCount: reference.length,
    hypothesisCharacterCount: hypothesis.length,
    editDistance,
    cerPct: reference.length === 0 ? null : round3((editDistance / reference.length) * 100),
  };
}

export function calculateSpeakerMetrics(referenceIntervals, providerUtterances) {
  const referenceSpeakers = [...new Set(referenceIntervals.map((interval) => interval.speaker))].sort();
  const providerSpeakers = [...new Set(providerUtterances.map((utterance) => utterance.speaker).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  const matrix = providerSpeakers.map(() => referenceSpeakers.map(() => 0));

  for (const utterance of providerUtterances) {
    const providerIndex = providerSpeakers.indexOf(utterance.speaker);
    if (providerIndex < 0) continue;
    for (const interval of referenceIntervals) {
      const referenceIndex = referenceSpeakers.indexOf(interval.speaker);
      matrix[providerIndex][referenceIndex] += overlapMs(utterance, interval);
    }
  }

  const assignment = bestSpeakerAssignment(matrix, providerSpeakers, referenceSpeakers);
  const mappedSpeakerByProvider = new Map(assignment.mapping.map((entry) => [entry.providerSpeaker, entry.referenceSpeaker]));
  const totalReferenceSpeechMs = referenceIntervals.reduce((sum, interval) => sum + (interval.endMs - interval.startMs), 0);
  const totalProviderReferenceOverlapMs = matrix.flat().reduce((sum, duration) => sum + duration, 0);
  const allTurns = calculateTurnAttribution(referenceIntervals, providerUtterances, mappedSpeakerByProvider);
  const majorIntervals = referenceIntervals.filter(isMajorReferenceTurn);
  const majorTurns = calculateTurnAttribution(majorIntervals, providerUtterances, mappedSpeakerByProvider);

  return {
    referenceSpeakerCount: referenceSpeakers.length,
    providerSpeakerCount: providerSpeakers.length,
    speakerCountExactMatch: referenceSpeakers.length === providerSpeakers.length,
    speakerCountDelta: providerSpeakers.length - referenceSpeakers.length,
    speakerCountRecallPct: referenceSpeakers.length === 0 ? null : round3((providerSpeakers.length / referenceSpeakers.length) * 100),
    referenceTurnCount: referenceIntervals.length,
    observedReferenceTurnCount: allTurns.observed,
    correctlyAttributedReferenceTurnCount: allTurns.correct,
    referenceTurnAttributionPct:
      referenceIntervals.length === 0 ? null : round3((allTurns.correct / referenceIntervals.length) * 100),
    observedTurnAttributionPct:
      allTurns.observed === 0 ? null : round3((allTurns.correct / allTurns.observed) * 100),
    majorReferenceTurnCount: majorIntervals.length,
    observedMajorReferenceTurnCount: majorTurns.observed,
    correctlyAttributedMajorReferenceTurnCount: majorTurns.correct,
    majorReferenceTurnAttributionPct:
      majorIntervals.length === 0 ? null : round3((majorTurns.correct / majorIntervals.length) * 100),
    observedMajorTurnAttributionPct:
      majorTurns.observed === 0 ? null : round3((majorTurns.correct / majorTurns.observed) * 100),
    referenceSpeechMs: round3(totalReferenceSpeechMs),
    providerReferenceOverlapMs: round3(totalProviderReferenceOverlapMs),
    correctlyAttributedOverlapMs: round3(assignment.score),
    referenceSpeechCoveragePct:
      totalReferenceSpeechMs === 0 ? null : round3((totalProviderReferenceOverlapMs / totalReferenceSpeechMs) * 100),
    speakerAttributedReferenceCoveragePct:
      totalReferenceSpeechMs === 0 ? null : round3((assignment.score / totalReferenceSpeechMs) * 100),
    speakerClusterPurityPct:
      totalProviderReferenceOverlapMs === 0 ? null : round3((assignment.score / totalProviderReferenceOverlapMs) * 100),
    speakerMapping: assignment.mapping,
  };
}

export function evaluateBenchmarkSample(metrics, targets) {
  const checks = {
    cerWithinTarget: metrics.cerPct !== null && metrics.cerPct <= targets.maxCerPct,
    majorReferenceTurnsWithinTarget:
      metrics.majorReferenceTurnAttributionPct !== null &&
      metrics.majorReferenceTurnAttributionPct >= targets.minMajorReferenceTurnAttributionPct,
    speakerCountWithinTarget: targets.requireExactSpeakerCount !== true || metrics.speakerCountExactMatch === true,
    providerSpeakerInfoPresent: metrics.providerSpeakerInfoPresent === true,
  };
  return { meetsBenchmarkTargets: Object.values(checks).every(Boolean), checks };
}

function calculateTurnAttribution(referenceIntervals, providerUtterances, mappedSpeakerByProvider) {
  let observed = 0;
  let correct = 0;
  for (const interval of referenceIntervals) {
    let bestProviderSpeaker = null;
    let bestOverlap = 0;
    for (const utterance of providerUtterances) {
      if (!utterance.speaker) continue;
      const overlap = overlapMs(utterance, interval);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestProviderSpeaker = utterance.speaker;
      }
    }
    if (bestOverlap <= 0) continue;
    observed += 1;
    if (mappedSpeakerByProvider.get(bestProviderSpeaker) === interval.speaker) correct += 1;
  }
  return { observed, correct };
}

function isMajorReferenceTurn(interval) {
  const durationMs = interval.endMs - interval.startMs;
  const characterCount = [...normalizeForCer(interval.text)].length;
  return durationMs >= 1500 || characterCount >= 6;
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function bestSpeakerAssignment(matrix, providerSpeakers, referenceSpeakers) {
  let best = { score: 0, indices: [] };

  function visit(providerIndex, usedReferences, score, indices) {
    if (providerIndex >= providerSpeakers.length) {
      if (score > best.score) best = { score, indices: [...indices] };
      return;
    }
    visit(providerIndex + 1, usedReferences, score, [...indices, -1]);
    for (let referenceIndex = 0; referenceIndex < referenceSpeakers.length; referenceIndex += 1) {
      if (usedReferences.has(referenceIndex)) continue;
      usedReferences.add(referenceIndex);
      visit(providerIndex + 1, usedReferences, score + matrix[providerIndex][referenceIndex], [...indices, referenceIndex]);
      usedReferences.delete(referenceIndex);
    }
  }

  visit(0, new Set(), 0, []);
  return {
    score: best.score,
    mapping: providerSpeakers.map((providerSpeaker, index) => ({
      providerSpeaker,
      referenceSpeaker: best.indices[index] >= 0 ? referenceSpeakers[best.indices[index]] : null,
    })),
  };
}

function overlapMs(left, right) {
  return Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
}

function normalizeForCer(value) {
  return String(value).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]/gu)?.join("") ?? "";
}

function levenshteinDistance(left, right) {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function decodePraatString(value) {
  return value.replace(/""/g, '"');
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function findArray(input, keys) {
  for (const key of keys) if (Array.isArray(input[key])) return input[key];
  for (const value of Object.values(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = findArray(value, keys);
    if (nested.length > 0) return nested;
  }
  return [];
}

function readSpeaker(row) {
  const additions = asRecord(row.additions);
  const value =
    row.speaker ??
    row.spk ??
    row.spk_id ??
    row.speaker_id ??
    row.speakerId ??
    row.speakerID ??
    additions.speaker ??
    additions.speaker_id ??
    additions.spk_id ??
    additions.channel_id;
  return value === undefined || value === null || value === "" ? null : String(value).trim();
}

function readText(row) {
  const value = row.text ?? row.transcript ?? row.sentence ?? row.content ?? row.utterance;
  return typeof value === "string" ? value.trim() : "";
}

function readTimeMs(row, keys) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
