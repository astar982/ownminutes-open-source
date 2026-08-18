# OwnMinutes Secret Management Runbook

This runbook is the production checklist for protecting user BYOK provider keys and OwnMinutes application secrets.

## Current Boundary

- Default secret provider: `local-app-secret`
- Implemented production runtime: `OWNMINUTES_SECRET_STORE=vault-transit`
- Declared but unsupported runtime: `OWNMINUTES_KMS_KEY_ID` / `KMS_KEY_ID` (fails closed until an adapter exists)
- Local encryption: AES-256-GCM
- Current scoped ciphertext format: `v2.<iv>.<tag>.<ciphertext>`
- Vault ciphertext envelope: `v3.vault.<base64url(vault-ciphertext)>`
- Runtime storage field: `provider_credentials.encrypted_secrets`
- Browser/API response field: `secretPreviews`
- Secret provider contract: `src/lib/server/secret-provider.ts`

Current local encryption derives a provider-scoped key from `userId` and `providerId`. Vault Transit binds its encryption context to `userId`, `providerId`, and `secretName`. This prevents a ciphertext from being moved across users, providers, or credential fields. Local mode is acceptable for MVP development but not enough for public commercial operation.
Local JSON auth store and PostgreSQL auth repository must both call the shared Secret Provider contract. Do not reintroduce duplicate Provider secret encryption/decryption helpers in repository-specific files.

## Required Environment

The implemented production provider requires:

- `OWNMINUTES_SECRET_STORE=vault-transit`
- `OWNMINUTES_VAULT_ADDR=https://vault.example.com`
- `OWNMINUTES_VAULT_TRANSIT_KEY=ownminutes-provider-secrets`
- `OWNMINUTES_VAULT_TRANSIT_MOUNT=transit` (optional, defaults to `transit`)
- `OWNMINUTES_VAULT_NAMESPACE` (optional)
- `OWNMINUTES_VAULT_TOKEN_FILE=/absolute/path/to/0600-token-file`

The Vault token source file on the host must be a regular owner-only file. In the production Compose runtime it is mounted read-only at `/run/secrets/vault_token`; the application only permits broader read bits for a non-writable file under `/run/secrets/`. Never put the token value in `.env.production`.

Setting only `OWNMINUTES_KMS_KEY_ID`, `KMS_KEY_ID`, a generic `SECRET_STORE_URL`, or any `OWNMINUTES_SECRET_STORE` value other than `vault-transit` is not an implementation. Runtime encryption and strict preflight both reject it.

## Least-Privilege Vault Policy

Use a dedicated Transit key and substitute the configured mount/key exactly. Do not grant wildcards:

```hcl
path "transit/encrypt/ownminutes-provider-secrets" {
  capabilities = ["update"]
}

path "transit/decrypt/ownminutes-provider-secrets" {
  capabilities = ["update"]
}
```

The App/Worker token must not have `read`, `create`, `delete`, `list`, `patch`, `sudo`, or policy-management access. In particular, these reads must return HTTP 403:

```text
GET /v1/transit/keys/ownminutes-provider-secrets
GET /v1/sys/mounts
```

Use a separate operations identity for enabling Transit, creating/rotating keys, policy changes, audit devices, backup, and recovery. Prefer AppRole or workload identity plus Vault Agent auto-auth. Configure the Agent file sink to replace the host token file atomically with owner-only permissions; OwnMinutes rereads the file on every Vault request, so token renewal does not require putting the token in an environment variable or restarting the App.

For a plaintext runtime token sink, do not configure `wrap_ttl`; OwnMinutes expects the raw token. Override Vault Agent's default file mode explicitly:

```hcl
sink {
  type = "file"
  config = {
    path = "/srv/ownminutes/deploy/secrets/vault-token"
    mode = "0600"
  }
}
```

Vault Agent auto-auth requires renewable/unlimited-use tokens; do not set a finite `token_num_uses`. Protect and rotate the AppRole RoleID/SecretID according to the Vault AppRole operational guidance.

Production must also define:

- `OWNMINUTES_SECRET_ROTATION_POLICY`
- `OWNMINUTES_SECRET_AUDIT_LOG`
- `OWNMINUTES_TENANT_SCOPED_KEYS`
- `OWNMINUTES_SECRET_DELETION_PROOF`
- `OWNMINUTES_SECRET_ADMIN_ACCESS_POLICY`
- `OWNMINUTES_SECRET_LOCAL_SECRET_DECISION`
- `OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT`
- `OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY`

Do not commit app secrets, KMS key material, provider API keys, cookies, generated ciphertext samples, recovery keys, or decrypted exports.

## Required Guarantees

