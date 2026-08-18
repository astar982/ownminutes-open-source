# Account deletion cleanup dead-letter runbook

## Why this gate exists

Account deletion invalidates authentication immediately, then a durable Worker removes account-owned recording objects. A permanently failing object-store or ownership check must not retry forever, must not be reported as `deleted`, and must not be hidden by a green readiness result.

After 12 failed claims the job remains in `account_deletion_cleanup_jobs`, receives `dead_lettered_at`, and stops being claimed automatically. The deletion receipt remains `pending_cleanup`; the admin deletion-cleanup endpoint and admin page expose only bounded one-way account references.

An isolated deletion-cleanup incident must not make Caddy remove every otherwise healthy Web replica. Public `/api/readyz` therefore keeps traffic health in `ok`/HTTP status and exposes only the additional boolean `releaseReady`. A deletion-cleanup incident leaves traffic health green but sets `releaseReady=false`; strict promotion verification and `account-cleanup:gate` must fail.

## Observe safely

1. Sign in with an admin account and request `GET /api/admin/deletion-cleanup?limit=25`.
2. Inspect `accountCleanup.deadLetteredCount`, `expiredClaimCount`, `overdueRunnableCount`, `maxAttempt`, and the pseudonymous inventory.
3. Confirm the authenticated runtime readiness `deletion-cleanup` check is red and the public `/api/readyz` response has `releaseReady=false`. Its public contract intentionally contains no inventory or internal error detail.
4. Investigate the database, object-store access, ownership blocker, Worker health, and backup state on the private server. Do not copy raw user ids, database URLs, object keys, manifests, or credentials into chat, GitHub, Obsidian, screenshots, or ordinary incident notes.

Run the aggregate-only release gate from the private runtime environment:

```bash
npm run account-cleanup:gate
```

It uses a read-only repeatable-read PostgreSQL transaction and fails closed on missing migration `0033`, dead-letter, expired claim, overdue runnable work, stale/wrong-version storage-integrity state, or any unattributed prefix. It does not print account ids, object prefixes, database errors, or credentials.

Do not delete the cleanup job and do not set `dead_lettered_at` to null manually. Removing the row can make an unresolved deletion appear complete.

## Replay one reviewed job

Replay is allowed only after the underlying failure is repaired and the pseudonymous admin reference has been matched to the exact private database row.

1. Create a JSON file outside the repository on the private server:

   ```json
   {
     "userId": "the-exact-private-deleted-user-id"
   }
   ```

2. Restrict the file to the operator:

   ```bash
   chmod 600 /private/path/account-cleanup-replay.json
   ```

3. Confirm the account is soft-deleted, the job is dead-lettered, the root cause is fixed, backups are current, and Workers are healthy. Then run:

   ```bash
   OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_INPUT_FILE=/private/path/account-cleanup-replay.json \
   OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_OPERATOR='ops-reviewer' \
   OWNMINUTES_ACCOUNT_CLEANUP_REPLAY_CONFIRM=RETRY_DEAD_LETTERED_ACCOUNT_CLEANUP \
   npm run account-cleanup:replay
   ```

The command requires PostgreSQL mode, a private `0600` input, an exact confirmation phrase, a soft-deleted account, and an existing dead-lettered job. It resets only that job's retry state, records a pseudonymous operator reference and replay count, and prints only a one-way account reference. It never deletes the durable job directly.

## Close the incident

1. Wait for the deletion Worker and query the user's deletion receipt; require `status=deleted` only after the job and every owner-linked catalog, transfer, tombstone, and object record are gone.
2. Require `deadLetteredCount=0`, `expiredClaimCount=0`, `overdueRunnableCount=0`, a fresh zero-blocker storage-integrity epoch, `releaseReady=true`, and a passing `npm run account-cleanup:gate`.
3. Record only pseudonymous references, timestamps, replay count, root-cause category, backup reference, and final gate status in the private incident record.
4. Securely remove the private input file when incident-retention policy permits.

Server migration or replay is an explicit production operation. Do not run either from ordinary source repair or CI work without deployment authority.
