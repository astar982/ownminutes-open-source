#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/asr-acceptance-pass.md";
const failPath = ".data/smoke/asr-acceptance-fail.md";
const draftPath = ".data/smoke/asr-acceptance-draft.md";
const meetingBatchPath = ".data/smoke/asr-meeting-batch/pass.json";

const batchSmoke = spawnSync("node", ["scripts/smoke-asr-meeting-batch-evidence.mjs"], { encoding: "utf8" });

const passEvidence = `# ASR Acceptance Evidence

## Decision

- Date: 2026-07-05
- Tester: QA Smoke
- Environment: staging
- App URL: https://app.example.invalid
- API URL: https://api.example.invalid
- Decision: pass
- Reason: Real ASR and speaker acceptance evidence fixture.

## Provider

- ASR provider: Volcano
- Credential type: ASR API Key
- Summary provider: Ark
- Runtime source: account BYOK
- Provider health: file_asr ready
- Release readiness before test: blocked
- Release readiness after test: ready

## Small Audio Test

- Test path: Web Settings
- Mode: transcribe
- Result status: transcribed
- Verification level: transcript
- Provider request id: request-redacted
- Sample type: generated wav
- Sample duration: 12 seconds
- Sample language: Mandarin
- Transcript preview: redacted readable Mandarin phrase
- Expected phrase: 今天确认会议记录验收
- Expected phrase readable: yes
- Secrets leaked: no
- Decision: pass

## Meeting Test

- Meeting ID: meeting-asr-smoke
- Duration: 3 minutes
- Scenario: two speakers alternating
- Formal transcript fallback-only: no
- Realtime draft clearly labeled: yes
- Realtime draft not published as formal transcript: yes
- Post-meeting transcript reprocessed from full audio: yes
- Post-meeting transcript quality better than realtime draft: yes
- Final summary uses post-meeting transcript: yes
- Transcript quality: usable
- Speaker diarization: pass
- Speaker labels distinguish major turns: yes
- Speaker rename workflow verified: yes
- Speaker segment assignment correction verified: yes
- Action item speaker assignment: pass
- Summary quality: pass
- Decisions grounded in transcript: yes
- Action items grounded in transcript: yes
- Share link: pass
- Obsidian Markdown: pass
- Secrets leaked: no
- Decision: pass

## Speaker Diarization

- Multi-speaker sample used: yes
- Speaker labels present in formal transcript: yes
- Speaker label review completed: yes
- Speaker rename/edit workflow available: yes
- Incorrect transcript segment reassignment verified: yes
- Renamed speakers reflected in summary/share/Markdown: yes
- Renamed speakers reflected in action item owners: yes
- Known limitation notice shown to user: yes
- Owner assignment fallback when speaker is uncertain: pass
- Decision: pass

## Quality Sampling

| Scenario | Duration | Transcript quality | Summary quality | Action item quality | Decision |
|---|---:|---|---|---|---|
| Mandarin near-field single speaker | 1 minute | usable | pass | pass | pass |
| Mandarin two speakers alternating | 3 minutes | usable | pass | pass | pass |
| Meeting-room far-field speech | 3 minutes | usable | pass | pass | pass |
| Mild noise | 2 minutes | usable | pass | pass | pass |
| Accented speaker | 2 minutes | usable | pass | pass | pass |

Speaker diarization sampling:

| Scenario | Speaker labels distinguishable | Rename workflow | Owner assignment | Limitation notice | Decision |
|---|---|---|---|---|---|
| Mandarin two speakers alternating | yes | yes | pass | yes | pass |
| Meeting-room multi-speaker discussion | yes | yes | pass | yes | pass |
| Overlapping speech / interruption | yes | yes | pass | yes | pass |

Realtime vs post-meeting boundary:

| Scenario | Realtime result | Final result | Final reprocessed full audio | Realtime not published as formal | Decision |
|---|---|---|---|---|---|
| Mandarin two speakers alternating | draft | formal | yes | yes | pass |
| Meeting-room multi-speaker discussion | draft | formal | yes | yes | pass |

## Structured Meeting Batch

- Evidence path: .data/smoke/asr-meeting-batch/pass.json
- Real 2-4 person samples: 3
- Total qualifying duration: 300 seconds
- Required scenario coverage: pass
- Audio hashes verified: pass
- Consent and privacy review: pass
- Manual quality review: pass
- Decision: pass
`;

const failEvidence = `# ASR Acceptance Evidence

## Decision

- Date: 2026-07-05
- Tester: QA Smoke
- Environment: staging
- App URL: https://app.example.invalid
- API URL: https://api.example.invalid
- Decision: fail
- Reason: Missing real transcript quality and speaker sampling.
`;

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, passEvidence);
writeFileSync(failPath, failEvidence);

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const draft = runDraft(draftPath);
const draftCheck = runChecker(draftPath);
const runbookScan = runForbiddenSourceScan();

const summary = {
  meetingBatchFixtureReady: batchSmoke.status === 0 && existsSync(meetingBatchPath),
  passFixtureAccepted: pass.status === 0 && pass.payload?.evidenceReady === true,
  failFixtureRejected: fail.status !== 0 && fail.payload?.evidenceReady === false,
  passDecisionCount: pass.payload?.passDecisionCount,
  passHasRealtimeBoundaryRows: pass.payload?.hasRealtimeBoundaryRows === true,
  failMissingFieldCount: fail.payload?.missingFields?.length,
  draftGenerated:
    draft.status === 0 &&
    draft.payload?.draftWritten === true &&
    draft.payload?.draftDecision === "pending" &&
    readDraft(draftPath).includes("This file is an automated draft from `npm run asr:acceptance:evidence:draft`.") &&
    readDraft(draftPath).includes("ASR provider: pending") &&
    readDraft(draftPath).includes("Realtime vs post-meeting boundary") &&
    readDraft(draftPath).includes("Decision: pending"),
  draftRejectedUntilManualChecks:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.missingFields?.includes("Result status: transcribed") &&
    draftCheck.payload?.hasRealtimeBoundaryRows === false &&
    draftCheck.payload?.passDecisionCount === 0,
  noForbiddenRunbookPhrases: runbookScan.ok,
  forbiddenRunbookHits: runbookScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.passFixtureAccepted ||
  !summary.meetingBatchFixtureReady ||
  !summary.passHasRealtimeBoundaryRows ||
  !summary.failFixtureRejected ||
  !summary.draftGenerated ||
  !summary.draftRejectedUntilManualChecks ||
  !summary.noForbiddenRunbookPhrases
) {
  process.exitCode = 1;
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-asr-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH: path,
      OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH: meetingBatchPath,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-asr-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_DRAFT_PATH: path,
      OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH: meetingBatchPath,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function readDraft(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "-----BEGIN PRIVATE KEY-----"];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/asr-acceptance-evidence-template.md", "docs/asr-runtime-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
