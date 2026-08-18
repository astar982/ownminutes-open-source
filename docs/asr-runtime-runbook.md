# ASR Runtime Runbook

## Current Boundary

OwnMinutes can record audio, upload chunks, call the configured Volcano file ASR runtime, finalize a meeting, generate Markdown, and expose share links. The file-ASR runtime path has passed private synthetic Mandarin speech and silence probes. The remaining release blocker is a reviewed batch of real 2-4 person meetings across near/far field, mild noise, accent, and interruption scenarios; runtime access alone is no longer the missing evidence.

Production file ASR must use the private URL path documented by Volcano: `audio.url` and `audio.data` are mutually exclusive. OwnMinutes assembles audio through files, converts it to mono speech input, normalizes loudness to -20 LUFS, encodes 48 kbps OGG Opus, writes a private transient object, sends only a 300-3600 second SigV4 GET URL, and deletes the object in `finally`. Signed URLs, query credentials, and raw audio must never appear in logs or evidence. Local storage is a development fallback and may still use a bounded 96 MiB Buffer path.

Official reference: <https://www.volcengine.com/docs/6561/1631584?lang=zh>

This runbook verifies the post-meeting ASR runtime path. It does not certify realtime WebSocket ASR or speaker diarization quality.

## Cost-aware production routing

The production-safe default remains the route that is authorized on the current account:

1. Volcano realtime ASR 2.0 (`volc.seedasr.sauc.duration`) produces the live draft.
2. Finalization reuses that realtime transcript only when its coverage and quality checks pass.
3. When no reusable transcript exists, the server-level file route stays `single` + `flash` with `volc.bigasr.auc_turbo`.
4. The official Turbo-only file route is allowed only for audio up to 30 minutes. Longer audio is preserved and finalization stops with `turbo_fallback_cost_cap`; it must not silently incur an unbounded Turbo charge.

The `standard_then_turbo` router is implemented, but it is **not a production default yet**. The intended primary resource `volc.seedasr.auc` is still not authorized for this account (the real probe returned HTTP `403` / status `45000030`). Keep `single` + `flash` until the standard file resource is enabled and a real provider probe passes. Do not work around an authorization failure by automatically switching to Turbo.

Once the standard resource is authorized, the guarded router permits at most one Turbo submit and only when the standard submit was clearly rejected before acceptance by HTTP `429`, HTTP `5xx`, or Volcano status `45000000`, and only while the audio is within the configured duration cap. It does not fall back after `403` / `45000030`, invalid parameters, an ambiguous network result, an accepted request followed by query timeout/failure, or a no-speech result. This fail-closed behavior prevents duplicate paid jobs.

Account-level BYOK always uses `strategy: single` with platform Turbo fallback disabled. A user's key, resource, and billing boundary must never inherit the server's platform fallback policy.

When “重新生成纪要” is requested and the existing transcript passes the formal-transcript quality gate, finalization reuses that transcript and runs summary generation only. File ASR usage for that operation is therefore zero. Mock, fallback, placeholder, unusable, or unverified transcripts are not eligible for this optimization.

## Required Environment

- Run production preview locally:
  - `npm run build`
  - `npm run preview:screen`
- Use the settings page:
  - `http://127.0.0.1:3002/settings`
- Use a test account, not a production customer account.
- Prepare one real Volcano ASR runtime credential set:
  - `VOLCANO_ASR_API_KEY`
  - or `VOLCANO_ASR_APP_ID` + `VOLCANO_ASR_TOKEN`
- Prepare summary model credentials if summary is not ready:
  - `ARK_API_KEY`
  - `ARK_CHAT_MODEL`

## Preflight

Run local structure checks first:

```bash
npm run smoke:asr
npm run smoke:asr-resilience
npm run smoke:asr-benchmark
npm run smoke:asr-preflight
```

Before treating the post-meeting file ASR path as a production candidate, configure:

