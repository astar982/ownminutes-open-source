#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const suffix = crypto.randomBytes(6).toString("hex");
const network = `ownminutes-cleanup-smoke-${suffix}`;
const server = `ownminutes-cleanup-minio-${suffix}`;
const rootUser = `root-${crypto.randomBytes(12).toString("hex")}`;
const rootPassword = crypto.randomBytes(24).toString("base64url");
const cleanupUser = `cleanup-${crypto.randomBytes(10).toString("hex")}`;
const cleanupPassword = crypto.randomBytes(24).toString("base64url");
const minioImage = "quay.io/minio/minio:latest@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const mcImage = "quay.io/minio/mc:latest@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727";
const policyPath = path.join(process.cwd(), "deploy", "minio-cleanup-policy.json");

try {
  runDocker(["network", "create", network]);
  runDocker([
    "run",
    "--detach",
    "--name",
    server,
    "--network",
    network,
    "--publish",
    "127.0.0.1::9000",
    "--env",
    `MINIO_ROOT_USER=${rootUser}`,
    "--env",
    `MINIO_ROOT_PASSWORD=${rootPassword}`,
    minioImage,
    "server",
    "/data",
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = runMc(rootUser, rootPassword, ["ready", "local"], false);
    if (result.status === 0) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error("Ephemeral MinIO did not become ready.");

  runMc(rootUser, rootPassword, ["mb", "local/ownminutes"]);
  runMc(rootUser, rootPassword, ["mb", "local/unrelated"]);
  runMc(rootUser, rootPassword, ["anonymous", "set", "none", "local/ownminutes"]);
  runMc(rootUser, rootPassword, ["version", "enable", "local/ownminutes"]);
  runMc(rootUser, rootPassword, ["admin", "user", "add", "local", cleanupUser, cleanupPassword]);
  runMc(rootUser, rootPassword, ["admin", "policy", "create", "local", "ownminutes-cleanup", "/policy.json"], true, true);
  runMc(rootUser, rootPassword, ["admin", "policy", "attach", "local", "ownminutes-cleanup", "--user", cleanupUser]);

  for (const objectPath of [
    "ownminutes/meetings/m1/manifest.json",
    "ownminutes/meetings/m1/transient/asr.wav",
    "ownminutes/meetings/m1/uploads/part-1",
  ]) {
    runMc(rootUser, rootPassword, ["cp", "/etc/hosts", `local/ownminutes/${objectPath}`]);
  }
  runMc(rootUser, rootPassword, ["rm", "--force", "local/ownminutes/ownminutes/meetings/m1/transient/asr.wav"]);
  runMc(rootUser, rootPassword, ["cp", "/etc/hosts", "local/ownminutes/ownminutes/meetings/m1/transient/asr.wav"]);
  runMc(rootUser, rootPassword, ["cp", "/etc/hosts", "local/ownminutes/ownminutes/meetings/m1/uploads/part-1"]);
  runMc(rootUser, rootPassword, ["cp", "/etc/hosts", "local/unrelated/private.txt"]);

  const listing = runMc(cleanupUser, cleanupPassword, [
    "ls",
    "--recursive",
    "--json",
    "local/ownminutes/ownminutes/meetings",
  ]).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const transient = listing.find((item) => item.key.endsWith("/transient/asr.wav"));
  const upload = listing.find((item) => item.key.endsWith("/uploads/part-1"));
  if (!transient || !upload) throw new Error("Cleanup identity could not list nested transient/upload keys.");
  expectDenied(cleanupUser, cleanupPassword, ["cat", `local/ownminutes/ownminutes/${transient.key}`]);
  runCleanup();

  expectDenied(cleanupUser, cleanupPassword, ["cat", "local/ownminutes/ownminutes/meetings/m1/manifest.json"]);
  expectDenied(cleanupUser, cleanupPassword, ["cp", "/etc/hosts", "local/ownminutes/ownminutes/meetings/m1/result.json"]);
  expectDenied(cleanupUser, cleanupPassword, ["rm", "--force", "local/ownminutes/ownminutes/meetings/m1/manifest.json"]);
  expectDenied(cleanupUser, cleanupPassword, ["ls", "local/unrelated"]);

  runMc(rootUser, rootPassword, ["stat", "local/ownminutes/ownminutes/meetings/m1/manifest.json"]);
  expectMissing(rootUser, rootPassword, "local/ownminutes/ownminutes/meetings/m1/transient/asr.wav");
  expectMissing(rootUser, rootPassword, "local/ownminutes/ownminutes/meetings/m1/uploads/part-1");
  const retainedVersions = runMc(rootUser, rootPassword, [
    "ls",
    "--recursive",
    "--versions",
    "--json",
    "local/ownminutes/ownminutes/meetings",
  ]).stdout;
  if (/\/(?:transient|uploads)\//.test(retainedVersions)) {
    throw new Error("Cleanup left a noncurrent transient/upload version or delete marker behind.");
  }

  console.log(JSON.stringify({
    cleanupCanDeleteTransientAndUploads: true,
    cleanupCannotDeleteCanonicalObjects: true,
    cleanupCannotReadOrWriteMeetingContent: true,
    cleanupCannotAccessUnrelatedBucket: true,
    cleanupPhysicallyPurgesVersionsAndDeleteMarkers: true,
  }, null, 2));
} finally {
  runDocker(["rm", "--force", server], false);
  runDocker(["network", "rm", network], false);
}

function runMc(user, password, args, required = true, mountPolicy = false, input) {
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    network,
    "--env",
    `MC_HOST_local=http://${user}:${password}@${server}:9000`,
  ];
  if (input !== undefined) dockerArgs.push("--interactive");
  if (mountPolicy) dockerArgs.push("--volume", `${policyPath}:/policy.json:ro`);
  dockerArgs.push(mcImage, ...args);
  return runDocker(dockerArgs, required, input);
}

function expectDenied(user, password, args) {
  const result = runMc(user, password, args, false);
  if (result.status === 0) throw new Error(`Cleanup policy unexpectedly allowed: mc ${args.join(" ")}`);
}

function expectMissing(user, password, objectPath) {
  const result = runMc(user, password, ["stat", objectPath], false);
  if (result.status === 0) throw new Error(`Expected cleanup to remove ${objectPath}.`);
}

function runCleanup() {
  const portOutput = runDocker(["port", server, "9000/tcp"]).stdout.trim().split("\n")[0] || "";
  const port = /:(\d+)$/.exec(portOutput)?.[1];
  if (!port) throw new Error("Could not resolve the ephemeral MinIO port.");
  const result = spawnSync(
    process.execPath,
    ["scripts/cleanup-transient-meeting-objects.mjs", "--once"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        OWNMINUTES_CLEANUP_TEST_MODE: "1",
        OWNMINUTES_CLEANUP_TEST_NOW: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        OWNMINUTES_STORAGE_PREFIX: "ownminutes/meetings",
        OWNMINUTES_TRANSIENT_RETENTION_DAYS: "1",
        OWNMINUTES_UPLOAD_RETENTION_DAYS: "1",
        OWNMINUTES_TRANSIENT_CLEANUP_INTERVAL_SECONDS: "300",
        S3_ACCESS_KEY_ID: cleanupUser,
        S3_BUCKET: "ownminutes",
        S3_ENDPOINT: `http://127.0.0.1:${port}`,
        S3_REGION: "us-east-1",
        S3_SECRET_ACCESS_KEY: cleanupPassword,
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Cleanup runtime failed.");
  const summary = JSON.parse(result.stdout);
  if (summary.deleted !== 5 || summary.scanned !== 6) {
    throw new Error(`Cleanup runtime returned an unexpected result: ${result.stdout}`);
  }
}

function runDocker(args, required = true, input) {
  const result = spawnSync("docker", args, { encoding: "utf8", input });
  if (result.error) throw result.error;
  if (required && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `docker ${args[0]} failed`);
  }
  return result;
}