- Provider API keys are never returned to the browser after save.
- Browser responses only expose configured secret names and previews.
- Each tenant has tenant-scoped encryption context.
- Secret save, rotation, deletion, and failed decrypt events are auditable.
- Provider secret encryption, decryption, and managed reference deletion go through one shared Secret Provider contract.
- Provider key decrypt failures must be routed to the audit sink declared by `OWNMINUTES_SECRET_DECRYPT_FAILURE_AUDIT`.
- Updating an existing Provider secret must emit `provider_secret_rotate`, not only another save event.
- Local MVP writes low-sensitive audit events to `.data/auth/secret-audit.jsonl`; production should forward equivalent events to the managed audit sink declared by `OWNMINUTES_SECRET_AUDIT_LOG`.
- Old ciphertext can be read during planned rotation.
- Deleted accounts remove provider credentials.
- Support staff cannot view decrypted provider keys.
- KMS keys or managed secret references must have backup and recovery evidence declared by `OWNMINUTES_SECRET_BACKUP_RECOVERY_POLICY`.

## Preflight

Run:

```bash
npm run smoke:secret-preflight
npm run smoke:secret-vault-runtime
npm run smoke:secret-vault-repository
npm run smoke:secret-vault-live-verifier
npm run smoke:secret-audit
npm run smoke:secrets
npm run smoke:secret-evidence
npm run secret:evidence:draft
npm run smoke:auth
npm run smoke:settings
npm run smoke:release
```

Expected state before production KMS:

- `smoke:secret-preflight` confirms strict preflight rejects declaration-only KMS, unsupported managed stores, incomplete Vault config, and unsafe token file permissions.
- `smoke:secret-vault-runtime` confirms Vault round-trip, user/provider/field isolation, redirect rejection, response size limits, sanitized failure, local v2 compatibility, and declaration-only KMS fail-closed behavior.
- `smoke:secret-vault-repository` runs an isolated Next instance and Vault service through register, save, read/decrypt, atomic failed rotation, successful rotation/removal, and account deletion without plaintext leakage.
- `smoke:secret-vault-live-verifier` confirms the online verifier requires explicit authorization, writes private evidence, rejects over-privileged tokens and refuses insecure token files.
- `smoke:secrets` confirms diagnostics do not leak secrets.
- `smoke:secret-audit` confirms Provider secret save/delete audit events exist and do not leak secret values.
- `smoke:secret-audit` also exercises a Provider secret overwrite and confirms `provider_secret_rotate`.
- `smoke:auth` confirms account export does not include raw provider secrets.
- `smoke:settings` confirms setup health responses hide submitted keys.
- Release readiness remains blocked until a real Vault deployment, rotation, audit, tenant isolation, deletion, and recovery evidence are configured. The local fake Vault tests prove application behavior, not production operations.
- Private acceptance evidence checker validates the real KMS or managed secret store evidence template and rejects local secret provider, missing rotation, missing tenant isolation, missing account deletion cleanup, failed checks, ciphertext samples, and leaked keys.
- `secret:evidence:draft` creates the private evidence file structure with `pending` values and must not pass the acceptance checker until real evidence replaces every pending value.

## Migration Steps

1. Deploy or select a production HashiCorp Vault-compatible Transit service.
2. Create a dedicated Transit key and a least-privilege AppRole/token policy limited to encrypt/decrypt on that key.
3. Define rotation policy and old-key read window.
4. Define audit events for save, rotate, delete, decrypt failure, and admin access attempts.
5. Define decrypt-failure audit routing and alert threshold.
6. Define KMS or managed secret backup/recovery procedure.
7. Configure `OWNMINUTES_SECRET_STORE=vault-transit` and the Vault environment listed above.
8. Run `npm run smoke:secret-vault-runtime`, `npm run smoke:secret-vault-repository`, and `npm run secret:preflight` in the release environment.
9. Add a dual-read period for local v2 ciphertext and new managed ciphertext.
10. Re-save or rotate active provider credentials.
11. Confirm account delete removes provider credential references.
12. Disable local app secret usage in production runtime.
13. Run the production smoke gate.
14. In the production deployment environment, run `npm run secret:preflight`.

## Production Compose

When `deploy/.env.production` contains `OWNMINUTES_SECRET_STORE=vault-transit`, `scripts/production-stack.mjs` automatically adds `deploy/compose.vault.yml`. The override mounts the token into `app`, `worker-1`, and `worker-2`, and passes only non-secret Vault metadata through environment variables.

Before `npm run production:config` or `npm run production:up`:

1. Create the host token file at the path in `OWNMINUTES_VAULT_TOKEN_FILE` and set mode `0600`.
2. Confirm the token can only call `transit/encrypt/<key>` and `transit/decrypt/<key>`; it must not manage policies, auth methods, mounts, or unrelated keys.
3. Fill every `OWNMINUTES_SECRET_*` operational evidence declaration in `.env.production`.
4. Run `npm run secret:preflight` on the host.
5. Run `OWNMINUTES_VAULT_LIVE_VERIFY=1 npm run secret:vault:live:verify`. It uses only random synthetic plaintext and writes `.data/acceptance/vault-transit-live-latest.json` with mode 0600.
6. Run `npm run production:config`; inspect that all three runtime services receive `/run/secrets/vault_token`, not the raw token.

Do not add Vault to the database migration, administrator bootstrap, MinIO, or Caddy containers; they do not decrypt user BYOK credentials.

