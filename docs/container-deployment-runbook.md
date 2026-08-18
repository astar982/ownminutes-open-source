# OwnMinutes Container Deployment Runbook

This runbook provides a repeatable local production-like topology for OwnMinutes. It is intended to prove that the application image, PostgreSQL migrations, two durable queue workers, cross-instance meeting locks, and S3-compatible private object storage can start together.

It does not replace managed production evidence, TLS, off-host backup storage, minimum-privilege cloud roles, KMS, public HTTPS, Apple sandbox, or real ASR acceptance.

## Topology

```text
127.0.0.1:3200 -> app
app -> PostgreSQL 16
app -> private MinIO bucket
worker-1 -> same PostgreSQL and object store
worker-2 -> same PostgreSQL and object store
migrate -> applies db/migrations before app and workers start
```

PostgreSQL and MinIO are only attached to an internal Docker network. App and Worker containers also use a separate egress network for provider calls; only the App Web/API port is published, and it binds to `127.0.0.1`.

## Start

```bash
npm run smoke:container
npm run stack:up
npm run stack:test
```

`stack:up` creates `.data/production-like/stack.env` with random local-only PostgreSQL, MinIO, and application secrets. The file is mode `0600`, ignored by Git, and its values are never printed.

Because Docker BuildKit can fail when the repository path contains Chinese characters, the command automatically rsyncs a secret-free source snapshot to the ASCII system temporary directory before building. The generated stack environment is copied there with mode `0600`; `.git`, `.data`, `.next`, and dependency directories are excluded. The temporary directory is removed by `stack:reset`.

The command then builds the production Docker image, runs all migrations, creates a private versioned MinIO bucket, starts the app and two queue workers, and waits for `/api/health`. Canonical current meeting objects do not expire automatically; an authorized meeting/account deletion physically purges all versions immediately. The local stack keeps superseded noncurrent versions for up to 7 days, transient ASR copies for 7 days, and incomplete resumable uploads for 2 days.

Expected verification:

- auth repository is `postgres`;
- finalization mode is `postgres-queue`;
- meeting write lock is `postgres-advisory` with durable deletion fence;
- storage provider is `s3`;
- app, PostgreSQL, MinIO, worker-1, and worker-2 are running.

`stack:test` then runs the authenticated business path against that topology: register, upload an audio chunk, enqueue finalization, wait for a Worker, read the remote result, publish and revoke a share link, delete the meeting, and delete the account. The isolated stack explicitly selects the mock transcription provider and contains no production model credentials. The smoke therefore validates queue, PostgreSQL, private object-storage, sharing, and deletion orchestration; it does not validate ASR quality and it must not silently exercise a paid provider.

## Encrypted Backup And Restore Drill

Create and authenticate an encrypted backup of PostgreSQL plus the current objects in MinIO:

```bash
npm run stack:backup
npm run stack:backup:verify
npm run stack:backup:replicate
npm run stack:restore-drill
npm run stack:backup:freshness
```

The `.ombak` artifact uses scrypt key derivation and AES-256-GCM authenticated encryption. Its internal manifest records the database dump and every current object with byte size and SHA-256. The restore drill decrypts and verifies the artifact, restores PostgreSQL into a disposable PostgreSQL 16 container, restores objects into a disposable MinIO container, checks record/object counts, and removes the temporary containers and network. Private local evidence is written to `.data/acceptance/backup-restore-latest.json` with mode `0600`.

For the production Compose stack use:

```bash
npm run production:backup
npm run production:backup:verify
npm run production:restore-drill
```

Schedule the full `production:backup` -> `production:backup:verify` -> `production:backup:replicate` -> `production:backup:freshness` chain at least daily. Replication requires a separate S3-compatible destination and performs a full remote download checksum before recording success. Run `production:restore-drill` against a recent off-site artifact on a separate host at least monthly. Monitor failed systemd units and backup age. Never copy the encryption key beside the artifact.

This backup contains the PostgreSQL database and current object versions. It does not preserve deleted or noncurrent MinIO versions; use bucket replication or a version-aware managed backup policy for that recovery window. The application backup key is generated as a separate 0600 secret and must be escrowed in a managed secret store.

## Inspect

```bash
npm run stack:status
npm run stack:verify
docker compose --env-file .data/production-like/stack.env -f deploy/compose.production-like.yml logs --tail 100
```

The local API is available at:

```text
http://127.0.0.1:3200
```

## Stop Or Reset

Stop containers while preserving local database and object-storage volumes:

```bash
npm run stack:down
```

Delete containers, volumes, and generated local-only secrets:

```bash
npm run stack:reset
```

## Production Boundary

Before a real deployment, replace local PostgreSQL and MinIO with managed services, require TLS, use minimum-privilege credentials, replicate encrypted backups off-host, connect KMS or a managed secret store, set real public HTTPS URLs, and complete every private acceptance evidence file.

Do not copy `.data/production-like/stack.env` to production. Do not expose PostgreSQL or object-storage ports publicly. Do not mark the database, queue runtime, object storage, secret management, or public URL readiness blockers complete from this local stack alone.