- `TRANSCRIPTION_PROVIDER=volcano`
- `VOLCANO_ASR_API_KEY` or `VOLCANO_ASR_APP_ID` + `VOLCANO_ASR_TOKEN`
- `VOLCANO_ASR_MODE=flash` for direct local audio upload
- HTTPS `VOLCANO_ASR_RECOGNIZE_URL` or the default Volcano flash endpoint
- `VOLCANO_ASR_RESOURCE_ID` or the default `volc.bigasr.auc_turbo`
- `OWNMINUTES_ASR_FILE_STRATEGY=single`
- `OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1`
- `OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES=30`
- HTTPS `VOLCANO_ASR_TURBO_RECOGNIZE_URL`
- `VOLCANO_ASR_TURBO_RESOURCE_ID=volc.bigasr.auc_turbo`
- `OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE`
- `OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY`
- `OWNMINUTES_ASR_FALLBACK_POLICY`
- `OWNMINUTES_ASR_PRIVACY_POLICY`

Run in the same deployment environment:

```bash
npm run asr:preflight
```

This preflight certifies only the post-meeting file ASR production candidate. Realtime WebSocket ASR has its own protocol smoke and production gate because it also requires a stateful Node runtime, weak-network tests, and a separate real-meeting acceptance record.

1. Confirm `/api/release/readiness` reports `file-asr` as the first critical blocker.
2. Open `/settings`.
3. Confirm the page shows:
   - `当前首要阻塞`
   - `填写会后 ASR`
   - `ASR 小音频真实测试`
   - `ASR 完整识别测试`
   - `选择音频样本`
   - `录 1-3 分钟短会`
4. Confirm no raw secret appears in page source, API JSON, logs, or screenshots.
5. Confirm `npm run smoke:settings` passes before editing configuration.

## Configure ASR

Use `/settings` for account-level BYOK when testing user-facing setup:

1. Select `会议转写：火山语音识别`.
2. Prefer entering `ASR API Key`.
3. If no ASR API Key is available, enter `ASR AppID` and `ASR Token`.
4. Save the provider.
5. Refresh configuration health.

Use `.env.local` only for server-level runtime testing:

```bash
TRANSCRIPTION_PROVIDER=volcano
VOLCANO_ASR_API_KEY=
VOLCANO_ASR_APP_ID=
VOLCANO_ASR_TOKEN=
VOLCANO_ASR_MODE=flash
VOLCANO_ASR_RECOGNIZE_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
VOLCANO_ASR_RESOURCE_ID=volc.bigasr.auc_turbo
OWNMINUTES_ASR_FILE_STRATEGY=single
OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1
OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES=30
VOLCANO_ASR_TURBO_RECOGNIZE_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
VOLCANO_ASR_TURBO_RESOURCE_ID=volc.bigasr.auc_turbo
# Optional reliability controls. Defaults: 3 attempts and 750 ms base delay.
VOLCANO_ASR_FLASH_ATTEMPTS=3
VOLCANO_ASR_FLASH_RETRY_MS=750
ARK_API_KEY=
ARK_CHAT_MODEL=
```

`VOLCANO_ASR_FLASH_ATTEMPTS` is clamped to `1..5`. `VOLCANO_ASR_FLASH_RETRY_MS` is clamped to `100..5000` milliseconds; retry delay grows exponentially and is capped at 5 seconds. The adapter retries HTTP `429`, HTTP `5xx`, and Volcano status `45000000`. It does not retry invalid requests or every provider error indiscriminately.

Do not set `OWNMINUTES_ASR_FILE_STRATEGY=standard_then_turbo` until the low-cost standard file resource is authorized. After authorization, use `VOLCANO_ASR_MODE=standard`, a non-Turbo primary `VOLCANO_ASR_RESOURCE_ID`, the explicit Turbo URL/resource above, and keep the cap in `1..30`. Run `npm run asr:preflight` and `npm run smoke:asr-resilience` before deployment.

Never commit real ASR keys, Ark keys, account AK/SK, tokens, cookies, private keys, or customer audio.

## Small Audio Verification

Run the user-facing smoke first:

```bash
npm run smoke:settings
npm run smoke:asr
```

Then in `/settings`, click:

```text
ASR 小音频真实测试
```

This first button only proves whether the provider accepts a small test request. It may use a generated short WAV and should not be treated as recognition-quality evidence.

For transcript evidence, prepare a 5-30 second Mandarin sample:

