# Legacy meeting deletion cleanup runbook

## Why this gate exists

Historical builds may have written a deletion tombstone whose meeting id is not valid under the current canonical id contract. OwnMinutes must never replace unsupported characters, guess a similar prefix, or delete a prefix based on a lossy conversion. A guessed prefix can belong to another recording.

The safe default is therefore `pending_manual_cleanup`:

- the meeting stays logically deleted;
- the account deletion receipt stays `pending_cleanup` while owner-linked storage cleanup is unresolved;
- automatic Workers skip the row;
- the admin inventory exposes only bounded one-way references, never raw owner or meeting ids;
- production promotion is blocked until the inventory is empty.

The account deletion receipt is valid for 90 days. Manual cleanup has a 30-day operational SLA, so the user can continue querying `pending_cleanup` through the chosen cleanup lifecycle. Do not clear the receipt on the device until the server reports `deleted`.

## Observe without exposing identifiers

1. Sign in with an admin account.
2. Request `GET /api/admin/deletion-cleanup?limit=25`.
3. Check `unresolvedOwnedCount`, `overdueCount`, `oldestDetectedAt`, and the pseudonymous `meetingRef` / `ownerRef` inventory.
4. Run the deployment gate from the production runtime:

   ```bash
   npm run legacy-cleanup:gate
   ```

The command intentionally fails when any owner-linked manual cleanup remains. It never prints a raw meeting id, owner id, database URL, or storage credential.

Production Compose also runs the strict gate after migrations and before admin bootstrap/App/Workers. `npm run production:verify` reruns it, so a later quarantined row also blocks promotion evidence.

## Resolve one quarantined row

Resolution is allowed only when the exact object prefix has an exact manifest whose `meetingId` and `ownerUserId` both match the tombstone. A relational `meetings` row, if present, must also match the exact owner and object prefix. Similar, sanitized, truncated, case-folded, or guessed prefixes are never accepted.

1. On the private server, identify the raw row directly in PostgreSQL. Do not paste it into chat, GitHub, Obsidian, screenshots, or ordinary shell history.
2. Create a private JSON file outside the repository:

   ```json
   {
     "meetingId": "the-exact-legacy-id",
     "ownerUserId": "the-exact-owner-id"
   }
   ```

3. Restrict it to the operator:

   ```bash
   chmod 600 /private/path/legacy-cleanup-review.json
   ```

4. Confirm database backup, exact manifest ownership, object-store access, and the admin inventory reference. Then run:

   ```bash
   OWNMINUTES_LEGACY_CLEANUP_INPUT_FILE=/private/path/legacy-cleanup-review.json \
   OWNMINUTES_LEGACY_CLEANUP_OPERATOR='ops-reviewer' \
   OWNMINUTES_LEGACY_CLEANUP_CONFIRM=DELETE_EXACT_OWNER_VERIFIED_PREFIX \
   npm run legacy-cleanup:resolve
   ```

The resolver:

- accepts only a single traversal-safe non-canonical prefix;
- verifies the exact manifest owner and meeting id;
- records a one-way manifest proof and pseudonymous operator reference before deletion;
- deletes only that exact prefix;
- verifies that the exact prefix is gone;
- replaces the raw tombstone with a SHA-256 deletion fence containing no raw owner or meeting identifier, preserving late-write protection without retaining direct identifiers.

If the manifest is absent, ownership conflicts, the exact prefix cannot be listed, or the proof changes, the resolver stops and leaves `pending_manual_cleanup`. Do not update the row manually to `cleanup_pending=false` and do not delete a sanitized lookalike prefix.

If the process stops after the exact prefix was deleted, rerun the same command with the same private review file. A retry can complete only when an earlier owner-verified proof is already stored.

## Close the incident

1. Rerun `npm run legacy-cleanup:gate`; require `unresolvedOwnedCount=0` and `releaseBlocked=false`.
2. Refresh `/api/admin/deletion-cleanup`; verify the pseudonymous item is gone.
3. Query the user's account deletion receipt; require `status=deleted` after all other asynchronous cleanup also completes.
4. Record only the pseudonymous `meetingRef`, `ownerRef`, operator reference, timestamps, gate output, and backup reference in the private incident record.
5. Securely remove the 0600 review file after the incident retention policy permits it.

Never include raw identifiers, credentials, database URLs, manifest contents, or recording object keys in release notes or repository handoff documents.
