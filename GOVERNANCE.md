# Governance

OwnMinutes is an early-stage, maintainer-led open-source project. This document
sets expectations for transparent collaboration without promising a response or
release service level.

## Roles

- **Users** may open issues and participate in discussions.
- **Contributors** submit reproducible reports, documentation, designs, tests,
  or code under the contribution terms in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Maintainers** triage issues, review changes, protect releases, enforce the
  Code of Conduct, and decide what enters the official repository.
- The **lead maintainer** has final responsibility for product direction,
  privacy and security boundaries, releases, and maintainer appointments.

Current maintainers are listed in [MAINTAINERS.md](MAINTAINERS.md).

## How decisions are made

Small fixes and documentation changes are decided through pull-request review.
Open an issue before a major change to product direction, architecture, schema,
privacy, security, billing, deployment, or compatibility. The issue should
describe the user problem, alternatives, trade-offs, migration impact, and a
rollback path where applicable.

Maintainers aim for evidence-based consensus. When consensus is not possible,
the lead maintainer makes the final decision and should record the important
reasoning in the issue or pull request. Security reports and private user data
are handled outside public threads.

## Becoming a maintainer

Maintainer access is earned through sustained, constructive contributions,
sound technical judgment, respect for privacy and security boundaries, and
reliable review participation. An existing maintainer proposes the appointment
in a pull request that updates [MAINTAINERS.md](MAINTAINERS.md). Repository
access is granted only after that change is accepted.

## Releases and official status

Only releases, packages, images, and services explicitly identified by the lead
maintainer are official OwnMinutes releases. A fork may change the software
under Apache License 2.0, but must not imply official endorsement. See
[TRADEMARKS.md](TRADEMARKS.md).

## Changes to governance

Governance changes use the same public issue and pull-request process. The lead
maintainer may make an immediate, documented change when necessary to address a
security, legal, privacy, or community-safety risk.
