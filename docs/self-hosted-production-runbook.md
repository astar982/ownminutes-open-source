# Self-hosted Production Runbook

## Purpose

This runbook deploys one OwnMinutes public environment on a Linux server with:

- Caddy automatic HTTPS and HTTP-to-HTTPS redirects.
- One Next.js API/Web process.
- Two durable finalization workers.
- PostgreSQL 16 with persistent storage and automatic migrations.
- Private MinIO storage with versioning, retention, and a prefix-restricted application user.
- Docker Secret files instead of plaintext database, storage, or application secrets in Compose.
- A one-shot administrator bootstrap that completes before public registration is exposed.

It is a practical staging and early-production topology. The optional `deploy/compose.vault.yml` adds the implemented Vault Transit BYOK encryption runtime when `OWNMINUTES_SECRET_STORE=vault-transit`; local Compose success still does not replace real Vault policy/rotation/recovery evidence, external monitoring, real ASR quality evidence, Apple IAP evidence, or TestFlight device evidence.

## Server And DNS

Use a Linux host with at least 4 CPU cores, 8 GB RAM, 100 GB persistent disk, Docker Engine, and Docker Compose v2. Place the repository in an ASCII-only absolute path such as `/srv/ownminutes`; the local macOS repository path contains Chinese characters and can trigger a Docker BuildKit gRPC header failure.

Before deployment:

1. Point the chosen hostname A/AAAA record to the server.
2. Allow inbound TCP 80 and TCP/UDP 443.
3. Do not expose PostgreSQL 5432 or MinIO 9000/9001.
4. Confirm the server clock and automatic security updates are healthy.
5. Put the server disk and Docker volumes on monitored persistent storage.

## Initialize

From the exact Git commit to deploy:

```bash
cd /srv/ownminutes
npm ci
npm run production:init -- --domain talk.example.com --email ops@example.com \
  --admin-email owner@example.com --admin-name "Owner" \
  --support-email support@example.com
```

The initializer creates:

- `deploy/.env.production` with mode `0600`.
- Eight independent random credentials under `deploy/secrets/`, each with mode `0600`, including a one-time administrator bootstrap password and a separate backup encryption key.
- An immutable release id and image tag derived from the checked-out Git commit.

Both paths are ignored by Git. Never send them through chat, commit them, or store them in Obsidian.

Before the App or Workers start, the `admin-bootstrap` service runs after migrations. It creates exactly one administrator only when the users table is empty. Public `/register` requests always create `user` accounts, so an unknown first visitor cannot claim `/admin`. On later deployments, an existing administrator is preserved and its password is not reset. If users exist but no active administrator exists, startup fails closed and requires operator recovery instead of silently promoting a public user.

Authentication rate limits trust only `X-OwnMinutes-Client-IP`, which Caddy overwrites with `{remote_host}` before proxying. Do not expose the App container directly and do not enable `OWNMINUTES_TRUST_PROXY_HEADERS=1` behind a proxy that allows clients to preserve this header. Public `X-Forwarded-For` supplied by callers is not accepted as the rate-limit identity.

Read the generated password directly from `deploy/secrets/admin-bootstrap-password` on the server, sign in once, change it immediately in the account center, and keep the bootstrap file private for disaster recovery. Do not paste it into a shell argument, ticket, chat, GitHub, or Obsidian.

Edit only non-secret provider and email settings in `deploy/.env.production`. BYOK users can configure their own providers in the app, so global Volcano/Ark credentials are optional for the first private beta. For public commercial use, configure Vault Transit following `docs/secret-management-runbook.md`; the host Vault token stays in a `0600` file and is mounted only into the App and Workers. Public registration requires a verified Resend sender, bounce/complaint policies, and `OWNMINUTES_REQUIRE_EMAIL_VERIFICATION=1`; registration does not issue a session until the one-time email link is confirmed.

Use Vault Agent/AppRole or an equivalent workload identity to renew the runtime token into that file. The runtime policy is encrypt/decrypt-only for the single OwnMinutes Transit key; key creation, rotation, policy management, audit configuration and backup/recovery belong to a separate operations identity. Before public traffic, run `OWNMINUTES_VAULT_LIVE_VERIFY=1 npm run secret:vault:live:verify` and retain the ignored 0600 JSON evidence.

## Preflight And Start

```bash
npm run production:preflight
npm run production:config
npm run production:up
npm run production:status
```

Preflight rejects:

- Local, LAN, wildcard, path-bearing, or placeholder domains.
- Placeholder TLS email.
- A release id that does not match the checked-out Git commit.
- A dirty Git worktree whose contents cannot be reproduced from the release id.
- `latest` as the OwnMinutes application image tag.
- Missing, short, reused, relative, or group/world-readable secret files.
- Missing administrator identity, unsafe bootstrap password file, or first-user admin fallback.
- Missing email provider, verified sender/domain, bounce/complaint policy, forced email verification, or enabled local token response.
- Invalid object retention or simulated billing.

`production:up` runs migration `0001` through the latest migration, including the email verification migration, then the administrator bootstrap, before App and Worker startup. Existing accounts receive their historical creation time as the verified timestamp; new production registrations remain unverified until confirmation. Caddy obtains the certificate only after public DNS and ports are correct.

## Verify

```bash
npm run production:status
npm run production:verify
npm run production:logs
```

`production:verify` first runs the aggregate-only account-deletion cleanup gate inside the live App runtime, then checks public HTTPS pages, login redirect, legal pages, traffic health, `releaseReady`, deployment diagnostics, and release readiness from outside the containers. A cleanup incident does not remove healthy Web replicas from Caddy, but it does fail promotion. This still must not be interpreted as commercial acceptance while any other release blocker remains.

Also verify manually:

```bash
curl -fsS https://talk.example.com/api/health
curl -I https://talk.example.com/privacy
curl -I https://talk.example.com/terms
curl -I https://talk.example.com/support
```

Then use a disposable account to run registration, login, a short recording, finalization, share/revoke, Markdown export, meeting deletion, and account deletion. Remove the account and all test objects afterward.

## Data Protection

The Compose stack intentionally exposes only Caddy. PostgreSQL and MinIO stay on an internal Docker network. The MinIO application credential can access only `ownminutes/meetings`; it cannot write outside that prefix. A separate cleanup credential can list key names under the meeting prefix but can delete only nested `transient` and `uploads` objects; it cannot read or write meeting content. No long-running helper receives the MinIO root credential; root access is limited to MinIO and explicit one-shot initialization or backup jobs.

Canonical current meeting objects do not expire automatically; they remain until the user or an authorized API deletes them. An authorized meeting/account deletion physically purges every current and retained version immediately. Superseded noncurrent versions that do not belong to a user deletion are removed after the default 7-day recovery window, transient ASR copies after 7 days, and incomplete resumable uploads after 2 days; orphan delete markers are removed as well. Initialization replaces lifecycle rules deterministically instead of appending duplicates. Review these periods against the published privacy policy and deletion promise before public launch. Versioning and retention are not backups.

At least daily, create and verify an authenticated encrypted backup:

```bash
npm run production:backup
npm run production:backup:verify
npm run production:backup:replicate
npm run production:backup:freshness
```

The first two commands stream a PostgreSQL custom dump, mirror current MinIO objects using the root credential only inside the one-shot backup container, record byte sizes and SHA-256 values, and encrypt the archive with scrypt plus AES-256-GCM. Replication uploads the newest `.ombak` to an independent S3-compatible bucket, downloads the complete remote object, and requires byte-for-byte SHA-256 equality before writing private evidence. Freshness fails when the local artifact or remote evidence is older than policy, the remote evidence does not match the latest artifact, or the monthly restore drill is stale.

Create the destination bucket as private before enabling replication. Create a dedicated backup identity limited to bucket location, prefix-scoped list, and Get/Put on `OWNMINUTES_BACKUP_OFFSITE_PREFIX`; it must not create buckets, change anonymous policy, administer users, or access unrelated prefixes. Store its access key and secret key in two additional mode `0600` files and configure `OWNMINUTES_BACKUP_OFFSITE_*` in `deploy/.env.production`. The endpoint must be public HTTPS without URL credentials, paths, query strings, or non-default ports. Do not reuse the application object-storage credential, do not point the destination at the same bucket/failure domain, and escrow `backup-encryption-key` independently from both local and off-site artifacts.

Render a persistent daily systemd timer after reviewing the generated files:

```bash
npm run production:backup:systemd -- --user ownminutes \
  --working-directory /srv/ownminutes \
  --production-env-file /srv/ownminutes/deploy/.env.production \
  --output-dir /tmp/ownminutes-systemd
sudo cp /tmp/ownminutes-systemd/ownminutes-backup.service /etc/systemd/system/
sudo cp /tmp/ownminutes-systemd/ownminutes-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ownminutes-backup.timer
sudo systemctl start ownminutes-backup.service
sudo systemctl status ownminutes-backup.service ownminutes-backup.timer
```

The timer is persistent and uses a randomized delay. A nonzero result from create, verify, replicate, or freshness fails the service. Connect failed-unit monitoring to the host alerting system and review `journalctl -u ownminutes-backup.service`; the repository does not send logs or credentials to a third-party alert destination automatically.

Every month run `npm run production:restore-drill` against a recent off-site artifact on a separate host, then run `npm run production:backup:freshness`. The restore command verifies authenticated decryption and every checksum, restores PostgreSQL and current objects into disposable PostgreSQL/MinIO containers, records counts, and cleans the drill runtime. Then open a known meeting in an isolated application environment and verify audio/result/Markdown reads. A backup that has not been restored is not accepted evidence.

The `.ombak` artifact contains current object versions only. Deleted and noncurrent MinIO versions require independent bucket replication or a version-aware managed backup policy; do not infer that the 7-day version recovery window is preserved by this artifact.

## Upgrade And Rollback

1. Back up PostgreSQL and MinIO off-host.
2. Pull the target commit and review migrations.
3. Run `production:init` only for the first install; never overwrite existing secrets during an upgrade.
4. Update `OWNMINUTES_RELEASE_ID` and `OWNMINUTES_IMAGE` in `deploy/.env.production` to the exact target commit/tag.
5. Run `production:preflight`, `production:config`, and `production:up`.
6. Run `production:verify` and a short private meeting.

For application rollback, restore the previous Git commit and image tag. Do not reverse a PostgreSQL migration blindly. If a migration is not backward compatible, follow its documented restore/forward-fix procedure using the pre-upgrade backup.

## Incident Boundaries

- If recording uploads fail, clients must keep local audio and retry; do not ask users to rerecord before checking pending sync.
- If ASR or summary providers fail, preserve audio and mark results unverified rather than publishing fabricated minutes.
- If a Worker crashes, the PostgreSQL lease permits bounded retry; inspect job attempts before manual requeue.
- If a secret may be exposed, rotate the affected credential, invalidate sessions where applicable, inspect sanitized audit events, and do not paste the credential into an issue or handoff file.
- If Caddy cannot renew TLS, keep the service out of TestFlight/public use until `production:verify` passes again.

## Acceptance Boundary

This stack can remove the implementation gap for a stable self-hosted HTTPS environment after it is deployed and verified on a real server/domain. Local Compose success alone does not clear `public-url`, `database`, `object-storage`, `secret-management`, TestFlight, Apple IAP, or real multi-speaker ASR blockers.
