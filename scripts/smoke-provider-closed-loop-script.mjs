#!/usr/bin/env node

import { readFileSync } from "node:fs";

const source = readFileSync("scripts/run-provider-closed-loop.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const runbook = readFileSync("docs/asr-runtime-runbook.md", "utf8");

const checks = {
  exposesCommand: packageJson.scripts["provider:closed-loop"] === "node scripts/run-provider-closed-loop.mjs",
  usesIsolatedProductionPreview:
    source.includes('spawn("./node_modules/.bin/next"') &&
    source.includes('"start", "--hostname", "127.0.0.1"') &&
    source.includes("getFreePort()"),
  usesTemporaryObsidianVault:
    source.includes("fs.mkdtempSync") &&
    source.includes("OWNMINUTES_OBSIDIAN_VAULT_PATH") &&
    source.includes("fs.rmSync(vaultPath"),
  callsRealProviderChain:
    source.includes('TRANSCRIPTION_PROVIDER: "volcano"') &&
    source.includes("/chunks") &&
    source.includes("/finalize") &&
    source.includes("expectedLastSequence: upload.totalChunks") &&
    source.includes("totalBytes: upload.totalBytes") &&
    source.includes('result.adapter === "volcano-file-asr"'),
  verifiesStructuredSummary:
    source.includes("structuredCoverage") &&
    source.includes("result.summary.decisions.length >= 1") &&
    source.includes("result.summary.actionItems.length >= 1") &&
    source.includes("result.summary.knowledgePoints.length >= 1"),
  verifiesOutputPermissions:
    source.includes("summaryShareHidesTranscript") &&
    source.includes("transcriptShareIncludesTranscript") &&
    source.includes("extractMarkdownSection"),
  verifiesObsidianAndMetadata:
    source.includes("Provider Acceptance") &&
    source.includes("/obsidian") &&
    source.includes("obsidianSaved"),
  verifiesCleanup:
    source.includes("shareRevoked") &&
    source.includes("meetingDeleted") &&
    source.includes("accountDeleted") &&
    source.includes("cleanupMeeting") &&
    source.includes("cleanupAccount"),
  writesPrivateEvidence:
    source.includes(".data/acceptance/provider-closed-loop-latest.md") &&
    source.includes("findSecretLeaks(evidence)") &&
    source.includes("fs.writeFileSync(outputPath, evidence, { mode: 0o600 })") &&
    source.includes("fs.chmodSync(outputPath, 0o600)"),
  documentsBoundary:
    runbook.includes("Real provider closed loop") &&
    runbook.includes("does not replace a human 1-3 minute multi-speaker meeting"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
