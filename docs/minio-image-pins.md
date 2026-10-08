# MinIO image pins

The community edition is now [distributed as source only](https://github.com/minio/minio#source-only-distribution).
The old Quay server and client digest requests returned `UNAUTHORIZED` on
2026-10-08, including after requesting anonymous pull tokens. The public Docker
Hub `minio/minio` tag endpoint returned 404. Adding CI credentials is not a fix
for unavailable public images.

Production, production-like Compose, cleanup smoke tests, off-site backup and
restore drills use the same release and OCI index:

```text
ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9
```

This is a third-party build, maintained by [Coollabs](https://github.com/coollabsio/minio),
of the upstream MinIO release. It contains both `minio` and `mc`; direct client
invocations must override the server entrypoint with `/usr/bin/mc`. Shell-based
initialization and backup commands retain `/bin/sh`. Script consumers share
`scripts/lib/minio-images.mjs`; `smoke:container` checks both Compose pins against
that constant. Update these together when changing the release.

## Verification evidence

Anonymous GHCR pull access returned 200 for both the release tag and the exact
index digest. The downloaded index's SHA-256 matches the pin. It includes:

- linux/amd64: `sha256:4f75fd76598afa23919555d1363e1fb13c632d9bcd4ce8edcf21d3cca2ed0579`
- linux/arm64: `sha256:7520deab26e83d3a36231bb449f86548a4b9ab2507eb388f87d1f70ef5e8c1f3`

The amd64 manifest's SHA-256 was also checked. Its config selects
`/usr/bin/docker-entrypoint.sh`, declares the release above and the MinIO secret
file variables used by production. Its layer history includes the server,
client, CA certificates and upstream entrypoint. Downloaded UBI layers contain
the shell, `cat`, `wc` and `sha256sum` required by the existing commands.

The attached BuildKit provenance identifies [build run 18846682762](https://github.com/coollabsio/minio/actions/runs/18846682762),
builder revision `f287946512b7fbc420f631c62092322f3a04850b`, an upstream clone
and checkout of the release, and a minisign verification step for the downloaded
mc using MinIO's public key. Inspect that revision's
[Dockerfile](https://github.com/coollabsio/minio/blob/f287946512b7fbc420f631c62092322f3a04850b/Dockerfile)
when reviewing the build. The inherited image revision label refers to its UBI
base; it is not the MinIO source revision.

The provenance records `reproducible: false` and incomplete materials. Registry
hash checks and this provenance inspection establish the selected artifact and
documented build process; they do not replace runtime acceptance or an independent
rebuild. The full server binary layer download timed out on the Windows host.
Docker is unavailable there, so cleanup authorization, version purging, lifecycle
initialization, backup/restore and queue recovery still require the unchanged
container gates on a Docker-capable runner. This change does not deploy a stack
or certify the image's complete vulnerability status.
