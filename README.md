# OwnMinutes

Meeting notes you own. Models and costs you control.

OwnMinutes is an open source meeting recorder and AI meeting notes product. It is designed for people who need reliable meeting notes but do not want to buy dedicated recording hardware or stay locked into expensive meeting-note subscriptions.

[![Verify OwnMinutes](https://github.com/astar982/ownminutes-open-source/actions/workflows/ci.yml/badge.svg)](https://github.com/astar982/ownminutes-open-source/actions/workflows/ci.yml)

> **Early-stage software:** OwnMinutes is not yet a stable release. Do not use it
> as the only copy of an important recording. Obtain consent before recording,
> review generated notes, and keep your provider credentials out of issues,
> screenshots, logs, and pull requests.

The official app is intended to be free to download. Users register an account, sign in, configure their own model providers, and pay model providers directly with their own API keys.

## Product Positioning

- Record meetings from the app.
- Generate realtime transcript drafts.
- Re-process the full recording after the meeting for higher quality notes.
- Create summaries, decisions, action items, risks, open questions, and Obsidian Markdown.
- Share meeting notes through a link.
- Let users bring their own ASR and LLM provider keys.
- Keep model cost under user control.

OwnMinutes is not trying to sell model credits in the first phase. The default model is BYOK: Bring Your Own Key.

## Open Source Use

OwnMinutes is released under the Apache License 2.0.

You may:

- Use it personally.
- Self-host it.
- Modify it.
- Build your own commercial product from it.
- Redistribute it under the terms of Apache-2.0.

You must:

- Keep the `LICENSE` file.
- Keep the `NOTICE` file.
- Mark files that you modify when you redistribute a derivative work.
- Retain applicable copyright, patent, trademark, and attribution notices as required by Apache-2.0.

The preferred public credit is:

> OwnMinutes — created by Wang Pengyuan (@astar982). Licensed under the Apache
> License 2.0. Source: https://github.com/astar982/ownminutes-open-source

Read [ATTRIBUTION.md](ATTRIBUTION.md) for the exact redistribution requirements
and the project's hosted-use request. Apache-2.0 does not require an in-product
attribution screen merely for hosted-only use. Starring the original repository
is appreciated, but never required by the license.

## Current Status

This repository is still an early product prototype. It already includes:

- Next.js web app.
- Expo / React Native iOS app prototype.
- Meeting recorder workspace.
- Durable iOS AAC/M4A recording with local recovery.
- Resumable 4 MiB full-recording uploads with SHA-256 verification and bounded-memory server-side assembly.
- File-based post-meeting ASR delivery through short-lived private object-storage URLs, with no production Base64 audio copy.
- Account-scoped recording-upload reservations, stale staging reclamation, and server-directed retry backoff.
- Browser microphone recording.
- Microphone selection, volume monitoring, chunk statistics, and recording health status.
- Audio chunk upload API and local server-side chunk storage.
- Provider abstraction for mock / OpenAI / Volcano.
- Provider diagnostics API that never returns raw secrets.
- Volcano account-level diagnostics and OpenAPI probing.
- Post-meeting processing API.
- Ark / Doubao summary integration.
- Post-meeting speaker review: rename global Speaker labels or correct individual transcript segments. Segment corrections persist to the formal transcript, public transcript, and Obsidian Markdown while summary attribution and action owners remain explicitly subject to human review.
- Share page prototype.
- Obsidian Markdown generation.
- Provider settings center at `/settings`.
- User-facing provider setup guide with BYOK steps, minimum Volcano ASR / Ark fields, and account-center save entry.
- Login and registration UI at `/login` and `/register`.
- Pricing UI at `/pricing`.
- Local account/session API with HttpOnly cookies.
- Account center at `/account`.
- Admin MVP at `/admin`.
- Admin commercial summary for provider setup, activation, paid-plan conversion, BYOK-only, official-only, and hybrid usage paths.
- Encrypted local BYOK provider credential storage.
- Account data export with account profile, usage, Provider masked summaries, Provider health, and meeting list.
- Logged-in meeting finalization can use user-level BYOK provider credentials before falling back to server `.env.local`.
- Logged-in meeting finalization records official minute usage.
- Meeting finalization persists `queued / processing / completed / failed` state, deduplicates concurrent requests, uses an expiry lease for crash recovery, and returns an existing result idempotently without charging usage twice.
- Production deployments can opt into a PostgreSQL finalization queue: the API returns `202`, Node workers claim jobs with `FOR UPDATE SKIP LOCKED`, refresh leases, reclaim crashed work, retry with bounded backoff, and Web/iOS poll the durable result state.
- PostgreSQL runtime now shares one bounded connection pool and can coordinate all meeting mutations with an advisory lock. A durable deletion tombstone prevents late audio chunks or worker results from recreating a deleted remote object prefix.
- Meeting audio manifests now store owner and share visibility metadata.
- Share links are private by default; owners must explicitly publish a public link.
- Publishing an unverified/fallback result requires an explicit `confirmUnverified` acknowledgement at the API boundary; a UI confirmation alone is not treated as sufficient authorization.
- Account center includes a meeting history panel for previewing, publishing, revoking, and toggling transcript visibility.

Main known gap:

- Local preview defaults to `.data/auth/`; the production Compose path uses PostgreSQL, a durable finalization queue, private object storage, and a fail-closed administrator bootstrap. A real host/domain, backup restore drill, and managed KMS evidence are still required.
- Apple IAP transaction verification, account binding, lifecycle notifications, and the native purchase flow are wired; real App Store Connect products, public Server Notifications V2, and TestFlight sandbox lifecycle evidence are still required.
- Public registration always creates a normal user. Production creates the initial administrator before the App starts from a 0600 Docker Secret; the old “first visitor becomes admin” behavior is disabled.
- Production registration requires one-time email verification before any login session is issued. Verification and password-reset tokens are hashed, expire, are single-use, and are removed with the account; existing users are grandfathered during migration.
- Login, registration, and password-reset rate limits trust only the client IP header overwritten by the bundled Caddy proxy; caller-supplied public `X-Forwarded-For` cannot select a fresh rate-limit bucket.
- Real Volcano ASR still needs speech runtime credentials: `VOLCANO_ASR_API_KEY` or `VOLCANO_ASR_APP_ID + VOLCANO_ASR_TOKEN`.
- Realtime Volcano ASR WebSocket protocol, heartbeat, bounded reconnect, finish handshake, and failure isolation are implemented. Production use still requires a speech runtime credential plus real weak-network and Mandarin-meeting evidence.
- Commercial ASR readiness requires a private structured batch of at least three real 2-4 person Mandarin meetings. `npm run asr:meeting-batch:collect` binds retained audio and provider evidence by SHA-256; `npm run asr:meeting-batch:check` rejects synthetic, stale, unconsented, low-quality, incomplete, or hand-typed evidence.
- Local Xcode TestFlight candidates can be validated and uploaded without EAS through `mobile:ios:local:upload-preflight`, `mobile:ios:local:validate`, and the double-gated `mobile:ios:local:upload`; signing probes, tampered packages, dirty/stale commits, local API origins, and non-private App Store Connect key files are rejected.

## Local Preview

Prerequisites: Node.js `22.22.x` and npm `11.8.x`.

```bash
npm install
npm run build
npm run preview -- --port 3003
```

Open:

```text
http://127.0.0.1:3003
```

For microphone recording, prefer production preview over `next dev`:

```bash
npm run preview:screen
```

This starts a detached `screen` session at `http://127.0.0.1:3003/`.

## Production-like Container Stack

Docker Desktop can run a local production-like topology with the Next.js app, PostgreSQL migrations, two durable finalization workers, PostgreSQL advisory locks, and a private S3-compatible MinIO bucket:

```bash
npm run smoke:container
npm run stack:up
npm run stack:test
```

Open `http://127.0.0.1:3200`. `stack:test` proves the authenticated upload, queued post-meeting processing, remote result storage, public sharing, revocation, meeting deletion, and account cleanup path. Generated local credentials stay under ignored `.data/production-like/` and are never printed.

Use `npm run stack:down` to preserve local volumes or `npm run stack:reset` to remove the stack, volumes, and generated local secrets. See [docs/container-deployment-runbook.md](docs/container-deployment-runbook.md) for topology and production boundaries.

## Mobile App

```bash
npm run mobile:ios
```

For iPhone testing, set the API Base URL to your Mac LAN IP, not `localhost`.

Example:

```text
http://192.168.1.10:3003
```

## Provider Configuration

Copy `.env.example` to `.env.local` and configure your provider.

```bash
TRANSCRIPTION_PROVIDER=volcano

VOLCANO_ASR_API_KEY=
VOLCANO_ASR_APP_ID=
VOLCANO_ASR_TOKEN=

ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_CHAT_MODEL=
```

You can inspect provider readiness from:

```text
/settings
GET /api/settings/providers
GET /api/providers/diagnostics
```

Logged-in users save encrypted BYOK credentials in `/settings`. The guided setup supports Volcano ASR API Key, or AppID + Token, plus Ark API Key, Endpoint ID, and optional Base URL. Secret fields use password semantics by default, can only be revealed with an explicit control, disable common password-manager autofill, and are cleared when switching between ASR and Ark before saving.

## Account MVP

The official OwnMinutes app should require account registration and login. The account system is for:

- User count.
- Device sync.
- Provider configuration status.
- Share permissions.
- Usage analytics.

Self-hosted or derivative versions may change or remove this requirement.

Current routes:

```text
/login
/register
/verify-email
/pricing
/account
/admin
/app
```

Current account APIs:

```text
POST /api/auth/register
POST /api/auth/email-verification/request
POST /api/auth/email-verification/confirm
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
DELETE /api/auth/delete
GET  /api/account/export
GET  /api/account/usage
POST /api/account/plan
GET  /api/account/provider-credentials
POST /api/account/provider-credentials
GET  /api/account/provider-health
GET  /api/meetings
GET  /api/meetings/:id/finalize
POST /api/meetings/:id/finalize
POST /api/meetings/:id/share
```

Provider secrets are encrypted before local storage and are never returned to the browser. API responses only include configured field names and secret previews.
The account export API returns only account, usage, Provider masked summaries, Provider health, and meeting metadata. It does not include raw audio, full transcripts, Markdown content, encrypted secrets, or plaintext keys.

When a logged-in user finalizes a meeting, the backend first tries that user's saved BYOK configuration for Volcano ASR and Ark summary. If a user-level provider is not saved, it falls back to server environment variables. The durable finalization state is stored at `{{meetingId}}/processing.json`; it contains only status, attempts, lease timestamps, result quality, and scrubbed errors.

Meeting upload and finalization require login. The first audio chunk binds a meeting to the current user. Share pages remain private until the owner publishes a link; public links default to summary, decisions, and actions only, with transcript hidden unless explicitly enabled.

Smoke tests:

```bash
npm run smoke:auth
npm run smoke:email-verification
npm run smoke:email-verification-postgres
npm run smoke:closed-loop
npm run smoke:finalization-recovery
npm run smoke:finalization-queue
npm run smoke:meeting-write-coordination
```

## Monetization Direction

OwnMinutes should use a free acquisition model:

- `Free`: BYOK is free forever, plus a small official trial quota.
- `Plus`: US$7.99/month with 600 official minutes for users who want less setup work.
- `Pro`: US$19.99/month with 1,800 official minutes for heavier monthly meeting volume.

Free includes a one-time 60-minute official trial and does not renew that trial monthly. On iOS, Plus and Pro use Apple In-App Purchase. BYOK remains the cost-control differentiator. Minute packs are not part of the overseas launch catalog and must not be shown as purchasable until a StoreKit product and matching server entitlement lifecycle exist.

## Documentation

- `docs/product-plan.md`
- `docs/architecture.md`
- `docs/commercial-provider-settings.md`
- `docs/ios-app-implementation.md`
- `docs/transcription-providers.md`
- `docs/recording-reliability.md`
- `docs/finalization-recovery.md`
- `docs/finalization-queue-runbook.md`
- `docs/obsidian-template.md`
- `docs/testflight-checklist.md`
- `docs/privacy-policy-draft.md`

## Contributing, Support, and Security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Read [GOVERNANCE.md](GOVERNANCE.md) for decision-making and maintainer roles.
- See [MAINTAINERS.md](MAINTAINERS.md) and [.github/CODEOWNERS](.github/CODEOWNERS)
  for current ownership.
- Use [ATTRIBUTION.md](ATTRIBUTION.md), [AUTHORS.md](AUTHORS.md), and
  [CITATION.cff](CITATION.cff) when crediting the project or its contributors.
- Follow [TRADEMARKS.md](TRADEMARKS.md) when naming a fork, service, or product.
- Use the issue templates for reproducible bugs and focused feature proposals.
- Read [SUPPORT.md](SUPPORT.md) for the support boundary.
- Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting. Never
  post credentials, private recordings, transcripts, or user data in a public issue.
- Community participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Maintainers can use [docs/open-source-publication-checklist.md](docs/open-source-publication-checklist.md)
  when publishing a sanitized repository snapshot.

Public legal routes:

- `/support`
- `/privacy`
- `/terms`
- `/data-deletion`

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
