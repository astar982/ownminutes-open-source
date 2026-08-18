#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(".data/smoke/appstore-upload");
const artifactRoot = path.join(root, "artifacts");
const ipaPath = path.join(artifactRoot, "OwnMinutes-1.0.0-901.ipa");
const summaryPath = path.join(artifactRoot, "latest-summary.json");
const keyPath = path.join(root, "private", "AuthKey_TESTKEY123.p8");
const runnerPath = path.join(root, "fake-altool.mjs");
const evidencePath = path.join(root, "upload-evidence.json");
const gitCommit = capture("git", ["rev-parse", "HEAD"]);

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(artifactRoot, { recursive: true });
fs.mkdirSync(path.dirname(keyPath), { recursive: true });
fs.writeFileSync(ipaPath, Buffer.from("synthetic-appstore-upload-smoke-ipa"), { mode: 0o600 });
const ipa = fs.readFileSync(ipaPath);
const summary = candidateSummary();
writePrivateJson(summaryPath, summary);
fs.writeFileSync(keyPath, "test-private-key-material-never-sent", { mode: 0o600 });
fs.writeFileSync(runnerPath, `
const args = process.argv.slice(2);
if (args.some((value) => value.includes("SIGNING-PROBE-DO-NOT-UPLOAD"))) process.exit(8);
if (!args.includes("--api-key") || !args.includes("--api-issuer") || !args.includes("--p8-file-path")) process.exit(9);
if (args.includes("--upload-package") && !args.includes("--wait")) process.exit(10);
console.log(JSON.stringify({ data: { deliveryId: args.includes("--upload-package") ? "delivery-smoke-redacted" : null }, errors: [] }));
`, { mode: 0o600 });

const baseEnv = {
  ...process.env,
  OWNMINUTES_APPSTORE_UPLOAD_TEST_MODE: "1",
  OWNMINUTES_ASC_TEST_GIT_CLEAN: "1",
  OWNMINUTES_ASC_TEST_ALTOOL_RUNNER: runnerPath,
  OWNMINUTES_LOCAL_TESTFLIGHT_ARTIFACT_ROOT: artifactRoot,
  OWNMINUTES_LOCAL_TESTFLIGHT_SUMMARY_PATH: summaryPath,
  OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH: evidencePath,
  OWNMINUTES_ASC_API_KEY_ID: "TESTKEY123",
  OWNMINUTES_ASC_API_ISSUER_ID: "12345678-1234-1234-1234-123456789abc",
  OWNMINUTES_ASC_API_PRIVATE_KEY_PATH: keyPath,
};

const preflight = runUpload(["--preflight"], baseEnv);
const validation = runUpload(["--validate"], baseEnv);
const validationEvidence = readJson(evidencePath);
const missingConfirmation = runUpload(["--upload"], baseEnv);
const upload = runUpload(["--upload"], { ...baseEnv, OWNMINUTES_APPSTORE_UPLOAD: "1" });
const uploadEvidence = readJson(evidencePath);
const formalCheck = runFormalChecker(baseEnv);

writePrivateJson(summaryPath, { ...summary, mode: "signing-probe-do-not-upload", artifact: "SIGNING-PROBE-DO-NOT-UPLOAD.ipa" });
const probe = runUpload(["--preflight"], baseEnv);
writePrivateJson(summaryPath, {
  ...summary,
  mode: "testflight-internal-only-candidate",
  distributionScope: "internal-testflight-only",
  testFlightInternalTestingOnly: true,
});
const internalOnlyAltool = runUpload(["--preflight"], baseEnv);
writePrivateJson(summaryPath, summary);
fs.writeFileSync(ipaPath, Buffer.from("tampered"), { mode: 0o600 });
const tampered = runUpload(["--preflight"], baseEnv);
fs.writeFileSync(ipaPath, ipa, { mode: 0o600 });
fs.chmodSync(ipaPath, 0o644);
const publicIpa = runUpload(["--preflight"], baseEnv);
fs.chmodSync(ipaPath, 0o600);
fs.chmodSync(keyPath, 0o644);
const publicKey = runUpload(["--preflight"], baseEnv);
fs.chmodSync(keyPath, 0o600);
const trackedEvidence = runUpload(["--preflight"], { ...baseEnv, OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH: path.join(process.cwd(), "docs", "should-not-write-upload-evidence.json") });

