# OwnMinutes Apple IAP Sandbox Runbook

This runbook separates the first TestFlight Sandbox purchase bootstrap from the evidence-complete release gate. Passing the bootstrap gate opens Sandbox testing only; it never makes the deployment production-ready.

## Current Boundary

- Transaction endpoint: `POST /api/payments/apple/transactions`
- Notification endpoint: `POST /api/payments/apple/notifications`
- IAP helper: `src/lib/apple-iap.ts`
- Order ledger: `billing_orders`
- Entitlement ledger: `entitlement_grants`
- Local endpoint smoke: `npm run smoke:iap`
- Signed payload verifier smoke: `npm run smoke:iap-verifier`

Local mock IAP is only for development. It does not replace Apple sandbox verification.

The existing shared staging deployment at `staging.example.com` is a **Sandbox-only TestFlight target**. Its project-specific PostgreSQL and object-storage data must remain isolated from any future production deployment. Never promote this host, database, object-storage namespace, or secret set in place by changing `APPLE_IAP_ENVIRONMENT` to `production`.

## Required Environment

The production Compose stack uses file-backed secrets. In `deploy/.env.production`, configure the host paths below; never paste the `.p8` contents into that file:

- `OWNMINUTES_APPLE_PRIVATE_KEY_FILE=/srv/ownminutes/deploy/secrets/apple-iap-private-key.p8`
- `OWNMINUTES_APPLE_ROOT_CA_G2_FILE=/srv/ownminutes/deploy/secrets/AppleRootCA-G2.cer`
- `OWNMINUTES_APPLE_ROOT_CA_G3_FILE=/srv/ownminutes/deploy/secrets/AppleRootCA-G3.cer`
- `OWNMINUTES_APP_SECRET_FILE=/srv/ownminutes/deploy/secrets/app-secret`

Compose mounts these files only into the App service. Inside the container, the runtime contract is:

- `APPLE_PRIVATE_KEY_FILE=/run/secrets/apple_iap_private_key`
- `APPLE_ROOT_CERTIFICATE_PATHS=/run/secrets/apple_root_ca_g2,/run/secrets/apple_root_ca_g3`

`scripts/run-with-secrets.mjs` reads the protected files while the container is still root, converts the public root certificates to the `APPLE_ROOT_CERTIFICATES` runtime format, then drops to the application uid/gid. Workers do not receive the Apple key or certificate mounts.

For the current shared staging, configure these non-secret identifiers and policy declarations in its server-private `deploy/.env.production`:

- `APPLE_ISSUER_ID`
- `APPLE_KEY_ID`
- `APPLE_BUNDLE_ID`
- `APPLE_APP_APPLE_ID` (optional for Sandbox; required on the future production deployment)
- `APPLE_IAP_ENVIRONMENT=sandbox`
- `OWNMINUTES_IAP_SANDBOX_ACCEPTANCE=1`
- `OWNMINUTES_APP_SECRET_VERSION=v1`
- `APPLE_IAP_PRODUCT_IDS`
- `APPLE_IAP_FETCH_TIMEOUT_MS=10000`
- `OWNMINUTES_IAP_RECEIPT_VERIFICATION`
- `OWNMINUTES_IAP_ENTITLEMENT_MAPPING`
- `OWNMINUTES_IAP_REFUND_HANDLING`
- `OWNMINUTES_ORDER_IDEMPOTENCY`
- `OWNMINUTES_IAP_NOTIFICATION_URL=https://staging.example.com/api/payments/apple/notifications`
- `OWNMINUTES_IAP_SANDBOX_PURCHASE_PROOF`
- `OWNMINUTES_IAP_SANDBOX_RENEWAL_PROOF`
- `OWNMINUTES_IAP_SANDBOX_REFUND_PROOF`
- `OWNMINUTES_IAP_SANDBOX_EXPIRATION_PROOF`
- `OWNMINUTES_IAP_DB_LEDGER_PROOF`

Leave all five `OWNMINUTES_IAP_SANDBOX_*_PROOF` / `OWNMINUTES_IAP_DB_LEDGER_PROOF` values empty before the first transaction. Populate each one only after the matching real TestFlight/Sandbox scenario passes and a private redacted evidence record exists.

