# Security Policy

## Supported versions

OwnMinutes is early-stage software. Security fixes are applied to the latest
commit on the default branch. There is no supported stable release line yet.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability.

Use GitHub's **Security → Advisories → Report a vulnerability** flow. Repository
maintainers must enable private vulnerability reporting before making the
repository public. If that button is unavailable, open a minimal issue asking
for a private contact method without including technical details.

Include, when possible:

- affected commit or version;
- impact and realistic attack scenario;
- minimal reproduction using synthetic data;
- suggested mitigation;
- whether a credential may have been exposed.

Never attach real meeting audio, transcripts, account exports, provider keys,
cookies, tokens, production configuration, or customer data. If a live
credential is exposed, revoke or rotate it before sending the report.

Maintainers will acknowledge reports on a best-effort basis, investigate them
privately, and coordinate disclosure after a fix is available. No response-time
guarantee is offered at this stage.

## Temporary upstream audit exception

Expo/Metro currently resolves `image-size@1.2.1`, while npm reports
`GHSA-w3rx-r6r6-pgpr` and `GHSA-5p2g-fcmc-qvqq` against every available
`image-size` version. These are denial-of-service issues in build-time image
parsers; the package is not shipped as application runtime code. The mobile
audit allows only these two advisory roots, only through the indirect
Expo/Metro path, and only until 2026-09-30. Any additional advisory or an
expired exception fails CI. This is risk acceptance, not a claim that the
upstream defect is fixed.

## Deployment responsibility

Self-hosters are responsible for their infrastructure, backups, access control,
provider accounts, legal compliance, and incident response. A passing local or
CI check does not certify a deployment as secure or legally compliant.