- WAV/M4A/MP3/AAC/WebM is acceptable for the UI.
- Keep the sample under 1.5MB when possible; the API hard limit is 2MB.
- Use clear speech with normal meeting volume.
- Do not upload customer audio, private meeting audio, or sensitive content.

Then in `/settings`, use:

```text
选择音频样本
或：录 10 秒测试样本
运行完整识别测试
```

The in-page recorder is only for ASR verification. It creates a local browser audio sample and does not create a meeting or persist meeting audio.

For repeatable CLI evidence, keep a local 3-30 second Mandarin sample outside Git and run:

```bash
OWNMINUTES_ASR_SAMPLE_PATH=/absolute/path/to/mandarin-sample.wav \
OWNMINUTES_ASR_EXPECTED_PHRASE="今天确认会议记录验收" \
npm run asr:sample
```

### Real provider closed loop

After the small ASR sample passes, run the complete backend chain with the same private sample. The command starts an isolated production preview, creates a temporary account and temporary Obsidian vault, then verifies Volcano file ASR, Ark structured summary, private Markdown, summary-only sharing, transcript sharing, Obsidian output, and cleanup:

```bash
OWNMINUTES_PROVIDER_SAMPLE_PATH=/absolute/path/to/mandarin-sample.wav \
OWNMINUTES_PROVIDER_EXPECTED_PHRASE="今天确认会议记录验收" \
OWNMINUTES_PROVIDER_SAMPLE_DURATION_MS=6000 \
npm run provider:closed-loop
```

Private evidence is written to `.data/acceptance/provider-closed-loop-latest.md`. A pass proves the configured provider chain can complete; it does not replace a human 1-3 minute multi-speaker meeting, far-field/noise sampling, diarization review, or TestFlight device evidence.

The command writes sanitized private evidence to:

```text
.data/acceptance/asr-small-audio-latest.md
```

It does not print transcript text to the terminal by default. The command fails when the sample is missing, empty, larger than the configured limit, credentials are not usable, the provider does not return readable text, or the expected phrase is not recognizable.

Interpret the result as four different levels:

- `preflight_pass`: fields are sufficient, but no external ASR call was made.
- `submitted`: Volcano accepted the test audio and returned a request id; this verifies provider submit/auth only.
- `transcribed`: Volcano returned readable transcript text; this is the first acceptable proof that the file ASR path can recognize speech.
- `completed_empty`: Volcano returned a completed response without readable text. For a silent/no-voice sample (`20000003`), this is an expected quality outcome: the formal transcript stays empty and unverified, and the local audio remains available. For a sample that should contain speech, inspect the microphone/input and retry with a real Mandarin voice sample.
- `failed`: the request did not reach a usable provider result; inspect the next action and provider diagnostic.

Pass criteria:

- The result is not `not_configured`.
- The response does not expose raw secrets.
- A provider request id or clear provider diagnostic is visible.
- For recognition-quality acceptance, the result must reach `transcribed`, not only `submitted`.
- The `transcriptPreview` contains the expected Mandarin sample content or a close readable transcript.
- `/api/account/provider-health` reports `file_asr` ready for the test account.

### Runtime failure behavior

- Volcano `20000003` is treated as completed-without-usable-speech, not as a technical transcript and not as fallback meeting content.
- Volcano `45000000` is an ambiguous runtime/resource rejection. The adapter performs bounded retries; if all attempts fail, the user receives a Chinese retry message instead of raw provider text.
- In both cases the original local recording remains the source of truth. A provider failure must not delete it or prevent an explicit later “重新生成纪要”.
- A Turbo-only official file call is blocked when the recording exceeds `OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES` (production default: 30). This is a cost gate, not data loss: the local recording remains available for BYOK or a later low-cost retry.
- In `standard_then_turbo`, Turbo is a one-attempt, pre-acceptance fallback only. Never trigger it after an accepted standard request becomes uncertain during query/polling.
- Run `npm run smoke:asr-resilience` after changing the adapter. Its local HTTP fixture proves two transient failures followed by success, no-speech handling, bounded backoff, retry classification, and preserved-audio/retry controls without spending provider quota.
- Run `npm run smoke:asr-turbo-cost-policy` after changing the cost cap, official fallback gate, or BYOK runtime boundary.
- Run `npm run smoke:summary-only-reprocess` after changing forced reprocessing. It verifies that a formal transcript regenerates only the summary and does not issue another file-ASR request.
- A synthetic pass proves the transport and adapter only. It must not be used to clear the real multi-speaker ASR or diarization release gate.

