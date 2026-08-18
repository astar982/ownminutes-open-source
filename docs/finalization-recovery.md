# Meeting Finalization Recovery

## Purpose

OwnMinutes must preserve the full recording first, then generate the formal transcript and notes. A client disconnect, duplicated request, app restart, or temporary missing object must not silently lose the meeting or charge usage twice.

## Durable State

Each uploaded meeting can have:

```text
{{meetingId}}/processing.json
```

The file contains only:

- meeting and owner ids;
- `queued / processing / completed / failed` status;
- attempt count;
- request, start, update, completion, failure, and lease timestamps;
- result quality status;
- scrubbed error code/message and retryability.

It must never contain audio bytes, transcripts, model responses, cookies, or provider credentials.

## API Contract

```text
GET  /api/meetings/:id/finalize
POST /api/meetings/:id/finalize
```

`GET` returns the current durable processing state and existing result.

`POST` behavior:

- concurrent requests in one Node process share one active operation;
- an existing result is returned idempotently unless `force=true`;
- existing-result recovery reads manifest duration metadata and does not require the original audio object to be downloaded again;
- official-minute usage is keyed by meeting id and recorded once;
- an active lease returns `409 processing_in_progress` instead of starting duplicate provider work;
- a failed or expired operation can be retried and increments `attempt`;
- errors persisted in `processing.json` are scrubbed.

`force=true` is reserved for an explicit user request to regenerate an existing result. It can call providers again, even though usage accounting remains idempotent.

## Mobile Recovery

The Expo app persists the local recording URI before upload. After the full audio upload succeeds it also stores `audioUploadedAt`.

- No `audioUploadedAt`: retry the full audio upload, then finalize.
- Has `audioUploadedAt`: call finalize directly; do not upload the full recording again.
- Successful/idempotent finalize: clear the local pending record.
- Failed finalize: keep the local file and pending record available for retry/export.

## Sharing Boundary

Public sharing is enforced by the API, not only by a UI dialog.

- A meeting result is required before publication.
- A verified result can be published normally.
- An unverified/fallback result requires `confirmUnverified=true` after explicit human review.
- Missing confirmation returns `409 unverified_result_confirmation_required`.
- The public page and Markdown still show the unverified quality warning.

## Deployment Boundary

Local development remains `inline`: finalize executes inside the HTTP request, while `processing.json` and the lease preserve observable, idempotent recovery.

Stateful production Node deployments can set `OWNMINUTES_FINALIZATION_MODE=postgres-queue`. In queue mode:

- POST finalize writes `meeting_finalization_jobs` and returns `202`;
- workers use PostgreSQL advisory enqueue locks and `FOR UPDATE SKIP LOCKED` claims;
- job and user-visible processing leases receive heartbeats;
- crashed work is reclaimed after lease expiry;
- retryable failures use bounded exponential backoff;
- Web and iOS poll GET finalize until completed or failed;
- meeting deletion cancels active jobs and the worker rechecks ownership before saving;
- account deletion explicitly removes queue rows because PostgreSQL users are soft-deleted.

See `docs/finalization-queue-runbook.md`. The production queue release gate remains blocked until a managed PostgreSQL deployment and at least two worker-capable instances provide real crash, retry, deletion, backup, and no-secret-leak evidence.

## Verification

```bash
npm run smoke:finalization-recovery
npm run smoke:finalization-queue
npm run smoke:share-confirmation
npm run smoke:closed-loop
npm run smoke:mobile-stability
npm run smoke:release
```

The recovery smoke covers concurrent finalize calls, idempotent result recovery after the original audio object is unavailable, usage deduplication, a missing-audio-object failure before first processing, successful retry after restoring the object, explicit unverified-share confirmation, and full-prefix deletion.
