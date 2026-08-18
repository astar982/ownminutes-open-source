# Public Deployment Runbook

## Current Boundary

OwnMinutes can run locally at `http://127.0.0.1:3002`, but local preview is not acceptable for TestFlight external testing, App Store review, public share links, password reset emails, Apple IAP notifications, or production monitoring.

This runbook verifies the public HTTPS deployment boundary. It does not prove real ASR quality, Apple IAP sandbox purchase success, object storage durability, or database backup quality.

For the repository-owned Caddy + PostgreSQL + MinIO + two-Worker deployment path, follow `docs/self-hosted-production-runbook.md`. The commands `production:init`, `production:preflight`, `production:config`, `production:up`, `production:status`, `production:verify`, `production:logs`, and `production:down` provide the supported single-server lifecycle.

When an existing shared gateway owns ports 80/443, create the dedicated,
internal bridge network `ownminutes_proxy` (for example with
`docker network create --driver bridge --internal ownminutes_proxy`) and attach only that gateway plus the
OwnMinutes App. Set `OWNMINUTES_SHARED_PROXY_NETWORK` to that exact narrow
network in both deployment definitions. Do not reuse a general sibling-project
network such as `junshi_web`: any container on such a network could connect to
the App directly and forge the proxy identity header used for client IP and
same-origin decisions. Before admitting traffic, inspect the network membership
and fail the release if it contains any unexpected container.

## Temporary HTTPS Staging

On macOS, a local production build can be exposed through an account-less Cloudflare quick tunnel for short network-chain tests:

```bash
npm run build
npm run staging:https:up
npm run staging:https:status
npm run staging:https:verify
```

`staging:https:up` starts isolated `ownminutes-https-staging` and `ownminutes-preview` screen sessions, restarts the port 3002 preview with the temporary public URL variables, and stores private runtime state under `.data/staging/`. `staging:https:verify` runs the public deployment preflight, live verifier, and mobile URL preflight against that URL. On macOS it also reuses an enabled system HTTP proxy for Node verification without printing proxy details.

Stop the tunnel when testing is complete:

```bash
npm run staging:https:down
```

The down command restores the normal local preview at `http://127.0.0.1:3003/`. The stop path verifies process ownership before killing a port 3003 listener, so an unrelated local service is left untouched.

This quick tunnel is temporary testing infrastructure only. Its random hostname and account-less runtime have no uptime guarantee. It does not satisfy the stable domain, managed deployment, password-reset email, Apple notification URL, monitoring, backup, or App Store production requirements in this runbook. Never record its random URL as the formal production URL or mark the `public-url` acceptance blocker permanently cleared from this test alone.

## Required Environment

Configure these values only in the deployment secret store:

```bash
OWNMINUTES_APP_URL=https://app.example.com
NEXT_PUBLIC_APP_URL=https://app.example.com
EXPO_PUBLIC_API_BASE_URL=https://app.example.com
OWNMINUTES_MOBILE_API_BASE_URL=https://app.example.com
OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy
OWNMINUTES_TERMS_URL=https://app.example.com/terms
OWNMINUTES_SUPPORT_URL=https://app.example.com/support
OWNMINUTES_SUPPORT_EMAIL=support@example.com
OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health
OWNMINUTES_SAMPLE_SHARE_URL=https://app.example.com/share/example-meeting-id
```

The hostname must not be `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, `10.x.x.x`, `172.16-31.x.x`, or `192.168.x.x`.

Path and origin rules:

- `OWNMINUTES_PRIVACY_URL` must use the same origin as `OWNMINUTES_APP_URL` and end at `/privacy`.
- `OWNMINUTES_TERMS_URL` must use the same origin as `OWNMINUTES_APP_URL` and end at `/terms`.
- `OWNMINUTES_SUPPORT_URL` must use the same origin as `OWNMINUTES_APP_URL` and end at `/support`.
- `OWNMINUTES_SUPPORT_EMAIL` must be a monitored mailbox on a real public domain. Placeholder domains such as `example.com`, `.test`, `.invalid`, `localhost`, or an unmonitored no-reply address are rejected.
- `OWNMINUTES_HEALTH_CHECK_URL` must use the same origin as `EXPO_PUBLIC_API_BASE_URL` or `OWNMINUTES_MOBILE_API_BASE_URL` and end at `/api/health`.
- `OWNMINUTES_SAMPLE_SHARE_URL` is optional but recommended before TestFlight review; when set, it must use the same origin as `OWNMINUTES_APP_URL` and point to `/share/<meetingId>`.

## Preflight

1. Build locally:
   - `npm run build`
2. Start preview locally:
   - `npm run preview:screen`
3. Run local diagnostics:
   - `OWNMINUTES_APP_URL=https://app.example.com EXPO_PUBLIC_API_BASE_URL=https://app.example.com OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy OWNMINUTES_TERMS_URL=https://app.example.com/terms OWNMINUTES_SUPPORT_URL=https://app.example.com/support OWNMINUTES_SUPPORT_EMAIL=support@example.com OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health OWNMINUTES_SAMPLE_SHARE_URL=https://app.example.com/share/example-meeting-id npm run deployment:preflight`
   - `npm run smoke:deployment`
   - `npm run smoke:deployment-preflight`
   - `npm run smoke:deployment-live`
   - `npm run smoke:release`
   - `EXPO_PUBLIC_API_BASE_URL=https://app.example.com OWNMINUTES_APP_URL=https://app.example.com OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy OWNMINUTES_TERMS_URL=https://app.example.com/terms OWNMINUTES_SUPPORT_URL=https://app.example.com/support OWNMINUTES_SUPPORT_EMAIL=support@example.com OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health npm run mobile:testflight:preflight`