## Meeting Verification

After the small audio test:

1. Open `/app`.
2. Record a 1-3 minute Mandarin meeting sample.
3. Stop the meeting and wait for finalize.
4. Open the meeting detail page.
5. Confirm the formal transcript is not just fallback text.
6. Confirm summary, decisions, action items, share link, and Obsidian Markdown exist.
7. Run:

```bash
npm run smoke:meetings
npm run smoke:release
```

## Summary Model Production Preflight

Before using Ark summaries for production candidates, configure:

- `ARK_API_KEY`
- `ARK_CHAT_MODEL`
- `ARK_BASE_URL` or the default Ark HTTPS endpoint
- `OWNMINUTES_SUMMARY_JSON_ONLY=1`
- `OWNMINUTES_SUMMARY_HALLUCINATION_POLICY`
- `OWNMINUTES_SUMMARY_RETRY_POLICY`
- `OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY`
- Optional bounded retry controls:
  - `OWNMINUTES_SUMMARY_MAX_ATTEMPTS` defaults to `2`, clamps to `1..3`.
  - `OWNMINUTES_SUMMARY_TIMEOUT_MS` defaults to `30000`, clamps to `3000..120000`.
  - `OWNMINUTES_SUMMARY_RETRY_DELAY_MS` defaults to `300`, clamps to `0..5000`.

Run:

```bash
npm run smoke:summary
npm run smoke:summary-preflight
npm run smoke:summary-evidence
npm run summary:preflight
```

`summary:preflight` must pass in the same deployment environment before treating the summary model as production candidate. It does not replace real transcript comparison; it only checks that the model configuration and guardrails are present.

## Summary Acceptance Evidence

Real summary model evidence must not include API keys, bearer tokens, customer transcript content, or private meeting content. Save sanitized evidence locally:

```text
.data/acceptance/summary-latest.md
```

Generate the private evidence draft first:

```bash
npm run summary:acceptance:evidence:draft
```

The draft is intentionally incomplete. It must stay `pending` until real model, transcript quality, grounding, repeatability, share, and Markdown evidence is added. The formal checker must reject the draft until every required field is replaced with real evidence.

Then run:

```bash
npm run summary:acceptance:evidence
```

Use `OWNMINUTES_SUMMARY_EVIDENCE_PATH=/path/to/evidence.md` when checking a different private file.

Required evidence fields:

```markdown
# Summary Acceptance Evidence

Date:
Commit:
Summary provider: volcano-ark | openai | managed
Model:
Transcript source:
Transcript language: 中文普通话
Transcript duration:
JSON schema:
Hallucination policy:
Human reviewer:
Markdown output: pass
Share output: pass
Release readiness summaryModelBlocked: no
Release readiness nextAction:

Production preflight: pass
Summary structure smoke: pass
Transcript quality gate: pass
Real model generation: pass
JSON parse: pass
Summary grounded: pass
Topics grounded: pass
Speaker views grounded: pass
Decisions grounded: pass
Action items grounded: pass
Risks grounded: pass
Open questions grounded: pass
Knowledge points grounded: pass
Uncertain claims labelled: pass
No unsupported claims: pass
Markdown generated: pass
Share page quality notice: pass
Human review completed: pass
Repeat generation stable: pass

Secrets leaked: no
Decision: pass
Known issues:
```

Do not mark `summary-model` ready if the summary invents decisions, assigns owners not present in the transcript, hides uncertainty, fails JSON parsing, or produces Markdown/share output that presents unverified content as formal fact.

## Quality Sampling

For the first real ASR pass, record evidence for:

- Mandarin near-field single speaker.
- Mandarin two speakers alternating.
- Meeting-room far-field speech.
- Mild noise.
- One accented speaker.

Minimum acceptance:

