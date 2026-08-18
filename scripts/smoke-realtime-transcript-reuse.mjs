#!/usr/bin/env node

import assert from "node:assert/strict";

const { selectReusableRealtimeTranscript } = await import("../src/lib/realtime-transcript-reuse.ts");

const segment = (id, text) => ({ id, speaker: "Speaker 1", timestamp: "00:01", text });
const baseSession = {
  adapter: "volcano-realtime-adapter",
  formatMismatchCount: 0,
  lastProviderStatus: "completed",
  outOfOrderCount: 0,
  provider: "volcano",
  statusCounts: { provider_error: 0 },
  totalDurationMs: 60_000,
  transcriptSegments: [segment("a", "我们确认了发布计划、负责人、时间节点以及下周需要完成的验收事项。")],
};

const reusable = selectReusableRealtimeTranscript({ audioDurationMs: 60_000, session: baseSession });
assert.equal(reusable.reusable, true);
assert.equal(reusable.transcript.length, 1);

const incomplete = selectReusableRealtimeTranscript({
  audioDurationMs: 60_000,
  session: { ...baseSession, totalDurationMs: 30_000 },
});
assert.equal(incomplete.reusable, false);
assert.match(incomplete.reason, /below 90 percent/);

const providerFailed = selectReusableRealtimeTranscript({
  audioDurationMs: 60_000,
  session: { ...baseSession, statusCounts: { provider_error: 1 } },
});
assert.equal(providerFailed.reusable, false);

const sparse = selectReusableRealtimeTranscript({
  audioDurationMs: 10 * 60_000,
  session: { ...baseSession, totalDurationMs: 10 * 60_000, transcriptSegments: [segment("short", "好的。")] },
});
assert.equal(sparse.reusable, false);
assert.match(sparse.reason, /quality|sparse/);

console.log(JSON.stringify({
  ok: true,
  completeRealtimeSkipsDuplicateFileAsr: reusable.reusable,
  incompleteRealtimeFallsBackSafely: !incomplete.reusable,
  providerErrorsBlockReuse: !providerFailed.reusable,
  sparseTranscriptBlocksReuse: !sparse.reusable,
}, null, 2));