const serializedEvidence = JSON.stringify(uploadEvidence || {});
const summaryResult = {
  preflightPassesForVerifiedCandidate: preflight.status === 0 && preflight.payload?.ok === true,
  validationCallsAltoolAndWritesPrivateEvidence:
    validation.status === 0 &&
    validationEvidence?.operation === "validate" &&
    validationEvidence?.status === "pass" &&
    (fs.statSync(evidencePath).mode & 0o077) === 0,
  uploadRequiresExplicitConfirmation:
    missingConfirmation.status !== 0 && missingConfirmation.payload?.error?.includes("OWNMINUTES_APPSTORE_UPLOAD=1"),
  uploadRecordsDeliveryReceipt:
    upload.status === 0 &&
    uploadEvidence?.operation === "upload" &&
    uploadEvidence?.apple?.deliveryId === "delivery-smoke-redacted" &&
    uploadEvidence?.apple?.processed === true,
  formalUploadEvidencePasses: formalCheck.status === 0 && formalCheck.payload?.ok === true,
  signingProbeRejected: probe.status !== 0 && probe.payload?.preflight?.failures?.some((value) => value.includes("signing probe")),
  internalOnlyCandidateRejectedByAltool:
    internalOnlyAltool.status !== 0 &&
    internalOnlyAltool.payload?.preflight?.failures?.some((value) => value.includes("UploadOptions.plist")),
  tamperedIpaRejected: tampered.status !== 0 && tampered.payload?.preflight?.failures?.some((value) => value.includes("SHA-256")),
  publicCandidateIpaRejected: publicIpa.status !== 0 && publicIpa.payload?.preflight?.failures?.some((value) => value.includes("IPA must be 0600")),
  publicCredentialFileRejected: publicKey.status !== 0 && publicKey.payload?.preflight?.failures?.some((value) => value.includes("0600")),
  trackedEvidencePathRejected: trackedEvidence.status !== 0 && trackedEvidence.payload?.preflight?.failures?.some((value) => value.includes("evidence path")),
  evidenceHidesCredentials:
    !serializedEvidence.includes("TESTKEY123") &&
    !serializedEvidence.includes("12345678-1234-1234-1234-123456789abc") &&
    !serializedEvidence.includes(keyPath) &&
    !serializedEvidence.includes("test-private-key-material"),
};

console.log(JSON.stringify(summaryResult, null, 2));
if (Object.values(summaryResult).some((value) => value !== true)) process.exitCode = 1;

function candidateSummary() {
  return {
    ok: true,
    mode: "testflight-candidate",
    artifact: path.relative(process.cwd(), ipaPath),
    bytes: ipa.byteLength,
    sha256: crypto.createHash("sha256").update(ipa).digest("hex"),
    appName: "OwnMinutes",
    bundleId: "app.ownminutes.mobile",
    version: "1.0.0",
    buildNumber: "901",
    teamId: "TEAMID1234",
    gitCommit,
    apiHost: "app.example.com",
    signatureVerified: true,
    appStoreProfile: true,
    checks: {
      bundleId: true,
      version: true,
      buildNumber: true,
      applicationIdentifier: true,
      betaReportsActive: true,
      distributionBuild: true,
      apiUrlEmbedded: true,
      apiDefaultMarker: true,
      noLocalDefaultMarker: true,
    },
  };
}

function runUpload(args, env) {
  const run = spawnSync("node", ["scripts/upload-ios-local-testflight.mjs", ...args], { encoding: "utf8", env });
  return { status: run.status, payload: parseJson(`${run.stdout || ""}${run.stderr || ""}`) };
}

function runFormalChecker(env) {
  const run = spawnSync("node", ["scripts/check-ios-appstore-upload-evidence.mjs"], { encoding: "utf8", env });
  return { status: run.status, payload: parseJson(run.stdout) };
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function readJson(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : null;
}

function parseJson(text = "") {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function capture(command, args) {
  const run = spawnSync(command, args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`${command} failed`);
  return run.stdout.trim();
}