- The transcript is readable enough to summarize.
- The summary does not invent decisions not present in the transcript.
- Action items include owner, due date, or `不确定` when missing.
- Two-speaker and multi-speaker samples include speaker labels in the formal transcript.
- Speaker labels can be reviewed or renamed after the meeting before sharing or exporting Markdown.
- Speaker-derived owner assignment falls back to `不确定` when the speaker is uncertain.
- User-facing copy does not claim 100% accurate single-device speaker identification.
- Provider diagnostics are visible when ASR quality is degraded.
- No raw secret appears in any user-visible output.

## Speaker Diarization Production Gate

Speaker diarization is a separate release gate from basic ASR. A readable transcript does not prove that the product can identify different speakers well enough for meeting action items.

Before marking `speaker-diarization` ready, configure and record evidence for:

```bash
OWNMINUTES_SPEAKER_DIARIZATION_REAL_AUDIO_EVIDENCE=
OWNMINUTES_SPEAKER_DIARIZATION_QUALITY_SAMPLING_POLICY=
OWNMINUTES_SPEAKER_DIARIZATION_LABEL_REVIEW_POLICY=
OWNMINUTES_SPEAKER_RENAME_WORKFLOW=
OWNMINUTES_SPEAKER_ASSIGNMENT_FALLBACK_POLICY=
OWNMINUTES_SPEAKER_LIMITATION_NOTICE=
```

Minimum production evidence:

- One Mandarin two-speaker alternating sample.
- One meeting-room multi-speaker sample.
- One interruption or overlapping-speech sample.
- Formal transcript contains distinguishable `Speaker N` labels for major turns.
- User can rename or correct speaker labels after the meeting.
- Summary, share page, and Obsidian Markdown reflect reviewed speaker labels or clearly preserve `Speaker N`.
- Action item owners use reviewed speaker labels, or `不确定` when the speaker is ambiguous.
- Support/privacy copy states that single-device speaker identification is not guaranteed to be 100% accurate.

Run:

```bash
npm run smoke:asr-acceptance
npm run smoke:transcript-quality
npm run smoke:meetings
npm run smoke:release
```

`speaker-diarization` must stay blocked until the evidence above exists. Do not mark it ready just because the provider returns a `speaker_id` field.

## Realtime Boundary

Realtime ASR remains separate from post-meeting file ASR.

Diagnostics now distinguish configuration from production readiness:

- `realtimeConfigured=true` means the account or environment has ASR credential fields and a WebSocket URL.
- `realtimeProtocolReady=true` means the WebSocket protocol implementation has been completed and accepted.
- `realtimeReady=true` must not be set just because the WebSocket URL exists.

The realtime draft path now provides a live Volcano WebSocket session plus a safety and observability layer:

- `POST /api/meetings/:id/realtime-chunks` accepts validated PCM candidate chunks and does not write them into the formal post-meeting audio manifest.
- `GET /api/meetings/:id/realtime-chunks` returns lightweight session metadata: chunk count, total bytes, total duration, provider status counts, last diagnostic and draft transcript count.
- The realtime session metadata must not include raw PCM audio or provider secrets.
- Account deletion must delete realtime-only sessions, even if no formal meeting manifest was ever created.

Implemented and protected by `npm run smoke:realtime-protocol`:

- WebSocket protocol implemented.
- Audio format confirmed.
- Heartbeat and reconnect behavior implemented.
- Stop/final response handshake implemented.
- Realtime failure does not affect local recording or post-meeting file ASR.
- Next production bundling keeps `ws` as a native server external package; otherwise binary sends can fail only after `next build`.
- Cumulative provider drafts reuse a stable sentence id, so the client updates the active sentence instead of appending duplicate text.
- User-configured realtime WebSocket URLs are restricted to the approved official provider host; loopback is available only under the explicit test flag.

Mobile transport ordering is protected by `npm run smoke:mobile-realtime-queue` and `npm run smoke:mobile-realtime`:

