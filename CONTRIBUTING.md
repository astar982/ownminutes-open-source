# Contributing to OwnMinutes

Thank you for helping improve OwnMinutes.

OwnMinutes uses a maintainer-led governance model. Read
[GOVERNANCE.md](GOVERNANCE.md) for how decisions are made and
[MAINTAINERS.md](MAINTAINERS.md) for current project ownership.

## Before you start

- Search existing issues and pull requests.
- Open an issue before a large product, architecture, schema, privacy, billing,
  or deployment change.
- Never use real meeting content, user data, or live credentials in a test,
  issue, commit, screenshot, or pull request.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js `22.22.x` and npm `11.8.x`.

```bash
npm ci
npm --prefix apps/mobile ci
npm run typecheck
npm run mobile:typecheck
npm run lint -- --max-warnings=0
npm run build
```

The full backend and iOS gates are expensive. Run focused tests during
development and let the repository CI route the final checks by changed path.

## Pull requests

Keep each pull request focused. Explain:

- the user-visible problem;
- the root cause or design reason;
- the chosen solution and trade-offs;
- tests that were run;
- remaining risks and evidence boundaries.

Do not weaken consent, deletion, credential, account-isolation, billing, or
release gates merely to make a test pass. Add regression coverage for fixes.

By submitting a contribution for inclusion in OwnMinutes, you agree that it may
be licensed under Apache License 2.0 as described by section 5 of that license,
unless you explicitly state otherwise before submission.

Do not remove or obscure applicable author, copyright, license, or NOTICE
information. See [ATTRIBUTION.md](ATTRIBUTION.md) for redistribution guidance.