4. Confirm local release readiness still reports `public-url` as blocked until public HTTPS variables are configured.
5. Confirm no raw secret appears in diagnostics output.

## Deploy

Deploy the same commit that passed local smoke.

Minimum deployment requirements:

- Public HTTPS URL.
- `npm run deployment:preflight` passes with the same environment that will be deployed.
- `npm run deployment:verify` passes from a machine that can reach the public deployment, using a short-lived administrator session token supplied only through `OWNMINUTES_DEPLOYMENT_VERIFY_ADMIN_BEARER_TOKEN`.
- Stable TLS certificate.
- `/api/health` reachable without login.
- `/api/readyz` confirms PostgreSQL, the durable queue, and both external Workers are ready before traffic is admitted.
- `/privacy`, `/terms`, `/support`, `/data-deletion` reachable without login.
- `/support` and `/data-deletion` render a working `mailto:` link for the configured support mailbox.
- `/share/<id>` reachable for public shares.
- `/app` redirects unauthenticated users to `/login`.
- API runtime can read production environment variables.

## Public URL Verification

Run from a network outside the deployment host:

```bash
curl -I https://app.example.com/
curl -s https://app.example.com/api/health
curl -s https://app.example.com/api/readyz
curl -I https://app.example.com/privacy
curl -I https://app.example.com/terms
curl -I https://app.example.com/support
curl -I https://app.example.com/data-deletion
OWNMINUTES_APP_URL=https://app.example.com EXPO_PUBLIC_API_BASE_URL=https://app.example.com OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy OWNMINUTES_TERMS_URL=https://app.example.com/terms OWNMINUTES_SUPPORT_URL=https://app.example.com/support OWNMINUTES_SUPPORT_EMAIL=support@example.com OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health OWNMINUTES_SAMPLE_SHARE_URL=https://app.example.com/share/example-meeting-id npm run deployment:verify
```

Before running that command, inject a short-lived administrator session token from the secret manager into `OWNMINUTES_DEPLOYMENT_VERIFY_ADMIN_BEARER_TOKEN`. Never place the token in this runbook, shell history, evidence draft, repository files, or Obsidian. Anonymous `401/403` from deployment diagnostics and release readiness is the expected public security posture, but it remains only `pending` evidence; a real public acceptance run must authenticate and record the redacted readiness summary.

To reduce copy/paste mistakes, generate a private evidence draft from the same verifier:

```bash
OWNMINUTES_APP_URL=https://app.example.com EXPO_PUBLIC_API_BASE_URL=https://app.example.com OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy OWNMINUTES_TERMS_URL=https://app.example.com/terms OWNMINUTES_SUPPORT_URL=https://app.example.com/support OWNMINUTES_SUPPORT_EMAIL=support@example.com OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health OWNMINUTES_SAMPLE_SHARE_URL=https://app.example.com/share/example-meeting-id npm run deployment:evidence:draft
```

This writes `.data/acceptance/public-deployment-latest.md`. The draft intentionally leaves manual checks such as `Mobile login`, `Short meeting`, `Password reset URL`, and `Apple notification URL configured` as `pending`; do not change `Decision:` to `pass` until those checks are actually completed.

Advanced use: set `OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_DRAFT_PATH=/private/path/public-deployment.md` when the evidence draft should be written somewhere other than the default `.data/acceptance/public-deployment-latest.md`.

After collecting deployment evidence, save a private copy to:

```text
.data/acceptance/public-deployment-latest.md
```

Then run:

```bash
OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH=.data/acceptance/public-deployment-latest.md npm run deployment:acceptance:evidence
```

