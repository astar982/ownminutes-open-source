#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const evidencePath = path.resolve(process.env.OWNMINUTES_APPSTORE_UPLOAD_EVIDENCE_PATH || ".data/acceptance/appstore-upload-latest.json");
const summaryPath = path.resolve(process.env.OWNMINUTES_LOCAL_TESTFLIGHT_SUMMARY_PATH || ".data/testflight-local/latest-summary.json");
const errors = [];
if (!isPrivateDestination(evidencePath)) errors.push("upload evidence path must be ignored .data or outside the repository");
if (!isPrivateDestination(summaryPath)) errors.push("candidate summary path must be ignored .data or outside the repository");
const evidence = readJson(evidencePath, "upload evidence");
const summary = readJson(summaryPath, "candidate summary");

if (evidence) {
  if ((fs.statSync(evidencePath).mode & 0o077) !== 0) errors.push("upload evidence must be 0600");
  if (evidence.schemaVersion !== 1 || evidence.operation !== "upload" || evidence.status !== "pass") errors.push("evidence must record a successful upload");
  const checkedAt = new Date(evidence.checkedAt || "");
  const ageHours = Number.isNaN(checkedAt.getTime()) ? Number.POSITIVE_INFINITY : (Date.now() - checkedAt.getTime()) / 3_600_000;
  if (ageHours < -1 || ageHours > 24 * 30) errors.push("upload evidence must be no more than 30 days old");
  if (!evidence.apple?.processed || typeof evidence.apple?.deliveryId !== "string" || !evidence.apple.deliveryId.trim()) errors.push("Apple delivery id and processed state are required");
  if (!evidence.checks || Object.values(evidence.checks).some((value) => value !== true)) errors.push("upload evidence checks are incomplete");
  if (/BEGIN PRIVATE KEY|AuthKey_|\.p8\b|api.?key|api.?issuer/i.test(JSON.stringify(evidence))) errors.push("upload evidence contains credential-like material");
}

if (summary) {
  if ((fs.statSync(summaryPath).mode & 0o077) !== 0) errors.push("candidate summary must be 0600");
  if (summary.mode !== "testflight-candidate" || summary.signatureVerified !== true || summary.appStoreProfile !== true) errors.push("candidate summary is not an uploadable App Store candidate");
  if (!summary.checks || Object.values(summary.checks).some((value) => value !== true)) errors.push("candidate verification checks are incomplete");
  const artifact = typeof summary.artifact === "string" ? path.resolve(repoRoot, summary.artifact) : "";
  if (!artifact || !fs.existsSync(artifact) || /SIGNING-PROBE-DO-NOT-UPLOAD/i.test(artifact)) {
    errors.push("candidate IPA is missing or is a signing probe");
  } else {
    const bytes = fs.statSync(artifact).size;
    if ((fs.statSync(artifact).mode & 0o077) !== 0) errors.push("candidate IPA must be 0600");
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
    if (summary.bytes !== bytes || summary.sha256 !== sha256) errors.push("candidate IPA no longer matches its summary");
    if (evidence && (evidence.candidate?.bytes !== bytes || evidence.candidate?.sha256 !== sha256)) errors.push("upload evidence does not match the candidate IPA");
  }
}

if (evidence && summary) {
  for (const field of ["bundleId", "version", "buildNumber", "gitCommit", "apiHost"]) {
    if (evidence.candidate?.[field] !== summary[field]) errors.push(`upload evidence candidate ${field} mismatch`);
  }
  if (!isGitAncestor(evidence.candidate?.gitCommit)) errors.push("uploaded candidate commit is not an ancestor of current HEAD");
}

const result = {
  ok: errors.length === 0,
  decision: errors.length === 0 ? "pass" : "fail",
  evidencePath,
  summaryPath,
  operation: evidence?.operation || null,
  deliveryIdRecorded: Boolean(evidence?.apple?.deliveryId),
  candidateCommit: evidence?.candidate?.gitCommit || null,
  errors,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    errors.push(`${label} is missing`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    errors.push(`${label} is unreadable`);
    return null;
  }
}

function isGitAncestor(commit) {
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)) return false;
  return spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: repoRoot }).status === 0;
}

function isPrivateDestination(value) {
  const resolved = path.resolve(value);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true;
  return relative === ".data" || relative.startsWith(`.data${path.sep}`);
}