- The iOS client serializes realtime chunk uploads in creation order instead of starting concurrent requests.
- Every queued task snapshots its meeting id, account session, API base URL, and queue generation. A late completion or failure from an older recording cannot update the next recording or send audio to its meeting id.
- Transient client/network failures use at most three attempts with bounded backoff. HTTP 408/425/429/5xx and network `TypeError` are retryable; permanent 4xx and PCM format errors are not.
- The upload queue retains at most 20 pending 3-second chunks. If the backend is slower for long enough to fill the queue, the newest realtime draft candidate is dropped with an explicit warning; the durable recorder continues independently. Invalid/HTML gateway responses are treated as bounded transient failures instead of crashing JSON parsing.
- If a chunk still fails after bounded transport retries, the client cancels all later queued chunks and disables realtime upload for that meeting. Continuing with higher sequence numbers would only produce permanent HTTP 409 gaps. The durable recorder and post-meeting file ASR continue; a provider-level `provider_error` or validated format rejection does not use this circuit breaker because the server has already recorded that sequence.
- Meeting stop waits up to 20 seconds for the ordered queue to drain. Timeout cancels queued realtime work and leaves the durable local recording and formal post-meeting flow authoritative.
- The stateful Node route serializes POST/DELETE for a meeting, idempotently ignores a repeated sequence without resending audio to the provider, rejects a sequence gap with HTTP 409, and returns HTTP 403 for cross-account meeting reuse.

The speech API Key must be created after the streaming service is activated. A Key that already works for file ASR may still receive HTTP 403 on every streaming resource. The safe bootstrap flow is:

```bash
npm run volcano:speech-bootstrap -- --activate-realtime --create-realtime-key
npm run volcano:realtime-auth-probe
```

The first command activates `volc.seedasr.sauc.duration`, creates a separate realtime-capable API Key, and updates ignored `.env.local` without printing the key. It does not purchase a prepaid resource pack. The second command performs only a WebSocket authentication handshake.

To verify actual binary frames and readable drafts against a private 5-180 second sample:

```bash
OWNMINUTES_REALTIME_SAMPLE_PATH=/absolute/path/to/sample.wav \
OWNMINUTES_REALTIME_EXPECTED_PHRASE="expected words" \
npm run volcano:realtime-live
```

The live verifier converts the sample to 16 kHz mono signed PCM, sends 3-second chunks through the same production API route, requires a completed session and non-empty transcript, deletes its temporary account, and writes only a transcript-free private summary to `.data/acceptance/realtime-asr-live-latest.json`.

The current private synthetic pressure probe used a 60-second / 20-chunk Mandarin sample and reached 20 drafts, zero provider/format errors, completed final status, and a readable expected phrase. This proves sustained transport and provider protocol behavior only. It does not replace weak-network testing on a device or a real 1-3 minute multi-speaker meeting.

Do not mark realtime ASR production-ready until these remaining acceptance items are done:

- Weak network test passed.
- A 1-3 minute real Mandarin meeting passes draft latency and speaker review.

Run local realtime production gate checks before any realtime ASR release candidate:

```bash
npm run smoke:realtime-preflight
```

Before treating realtime ASR as a production candidate, configure and run in the same deployment environment:

```bash
TRANSCRIPTION_PROVIDER=volcano
VOLCANO_ASR_API_KEY=
VOLCANO_ASR_APP_ID=
VOLCANO_ASR_TOKEN=
VOLCANO_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
VOLCANO_REALTIME_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
OWNMINUTES_REALTIME_ASR_PROTOCOL_IMPLEMENTED=1
OWNMINUTES_REALTIME_ASR_RUNTIME=stateful_node
OWNMINUTES_REALTIME_ASR_HEARTBEAT_POLICY=ping-15s-stale-45s
OWNMINUTES_REALTIME_ASR_RECONNECT_POLICY=fresh-session-bounded-no-audio-replay
OWNMINUTES_REALTIME_ASR_WEAK_NETWORK_EVIDENCE=
OWNMINUTES_REALTIME_ASR_FAILURE_ISOLATION_EVIDENCE=
OWNMINUTES_REALTIME_ASR_REAL_MEETING_EVIDENCE=
npm run realtime:preflight
```

`VOLCANO_ACCESS_KEY_ID` and `VOLCANO_SECRET_ACCESS_KEY` are account-management credentials and do not replace the speech runtime API Key or AppID + Token. The in-memory WebSocket session manager requires a long-lived stateful Node/container process and must not be deployed as an ephemeral serverless function. The Web and iOS settings screens expose a separate realtime connection test so BYOK users can detect missing streaming entitlement before starting a meeting.

