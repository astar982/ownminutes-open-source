#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const options = new Set(process.argv.slice(2));
const operation = options.has("--upload") ? "upload" : options.has("--validate") ? "validate" : "preflight";
const testMode = process.env.OWNMINUTES_APPSTORE_UPLOAD_TEST_MODE === "1";
const artifactRoot = path.resolve(process.env.OWNMINUTES_LOCAL_TESTFLIGHT_ARTIFACT_ROOT || path.join(repoRoot, ".data", "testflight-local"));
const summaryPath = path.resolve(process.env.OWNMINUTES_LOCAL_TESTFLIGHT_SUMMARY_PATH || path.join(artifactRoot, "latest-summary.json"));
const evidencePath = path.resolve(process.env.OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH || path.join(repoRoot, ".data", "acceptance", "appstore-upload-latest.json"));
const apiKeyId = process.env.OWNMINUTES_ASC_API_KEY_ID?.trim() || "";
const apiIssuerId = process.env.OWNMINUTES_ASC_API_ISSUER_ID?.trim() || "";
const privateKeyPath = process.env.OWNMINUTES_ASC_API_PRIVATE_KEY_PATH?.trim() || "";
const gitCommit = git(["rev-parse", "HEAD"]);
const gitClean = testMode
  ? process.env.OWNMINUTES_ASC_TEST_GIT_CLEAN === "1"
  : git(["status", "--porcelain"]) === "";

const preflight = collectPreflight();
if (operation === "preflight") {
  console.log(JSON.stringify({ ok: preflight.failures.length === 0, operation, preflight }, null, 2));
  if (preflight.failures.length > 0) process.exitCode = 1;
  process.exit();
}

if (preflight.failures.length > 0) fail("App Store upload preflight failed.", { failures: preflight.failures });
if (operation === "upload" && process.env.OWNMINUTES_APPSTORE_UPLOAD !== "1") {
  fail("Actual upload requires OWNMINUTES_APPSTORE_UPLOAD=1 in addition to --upload.");
}

removeStaleEvidence();
const altoolArgs = [
  operation === "upload" ? "--upload-package" : "--validate-app",
  preflight.ipaPath,
  "--api-key",
  apiKeyId,
  "--api-issuer",
  apiIssuerId,
  "--p8-file-path",
  privateKeyPath,
  "--output-format",
  "json",
  ...(operation === "upload" ? ["--wait"] : []),
];
const result = runAltool(altoolArgs);
const output = redact(result.output);
const payload = parseJson(output);
if (result.status !== 0 || hasAltoolErrors(payload, output)) {
  fail(`App Store ${operation} failed.`, {
    status: result.status,
    diagnostic: summarizeDiagnostic(payload, output),
  });
}

const receipt = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  operation,
  status: "pass",
  candidate: {
    sha256: preflight.candidateSha256,
    bytes: preflight.candidateBytes,
    bundleId: preflight.bundleId,
    version: preflight.version,
    buildNumber: preflight.buildNumber,
    gitCommit,
    apiHost: preflight.apiHost,
  },
  apple: {
    deliveryId: findDeliveryId(payload),
    processed: operation === "upload",
  },
  checks: {
    candidateMode: true,
    signingProbeRejected: true,
    candidateHashMatches: true,
    cleanGit: true,
    currentCommit: true,
    distributionSignature: true,
    publicApiOrigin: true,
    credentialFilePrivate: true,
    noSecretLeak: true,
  },
};