Formal production must be a new deployment with a formal domain, new PostgreSQL database, new object-storage boundary, and new server-private secret set. Only that new deployment may use `APPLE_IAP_ENVIRONMENT=production` with `OWNMINUTES_IAP_SANDBOX_ACCEPTANCE=0`. It rejects every Sandbox/TestFlight transaction and notification after cryptographic verification. `auto` is useful only for diagnostics and is rejected by both strict gates; never let sandbox purchases write entitlements into the production user database.

Real IAP is fail-closed unless `OWNMINUTES_AUTH_REPOSITORY=postgres` and `DATABASE_URL`/`POSTGRES_URL` are active. The local-file store is mock-only and is not a supported payment ledger.

The raw `APPLE_PRIVATE_KEY`, `APPLE_ROOT_CERTIFICATES`, and `OWNMINUTES_APP_SECRET` variables remain supported for local compatibility, but production should use the file paths above. Keep the application account-binding secret stable because it derives each user's StoreKit `appAccountToken`. When rotation is necessary, increment `OWNMINUTES_APP_SECRET_VERSION` and temporarily supply prior version/secret pairs through the server-private `OWNMINUTES_PREVIOUS_APP_SECRETS_JSON`; never overwrite a secret while keeping the same version, and never commit previous secrets.

Optional:

- `APPLE_IAP_ENABLE_ONLINE_CHECKS=1`

Production must also keep `OWNMINUTES_ENABLE_SIMULATED_BILLING=0` and `OWNMINUTES_ENABLE_IAP_MOCK=0`.

Do not commit Apple private keys, transaction ids, signedPayload samples from real users, sandbox account passwords, App Store Connect cookies, or API tokens. Apple root certificates are public trust anchors, but keep their deployment paths explicit and mounts read-only.

## Apple Root Certificates

1. Download Apple Root Certificates from Apple PKI: `https://www.apple.com/certificateauthority/`.
2. Download the G2 and G3 certificates and place them at the paths declared by `OWNMINUTES_APPLE_ROOT_CA_G2_FILE` and `OWNMINUTES_APPLE_ROOT_CA_G3_FILE`.
3. Confirm the files are non-empty and readable by Docker Compose. Do not alter the container targets in `APPLE_ROOT_CERTIFICATE_PATHS`.
4. Local/non-Compose runs may instead use `APPLE_ROOT_CERTIFICATES` for PEM, base64 DER, or a JSON array, or `APPLE_ROOT_CERTIFICATE_PATHS` for comma-separated local files.
5. Run:

```bash
npm run smoke:iap-verifier
npm run smoke:payments
npm run smoke:production-deployment
```

Expected state:

- `smoke:iap-verifier` confirms `SignedDataVerifier` is wired.
- Payment diagnostics no longer list `APPLE_ROOT_CERTIFICATES` as missing once configured.

## App Store Connect Setup

1. Create or confirm Bundle ID: `app.ownminutes.mobile` or the production bundle id in `APPLE_BUNDLE_ID`.
2. Create IAP products for the current mapping:
   - `ownminutes.plus.monthly`
   - `ownminutes.pro.monthly`
3. Add product ids to `APPLE_IAP_PRODUCT_IDS`.
4. Keep `OWNMINUTES_APP_SECRET` stable across deployments and version every intentional rotation. The app sends a server-derived UUID as StoreKit `appAccountToken`, and the backend retains old version bindings so restored purchases remain attributable.
5. Ensure `OWNMINUTES_IAP_ENTITLEMENT_MAPPING` maps every active product id to a plan, amount, and currency. Treat subscription SKU mappings as append-only while any subscriber can still renew; retired SKUs may be hidden from sale but must remain mapped until every subscription family has migrated or expired.
6. Create App Store Server API key in Users and Access > Integrations > In-App Purchase.
7. Configure `APPLE_ISSUER_ID` and `APPLE_KEY_ID`, then store the App Store Connect `.p8` key at `OWNMINUTES_APPLE_PRIVATE_KEY_FILE`. Do not put `APPLE_PRIVATE_KEY` in `deploy/.env.production`.
8. Create sandbox tester accounts in App Store Connect.
9. In App Store Connect, configure this value in **Sandbox Server URL only**:

```text
https://staging.example.com/api/payments/apple/notifications
```

10. Leave **Production Server URL empty** while this shared staging is the only deployed backend. Add a Production Server URL only after the separate production deployment passes the full production gate.

The URL must be public HTTPS. Localhost is only valid for local mock smoke. Do not put the shared staging URL into App Store Connect's Production Server URL field.

## Two-Phase Sandbox Gate

The circular dependency is intentional: lifecycle evidence cannot exist before the first real transaction. The preflight therefore has two strict phases, and neither phase permits fabricated evidence.

### Phase 1: Sandbox bootstrap before the first purchase

Keep all five evidence variables empty. The bootstrap phase verifies the Sandbox environment pair, PostgreSQL ledger, Apple credentials and trust roots, account binding, product IDs, policy declarations, public notification URL, disabled mocks, and server runtime wiring. It deliberately omits the five post-transaction evidence checks.

Run the strict check **inside the App container** so `scripts/run-with-secrets.mjs` can load the mounted `.p8`, public root certificates, app secret, and PostgreSQL password before dropping privileges:

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml -f deploy/compose.public-staging.yml -f deploy/compose.shared-proxy.yml exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --phase=sandbox-bootstrap --strict
```

Do not replace this with a host-side `node --env-file=deploy/.env.production ...` command. The host process cannot see container secret mounts or the runtime `DATABASE_URL` synthesized by `run-with-secrets.mjs`.

Required result before the first purchase:

- `ok=true`
- `phase=sandbox-bootstrap`
- `bootstrapReady=true`
- `evidenceReady=false`
- `deploymentBoundary=sandbox-only`
- `productionCandidate=false`
- `/api/payments/diagnostics` reports `acceptingPurchases=true` and `productionReady=false`

### Phase 2: Full strict acceptance after real Sandbox evidence

Complete the purchase, renewal, refund, expiration/revocation, and database-ledger scenarios below. Save redacted evidence privately, fill only the matching evidence declarations, recreate the App container so it receives the updated environment, then run the full gate (the default `release` phase):

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml -f deploy/compose.public-staging.yml -f deploy/compose.shared-proxy.yml up -d --no-deps --force-recreate app
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml -f deploy/compose.public-staging.yml -f deploy/compose.shared-proxy.yml exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --strict
```

The three `-f` layers are mandatory for every current shared-staging `config`, `exec`, and `up` operation. `--no-deps` ensures Phase 2 recreates only `app`, while the public-staging network and shared-proxy routing remain attached. On the Sandbox deployment, a pass means `acceptanceReady=true`, `evidenceReady=true`, and `productionCandidate=false`. This deployment remains Sandbox-only. Do not flip it to production; provision and validate the separate production deployment described under Production Verification.

## Preflight

Run before attempting a real sandbox purchase:

```bash
npm run lint
npm run build
npm run smoke:production-deployment
npm run smoke:iap-preflight
npm run smoke:payments
npm run smoke:iap-verifier
npm run smoke:iap-lifecycle
npm run smoke:iap-postgres
npm run smoke:iap
npm run smoke:release
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml -f deploy/compose.public-staging.yml -f deploy/compose.shared-proxy.yml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml -f deploy/compose.public-staging.yml -f deploy/compose.shared-proxy.yml exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --phase=sandbox-bootstrap --strict
```

Expected state:

- Build passes.
- Local mock IAP purchase, renewal, refund, and duplicate notification paths still pass.
- `smoke:iap-preflight` confirms Sandbox bootstrap passes without fabricated evidence, rejects production mode, and the full gate still blocks missing Sandbox evidence, public notification URL, or production App Apple ID.
- `smoke:production-deployment` confirms the `.p8` and both root certificates are mounted only into the App, loaded before privilege drop, and that formal production renders `APPLE_IAP_ENVIRONMENT=production`.
- `smoke:payments` confirms `/api/payments/diagnostics` will not mark `productionReady=true` until Apple credentials, products, root certificates, PostgreSQL, public notification URL, receipt verification, entitlement mapping, refund handling, idempotency, sandbox purchase/renewal/refund/expiration evidence, and database ledger proof are all present.
- Release readiness remains `commercialReady=false` until real sandbox verification is documented.
- No command output leaks Apple private keys, signedPayload values, or transaction ids from real users.

## Sandbox Transaction Verification

Use a TestFlight or sandbox build that sends Apple transaction ids to the server.

1. Sign in on the device with a sandbox tester.
2. Purchase `ownminutes.plus.monthly`.
3. Send the returned Apple transaction id to:

```http
POST /api/payments/apple/transactions
```

4. Confirm the response:
   - `ok=true`
   - `entitlementGranted=true`
   - `duplicate=false`
   - `order.provider=apple_iap`
   - `order.status=paid`
   - `order.externalTransactionId` equals the Apple transaction id.
   - `order.originalTransactionId` is present.
   - User plan changes to `plus`.
5. Send the same transaction id again.
6. Confirm the second response:
   - `duplicate=true`
   - Same order id.
   - No extra entitlement grant.

Repeat for `ownminutes.pro.monthly`.

## Server Notification Verification

Use App Store Server Notifications V2 and a public HTTPS endpoint.

1. In App Store Connect, send a test notification if available.
2. For purchase, renewal, refund, and expiration scenarios, capture server logs without printing raw signedPayload.
3. Confirm `/api/payments/apple/notifications`:
   - Verifies the outer `signedPayload`.
   - Verifies nested `signedTransactionInfo`.
   - Rejects invalid signature with `invalid_signed_payload_signature`.
   - Rejects unknown product id with `unknown_product_id`.
   - Applies only verified payloads to `recordAppleIapNotification`.
4. Confirm `DID_RENEW`:
   - Creates a new `apple_iap` order.
   - Preserves the same `originalTransactionId`.
   - Does not duplicate if the notification is delivered twice.
5. Confirm `REFUND`:
   - Marks order as `refunded`.
   - Marks entitlement grant as `refunded`.
   - Rolls back the plan only when the refunded grant is the current active plan.
6. Confirm `EXPIRED` or `GRACE_PERIOD_EXPIRED`:
   - Keeps the historical paid order `paid`.
   - Marks the entitlement grant `revoked` and the subscription `expired`.
7. Confirm `REVOKE`:
   - Keeps financial history unchanged unless Apple also sends `REFUND`.
   - Marks the entitlement grant and subscription `revoked`.
8. Confirm immediate upgrade and scheduled downgrade:
   - `DID_CHANGE_RENEWAL_PREF/UPGRADE` creates the new period/order and switches the plan immediately.
   - `OFFER_REDEEMED/DOWNGRADE` or renewal preference downgrade does not switch the current entitlement early.
9. Deliver a newer status/preference event before an older `DID_RENEW` and confirm the newer transaction period still wins; deliver an older refund after a newer `REFUND_REVERSED` and confirm it is ignored.

## Database Checks

After every sandbox scenario, inspect the database without exposing customer secrets:

```sql
select provider, status, plan, price_milliunits, currency, external_transaction_id, original_transaction_id, period_start_at, period_end_at, status_signed_date
from billing_orders
where provider = 'apple_iap'
order by created_at desc
limit 10;

select source, status, previous_plan, plan, billing_order_id
from entitlement_grants
where source = 'apple_iap'
order by created_at desc
limit 10;
```

Expected state:

- Every Apple transaction has one billing order.
- Every active paid order links to one entitlement grant.
- Duplicate transaction ids do not create extra orders.
- Renewal orders share `original_transaction_id`.
- `apple_subscriptions` identifies the current transaction and monotonic notification state.
- `apple_notification_events` contains one processed/ignored row per notification UUID and no raw signed payload.
- Refund updates financial status; natural expiration/revocation updates entitlement state without rewriting paid revenue history.

## Rollback

Before public release:

- Keep Sandbox/TestFlight acceptance on its isolated staging database only.
- Remove the App Store Connect Sandbox Server URL if it creates bad events; leave Production Server URL empty.
- Keep `OWNMINUTES_ENABLE_SIMULATED_BILLING=0`.
- Do not manually edit `billing_orders` or `entitlement_grants` unless a backup exists.
- Never switch this shared staging to `APPLE_IAP_ENVIRONMENT=production`, and never reuse its database/object-storage data as production.