`realtime:preflight` must continue to fail until the real runtime credential, weak-network evidence, failure-isolation evidence, and real-meeting evidence all pass. A WebSocket URL and account AK/SK alone do not prove a production realtime transcript path.

## Evidence Template

Use `docs/asr-acceptance-evidence-template.md` as the canonical evidence template. Fill a copy in a private issue or private Obsidian note. Do not commit audio or raw transcripts from real meetings. For local repeatable checks, keep the private copy at `.data/acceptance/asr-latest.md`.

Before accepting ASR readiness, run:

```bash
npm run smoke:asr-acceptance
npm run smoke:asr-acceptance-evidence
npm run smoke:asr-acceptance-collector
npm run smoke:asr-meeting-batch
npm run asr:meeting-batch:collect
npm run asr:meeting-batch:check
npm run asr:acceptance:evidence:draft
npm run asr:acceptance:collect
OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md \
OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH=.data/acceptance/asr-meeting-batch-latest.json \
npm run asr:acceptance:evidence
```

`asr:acceptance:evidence:draft` creates `.data/acceptance/asr-latest.md` with the required sections and sampling tables. The draft is intentionally incomplete and must fail the formal checker until the pending fields are replaced with real transcribed small-audio evidence, formal meeting transcript evidence, speaker review evidence, realtime/formal boundary evidence, share output, and Obsidian Markdown evidence.

`asr:acceptance:collect writes a private evidence draft` at `.data/acceptance/asr-latest.md` by default. It combines ASR production preflight, optional small-audio sample transcription, realtime/formal boundary placeholders, speaker diarization placeholders, quality sampling tables, and a reference to the structured meeting batch. Override the output with `OWNMINUTES_ASR_ACCEPTANCE_COLLECT_PATH=/private/path/asr-latest.md`, pass a real sample with `OWNMINUTES_ASR_SAMPLE_PATH=/absolute/path/to/mandarin-sample.wav`, and optionally verify an expected phrase with `OWNMINUTES_ASR_EXPECTED_PHRASE="今天确认会议记录验收"`. The collector is a convenience for private evidence collection only; it intentionally leaves the release decision pending until a real meeting and speaker review are filled in and both structured and Markdown checks pass.

### Public reproducible quality benchmark

Use the pinned AliMeeting Eval far-field subset to compare ASR and anonymous speaker-clustering changes before asking people to repeat private acceptance meetings. AliMeeting is published through OpenSLR under CC BY-SA 4.0 and contains real Mandarin meetings with multi-speaker timing annotations. OwnMinutes does not commit or redistribute its audio or transcripts.

```bash
# Downloads about 3.67 GB only when the archive is not already present.
npm run asr:benchmark:prepare -- --download
npm run asr:benchmark:run
npm run smoke:asr-benchmark
```

The preparation command verifies the pinned archive SHA-256 before extraction, selects channel 0, and creates three 120-second private samples: normal turn-taking, moderate overlap, and severe overlap. The runner uses the production audio standardization and real Volcano adapter, then calculates normalized Chinese CER, exact speaker-count agreement, major-turn attribution, speech coverage, and cluster purity. The report is written with mode `0600` to `.data/acceptance/alimeeting-public-benchmark-latest.json`; it contains no raw transcript.

The 2026-07-13 `volc.bigasr.auc_turbo` snapshot after OGG Opus loudness standardization produced:

| Profile | Overlap in 120 s | Reference/provider speakers | CER | Major-turn attribution | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| Normal | 6.8 s | 4 / 4 | 23.72% | 83.33% | benchmark target met |
| Moderate | 14.9 s | 3 / 4 | 32.76% | 66.67% | below target |
| Stress | 54.6 s | 4 / 4 | 61.12% | 39.39% | below target |

This proves the current fast model is usable in the selected normal turn-taking window but degrades materially as overlap rises. It also proves that a returned `speaker` field does not guarantee correct speaker count or turns. The current account returned `403 / 45000030` when probing standard 1.0 and `volc.seedasr.auc` 2.0, so no 2.0 comparison is claimed.