The live verifier deliberately fails when its token can read Transit key metadata or `sys/mounts`. Do not weaken this check to make an administrator/root token pass; create the actual least-privilege runtime token instead.
Loopback HTTP is available only to the automated smoke and writes `status=test-pass`; the acceptance checker only accepts `status=pass` from an HTTPS run.

## Private Acceptance Evidence

Real provider keys, ciphertext samples, Vault token/policy material, recovery material, and decrypted exports must not be committed. Save sanitized production evidence locally:

```text
.data/acceptance/secret-management-latest.md
.data/acceptance/vault-transit-live-latest.json
```

To create the private evidence file structure before QA, run:

```bash
npm run secret:evidence:draft
```

This writes `.data/acceptance/secret-management-latest.md` with every required field set to `pending`. The draft is intentionally incomplete: `npm run secret:acceptance:evidence` must fail until every pending value is replaced, the final line is `Decision: pass`, and a matching Vault live JSON exists. The JSON must be no older than 24 hours, mode 0600, use HTTPS, match the Markdown commit, and contain all required checks as `true`.

Then run:

```bash
npm run secret:acceptance:evidence
```

Use `OWNMINUTES_SECRET_EVIDENCE_PATH=/path/to/evidence.md` when checking a different private file.

Required evidence fields:

```markdown
# Secret Management Acceptance Evidence

Date:
Commit:
Secret provider: managed-secret-store
Runtime adapter: vault-transit
KMS key or store reference:
Vault policy:
Vault live evidence:
Encryption context:
Rotation policy:
Audit log sink:
Tenant scoped keys: yes
Deletion proof:
Admin access policy:
Local secret decision:
Decrypt failure audit:
Backup recovery policy:
Secret diagnostics: pass
Release readiness secretManagementBlocked: no
Release readiness nextAction:

Production preflight: pass
Vault runtime smoke: pass
Vault repository smoke: pass
Vault live verifier: pass
Redirect rejection: pass
Oversized response rejection: pass
Token file permission check: pass
Secret audit smoke: pass
Provider secret save: pass
Provider secret preview only: pass
Provider secret rotate: pass
Provider secret delete: pass
Account deletion cleanup: pass
Tenant isolation proof: pass
Admin plaintext denial: pass
Decrypt failure audit proof: pass
Backup/recovery proof: pass
Local secret migration handled: pass
Runtime provider decrypt: pass
Export excludes plaintext: pass
Browser response hides plaintext: pass

Secrets leaked: no
Decision: pass
Known issues:
```

Do not paste provider API keys, app secrets, raw ciphertext, signed tokens, cookies, KMS key material, recovery keys, or decrypted exports.

## Rotation

Minimum rotation procedure:

```text
create new key version
write new secrets with new key version
keep old key readable for migration window
re-encrypt active provider credentials
verify provider runtime config can decrypt
disable old key after rollback window
record audit events
```

Vault Transit decrypts older ciphertext versions after `transit/keys/<key>/rotate`. Do not raise `min_decryption_version` until every stored `v3.vault` credential has been rewrapped or re-saved and rollback evidence has passed. The runtime token must not receive rotate/rewrap/key-configuration privileges merely to simplify this procedure.

## Rollback

- Do not delete old keys until the rollback window ends.
- Do not overwrite local ciphertext without a backup.
- If managed secret writes fail, keep reading old ciphertext and block new provider setup.
- If Vault token renewal fails, preserve meeting audio, reject Provider secret save/decrypt with a sanitized error, restore the Vault Agent/token path, then rerun the synthetic live verifier before resuming model processing.
- Never expose decrypted provider keys during rollback.

## Production Verification

Minimum production gate:

```bash
npm run secret:preflight
npm run smoke:secret-vault-runtime
npm run smoke:secret-vault-repository
npm run smoke:secret-vault-live-verifier
OWNMINUTES_VAULT_LIVE_VERIFY=1 npm run secret:vault:live:verify
npm run smoke:secret-audit
npm run smoke:secrets
npm run smoke:auth
npm run smoke:settings
npm run secret:evidence:draft
npm run secret:acceptance:evidence
npm run smoke:release
```

Manual verification still required:

- Vault policy and token lifetime review.
- Key rotation rehearsal.
- Account deletion proof.
- Audit log sample for provider secret save and deletion.
- Support/admin access denial proof.
- Decrypt-failure audit sample.
- Backup/recovery drill for Vault storage and Transit key material.

## References

- HashiCorp Vault Transit API: https://developer.hashicorp.com/vault/api-docs/secret/transit
- Vault Transit secrets engine: https://developer.hashicorp.com/vault/docs/secrets/transit
- Vault Agent auto-auth: https://developer.hashicorp.com/vault/docs/agent-and-proxy/autoauth
- Vault Agent file sink: https://developer.hashicorp.com/vault/docs/agent-and-proxy/autoauth/sinks/file
- AppRole auto-auth: https://developer.hashicorp.com/vault/docs/agent-and-proxy/autoauth/methods/approle
