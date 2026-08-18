#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const evidencePath = process.env.OWNMINUTES_RECORDING_ACCEPTANCE_EVIDENCE_PATH || ".data/acceptance/recording-latest.md";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";

const requiredMetadata = [
  "Date:",
  "Tester:",
  "Environment:",
  "App URL:",
  "Build source:",
  "Browser:",
  "Device:",
  "Microphone:",
  "Account:",
];

const scenarioRequirements = [
  { name: "Short sanity", duration: "5 minutes" },
  { name: "Normal meeting", duration: "30 minutes" },
  { name: "Long meeting", duration: "90 minutes" },
  { name: "Weak network", duration: "10 minutes" },
  { name: "Offline recovery", duration: "10 minutes" },
  { name: "Device interruption", duration: "5 minutes" },
  { name: "Background risk", duration: "10 minutes" },
];

const requiredEvidenceFields = [
  "Scenario:",
  "Duration:",
  "Started at:",
  "Stopped at:",
  "Network condition:",
  "Meeting ID:",
  "Timer reached expected duration: pass",
  "Chunks increasing: pass",
  "Bytes:",
  "Local audio URI/file exists: pass",
  "Pending after stop: 0",
  "Failed chunks:",
  "Finalize waited for upload completion: pass",
  "Local audio playback: pass",
  "Foreground/background interruptions:",
  "Last interruption time:",
  "Crash or tab freeze observed: no",
  "Memory/battery observation:",
  "Finalize result: pass",
  "Transcript boundary: pass",
  "Summary boundary: pass",
  "Share link: pass",
  "Obsidian Markdown: pass",
  "Retry/export state: pass",
  "Recovery after restart/reopen: pass",
  "No secrets leaked: yes",
  "Decision: pass",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "-----BEGIN PRIVATE KEY-----",
  "Bearer ",
  "session=",
  "BEGIN OPENSSH PRIVATE KEY",
  "PRIVATE-ENCRYPTED-SECRET",
];

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const scenarioSections = getScenarioSections(evidence);
const scenarioChecks = scenarioRequirements.map((requirement) => {
  const section = scenarioSections.get(requirement.name) ?? "";
  return {
    scenario: requirement.name,
    exists: Boolean(section),
    hasScenarioField: section.includes(`Scenario: ${requirement.name}`),
    hasDuration: section.includes(`Duration: ${requirement.duration}`),
    missingEvidenceFields: requiredEvidenceFields.filter((phrase) => !section.includes(phrase)),
    hasFailDecision: /Decision:\s*fail/i.test(section),
  };
});

const missingScenarios = scenarioChecks.filter((item) => !item.exists).map((item) => item.scenario);
const missingScenarioFields = scenarioChecks.filter((item) => item.exists && !item.hasScenarioField).map((item) => item.scenario);
const missingDurations = scenarioChecks.filter((item) => item.exists && !item.hasDuration).map((item) => item.scenario);
const missingEvidenceFieldsByScenario = scenarioChecks
  .filter((item) => item.exists && item.missingEvidenceFields.length > 0)
  .map((item) => ({ scenario: item.scenario, missing: item.missingEvidenceFields }));
const scenarioFailDecisions = scenarioChecks.filter((item) => item.hasFailDecision).map((item) => item.scenario);
const requiredScenarioCount = scenarioRequirements.length;
const passDecisionCount = countMatches(evidence, /Decision:\s*pass/gi);
const failDecisionCount = countMatches(evidence, /Decision:\s*fail/gi);
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));
const hasBrowserOrAppEnvironment =
  /Environment:\s*(web|pwa|browser|testflight|simulator|production|staging|local)/i.test(evidence) ||
  /Build source:\s*(web|pwa|browser|testflight|simulator|production preview|local preview)/i.test(evidence);

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  requiredScenarioCount,
  passDecisionCount,
  failDecisionCount,
  hasBrowserOrAppEnvironment,
  missingMetadata,
  missingScenarios,
  missingScenarioFields,
  missingDurations,
  missingEvidenceFieldsByScenario,
  scenarioFailDecisions,
  leakedPhrases,
  evidenceReady:
    Boolean(evidence) &&
    missingMetadata.length === 0 &&
    missingScenarios.length === 0 &&
    missingScenarioFields.length === 0 &&
    missingDurations.length === 0 &&
    missingEvidenceFieldsByScenario.length === 0 &&
    scenarioFailDecisions.length === 0 &&
    leakedPhrases.length === 0 &&
    passDecisionCount >= requiredScenarioCount &&
    failDecisionCount === 0 &&
    hasBrowserOrAppEnvironment,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.evidenceReady) {
  process.exitCode = 1;
}

function countMatches(text, pattern) {
  return Array.from(text.matchAll(pattern)).length;
}

function getScenarioSections(text) {
  const sections = new Map();
  const headingPattern = /^##\s+(.+)$/gm;
  const headings = Array.from(text.matchAll(headingPattern));

  headings.forEach((match, index) => {
    const name = match[1].trim();
    const start = match.index ?? 0;
    const next = headings[index + 1]?.index ?? text.length;
    sections.set(name, text.slice(start, next));
  });

  return sections;
}
