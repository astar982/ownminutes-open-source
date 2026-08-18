#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

loadDotEnvLocal();

const options = parseArgs(process.argv.slice(2));
const samplePath = options.sample || process.env.OWNMINUTES_PROVIDER_SAMPLE_PATH || process.env.OWNMINUTES_ASR_SAMPLE_PATH;
const expectedPhrase = options.expected || process.env.OWNMINUTES_PROVIDER_EXPECTED_PHRASE || process.env.OWNMINUTES_ASR_EXPECTED_PHRASE || "";
const durationMs = Number(options.durationMs || process.env.OWNMINUTES_PROVIDER_SAMPLE_DURATION_MS || process.env.OWNMINUTES_ASR_SAMPLE_DURATION_MS || 10_000);
const outputPath = options.output || process.env.OWNMINUTES_PROVIDER_CLOSED_LOOP_EVIDENCE_PATH || ".data/acceptance/provider-closed-loop-latest.md";
const requireStructuredCoverage = options.requireStructured === "1" || process.env.OWNMINUTES_PROVIDER_REQUIRE_STRUCTURED === "1";

if (!samplePath || !fs.existsSync(samplePath)) {
  fail("Missing provider sample. Set OWNMINUTES_PROVIDER_SAMPLE_PATH or pass --sample=/absolute/path.wav.");
}
if (!expectedPhrase.trim()) {
  fail("Missing expected phrase. Set OWNMINUTES_PROVIDER_EXPECTED_PHRASE or pass --expected=...");
}

const sample = fs.readFileSync(samplePath);
if (sample.byteLength === 0) fail("Provider sample is empty.");

const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const nonce = crypto.randomBytes(4).toString("hex");
const meetingId = `provider-closed-loop-${timestamp}-${nonce}`;
const email = `${meetingId}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}-${nonce}`;
const title = `OwnMinutes Provider 闭环验收 ${timestamp}`;
const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-provider-vault-"));
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
const checkedAt = new Date().toISOString();
let app;
let baseUrl;
let cookie;
let cleanupMeeting = false;
let cleanupAccount = false;