assertNoSensitiveEvidence(JSON.stringify(receipt));
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.writeFileSync(evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(evidencePath, 0o600);

console.log(JSON.stringify({
  ok: true,
  operation,
  status: "pass",
  evidencePath,
  candidate: receipt.candidate,
  deliveryIdRecorded: Boolean(receipt.apple.deliveryId),
  secretLeak: false,
}, null, 2));

function collectPreflight() {
  const failures = [];
  const summary = readSummary(summaryPath, failures);
  const artifact = typeof summary?.artifact === "string" ? summary.artifact : "";
  const ipaPath = artifact ? path.resolve(repoRoot, artifact) : "";
  const candidateSha256 = ipaPath && fs.existsSync(ipaPath) ? sha256File(ipaPath) : "";
  const candidateBytes = ipaPath && fs.existsSync(ipaPath) ? fs.statSync(ipaPath).size : 0;
  const apiHost = typeof summary?.apiHost === "string" ? summary.apiHost : "";

  if (!isPrivateDestination(artifactRoot)) failures.push("artifact root must be ignored .data or outside the repository");
  if (!isPrivateDestination(evidencePath)) failures.push("upload evidence path must be ignored .data or outside the repository");

  if (summary?.mode !== "testflight-candidate") failures.push("candidate mode must be testflight-candidate");
  if (summary?.testFlightInternalTestingOnly === true || summary?.mode === "testflight-internal-only-candidate") {
    failures.push("internal-only candidate must use Xcode UploadOptions.plist, not altool");
  }
  if (!ipaPath || !isWithin(artifactRoot, ipaPath) || !fs.existsSync(ipaPath)) failures.push("candidate IPA must exist inside the private artifact root");
  if (ipaPath && fs.existsSync(ipaPath) && (fs.statSync(ipaPath).mode & 0o077) !== 0) failures.push("candidate IPA must be 0600");
  if (/SIGNING-PROBE-DO-NOT-UPLOAD/i.test(artifact) || /SIGNING-PROBE-DO-NOT-UPLOAD/i.test(ipaPath)) failures.push("signing probe IPA cannot be uploaded");
  if (!/^[a-f0-9]{64}$/.test(summary?.sha256 || "") || summary?.sha256 !== candidateSha256) failures.push("candidate SHA-256 mismatch");
  if (!Number.isInteger(summary?.bytes) || summary?.bytes !== candidateBytes) failures.push("candidate byte size mismatch");
  if (summary?.gitCommit !== gitCommit) failures.push("candidate Git commit does not match HEAD");
  if (!gitClean) failures.push("Git worktree must be clean");
  if (summary?.signatureVerified !== true || summary?.appStoreProfile !== true) failures.push("candidate distribution signature/profile not verified");
  if (!summary?.checks || Object.values(summary.checks).some((value) => value !== true)) failures.push("candidate verification checks are incomplete");
  if (!isPublicHost(apiHost)) failures.push("candidate API host must be public");
  if (!/^[A-Z0-9]{10,20}$/.test(apiKeyId)) failures.push("OWNMINUTES_ASC_API_KEY_ID is invalid or missing");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(apiIssuerId)) failures.push("OWNMINUTES_ASC_API_ISSUER_ID is invalid or missing");
  if (!privateKeyPath || !path.isAbsolute(privateKeyPath) || !fs.existsSync(privateKeyPath)) {
    failures.push("OWNMINUTES_ASC_API_PRIVATE_KEY_PATH must be an existing absolute file");
  } else {
    const stat = fs.statSync(privateKeyPath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) failures.push("App Store Connect private key file must be 0600");
    if (!testMode && isInsideRepo(fs.realpathSync(privateKeyPath))) failures.push("App Store Connect private key file must stay outside the repository");
    if (!testMode && !/^-----BEGIN PRIVATE KEY-----/.test(fs.readFileSync(privateKeyPath, "utf8").trim())) failures.push("App Store Connect private key file is not a p8 private key");
  }
  if (operation !== "preflight" && !altoolAvailable()) failures.push("xcrun altool is unavailable");

  return {
    summaryPath,
    artifactRoot,
    ipaPath,
    mode: summary?.mode || null,
    bundleId: summary?.bundleId || null,
    version: summary?.version || null,
    buildNumber: summary?.buildNumber || null,
    apiHost: apiHost || null,
    candidateSha256: candidateSha256 || null,
    candidateBytes,
    gitCommit,
    gitClean,
    credentialModePrivate: Boolean(privateKeyPath && fs.existsSync(privateKeyPath) && (fs.statSync(privateKeyPath).mode & 0o077) === 0),
    failures,
  };
}

function runAltool(args) {
  if (testMode) {
    const runner = process.env.OWNMINUTES_ASC_TEST_ALTOOL_RUNNER?.trim() || "";
    if (!runner || !path.isAbsolute(runner) || !fs.existsSync(runner)) fail("Test mode requires an absolute fake altool runner.");
    const run = spawnSync(process.execPath, [runner, ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { status: run.status ?? 1, output: `${run.stdout || ""}${run.stderr || ""}`.trim() };
  }
  const run = spawnSync("xcrun", ["altool", ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return { status: run.status ?? 1, output: `${run.stdout || ""}${run.stderr || ""}`.trim() };
}

function altoolAvailable() {
  if (testMode) return true;
  return spawnSync("xcrun", ["--find", "altool"], { encoding: "utf8" }).status === 0;
}

function readSummary(filePath, failures) {
  if (!fs.existsSync(filePath)) {
    failures.push("candidate summary is missing");
    return null;
  }
  try {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o077) !== 0) failures.push("candidate summary must be 0600");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    failures.push("candidate summary is unreadable");
    return null;
  }
}

function hasAltoolErrors(payload, output) {
  if (/\b(error|failed|failure)\b/i.test(output) && !/"errors"\s*:\s*\[\s*\]/i.test(output)) return true;
  if (!payload || typeof payload !== "object") return false;
  const errors = payload.errors || payload.productErrors || payload["product-errors"];
  return Array.isArray(errors) && errors.length > 0;
}

function summarizeDiagnostic(payload, output) {
  const text = payload ? JSON.stringify(payload) : output;
  return redact(text).replace(/\s+/g, " ").slice(0, 800);
}

function findDeliveryId(value) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (/delivery.?id/i.test(key) && typeof child === "string" && child.trim()) return child.trim().slice(0, 120);
    const nested = findDeliveryId(child);
    if (nested) return nested;
  }
  return null;
}

function parseJson(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function redact(value) {
  let output = String(value || "");
  for (const secret of [apiKeyId, apiIssuerId, privateKeyPath].filter((entry) => entry.length >= 4)) {
    output = output.split(secret).join("[redacted]");
  }
  return output.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, "[redacted-private-key]");
}

function assertNoSensitiveEvidence(value) {
  if ([apiKeyId, apiIssuerId, privateKeyPath].filter((entry) => entry.length >= 4).some((entry) => value.includes(entry))) {
    throw new Error("Upload evidence contains App Store Connect credential material.");
  }
  if (/BEGIN PRIVATE KEY|\.p8\b|AuthKey_/i.test(value)) throw new Error("Upload evidence contains private key material.");
}

function removeStaleEvidence() {
  if (fs.existsSync(evidencePath)) fs.rmSync(evidencePath, { force: true });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isInsideRepo(value) {
  const relative = path.relative(repoRoot, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPrivateDestination(value) {
  const resolved = path.resolve(value);
  if (!isInsideRepo(resolved)) return true;
  const privateRoot = path.join(repoRoot, ".data");
  return resolved === privateRoot || isWithin(privateRoot, resolved);
}

function isPublicHost(host) {
  if (typeof host !== "string" || !host || ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host)) return false;
  return !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function fail(error, details = {}) {
  console.error(JSON.stringify({ ok: false, operation, error, ...details }, null, 2));
  process.exit(1);
}
