# Launch Acceptance Runbook

This runbook is the final go/no-go wrapper for OwnMinutes. It does not replace the individual acceptance checkers. It verifies that every private evidence pack has been reviewed, marked pass, and contains no secrets before TestFlight or commercial release decisions.

## Generate Draft

```bash
npm run launch:acceptance:evidence:draft
```

This creates:

```text
.data/acceptance/launch-latest.md
```

The generated file is intentionally incomplete. It contains `pending` values and must fail the formal checker until real evidence is filled.

## Required Evidence Packs

Before marking the launch evidence as pass, collect and pass every pack below:

```bash
npm run deployment:evidence:draft
OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH=.data/acceptance/public-deployment-latest.md npm run deployment:acceptance:evidence

npm run ios:testflight:evidence:draft
OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH=.data/acceptance/ios-testflight-latest.md npm run ios:testflight:evidence

npm run asr:acceptance:evidence:draft
OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence

npm run summary:acceptance:evidence:draft
OWNMINUTES_SUMMARY_EVIDENCE_PATH=.data/acceptance/summary-latest.md npm run summary:acceptance:evidence

npm run database:evidence:draft
OWNMINUTES_POSTGRES_EVIDENCE_PATH=.data/acceptance/postgres-latest.md npm run database:acceptance:evidence

npm run storage:evidence:draft
OWNMINUTES_OBJECT_STORAGE_EVIDENCE_PATH=.data/acceptance/object-storage-latest.md npm run storage:acceptance:evidence

npm run secret:evidence:draft
OWNMINUTES_VAULT_LIVE_VERIFY=1 npm run secret:vault:live:verify
OWNMINUTES_SECRET_EVIDENCE_PATH=.data/acceptance/secret-management-latest.md OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH=.data/acceptance/vault-transit-live-latest.json npm run secret:acceptance:evidence

npm run iap:acceptance:evidence:draft
OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/apple-iap-latest.md npm run iap:acceptance:evidence
```

The ASR evidence pack covers three release blockers: post-meeting ASR, realtime/formal transcript boundary, and speaker diarization.

## Final Launch Gate

After every pack passes, fill `.data/acceptance/launch-latest.md` with:

- `Launch decision: pass`
- release commit
- reviewer
- evidence date
- one section for every required pack
- exact evidence file path
- exact verification command
- `Decision: pass`
- `Secrets leaked: no`

Then run:

```bash
OWNMINUTES_LAUNCH_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/launch-latest.md npm run launch:acceptance:evidence
```

The checker rejects:

- missing packs
- `pending`, `todo`, or `tbd` values
- any pack not marked `Decision: pass`
- any pack not marked `Secrets leaked: no`
- localhost or LAN URLs in public deployment or TestFlight evidence sections
- obvious API keys, bearer tokens, session cookies, database URLs, or private keys

## Repository Safety

Do not commit `.data/acceptance/*.md`. These files can contain private URLs, account ids, request ids, meeting ids, screenshots, or QA notes. They must stay local or in a private evidence store.