try {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = startNextPreview(port, vaultPath);
  await waitForApp(baseUrl, app);

  const register = await postJson(`${baseUrl}/api/auth/register`, {
    name: "Provider Closed Loop",
    email,
    password,
  }, null, { "x-forwarded-for": testIp });
  cookie = extractCookie(register.response);
  cleanupAccount = true;

  const form = new FormData();
  const mimeType = inferMimeType(samplePath);
  form.append("sequence", "1");
  form.append("mimeType", mimeType);
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", String(Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 10_000));
  form.append("chunk", new Blob([sample], { type: mimeType }), path.basename(samplePath));

  const upload = await postForm(`${baseUrl}/api/meetings/${meetingId}/chunks`, form, cookie);
  cleanupMeeting = true;
  const final = await finalizeMeeting(baseUrl, meetingId, title, cookie, upload);
  const result = final.result;
  if (!result) throw new Error("Provider finalization completed without a meeting result.");

  const transcriptText = result.transcript.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim();
  const summaryText = result.summary?.summary?.trim() || "";
  const metadata = await postJson(`${baseUrl}/api/meetings/${meetingId}`, {
    project: "Provider Acceptance",
    tags: ["provider", "asr", "summary", "obsidian"],
  }, cookie, {}, "PATCH");
  const detail = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const exportResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}/export`, { headers: { Cookie: cookie } });
  const exportedMarkdown = await readTextResponse(exportResponse, "private Markdown export");
  const obsidian = await postJson(`${baseUrl}/api/meetings/${meetingId}/obsidian`, {}, cookie);
  const obsidianPath = obsidian.saved?.relativePath ? path.join(vaultPath, obsidian.saved.relativePath) : "";
  const obsidianMarkdown = obsidianPath && fs.existsSync(obsidianPath) ? fs.readFileSync(obsidianPath, "utf8") : "";

  const review = await postJson(`${baseUrl}/api/meetings/${meetingId}/review`, { confirmed: true }, cookie);
  const publishSummary = await postJson(`${baseUrl}/api/meetings/${meetingId}/share`, {
    visibility: "public",
    includeTranscript: false,
    confirmUnverified: false,
  }, cookie);
  const summaryShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const summaryShareHtml = await readTextResponse(summaryShare, "summary-only share page");
  const summaryMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const summaryMarkdown = await readTextResponse(summaryMarkdownResponse, "summary-only public Markdown");

  const publishTranscript = await postJson(`${baseUrl}/api/meetings/${meetingId}/share`, {
    visibility: "public",
    includeTranscript: true,
    confirmUnverified: false,
  }, cookie);
  const transcriptMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const transcriptMarkdown = await readTextResponse(transcriptMarkdownResponse, "transcript public Markdown");
  const summaryTranscriptSection = extractMarkdownSection(summaryMarkdown, "逐字稿");
  const transcriptTranscriptSection = extractMarkdownSection(transcriptMarkdown, "逐字稿");

  const revoke = await postJson(`${baseUrl}/api/meetings/${meetingId}/share`, {
    visibility: "private",
    includeTranscript: false,
  }, cookie);
  const deleteMeetingResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const deleteMeeting = await readJsonResponse(deleteMeetingResponse, "meeting cleanup");
  cleanupMeeting = false;
  const deletedShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const deletedShareHtml = await deletedShare.text();
  const deletedMarkdown = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const deleteAccountResponse = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const deleteAccount = await readJsonResponse(deleteAccountResponse, "account cleanup");
  cleanupAccount = false;
  const deletedSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });

  const fallbackDiagnostic = result.diagnostics.some((diagnostic) =>
    /fallback|not usable|deterministic local|Ark summary failed|timed out|returned empty|config is incomplete/i.test(diagnostic),
  );
  const checks = {
    registerOk: register.payload.ok === true,
    uploadOk: upload.ok === true && upload.savedBytes === sample.byteLength,
    uploadUsesVolcano: upload.provider === "volcano",
    finalizeOk: final.ok === true,
    providerIsVolcano: result.provider === "volcano",
    adapterIsRealFileAsr: result.adapter === "volcano-file-asr",
    transcriptReadable: transcriptText.length >= 8,
    expectedPhraseReadable: fuzzyIncludes(transcriptText, expectedPhrase),
    summaryIsModelOutput: summaryText.length >= 12 && !summaryText.startsWith("本地保守纪要"),
    summaryStructured:
      Array.isArray(result.summary?.topics) &&
      Array.isArray(result.summary?.decisions) &&
      Array.isArray(result.summary?.actionItems) &&
      Array.isArray(result.summary?.risks) &&
      Array.isArray(result.summary?.openQuestions) &&
      Array.isArray(result.summary?.knowledgePoints),
    structuredCoverage:
      !requireStructuredCoverage ||
      (result.summary.decisions.length >= 1 &&
        result.summary.actionItems.length >= 1 &&
        result.summary.risks.length >= 1 &&
        result.summary.openQuestions.length >= 1 &&
        result.summary.knowledgePoints.length >= 1),
    noFallbackDiagnostic: !fallbackDiagnostic,
    metadataSaved: metadata.payload.ok === true && detail.meeting?.metadata?.project === "Provider Acceptance",
    privateMarkdownComplete:
      exportedMarkdown.includes("## 会议摘要") &&
      exportedMarkdown.includes("## 待办事项") &&
      exportedMarkdown.includes("## 逐字稿") &&
      fuzzyIncludes(exportedMarkdown, expectedPhrase),
    obsidianSaved:
      obsidian.payload.ok === true &&
      Boolean(obsidianPath) &&
      fs.existsSync(obsidianPath) &&
      obsidian.saved.relativePath.startsWith("OwnMinutes/Provider Acceptance/") &&
      fuzzyIncludes(obsidianMarkdown, expectedPhrase),
    reviewConfirmed: review.payload.ok === true && review.payload.humanReview?.status === "confirmed",
    summarySharePublished: publishSummary.payload.ok === true && summaryShareHtml.includes(title),
    summaryShareHidesTranscript:
      summaryTranscriptSection.includes("逐字稿未公开") &&
      !fuzzyIncludes(summaryTranscriptSection, expectedPhrase),
    transcriptSharePublished: publishTranscript.payload.ok === true,
    transcriptShareIncludesTranscript: fuzzyIncludes(transcriptTranscriptSection, expectedPhrase),
    shareRevoked: revoke.payload.ok === true,
    meetingDeleted:
      deleteMeeting.ok === true &&
      deletedShareHtml.includes("尚未公开") &&
      deletedMarkdown.status === 404,
    accountDeleted: deleteAccount.ok === true && deletedSession.status === 401,
  };

  const allPassed = Object.values(checks).every(Boolean);
  const evidence = buildEvidence({
    checkedAt,
    checks,
    diagnostics: result.diagnostics,
    expectedPhrase,
    meetingId,
    obsidianRelativePath: obsidian.saved?.relativePath || "not saved",
    requestAdapter: result.adapter,
    requireStructuredCoverage,
    summaryCounts: {
      actions: result.summary.actionItems.length,
      decisions: result.summary.decisions.length,
      knowledgePoints: result.summary.knowledgePoints.length,
      openQuestions: result.summary.openQuestions.length,
      risks: result.summary.risks.length,
      topics: result.summary.topics.length,
    },
    transcriptCharacters: transcriptText.length,
    transcriptSegments: result.transcript.length,
  });
  const leaked = findSecretLeaks(evidence);
  if (leaked.length > 0) throw new Error(`Acceptance evidence contains ${leaked.length} secret fragment(s).`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, evidence, { mode: 0o600 });
  fs.chmodSync(outputPath, 0o600);

  console.log(JSON.stringify({
    ok: allPassed,
    adapter: result.adapter,
    evidencePath: outputPath,
    checks,
    diagnosticsCount: result.diagnostics.length,
    meetingId,
    summaryCounts: {
      topics: result.summary.topics.length,
      decisions: result.summary.decisions.length,
      actions: result.summary.actionItems.length,
    },
    transcriptCharacters: transcriptText.length,
    transcriptSegments: result.transcript.length,
  }, null, 2));

  if (!allPassed) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: sanitizeError(error), meetingId }, null, 2));
  process.exitCode = 1;
} finally {
  if (baseUrl && cookie && cleanupMeeting) {
    await fetch(`${baseUrl}/api/meetings/${meetingId}`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
  }
  if (baseUrl && cookie && cleanupAccount) {
    await fetch(`${baseUrl}/api/auth/delete`, { method: "DELETE", headers: { Cookie: cookie } }).catch(() => undefined);
  }
  if (app) app.kill("SIGTERM");
  fs.rmSync(vaultPath, { force: true, recursive: true });
}

function startNextPreview(port, temporaryVaultPath) {
  const child = spawn("./node_modules/.bin/next", ["start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OWNMINUTES_OBSIDIAN_VAULT_PATH: temporaryVaultPath,
      TRANSCRIPTION_PROVIDER: "volcano",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(data);
  });
  child.stderr.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stderr.write(data);
  });
  return child;
}

async function finalizeMeeting(targetBaseUrl, targetMeetingId, meetingTitle, authCookie, upload) {
  let response = await postJson(
    `${targetBaseUrl}/api/meetings/${targetMeetingId}/finalize`,
    {
      title: meetingTitle,
      expectedLastSequence: upload.totalChunks,
      totalBytes: upload.totalBytes,
    },
    authCookie,
  );
  if (response.payload.result) return response.payload;

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(1_000);
    const status = await getJson(`${targetBaseUrl}/api/meetings/${targetMeetingId}/finalize`, authCookie);
    if (status.result) return status;
    if (status.processing?.status === "failed") throw new Error(status.processing.error?.message || "Provider finalization failed.");
  }
  throw new Error("Provider finalization timed out.");
}

async function waitForApp(targetBaseUrl, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next preview exited early with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${targetBaseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error("Timed out waiting for provider acceptance preview.");
}

async function postJson(url, body, authCookie, extraHeaders = {}, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authCookie ? { Cookie: authCookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse(response, url);
  return { response, payload, ...payload };
}

async function postForm(url, body, authCookie) {
  const response = await fetch(url, { method: "POST", headers: { Cookie: authCookie }, body });
  return readJsonResponse(response, url);
}

async function getJson(url, authCookie) {
  const response = await fetch(url, { headers: authCookie ? { Cookie: authCookie } : {} });
  return readJsonResponse(response, url);
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `${label} failed with HTTP ${response.status}.`);
  return payload;
}

async function readTextResponse(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  return text;
}

function extractCookie(response) {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Registration did not return a session cookie.");
  return value.split(";", 1)[0];
}

function inferMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".ogg") return "audio/ogg";
  if (extension === ".webm") return "audio/webm";
  if (extension === ".m4a" || extension === ".mp4") return "audio/mp4";
  if (extension === ".aac") return "audio/aac";
  return "application/octet-stream";
}

function fuzzyIncludes(text, phrase) {
  const compactText = text.replace(/[\s，。！？、；：,.!?;:]/g, "");
  const compactPhrase = phrase.replace(/[\s，。！？、；：,.!?;:]/g, "");
  return Boolean(compactPhrase) && compactText.includes(compactPhrase);
}

function extractMarkdownSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = start + marker.length;
  const nextHeading = markdown.indexOf("\n## ", bodyStart);
  return markdown.slice(bodyStart, nextHeading < 0 ? markdown.length : nextHeading).trim();
}

function buildEvidence(input) {
  return `# Real Provider Closed Loop Evidence