The `.data` directory is ignored by Git. Do not commit public deployment evidence if it includes customer share IDs, test account details, logs, cookies, tokens, API keys, deployment provider IDs, or incident notes.

Acceptance criteria:

- All public pages return HTTP 200 or expected redirect.
- `/api/health` returns JSON with `ok=true`.
- `/api/readyz` returns HTTP 200 with `ok=true` and `status=ready`; a 503 blocks promotion even when liveness is healthy.
- TLS certificate is valid and not self-signed.
- Response does not include raw secrets, API keys, database URLs, Apple private keys, cookies, or provider credentials.
- `deployment:verify` returns `productionDeploymentVerified=true`.
- `deployment:verify` reports `adminVerificationConfigured=true`; an anonymous protected response must not clear production evidence.
- `deployment:verify` includes `release-public-url.readiness` with `mvpReady`, `testflightReady`, `commercialReady`, `criticalBlocked`, `blockerCount`, `publicUrlBlocked`, and `nextAction`.
- `deployment:verify` must not be treated as TestFlight or commercial acceptance when `readiness.testflightReady=false`, `readiness.commercialReady=false`, or `readiness.criticalBlocked > 0`.

`OWNMINUTES_DEPLOYMENT_VERIFY_ALLOW_LOCAL=1` exists only for `npm run smoke:deployment-live` against local preview. Never use that override as TestFlight, App Store, or production acceptance evidence.

## Deployment Diagnostics Verification

After deployment variables are set, request:

```text
GET /api/deployment/diagnostics
GET /api/release/readiness
```

Pass criteria for public deployment readiness:

- `appUrl.https=true`
- `appUrl.publicHost=true`
- `mobileApiBaseUrl.https=true`
- `mobileApiBaseUrl.publicHost=true`
- `legalPages.publicUrlsConfigured=true`
- `legalPages.publicUrlsValid=true`
- `healthCheck.publicUrlConfigured=true`
- `healthCheck.publicUrlValid=true`
- `capabilities.hasPublicHttpsOrigin=true`
- `capabilities.supportsTestFlightApi=true`
- `sampleShareUrl.valid=true` when `OWNMINUTES_SAMPLE_SHARE_URL` is configured
- `public-url` is no longer `blocked`
- Release readiness top-level fields are present:
  - `summary`
  - `blockers`
  - `nextAction`
- `summary.testflightReady`, `summary.commercialReady`, `summary.criticalBlocked`, and `blockers.length` are reviewed before external TestFlight, App Store review, or public commercial launch.

## Mobile API Verification

For TestFlight or an iPhone build:

1. Configure `EXPO_PUBLIC_API_BASE_URL` or in-app API Base URL to the public HTTPS origin.
2. Run `npm run mobile:testflight:preflight` before `npm run mobile:testflight:build`; the build must fail if the URL is localhost, LAN, invalid, or public HTTP.
3. Install the app or open the mobile web app.
4. Log in with a test account.
5. Run backend connection check.
6. Record a short meeting.
7. Confirm upload, finalize, share link, and Markdown export.

The mobile client must not use `localhost` or a LAN IP for external testing.

## Email And Password Reset Verification

Public registration requires both account verification and password reset email delivery:

- `OWNMINUTES_APP_URL` must be the public HTTPS app URL.
- Reset links must open the public app, not localhost.
- Production should not return development reset tokens in API responses.
- `OWNMINUTES_REQUIRE_EMAIL_VERIFICATION=1` must be enabled; registration must not issue a session before verification.
- `OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE` and `OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE` must not be `1`.
- `RESEND_API_KEY` or `OWNMINUTES_RESEND_API_KEY` must be configured in the deployment environment.
- `OWNMINUTES_EMAIL_FROM` or `EMAIL_FROM` must use a verified sending identity.
- `OWNMINUTES_EMAIL_DOMAIN_VERIFIED=1` should only be set after DNS/domain verification is complete.
- `OWNMINUTES_EMAIL_BOUNCE_POLICY` and `OWNMINUTES_EMAIL_COMPLAINT_POLICY` must describe how bounced or complained recipients are handled.

Use a dedicated verified sender such as `OwnMinutes <verify@notify.example.com>`.
Add the chosen mail subdomain, rather than the apex domain, as the Resend
sending domain. Copy the Resend-generated records exactly:

- MX and SPF/TXT at `send.notify`
- DKIM/TXT at `resend._domainkey.notify`
- any provider verification or tracking CNAME as DNS only

