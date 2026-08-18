# Open-source publication checklist

Use this checklist only with the sanitized, single-commit public snapshot. Do
not change the private source repository to public, copy its working directory,
or import its branches, tags, pull requests, Actions artifacts, or Git history.

## 1. Inspect the local snapshot

From the generated snapshot directory:

```bash
git status --short
git rev-list --count --all
npm ci
npm --prefix apps/mobile ci
npm run open-source:check -- --repository OWNER/REPOSITORY
npm run typecheck
npm run mobile:typecheck
npm run lint -- --max-warnings=0
npm run build
```

The worktree must be clean, the history count must be `1`, and all checks must
pass. Search the snapshot again for credentials, personal email addresses,
private hostnames, public server addresses, private meeting data, transcripts,
and local filesystem paths. Automated scanning reduces risk but does not prove
that publication is safe.

## 2. Create an empty GitHub repository

Create a new public repository using the exact `OWNER/REPOSITORY` name passed to
the snapshot generator. Do not initialize it with a README, license, `.gitignore`,
template, or imported history. Then connect and push the snapshot:

```bash
git remote add origin git@github.com:OWNER/REPOSITORY.git
git push -u origin main
```

Never force-push the private source history into this repository.

## 3. Configure GitHub before announcing the project

- Enable private vulnerability reporting under **Security**.
- Confirm secret scanning and push protection are enabled.
- Enable Dependabot alerts and security updates.
- Enable GitHub's recommended CodeQL/default code-scanning setup where available.
- Set Actions workflow permissions to read-only by default.
- Require approval before workflows from first-time outside contributors run.
- Add a `main` ruleset that blocks force pushes and deletion and requires pull
  requests plus the repository's CI checks.
- Confirm Issues are enabled; enable Discussions only if there is time to
  moderate and answer them.

Wait for the first CI, dependency, secret, and code-scanning results. Review any
finding before sharing the repository publicly.

## 4. Final human review

- Read README, SECURITY, SUPPORT, CONTRIBUTING, NOTICE, and LICENSE as a new user.
- Confirm ATTRIBUTION, AUTHORS, CITATION, GOVERNANCE, MAINTAINERS, TRADEMARKS,
  and CODEOWNERS identify the creator and do not overstate Apache-2.0 duties.
- Confirm screenshots and fixtures contain only synthetic information.
- Confirm no production or shared-test service is referenced or required.
- Decide whether the OwnMinutes name and logo need a separate trademark policy.
- State clearly that the project is early-stage and support is best-effort.

Publishing source code does not publish a server, TestFlight build, App Store
release, hosted service, or security certification. Keep those decisions and
credentials separate.