## Decision

- Checked at: ${input.checkedAt}
- Decision: ${Object.values(input.checks).every(Boolean) ? "pass" : "fail"}
- Scope: synthetic Mandarin audio through real Volcano file ASR and Ark summary runtime
- Structured coverage required: ${input.requireStructuredCoverage ? "yes" : "no"}
- Boundary: this is not human multi-speaker quality evidence and does not clear diarization or TestFlight gates

## Runtime

- Meeting id: ${input.meetingId}
- Provider: Volcano
- Adapter: ${input.requestAdapter}
- Transcript segments: ${input.transcriptSegments}
- Transcript characters: ${input.transcriptCharacters}
- Expected phrase readable: ${input.checks.expectedPhraseReadable ? "yes" : "no"}
- Expected phrase: ${input.expectedPhrase}
- Diagnostics count: ${input.diagnostics.length}
- Secrets leaked: no

## Structured Summary

- Topics: ${input.summaryCounts.topics}
- Decisions: ${input.summaryCounts.decisions}
- Actions: ${input.summaryCounts.actions}
- Risks: ${input.summaryCounts.risks}
- Open questions: ${input.summaryCounts.openQuestions}
- Knowledge points: ${input.summaryCounts.knowledgePoints}

## Output Chain

- Private Markdown: ${input.checks.privateMarkdownComplete ? "pass" : "fail"}
- Obsidian temporary vault: ${input.checks.obsidianSaved ? "pass" : "fail"}
- Obsidian relative path: ${input.obsidianRelativePath}
- Summary-only share hides transcript: ${input.checks.summaryShareHidesTranscript ? "pass" : "fail"}
- Transcript share includes transcript: ${input.checks.transcriptShareIncludesTranscript ? "pass" : "fail"}

## Checks

${Object.entries(input.checks).map(([name, passed]) => `- ${name}: ${passed ? "pass" : "fail"}`).join("\n")}
`;
}

function parseArgs(args) {
  return Object.fromEntries(args.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=") || "1"];
  }));
}

function loadDotEnvLocal() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator);
    const raw = trimmed.slice(separator + 1);
    if (!process.env[key]) process.env[key] = stripQuotes(raw);
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function secretFragments() {
  return [
    process.env.VOLCANO_ASR_API_KEY,
    process.env.VOLCANO_ASR_TOKEN,
    process.env.ARK_API_KEY,
    process.env.VOLCANO_ACCESS_KEY_ID,
    process.env.VOLCANO_SECRET_ACCESS_KEY,
    "AKL",
    "sk-proj",
    "Secret Access Key",
    "WVRCaE",
    "-----BEGIN PRIVATE KEY-----",
  ].filter((value) => typeof value === "string" && value.length >= 6);
}

function findSecretLeaks(text) {
  return secretFragments().filter((fragment) => text.includes(fragment));
}

function sanitizeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const fragment of secretFragments()) message = message.split(fragment).join("[redacted]");
  return message.slice(0, 800);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}
