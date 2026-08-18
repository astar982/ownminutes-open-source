# OwnMinutes PostgreSQL Migration Runbook

This runbook is the production checklist for moving OwnMinutes account runtime data from local JSON to PostgreSQL.

## Current Boundary

- Default runtime repository: `local-file`
- PostgreSQL runtime repository: guarded by `OWNMINUTES_AUTH_REPOSITORY=postgres`
- Current PostgreSQL runtime writes: implemented in `src/lib/server/auth-repository.ts`
- Existing migration files: `db/migrations/0001_initial.sql` through `db/migrations/0033_account_deletion_cleanup_observability.sql`
- PostgreSQL durable queue: `meeting_finalization_jobs` plus `src/lib/server/finalization-queue.ts`
- Shared PostgreSQL pool: `src/lib/server/postgres-runtime.ts`
- Cross-instance meeting writes: PostgreSQL advisory lock plus `meeting_deletion_tombstones`
- Existing migration runner: `scripts/run-postgres-migrations.mjs`
- Existing auth-store export: `scripts/export-auth-store-to-postgres.mjs`

Do not set `OWNMINUTES_AUTH_REPOSITORY=postgres` in production until the target database has been migrated, imported, backed up, and smoke-tested with the same environment.

### Lock Contention Behavior

Lock contention is a recoverable availability event, not an ownership or deletion failure. When a PostgreSQL advisory meeting/user lock cannot be acquired before `OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS`, the API returns HTTP `503` with code `meeting_write_lock_timeout`, `retryable: true`, and a `Retry-After` header. Recording clients must retain local audio and retry; finalization workers must use their bounded retry policy. Normal `403`, `404`, and `410` meeting errors remain non-retryable.

## Required Environment

Production deployment must define:

- `DATABASE_URL` or `POSTGRES_URL`
- `OWNMINUTES_DB_MIGRATION_COMMAND`
- `OWNMINUTES_DB_BACKUP_POLICY`
- `OWNMINUTES_DB_RESTORE_DRILL`
- `OWNMINUTES_DB_MIN_ROLE`
- `OWNMINUTES_DB_AUDIT_LOG`
- `OWNMINUTES_DB_SSL_REQUIRED=1`
- `OWNMINUTES_DB_LOCAL_STORE_DECISION`
- `OWNMINUTES_FINALIZATION_MODE=postgres-queue`
- `OWNMINUTES_FINALIZATION_WORKER=1` on worker-capable stateful Node instances
- `OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER=1` on the same worker-capable stateful Node instances
- `OWNMINUTES_FINALIZATION_WORKER_INSTANCES` with at least `2` for production acceptance
- `OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory`

Do not commit database URLs, passwords, API keys, cookies, or generated SQL imports.

## Preflight

Run these commands before touching a real database:

```bash
npm run smoke:database-preflight
npm run smoke:database-schema
npm run smoke:database-migrate
npm run smoke:database-export
npm run smoke:database
npm run smoke:auth-repository
npm run smoke:database-evidence
npm run smoke:finalization-queue
npm run smoke:meeting-write-coordination
npm run smoke:account-deletion-cleanup-gate
```

Expected state before runtime migration:

- Schema smoke passes.
- Production database preflight smoke confirms missing env fails, database-only env fails, and complete env passes without leaking the database URL.
- Migration dry-run passes and reports:
  - `hasUniqueVersions: true`
  - `hasMonotonicOrder: true`
  - `eachMigrationRecordsItself: true`
  - `destructiveSqlReviewed: true`
  - `destructiveSqlFree` remains a truthful inventory flag: it is `false` when a migration contains deletion SQL.
  - `approvedDestructiveMigrations` may contain only version + exact SHA-256 pairs reviewed in `scripts/run-postgres-migrations.mjs`; any content change or new destructive migration must fail closed in `unapprovedDestructiveMatches`.
  - Dry-run and real execution enforce the same policy before any database connection or SQL execution.
