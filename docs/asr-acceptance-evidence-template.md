# ASR Acceptance Evidence Template

Use this template when verifying a real Volcano ASR runtime credential. Do not commit real audio, raw customer transcripts, provider secrets, request headers, tokens, cookies, API keys, or private meeting content.

For repeatable local checks, copy the completed private evidence into:

```text
.data/acceptance/asr-latest.md
```

The `.data` directory is ignored by Git. Do not commit this private evidence file.

After filling the evidence, run:

```bash
OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence
```

## Decision

- Date:
- Tester:
- Environment: local / staging / production
- App URL:
- API URL:
- Decision: pass / fail
- Reason:

## Provider

- ASR provider: Volcano
- Credential type: ASR API Key / ASR AppID + Token
- Summary provider: Ark / local fallback
- Runtime source: account BYOK / server env
- Provider health: file_asr ready / not ready
- Release readiness before test:
- Release readiness after test:

## Small Audio Test

- Test path: Web Settings / Mobile Settings / API
- Mode: submit / transcribe
- Result status: not_configured / preflight_pass / submitted / transcribed / completed_empty / failed
- Verification level: none / preflight / submit / transcript
- Provider request id:
- Sample type: generated wav / uploaded wav / uploaded m4a / uploaded mp3 / browser recording
- Sample duration:
- Sample language:
- Transcript preview:
- Expected phrase:
- Expected phrase readable: yes / no
- Secrets leaked: no / yes
- Decision: pass / fail

Passing rule: ASR recognition quality is accepted only when result status is `transcribed`, verification level is `transcript`, the transcript preview is readable, the expected Mandarin phrase is recognizable, and secrets leaked is `no`.

## Meeting Test

- Meeting ID:
- Duration:
- Scenario: near-field single speaker / two speakers alternating / far-field meeting room / mild noise / accented speaker
- Formal transcript fallback-only: no / yes
- Realtime draft clearly labeled: yes / no
- Realtime draft not published as formal transcript: yes / no
- Post-meeting transcript reprocessed from full audio: yes / no
- Post-meeting transcript quality better than realtime draft: yes / no
- Final summary uses post-meeting transcript: yes / no
- Transcript quality: usable / low_confidence / empty
- Speaker diarization: pass / fail / not_applicable
- Speaker labels distinguish major turns: yes / no / not_applicable
- Speaker rename workflow verified: yes / no
- Speaker segment assignment correction verified: yes / no
- Action item speaker assignment: pass / fail / not_applicable
- Summary quality: pass / fail
- Decisions grounded in transcript: yes / no
- Action items grounded in transcript: yes / no
- Share link: pass / fail
- Obsidian Markdown: pass / fail
- Secrets leaked: no / yes
- Decision: pass / fail

Passing rule: meeting acceptance requires non-fallback formal transcript, usable transcript quality, grounded summary, working share link, working Obsidian Markdown, no secret leakage, and speaker diarization evidence for any multi-speaker scenario.

## Speaker Diarization

- Multi-speaker sample used: yes / no
- Speaker labels present in formal transcript: yes / no
- Speaker label review completed: yes / no
- Speaker rename/edit workflow available: yes / no
- Incorrect transcript segment reassignment verified: yes / no
- Renamed speakers reflected in summary/share/Markdown: yes / no
- Renamed speakers reflected in action item owners: yes / no
- Known limitation notice shown to user: yes / no
- Owner assignment fallback when speaker is uncertain: pass / fail
- Decision: pass / fail

Passing rule: speaker diarization passes only when a two-speaker or multi-speaker sample keeps major turns distinguishable, user-visible labels can be reviewed or renamed after the meeting, uncertain owners fall back to `不确定`, and the product does not claim 100% single-device speaker accuracy.

## Quality Sampling

Record at least one row per scenario. Do not paste raw sensitive transcript text.

| Scenario | Duration | Transcript quality | Summary quality | Action item quality | Decision |
|---|---:|---|---|---|---|
| Mandarin near-field single speaker |  |  |  |  |  |
| Mandarin two speakers alternating |  |  |  |  |  |
| Meeting-room far-field speech |  |  |  |  |  |
| Mild noise |  |  |  |  |  |
| Accented speaker |  |  |  |  |  |

Speaker diarization sampling:

| Scenario | Speaker labels distinguishable | Rename workflow | Owner assignment | Limitation notice | Decision |
|---|---|---|---|---|---|
| Mandarin two speakers alternating |  |  |  |  |  |
| Meeting-room multi-speaker discussion |  |  |  |  |  |
| Overlapping speech / interruption |  |  |  |  |  |

Realtime vs post-meeting boundary:

| Scenario | Realtime result | Final result | Final reprocessed full audio | Realtime not published as formal | Decision |
|---|---|---|---|---|---|
| Mandarin two speakers alternating | draft | formal |  |  |  |
| Meeting-room multi-speaker discussion | draft | formal |  |  |  |

Passing rule: realtime results are only acceptable as meeting-in-progress drafts. Formal sharing, Markdown, action owners, decisions, and summary quality must be based on the post-meeting transcript generated from full audio reprocessing.

## Structured Meeting Batch

- Evidence path: `.data/acceptance/asr-meeting-batch-latest.json`
- Real 2-4 person samples:
- Total qualifying duration:
- Required scenario coverage:
- Audio hashes verified:
- Consent and privacy review:
- Manual quality review:
- Decision: pass / fail

Passing rule: the Markdown review is not sufficient on its own. `npm run asr:meeting-batch:check` must accept a private structured batch with at least three different real Mandarin meetings, each 60-180 seconds and containing 2-4 consenting people. The batch must total at least five minutes and cover near-field, far-field, mild noise, accented speech, and overlapping speech or interruption. Every sample is bound to the retained private audio and provider result by SHA-256, and every transcript, speaker turn, renamed output, summary, share page, and Obsidian Markdown result must receive human review. Synthetic voices, environmental dialogue, single-speaker recordings, missing consent, stale evidence, and manually typed provider results do not qualify.

## Required Commands

```bash
npm run smoke:settings
npm run smoke:asr
npm run smoke:transcript-quality
npm run smoke:meetings
npm run smoke:release
npm run smoke:asr-acceptance-evidence
npm run smoke:asr-meeting-batch
npm run asr:meeting-batch:check
```

## Failure Notes

- Failure type:
- User-visible symptom:
- Provider diagnostic:
- Next action:
- Retest owner:
- Retest date:
