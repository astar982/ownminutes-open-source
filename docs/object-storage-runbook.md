# OwnMinutes Object Storage Runbook

This runbook is the production checklist for moving meeting audio objects from local `.data/meetings` to object storage.

## Current Boundary

- Default storage provider: `local`
- Supported remote providers: `s3`, `r2`, `volcano-tos`
- Runtime adapter: `src/lib/server/meeting-object-store.ts`
- Remote object smoke: `npm run smoke:storage-remote`
- Cross-instance coordinator: `src/lib/server/meeting-write-lock.ts`
- Durable deletion fence: `db/migrations/0009_meeting_deletion_tombstones.sql`

Meeting chunks, manifests, generated results, and Obsidian Markdown must all go through the object store adapter. Do not write production meeting audio directly to local disk.

## Required Environment

Choose one provider family.

### S3 Compatible

- `S3_BUCKET`
- `S3_ENDPOINT`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_REGION`

### Cloudflare R2

- `R2_BUCKET`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_REGION`

### Volcano TOS

- `VOLCANO_TOS_BUCKET` or `TOS_BUCKET`
- `VOLCANO_TOS_ENDPOINT` or `TOS_ENDPOINT`
- `VOLCANO_TOS_ACCESS_KEY_ID` or `TOS_ACCESS_KEY_ID`
- `VOLCANO_TOS_SECRET_ACCESS_KEY` or `TOS_SECRET_ACCESS_KEY`
- `VOLCANO_TOS_REGION` or `TOS_REGION`

All providers must also define:

- `OWNMINUTES_STORAGE_PREFIX` (for example `ownminutes/meetings`; required by the real-provider acceptance verifier)
- `OWNMINUTES_STORAGE_LIFECYCLE_POLICY`
- `OWNMINUTES_STORAGE_DELETE_PROOF`
- `OWNMINUTES_STORAGE_COST_BUDGET`
- `OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION`
- `OWNMINUTES_STORAGE_PRIVATE_ACCESS=1`
- `OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE`
- `OWNMINUTES_STORAGE_RESTORE_READ_PROOF`
- `OWNMINUTES_AUTH_REPOSITORY=postgres`
- `DATABASE_URL` or `POSTGRES_URL`
- `OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory`

Do not commit bucket credentials, generated signed URLs, access keys, secret keys, cookies, or audio exports.

## Preflight

Run:

```bash
npm run smoke:storage-preflight
npm run smoke:storage
npm run smoke:storage-remote
npm run smoke:storage-real-verifier
npm run smoke:meeting-write-coordination
npm run smoke:storage-evidence
npm run smoke:meetings
npm run smoke:release
```

Expected state:

- Local diagnostics show object store adapter is present.
- Local diagnostics show `localInventory.meetingCount`, `localInventory.manifestCount`, and `localInventory.totalBytes` before migration.
- Production storage preflight smoke confirms missing env fails, bucket-only env fails, and complete S3/R2/Volcano TOS env passes without leaking credentials.
- Production storage preflight must also confirm lifecycle policy, deletion proof, local inventory decision, private access, minimum-privilege credentials, restore/read proof, and cost budget declarations.
- Remote smoke proves PUT, GET, LIST, DELETE, signature headers, and content hash handling.
- Cross-instance runtime smoke uses two independent Next processes and PostgreSQL to prove concurrent chunk writes preserve every sequence and byte, then proves a deleted meeting rejects a late upload with HTTP 410.
- Meeting closed loop still works through the object store adapter.
- Release readiness still shows production blocked until real provider configuration exists.
- Private acceptance evidence checker validates the real bucket evidence template and rejects missing account deletion, localhost endpoints, public access, failed checks, and leaked secrets.

## Migration Steps

1. Create a private bucket.
2. Disable public object listing.
3. Create a minimum-privilege app access key.
4. Configure lifecycle policy and retention period.
5. Disable public object listing and public object reads. Record this as `OWNMINUTES_STORAGE_PRIVATE_ACCESS=1`.
6. Create a minimum-privilege app access key limited to the target bucket and meeting object prefix. Record the policy location in `OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE`.
7. Record deletion proof, local inventory decision, restore/read proof, and cost budget in the deployment secret store:

```bash
OWNMINUTES_STORAGE_LIFECYCLE_POLICY="<retention and lifecycle policy>"
OWNMINUTES_STORAGE_DELETE_PROOF="<meeting and account deletion evidence location>"
OWNMINUTES_STORAGE_COST_BUDGET="<monthly audio storage and request budget>"
OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION="<migrate, archive, or discard local .data/meetings>"
OWNMINUTES_STORAGE_PRIVATE_ACCESS=1
OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE="<policy location and allowed bucket/prefix/actions>"
OWNMINUTES_STORAGE_RESTORE_READ_PROOF="<stored object restore/read evidence location>"
```

8. Apply PostgreSQL migration `0009_meeting_deletion_tombstones` and configure `OWNMINUTES_MEETING_WRITE_LOCK=postgres-advisory`. Remote object storage is not production-safe with only the default single-process lock.
9. Configure provider environment variables only in the deployment secret store.
10. Run storage production preflight against the same environment:

```bash
npm run storage:preflight
```

To reduce copy/paste mistakes, generate a private acceptance evidence draft from the same preflight data:

```bash
npm run storage:evidence:draft
```

This writes `.data/acceptance/object-storage-latest.md` by default. The draft intentionally leaves remote PUT/GET/LIST/DELETE, object read/write, meeting/account deletion, lifecycle proof, private access proof, minimum privilege proof, restore/read proof, cost review, and local inventory handling as `pending` until the real bucket checks are completed.

Advanced use: set `OWNMINUTES_OBJECT_STORAGE_EVIDENCE_DRAFT_PATH=/private/path/object-storage-latest.md` when the draft should be written somewhere else.

11. Run `npm run smoke:storage-remote` against a staging bucket.

For a real S3/R2/TOS bucket, use the explicit destructive-test gate and an isolated prefix:

```bash
OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE=1 npm run storage:real:verify
```

The verifier refuses local/LAN or non-HTTPS endpoints, requires `OWNMINUTES_STORAGE_PREFIX`, writes only random acceptance objects below that namespace, checks manifest/audio/result/Markdown write-read, listing, anonymous access denial and prefix deletion, and always attempts cleanup in `finally`. Its sanitized private JSON evidence defaults to `.data/acceptance/object-storage-live-latest.json`; it records only an endpoint hostname and bucket hash, never credentials, bucket names, signed URLs, cookies, or audio.
12. Run the two-instance coordination smoke against the migrated PostgreSQL environment.

```bash
npm run smoke:meeting-write-coordination-runtime
```

The command requires the migrated database URL in the process environment and a production build workdir through `SMOKE_SERVER_WORKDIR`. It creates two temporary Next processes and a temporary S3-compatible protocol server; it must not point at a bucket containing real customer audio.

13. Run `npm run smoke:meetings` with remote storage enabled.
14. Confirm meeting deletion and account deletion remove all objects, and a late retry cannot recreate a deleted prefix.
15. Restore/read a previously stored manifest, result, Markdown, and audio chunk from the provider and record the evidence.
16. Read `/api/storage/diagnostics` and record the local migration inventory.
17. Back up or migrate any required local `.data/meetings` objects.
18. Confirm local migration inventory is zero or explicitly accepted as not needed.
19. Deploy remote storage configuration.

## Private Acceptance Evidence

Real provider credentials and bucket evidence must not be committed. Save the sanitized evidence locally:

```text
.data/acceptance/object-storage-latest.md
```

Then run:

```bash
npm run storage:acceptance:evidence
```

Use `OWNMINUTES_OBJECT_STORAGE_EVIDENCE_PATH=/path/to/evidence.md` when checking a different private file.

You can start from the automated draft generated by `npm run storage:evidence:draft`, then manually replace every `pending` field with the real result. `storage:acceptance:evidence` must fail while any required manual field remains pending.

Required evidence fields:

```markdown
# Object Storage Acceptance Evidence

Date:
Commit:
Provider: s3 | r2 | volcano-tos
Bucket:
Region:
Endpoint: https://...
Object prefix:
Lifecycle policy:
Delete proof:
Cost budget:
Local inventory decision:
Private access: yes
Minimum privilege policy:
Restore read proof:
Storage diagnostics: pass
Release readiness objectStorageBlocked: no
Release readiness nextAction:

Production preflight: pass
Remote PUT: pass
Remote GET: pass
Remote LIST: pass
Remote DELETE: pass
Manifest write/read: pass
Audio chunk write/read: pass
Result JSON write/read: pass
Obsidian Markdown write/read: pass
Meeting delete prefix: pass
Account delete prefix: pass
Cross-instance concurrent chunks: pass
Deleted meeting recreation blocked: pass
Lifecycle policy proof: pass
Private access proof: pass
Minimum privilege proof: pass
Restore/read proof: pass
Cost budget reviewed: pass
Local inventory handled: pass

Secrets leaked: no
Decision: pass
Known issues:
```

Do not paste access keys, secret keys, signed URLs, cookies, or raw object URLs that include signatures.

## Object Layout

The formal object layout is versioned by `meeting-object-store-contract:v3` in `src/lib/server/meeting-object-store.ts`. Version 3 keeps every persistent object key from v2 and adds `getFile` plus `createPresignedGetUrl`. Completed audio can be streamed to disk, normalized without a full Node Buffer, uploaded as a private transient ASR object, and fetched by the provider through a short-lived signed URL.

Business code must call `buildMeetingObjectKey(...)` for meeting object keys. Do not construct .data/meetings paths or remote object keys directly outside the object-store adapter.

Transient ASR inputs use `{{meetingId}}/transient/asr/{{fileName}}`. They must remain private, must never be written to logs or evidence files as signed URLs, and must be deleted in `finally` after recognition. Production lifecycle policy must also expire `*/transient/asr/*` as a last-resort cleanup path. `putFile`, `getFile`, and `createPresignedGetUrl` are part of the required adapter contract.

Expected object keys:

```text
{{meetingId}}/manifest.json
{{meetingId}}/chunks/{{fileName}}
{{meetingId}}/processing.json
{{meetingId}}/result.json
{{meetingId}}/obsidian.md
```

Resumable full-recording uploads also use two internal object families:

```text
{{meetingId}}/uploads/{{uploadId}}/manifest.json
{{meetingId}}/uploads/{{uploadId}}/parts/part-{{index}}.bin
{{meetingId}}/upload-receipts/{{uploadId}}.json
```

## Resumable Upload Staging

The application reserves the full declared recording size before accepting the first part. Defaults are four active uploads and 256 MiB reserved per account, with a 72-hour stale lease:

```bash
OWNMINUTES_RECORDING_UPLOAD_MAX_ACTIVE_PER_USER=4
OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER=268435456
OWNMINUTES_RECORDING_UPLOAD_STALE_HOURS=72
```

`OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER` must be at least `OWNMINUTES_FULL_AUDIO_MAX_BYTES`. Increasing either limit requires checking object-storage cost, mobile retry behavior, proxy body limits, Node memory during commit, and ffmpeg/ASR limits together.

The server opportunistically removes an expired `{{meetingId}}/uploads/{{uploadId}}/` prefix when that upload is queried or when a new upload starts. This is not a scheduled garbage collector and cannot clean an idle bucket with no application traffic. Configure the provider lifecycle policy to expire only incomplete objects below `*/uploads/*` after the accepted retention window. Do not apply that short expiry to `*/upload-receipts/*`, formal `manifest.json`, `chunks/*`, `result.json`, or `obsidian.md`.

The mobile client must retain the original local recording on `409`, `413`, `422`, or `429`. A `Retry-After` response controls the next pending-sync attempt, bounded by the App's 15-minute maximum backoff. Account deletion must remove staging-only meeting prefixes as well as committed meetings.

Example chunk key:

```text
{{meetingId}}/chunks/chunk-000001.webm
```

`processing.json` stores only the durable finalization state, attempt count, lease timestamps, quality status, and scrubbed failure metadata. It must never contain audio bytes, provider credentials, or raw model responses.

The meeting id is the tenant-owned prefix. Deletion must remove the full meeting prefix, including processing state.

## Rollback

Before enabling remote storage:

- Keep local `.data/meetings` untouched.
- Roll back by removing remote storage env vars and redeploying.

After enabling remote storage:

- Do not switch back to local storage without exporting remote objects first.
- Avoid splitting one user's meeting history across local and remote stores.
- Confirm deletion and lifecycle behavior before changing providers.

## Production Verification

Minimum production gate:

```bash
npm run smoke:storage
npm run storage:preflight
npm run smoke:storage-remote
npm run smoke:meeting-write-coordination
npm run storage:acceptance:evidence
npm run smoke:meetings
npm run smoke:release
```

Manual verification still required:

- Local migration inventory before switching providers.
- 30-minute and 90-minute meeting object growth.
- Delete account and verify audio object deletion.
- Two App instances upload overlapping bursts to one meeting without losing any manifest sequence or byte.
- A delayed chunk after meeting deletion returns HTTP 410 and does not recreate the remote prefix.
- Lifecycle policy screenshot or provider API proof.
- Public access block or equivalent bucket policy proof.
- Minimum-privilege access-key policy proof.
- Cost estimate for typical monthly audio volume.
- Restore/read test from stored objects.