If a sandbox or production notification path misbehaves:

1. Disable the Sandbox Server URL in App Store Connect.
2. Keep `/api/payments/apple/transactions` enabled only if transaction verification is still correct.
3. Export affected `billing_orders`, `entitlement_grants`, and user ids for audit.
4. Patch code, run the full preflight, then re-enable notifications.

## Production Verification

The shared staging can never satisfy this production boundary. First provision a separate formal domain, PostgreSQL database, object-storage boundary, and server-private secret set. Keep App Store Connect Production Server URL empty until the new endpoint is live and verified. Then set the new deployment to `APPLE_IAP_ENVIRONMENT=production` and `OWNMINUTES_IAP_SANDBOX_ACCEPTANCE=0`.

Minimum gate before declaring that separate Apple IAP deployment production-ready:

```bash
npm run lint
npm run build
npm run smoke:production-deployment
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml exec -T --user 0 app node scripts/run-with-secrets.mjs -- node scripts/check-apple-iap-production-env.mjs --strict
npm run iap:preflight # equivalent only in a shell where runtime secrets and DATABASE_URL are already loaded
npm run smoke:payments
npm run smoke:iap-verifier
npm run smoke:iap
npm run smoke:release
```

The strict output must include `productionCandidate=true`. Only then may the new formal production notification endpoint be entered as App Store Connect's Production Server URL. Passing Phase 2 on shared Sandbox staging is acceptance evidence, not permission to promote that deployment.

After collecting sandbox or TestFlight evidence, save a private copy to:

```text
.data/acceptance/apple-iap-latest.md
```

You can generate the private evidence draft first:

```bash
npm run iap:acceptance:evidence:draft
```

This writes `.data/acceptance/apple-iap-latest.md` with every required scenario and field set to `pending`. The draft is intentionally incomplete: `npm run iap:acceptance:evidence` must fail until every scenario is replaced with real Apple sandbox/TestFlight evidence and the final decision is `pass`.

Then run:

```bash
OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/apple-iap-latest.md npm run iap:acceptance:evidence
```

The `.data` directory is ignored by Git. Do not commit Apple private keys, signedPayload samples, full transaction ids, sandbox account passwords, App Store Connect cookies, API tokens, customer identifiers, or raw server logs.

Manual evidence still required:

- Screenshot or log proof that Apple Root Certificates are configured in the deployment secret store.
- Sandbox Plus purchase success.
- Sandbox Pro purchase success.
- Duplicate transaction id idempotency proof.
- DID_RENEW notification proof.
- REFUND notification proof.
- EXPIRED or REVOKE notification proof.
- App Store Connect notification URL configured to public HTTPS.
- Database ledger evidence for `billing_orders` and `entitlement_grants`.
- Account plan rollback evidence after refund or expiration.
- One passing private evidence check with `npm run iap:acceptance:evidence`.

Only after the manual evidence exists should the payment section move from blocked/manual to production-ready.

## Evidence Template

Store this in a private issue, private QA note, or `.data/acceptance/apple-iap-latest.md`.

```text
# Apple IAP Acceptance Evidence

Date:
Tester:
Commit:
Build source: TestFlight/Sandbox
Bundle ID:
Environment: sandbox/testflight
Public notification URL:
Sandbox account: redacted

## Plus purchase
Scenario: Plus purchase
Apple product: ownminutes.plus.monthly
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

## Pro purchase
Scenario: Pro purchase
Apple product: ownminutes.pro.monthly
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

## Duplicate transaction idempotency
Scenario: Duplicate transaction idempotency
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

## DID_RENEW notification
Scenario: DID_RENEW notification
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

## REFUND notification
Scenario: REFUND notification
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

## EXPIRED or REVOKE notification
Scenario: EXPIRED or REVOKE notification
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

## Database ledger
Scenario: Database ledger
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

## Account plan rollback
Scenario: Account plan rollback
Transaction verification: pass/fail
Notification verification: pass/fail
Order ledger: pass/fail
Entitlement ledger: pass/fail
Duplicate handling: pass/fail
Plan result: pass/fail
Secrets leaked: no/yes
Decision: pass/fail

Decision: pass/fail
Known issues:
```