- Auth-store export smoke passes.
- Database diagnostics reports `supportsPostgresRuntimeWrites: false` while local-file mode is active.
- Auth repository smoke confirms application code goes through `auth-repository` and PostgreSQL runtime methods exist.
- Production preflight must also confirm restore drill evidence, SSL/TLS enforcement, and a local JSON store import/isolation/removal decision.
- Private acceptance evidence checker validates the real PostgreSQL migration and runtime evidence template and rejects local-file runtime, missing account deletion cleanup, missing SSL/TLS, failed checks, and leaked database URLs.
- Queue smoke verifies `FOR UPDATE SKIP LOCKED`, advisory enqueue serialization, leases, heartbeats, bounded retry, deletion cancellation, API `202`, and Web/iOS polling.
- Meeting write coordination smoke verifies a shared PostgreSQL pool, cross-instance advisory locks, exact concurrent manifest updates, durable deletion tombstones, and rejected late uploads.

## Migration Steps

1. Provision managed PostgreSQL.
2. Configure backups and retention.
3. Create minimum-privilege app role.
4. Set `DATABASE_URL` or `POSTGRES_URL` only in the deployment secret store.
5. Set the production cutover guardrails in the deployment secret store:

```bash
OWNMINUTES_AUTH_REPOSITORY=postgres
OWNMINUTES_DB_MIGRATION_COMMAND="node scripts/run-postgres-migrations.mjs"
OWNMINUTES_DB_BACKUP_POLICY="<managed backup policy and restore drill>"
OWNMINUTES_DB_RESTORE_DRILL="<restore drill evidence or scheduled drill record>"
OWNMINUTES_DB_MIN_ROLE="<minimum privilege app role>"
OWNMINUTES_DB_AUDIT_LOG="<audit log policy>"
OWNMINUTES_DB_SSL_REQUIRED=1
OWNMINUTES_DB_LOCAL_STORE_DECISION="<import, isolate, archive, or destroy local JSON store decision>"
OWNMINUTES_FINALIZATION_MODE=postgres-queue
OWNMINUTES_FINALIZATION_WORKER=1
OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER=1
OWNMINUTES_FINALIZATION_WORKER_INSTANCES=2
OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory
```

6. Run production database preflight against the same environment:

```bash
npm run database:preflight
```

To reduce copy/paste mistakes, generate a private acceptance evidence draft from the same preflight data:

```bash
npm run database:evidence:draft
```

This writes `.data/acceptance/postgres-latest.md` by default. The draft intentionally leaves runtime writes, auth flows, account deletion, backup, restore, minimum privilege, audit, SSL/TLS proof, and local JSON store handling as `pending`; do not change `Decision:` to `pass` until those checks are actually completed.

Advanced use: set `OWNMINUTES_POSTGRES_EVIDENCE_DRAFT_PATH=/private/path/postgres-latest.md` when the draft should be written somewhere else.

7. Run migrations:

```bash
node scripts/run-postgres-migrations.mjs
```

8. Export local auth data for review:

```bash
node scripts/export-auth-store-to-postgres.mjs
```

The generated import requires `0014_lifetime_free_trial` (and therefore all earlier real migrations) to already be recorded in the target database. It never writes `ownminutes_schema_migrations` itself; importing data must not forge schema history.

9. Review the generated SQL locally.
10. Import only after confirming the target database, SSL/TLS mode, backup snapshot, restore drill evidence, and minimum-privilege role.
11. Apply the local JSON store decision: import, isolate, encrypted archive, or destroy. Do not leave writable local JSON state on the production host.
12. Run the post-switch verification gate against the same deployment environment.

After the App and Workers are running and the storage-integrity epoch has been refreshed, run:

```bash
npm run account-cleanup:gate
```

Do not run this gate before Worker startup: migration `0033` creates the state table, while a live deletion Worker establishes the bounded whole-bucket ownership audit. Promotion requires both public `/api/readyz` `releaseReady=true` and the strict aggregate-only gate. Traffic `ok=true` alone is not release evidence.

## Private Acceptance Evidence

Real database URLs, passwords, exports, and generated SQL imports must not be committed. Save sanitized production-like evidence locally:

```text
.data/acceptance/postgres-latest.md
```