Public benchmark results always carry `sourceKind: public_benchmark` and `releaseGateQualified: false`. They cannot satisfy consent, real iPhone behavior, speaker rename, summary grounding, share, or Obsidian checks, and must never be copied into the real-meeting evidence as `sourceKind: real_meeting`.

Official references:

- <https://www.openslr.org/119/>
- <https://github.com/yufan-aslp/AliMeeting>
- <https://www.volcengine.com/docs/6561/1631584?lang=zh>
- <https://www.volcengine.com/docs/6561/1354871?lang=zh>

### Real meeting batch

The release gate no longer accepts environment-variable claims or a hand-edited Markdown table as proof of ASR quality. It requires `.data/acceptance/asr-meeting-batch-latest.json`, generated from retained private audio and matching provider evidence.

Start with:

```bash
npm run asr:meeting-batch:collect
```

The first run creates a `0600` private plan at `.data/acceptance/asr-meeting-batch-plan.json`. Fill it with three different real Mandarin meeting recordings. Every sample must be 60-180 seconds, contain 2-4 consenting people, and use `sourceKind: real_meeting`. Across the batch, `scenarioTags` must cover:

- `near_field`
- `far_field`
- `mild_noise`
- `accented_speech`
- `overlap_or_interruption`

Rerun the collector. It calls the real Volcano file ASR adapter for each sample and binds the private audio, provider request, segment count, and speaker count with SHA-256. The structured JSON intentionally contains no raw transcript. It starts with every `manualReview` field pending.

Privately inspect each provider evidence file and the actual app outputs. Record a named reviewer, `meaningAccuracyPct`, `speakerTurnAccuracyPct`, transcript usability, full-audio formal processing, realtime/formal separation, global speaker rename, per-segment speaker assignment correction, grounded summary/action items, share page, Obsidian Markdown, uncertain-owner fallback, and leak review. Set top-level `decision` to `pass` only after every field is true, then run:

```bash
OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH=.data/acceptance/asr-meeting-batch-latest.json \
npm run asr:meeting-batch:check
```

The checker independently reopens every retained audio file, verifies byte size and SHA-256, verifies the matching provider evidence, requires at least three samples and five total minutes, rejects evidence older than 30 days, and requires at least 80% meaning and major-speaker-turn accuracy on every sample. Synthetic voices, single-speaker recordings, environmental dialogue, missing consent, copied request IDs, modified audio, stale evidence, or raw transcript fields fail closed. Real customer audio, transcripts, API keys, and the JSON evidence remain under ignored `.data` or an equivalently private mounted path and must never be committed.

```text
Date:
Tester:
ASR provider:
Credential type: API Key / AppID+Token
Summary provider:
Small audio test: pass/fail
Provider request id:
Meeting ID:
Duration:
Scenario:
Transcript quality:
Summary quality:
Action item quality:
Share link: pass/fail
Obsidian Markdown: pass/fail
Secrets leaked: no/yes
Decision: pass/fail
Known issues:
```

## Failure Criteria

Any item below blocks ASR acceptance:

- `file-asr` remains blocked after saving credentials.
- ASR test returns `not_configured`.
- Raw secrets appear in UI, API JSON, logs, Markdown, or share page.
- Final transcript is fallback-only.
- Summary is based on invented content.
- Finalize fails without a clear retry path.
- Realtime ASR failure causes local recording loss.

## Rollback

If a bad credential or provider error breaks tests:

1. Delete the provider in `/settings`.
2. Confirm `/api/account/provider-health` returns file ASR as not configured.
3. Remove any server-level `.env.local` ASR runtime values.
4. Restart preview:
   - `npm run build`
   - `npm run preview:screen`
5. Run:
   - `npm run smoke:settings`
   - `npm run smoke:release`

## Production Verification

Production ASR is not accepted until the same tests pass on:

- Public HTTPS app URL.
- Production database.
- Production object storage.
- Production secret management.
- At least one iPhone TestFlight recording.

The final production decision must reference `file-asr`, `summary-model`, `object-storage`, `secret-management`, and `public-url` readiness evidence.