Email and verification records must remain DNS only; Cloudflare must not proxy
them. Add or tighten the mail subdomain DMARC policy only after verifying the
intended scope. Set `OWNMINUTES_EMAIL_DOMAIN_VERIFIED=1` only after Resend
reports the domain as verified and a real delivery reaches both a mainstream
global mailbox and a second provider. Tighten DMARC only after SPF, DKIM, and
DMARC all pass. Keep domain auto-renew enabled because account recovery depends
on the sender remaining under project control.

Run:

```bash
npm run email:preflight
npm run smoke:email-preflight
npm run smoke:email
npm run smoke:email-verification
npm run smoke:email-verification-postgres
npm run smoke:auth
```

Manually register a new address on the public deployment. Confirm the six-digit code arrives in the requested language, expires after ten minutes, observes the resend cooldown, locks after the bounded failure count, creates an HttpOnly session only after success, and cannot be reused. Confirm the one-time 60-minute trial is absent before verification and granted exactly once in the successful verification transaction. During the Build 9 compatibility window, also confirm the legacy verification link remains single-use. Then request a password reset and confirm the reset link is also single-use. Public API JSON must never contain the code, token, provider delivery result, or any sender credential.

## Apple IAP Notification Verification

Apple Server Notifications V2 requires public HTTPS:

- Configure App Store Connect notification URL:
  - `https://app.example.com/api/payments/apple/notifications`
- Confirm the route does not require user login.
- Confirm invalid signed payloads do not write orders.
- Confirm valid sandbox notifications are recorded only after Apple signed payload verification.

Run:

```bash
npm run smoke:iap
npm run smoke:iap-verifier
npm run smoke:iap-runbook
```

## Share Link Verification

Create a public meeting share and test from a logged-out browser:

```text
https://app.example.com/share/<meetingId>
```

Acceptance criteria:

- Public summary is visible.
- Transcript is hidden by default.
- Raw audio is not public by default.
- Expired shares return the safe hidden state.
- Public Markdown download respects share visibility and expiration.

## Evidence Template

Store evidence in a private issue or private Obsidian note. Do not commit customer data.

You can start from the automated draft generated by:

```bash
npm run deployment:evidence:draft
```

Then manually replace every `pending` field with the actual result. `deployment:acceptance:evidence` must fail while any required manual field remains pending.

```text
Date:
Commit:
Deployment provider:
Public app URL:
Mobile API base URL:
Privacy URL:
Terms URL:
Support URL:
Health check URL:
Sample share URL:
/api/health: pass/fail
/api/deployment/diagnostics: pass/fail
/api/release/readiness top-level summary: pass/fail
Readiness mvpReady:
Readiness testflightReady:
Readiness commercialReady:
Readiness criticalBlocked:
Readiness blockerCount:
Readiness publicUrlBlocked: no/yes
Readiness nextAction:
Mobile login: pass/fail
Short meeting: pass/fail
Share link: pass/fail
Password reset URL: pass/fail
Apple notification URL configured: pass/fail
Secrets leaked: no/yes
Decision: pass/fail
Known issues:
```

## Failure Criteria

Any item below blocks public deployment acceptance:

- Any public URL uses HTTP instead of HTTPS.
- Any external testing URL uses localhost or LAN IP.
- `/api/health` is unreachable.
- Privacy, terms, or support pages are unreachable.
- Password reset links point to localhost.
- Mobile API Base URL points to localhost or LAN IP.
- App Store notification URL is not public HTTPS.
- Diagnostics leak secrets.
- Public shares expose transcript or audio by default.
- `/api/release/readiness` does not expose top-level `summary`, `blockers`, and `nextAction`.
- `deployment:verify` cannot report `release-public-url.readiness`.
- `deployment:acceptance:evidence` fails against the private public deployment evidence file.
- `readiness.testflightReady=false` blocks external TestFlight acceptance.
- `readiness.commercialReady=false` or `readiness.criticalBlocked > 0` blocks App Store/public commercial acceptance.

## Rollback

If deployment verification fails:

1. Disable external TestFlight invitations.
2. Revert or redeploy the last known good commit.
3. Restore previous environment variables in the deployment secret store.
4. Re-run:
   - `npm run smoke:deployment`
   - `npm run smoke:deployment-live`
   - `npm run smoke:release`
5. Re-test `/api/health`, legal pages, login, and one public share link.

## Production Verification

Public deployment is not production-accepted until these are also complete:

- `database` readiness is not blocked.
- `object-storage` readiness is not blocked.
- `secret-management` readiness is not blocked.
- `file-asr` readiness is not blocked.
- Apple IAP sandbox evidence exists if paid plans are enabled.
- At least one iPhone TestFlight recording uses the public HTTPS API base URL.