Then run:

```bash
npm run database:acceptance:evidence
```

Use `OWNMINUTES_POSTGRES_EVIDENCE_PATH=/path/to/evidence.md` when checking a different private file.

You can start from the automated draft generated by `npm run database:evidence:draft`, then manually replace every `pending` field with the real result. `database:acceptance:evidence` must fail while any required manual field remains pending.

Required evidence fields:

```markdown
# PostgreSQL Acceptance Evidence

Date:
Commit:
Database provider:
Runtime repository: postgres
Finalization mode: postgres-queue
Worker instances: 2
Meeting write lock: postgres-advisory
Migration command:
Migration version:
Backup policy:
Restore drill:
Minimum privilege role:
Audit log policy:
SSL/TLS required: yes
Local JSON store decision:
Database diagnostics: pass
Release readiness databaseBlocked: no
Release readiness finalizationQueueBlocked: no
Release readiness nextAction:

Production preflight: pass
Schema smoke: pass
Migration dry run: pass
Migration applied: pass
Auth export reviewed: pass
Runtime writes: pass
Register/login: pass
Password reset token: pass
Provider credentials save/delete: pass
Meeting metadata write/read: pass
Usage event write/read: pass
Admin metrics: pass
Account deletion cleanup: pass
Queue migration applied: pass
Queue duplicate enqueue: pass
Queue atomic claim: pass
Queue expired lease reclaim: pass
Queue retry recovery: pass
Queue deletion cancellation: pass
Queue account cleanup: pass
Meeting deletion fence migration: pass
Cross-instance chunk write: pass
Deleted meeting recreation blocked: pass
Backup snapshot: pass
Restore drill proof: pass
Minimum privilege proof: pass
Audit log proof: pass
SSL/TLS proof: pass
Local JSON store handled: pass

Secrets leaked: no
Decision: pass
Known issues:
```

Do not paste `DATABASE_URL`, `POSTGRES_URL`, database passwords, raw SQL dumps, cookies, session tokens, provider keys, or customer meeting content.

## Rollback

Before enabling PostgreSQL runtime writes:

- Keep the local JSON auth store read-only and backed up.
- Keep the local JSON auth store out of the production write path; if retained for rollback, store it as an encrypted archive outside the app runtime path.
- Keep `OWNMINUTES_AUTH_REPOSITORY` unset.
- Roll back by removing the PostgreSQL repository env var and redeploying.

After enabling PostgreSQL runtime writes:

- Roll back only after confirming whether writes occurred in PostgreSQL.
- Export PostgreSQL deltas before switching back to local runtime.
- Do not silently fork account state between local JSON and PostgreSQL.

## Verification After Runtime Switch

Once PostgreSQL runtime is selected, the minimum gate is:

```bash
OWNMINUTES_AUTH_REPOSITORY=postgres npm run smoke:auth
OWNMINUTES_AUTH_REPOSITORY=postgres npm run smoke:settings
npm run database:preflight
OWNMINUTES_AUTH_REPOSITORY=postgres npm run smoke:database
OWNMINUTES_AUTH_REPOSITORY=postgres OWNMINUTES_FINALIZATION_MODE=postgres-queue npm run smoke:finalization-queue
OWNMINUTES_AUTH_REPOSITORY=postgres OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory npm run smoke:meeting-write-coordination
npm run smoke:meeting-write-coordination-runtime
OWNMINUTES_AUTH_REPOSITORY=postgres npm run database:acceptance:evidence
OWNMINUTES_AUTH_REPOSITORY=postgres npm run smoke:release
```

Production readiness remains false until real migrations, backups, restore drill, minimum privilege, audit logging, and PostgreSQL runtime writes are verified against the production-like database.
Production readiness also requires SSL/TLS database transport and a documented local JSON store disposal or isolation decision.
The separate finalization queue release gate remains blocked until a real PostgreSQL deployment with at least two worker-capable instances proves duplicate enqueue idempotency, atomic claim, expired-lease reclaim, retry recovery, deletion cancellation, account cleanup, and no secret leakage.
