# Recording Long-Test Runbook

## Current Boundary

OwnMinutes currently has a Web App recording workbench, a short recorder self-test, chunk upload, local audio persistence, finalize processing, share links, and Obsidian Markdown export.

The Web App persists each MediaRecorder chunk to IndexedDB before attempting upload. If the tab refreshes, the browser crashes, or the network is offline, reopening `/app` reconstructs a playable local Blob and retries every chunk without a server acknowledgement. The `online` event also retries pending chunks without a refresh. A successful formal finalization removes the recovery copy; account deletion removes every IndexedDB recording owned by that user. Do not describe an in-memory object URL alone as local persistence.

This runbook is for real recording stability acceptance. It does not prove ASR accuracy by itself. ASR and summary quality must be checked separately after the audio survives the test.

## Required Environment

- Use the production preview build, not Next.js dev mode:
  - `npm run build`
  - `npm run preview:screen`
- Test URL:
  - `http://127.0.0.1:3002/app`
- Browser:
  - Chrome, Edge, or Safari with microphone permission enabled.
- Hardware:
  - Built-in microphone.
  - One external microphone or headset if available.
- Network conditions:
  - Normal network.
  - Weak network.
  - Temporary offline period.
- Commands to run before and after:
  - `npm run smoke:app`
  - `npm run smoke:meetings`
  - `npm run smoke:release`

## Preflight

1. Confirm preview is listening:
   - `lsof -nP -iTCP:3002 -sTCP:LISTEN`
2. Open `/app` and sign in with a test account.
3. Open recording settings.
4. Run `录音自检`.
5. Confirm the result says the microphone generated at least one audio chunk.
6. Confirm the selected microphone is the intended device.
7. Confirm the workbench shows:
   - `开始录音`
   - `实时转写`
   - `会议纪要`
   - `录音自检`

## Test Matrix

Run all scenarios below before calling the Web App recording MVP stable.

| Scenario | Duration | Required Actions |
| --- | ---: | --- |
| Short sanity | 5 minutes | Speak normally, stop, confirm audio playback and finalize. |
| Normal meeting | 30 minutes | Speak intermittently, pause/resume once, stop, confirm finalize. |
| Long meeting | 90 minutes | Keep page open, speak every 5-10 minutes, stop, confirm finalize. |
| Weak network | 10 minutes | Start recording, throttle network or switch Wi-Fi briefly, restore network, confirm upload catches up. |
| Offline recovery | 10 minutes | Start recording, disconnect network for 60 seconds, reconnect, confirm no local audio loss. |
| Device interruption | 5 minutes | Start with headset, disconnect or switch device if available, confirm clear warning and recoverable state. |
| Background risk | 10 minutes | Switch tabs/apps briefly, return, confirm timer/chunks continue and `前后台中断` count is visible in the stability panel. |

## Acceptance Metrics

The recording MVP passes only if all of these are true:

- App does not crash during 5, 30, and 90 minute tests.
- Each scenario records start time, stop time, and whether the timer reached the expected duration.
- Local audio playback is available after stopping.
- Local audio URI or exported file is present after stopping.
- `stats.chunks` keeps increasing during active recording.
- Upload state reaches `pending=0` after network recovery.
- Finalize starts only after upload reaches a stable terminal state.
- Failed chunks are either `0` or clearly surfaced with retry/failure state.
- Background or inactive transitions during recording are visible as `前后台中断` count, with the last interruption time.
- Browser crash, tab freeze, memory pressure, or battery abnormality is explicitly recorded.
- Meeting can be finalized after recording ends.
- Generated meeting has:
  - summary
  - decisions or clear no-decision output
  - action items or clear no-action output
  - Obsidian Markdown
  - share page route
- No raw secret, API key, or provider credential appears in UI, logs, Markdown, or share page.
- Real-time transcript is treated as draft; final summary is based on post-meeting processing or clearly marked fallback.

## Failure Criteria

Any of these blocks acceptance:

- Browser tab becomes unresponsive.
- Recording stops without visible warning.
- Local audio is missing after stop.
- Audio chunks stop for more than 7 seconds without warning.
- Upload failures are hidden from the user.
- Finalize runs before pending upload reaches zero.
- Share page exposes transcript or audio by default without explicit user action.
- Deleting a meeting leaves its local manifest/result/share state visible through the app.

## Evidence Template

For each run, record this evidence in a private test note or issue. Do not commit real customer audio or transcripts.

For machine-checkable release evidence, save the redacted evidence to:

```text
.data/acceptance/recording-latest.md
```

Then run:

```bash
OWNMINUTES_RECORDING_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/recording-latest.md npm run recording:acceptance:evidence
```

The evidence file must include all scenarios in the matrix as separate `## Scenario name` sections. Each scenario section must include its own duration, start/stop times, network condition, meeting id, timer result, chunk growth result, bytes, local audio file existence, upload pending count, failed chunk count, finalize wait result, local playback result, foreground/background interruption fields, crash/freeze status, memory/battery observation, finalize result, transcript boundary, summary boundary, share link result, Obsidian Markdown result, retry/export state, restart/reopen recovery, `No secrets leaked: yes`, and `Decision: pass`.

```text
Date:
Tester:
Environment:
App URL:
Build source:
Device:
Browser:
Microphone:
Account:

## Short sanity
Scenario:
Duration:
Started at:
Stopped at:
Network condition:
Meeting ID:
Timer reached expected duration: pass/fail
Chunks increasing:
Bytes:
Local audio URI/file exists: pass/fail
Pending after stop:
Failed chunks:
Finalize waited for upload completion: pass/fail
Foreground/background interruptions:
Last interruption time:
Crash or tab freeze observed: no/yes
Memory/battery observation:
Local audio playback: pass/fail
Finalize result: pass/fail
Transcript boundary: pass/fail
Summary boundary: pass/fail
Share link: pass/fail
Obsidian Markdown: pass/fail
Retry/export state: pass/fail
Recovery after restart/reopen: pass/fail
No secrets leaked: yes/no
Known issues:
Decision: pass/fail
```

## Commands

Run these after each code change that can affect recording, upload, finalize, sharing, or auth:

```bash
npm run smoke:app
npm run smoke:meetings
npm run smoke:release
npm run smoke:recording-evidence
git diff --check
```

Run this runbook structure smoke after editing this file:

```bash
npm run smoke:recording-runbook
npm run smoke:recording-evidence
```

## Rollback

If a recording change breaks stability:

1. Stop the preview server.
2. Revert only the recording-related change.
3. Rebuild:
   - `npm run build`
   - `npm run preview:screen`
4. Run:
   - `npm run smoke:app`
   - `npm run smoke:meetings`
   - `npm run smoke:release`
5. Repeat the short sanity scenario before continuing feature work.

## Production Verification

Before TestFlight or public App Store release, repeat this runbook against:

- Public HTTPS app URL.
- Production database.
- Production object storage.
- Production secret management.
- Real ASR provider credentials.
- At least one iPhone TestFlight build.

Production verification is incomplete until 30 and 90 minute recordings survive with local audio, uploaded audio, finalize output, share page, and Obsidian Markdown evidence.
