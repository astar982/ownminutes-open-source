// The community distribution is source-only. This build compiles the upstream
// release and verifies the bundled mc with MinIO's minisign key. See
// docs/minio-image-pins.md for registry and provenance verification evidence.
export const MINIO_IMAGE = "ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9";
export const MINIO_CLIENT_IMAGE = MINIO_IMAGE;
// The shared image defaults to the server's entrypoint, not mc.
export const MINIO_CLIENT_ARGS = Object.freeze(["--entrypoint", "/usr/bin/mc", MINIO_CLIENT_IMAGE]);
