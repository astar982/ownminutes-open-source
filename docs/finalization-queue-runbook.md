# Finalization Queue Runbook

## Purpose

Long ASR and summary calls must not depend on the lifetime of `POST /api/meetings/:id/finalize`. OwnMinutes now supports an opt-in PostgreSQL durable queue for stateful Node deployments.

Local development remains `inline` by default. Enabling the queue does not clear the PostgreSQL release blocker; real migration, backup, restore, SSL, minimum-privilege, multi-instance, and load evidence are still required.

## Architecture

```text
iOS/Web POST finalize
  -> PostgreSQL meeting_finalization_jobs
  -> 202 queued
  -> Next.js Node worker
  -> FOR UPDATE SKIP LOCKED atomic claim
  -> ASR + summary + result/Markdown
  -> processing.json completed/failed
  -> client GET polling
```

The queue provides:

- per-meeting enqueue serialization with a PostgreSQL advisory transaction lock;
- multi-worker atomic claims with `FOR UPDATE SKIP LOCKED`;
- worker and user-visible leases with heartbeat refresh;
- expired-lease reclaim after a crash;
- bounded exponential retry and terminal failure;
- owner lookup from the same PostgreSQL repository;
- API `202` plus Web/iOS polling until completed or failed;
- meeting-prefix deletion and account cascade behavior through the existing storage and user foreign-key boundaries.

## Required Environment

```bash
OWNMINUTES_AUTH_REPOSITORY=postgres
OWNMINUTES_FINALIZATION_MODE=postgres-queue
OWNMINUTES_FINALIZATION_WORKER=1
OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER=1
OWNMINUTES_FINALIZATION_POLL_MS=2000
OWNMINUTES_FINALIZATION_JOB_LEASE_MS=300000
OWNMINUTES_FINALIZATION_MAX_ATTEMPTS=5
OWNMINUTES_FINALIZATION_RETRY_BASE_MS=15000
DATABASE_URL=[managed secret reference]
```

Do not place a database URL in Git, logs, screenshots, evidence Markdown, or mobile builds.

`OWNMINUTES_FINALIZATION_WORKER=1` starts finalization work from `src/instrumentation.ts` only in the Node runtime. The same stateful Worker instances must set `OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER=1` so account deletion object cleanup, storage-integrity refresh, lease heartbeat, bounded retry, and dead-letter handling remain active. Do not enable either loop in Edge or short-lived serverless runtimes.

When `OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER=1` is present, the finalization loop does not also schedule opportunistic deletion cleanup. The two production Worker processes therefore provide two HA deletion consumers rather than four duplicate polling paths. A finalization-only legacy process may still run opportunistic cleanup when the dedicated flag is absent, but that fallback is not a production topology substitute.

## Migration

```bash
npm run smoke:database-migrate
npm run db:migrate
npm run smoke:database-schema
npm run smoke:finalization-queue
npm run smoke:finalization-queue-runtime
npm run smoke:account-deletion-cleanup-gate
npm run smoke:account-deletion-cleanup-runtime
```

Migration `0008_meeting_finalization_jobs.sql` must be present before enabling queue mode. Roll back the environment flags to `inline` before rolling back application code; do not drop the queue table during an incident.

## Deployment

1. Complete the PostgreSQL production preflight and migration.
2. Deploy a stateful Node service with queue mode enabled.
3. Start at least one instance with `OWNMINUTES_FINALIZATION_WORKER=1`.
4. Keep other web instances on the same database; they may also run workers because claims are atomic.
5. Submit a short meeting and confirm `POST finalize` returns `202` with `queued=true`.
6. Confirm `GET finalize` transitions `queued -> processing -> completed`.
7. Stop a worker during processing, wait for lease expiry, and confirm another worker reclaims the job.
8. Force a retryable provider failure and verify bounded `retry_wait` backoff.
9. Force a permanent entitlement/user error and verify terminal `failed` without a retry loop.
10. Confirm duplicate POST requests return the same active job.
11. After Workers have refreshed the storage-integrity epoch, require `npm run account-cleanup:gate` and public `/api/readyz` `releaseReady=true`. See `docs/account-deletion-cleanup-runbook.md` before replaying a dead-lettered job.

## Monitoring

Alert on:

- oldest queued job age;
- `retry_wait` and terminal failure counts;
- expired processing leases;
- attempts approaching `max_attempts`;
- queue depth with no active worker;
- processing duration by provider;
- error codes after message scrubbing.

Never log provider keys, database URLs, raw transcripts, audio bytes, cookies, or model responses from the worker.

## Verification Boundary

Code-level checks:

```bash
npm run smoke:finalization-queue
npm run smoke:database-schema
npm run smoke:database-migrate
npm run build
npm run smoke:release
```

Production acceptance still requires a real managed PostgreSQL database and at least two worker-capable instances. Record migration, enqueue, duplicate request, crash reclaim, retry, terminal failure, completed result, usage idempotency, deletion, backup/restore, and no-secret-leak evidence in the private PostgreSQL acceptance file.

For an isolated local PostgreSQL runtime test, start a disposable PostgreSQL instance and a production build configured for `postgres-queue`, then run:

```bash
DATABASE_URL=[local secret reference] \
SMOKE_BASE_URL=http://127.0.0.1:3102 \
SMOKE_SERVER_WORKDIR=/private/ownminutes-runtime \
npm run smoke:finalization-queue-runtime
```

The runtime smoke verifies 202 enqueue, duplicate-job idempotency, Worker completion, expired-lease reclaim, retry after audio restoration, meeting-delete cancellation, usage charged once, account cleanup, and no secret leakage. It is strong local evidence, not a substitute for managed production PostgreSQL and multi-instance acceptance.

The repository production-like stack also runs a destructive Worker recovery drill:

```bash
npm run stack:up
npm run stack:test
```

The drill uses PostgreSQL, private MinIO storage, and two independent Worker containers. It stops Worker 2, queues a held job on Worker 1, kills Worker 1 after the database records its lease, explicitly keeps Worker 1 stopped despite its restart policy, starts Worker 2, waits for the 30-second lease to expire, and requires the second Worker identity to complete attempt 2 exactly once. It then verifies a temporary failure enters `retry_wait` and succeeds on attempt 2, while a persistent temporary failure stops at the configured third attempt. Finally it restores both Workers, deletes the test account, and requires zero remaining queue jobs and no internal error or secret exposure.

The production-like Compose profile explicitly uses `TRANSCRIPTION_PROVIDER=mock`. This keeps the destructive queue drill deterministic and prevents local or CI orchestration checks from depending on real provider credentials or creating paid usage. Formal ASR behavior remains covered by its dedicated provider tests and private acceptance evidence; the formal production Compose profile remains configured for the real provider.

Fault injection is inert unless both `OWNMINUTES_RUNTIME_PROFILE=production-like` and `OWNMINUTES_FINALIZATION_TEST_HOOKS=1` are present. These variables exist only in `deploy/compose.production-like.yml`; they must never be copied into `deploy/compose.production.yml` or a managed environment. GitHub Actions runs the same production-like drill, but neither local Docker nor CI clears the managed PostgreSQL and multi-instance production acceptance boundary.
