#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/launch-acceptance-pass.md";
const failPath = ".data/smoke/launch-acceptance-fail.md";
const missingPackPath = ".data/smoke/launch-acceptance-missing-pack.md";
const draftPath = ".data/smoke/launch-acceptance-draft.md";

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, buildEvidence());
writeFileSync(
  failPath,
  buildEvidence({
    launchDecision: "fail",
    packOverrides: {
      "public-url": {
        "Decision": "fail",
        "Evidence file": "pending",
        "Notes": "localhost http://127.0.0.1:3002 is not acceptable for launch.",
      },
    },
  }),
);
writeFileSync(missingPackPath, buildEvidence({ omitPackId: "payments" }));

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const missingPack = runChecker(missingPackPath);
const draft = runDraft(draftPath);
const draftCheck = runChecker(draftPath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  passFixtureAccepted:
    pass.status === 0 &&
    pass.payload?.evidenceReady === true &&
    pass.payload?.readyPackCount === 10 &&
    pass.payload?.requiredPackCount === 10,
  failFixtureRejected:
    fail.status !== 0 &&
    fail.payload?.evidenceReady === false &&
    fail.payload?.launchDecision === "fail" &&
    fail.payload?.incompletePacks?.some((pack) => pack.id === "public-url"),
  missingPackRejected:
    missingPack.status !== 0 &&
    missingPack.payload?.evidenceReady === false &&
    missingPack.payload?.missingPacks?.includes("payments"),
  draftGenerated:
    draft.status === 0 &&
    draft.payload?.draftWritten === true &&
    draft.payload?.draftDecision === "pending" &&
    readFile(draftPath).includes("Launch decision: pending") &&
    readFile(draftPath).includes("## Apple IAP Payments") &&
    readFile(draftPath).includes("OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/apple-iap-latest.md npm run iap:acceptance:evidence"),
  draftRejectedUntilManualReview:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.pendingMentions?.length > 0 &&
    draftCheck.payload?.readyPackCount === 0,
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.passFixtureAccepted ||
  !summary.failFixtureRejected ||
  !summary.missingPackRejected ||
  !summary.draftGenerated ||
  !summary.draftRejectedUntilManualReview ||
  !summary.noForbiddenSourcePhrases
) {
  process.exitCode = 1;
}

function buildEvidence({ launchDecision = "pass", omitPackId = "", packOverrides = {} } = {}) {
  const packs = [
    ["public-url", "Public HTTPS Deployment", ".data/acceptance/public-deployment-latest.md", "OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH=.data/acceptance/public-deployment-latest.md npm run deployment:acceptance:evidence"],
    ["ios-testflight", "iOS TestFlight Recording", ".data/acceptance/ios-testflight-latest.md", "OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH=.data/acceptance/ios-testflight-latest.md npm run ios:testflight:evidence"],
    ["file-asr", "Post Meeting ASR", ".data/acceptance/asr-latest.md", "OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence"],
    ["realtime-asr", "Realtime ASR Boundary", ".data/acceptance/asr-latest.md", "npm run smoke:mobile-realtime && OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence"],
    ["speaker-diarization", "Speaker Diarization", ".data/acceptance/asr-latest.md", "OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence"],
    ["summary-model", "Summary Model", ".data/acceptance/summary-latest.md", "OWNMINUTES_SUMMARY_EVIDENCE_PATH=.data/acceptance/summary-latest.md npm run summary:acceptance:evidence"],
    ["database", "Production PostgreSQL", ".data/acceptance/postgres-latest.md", "OWNMINUTES_POSTGRES_EVIDENCE_PATH=.data/acceptance/postgres-latest.md npm run database:acceptance:evidence"],
    ["object-storage", "Private Object Storage", ".data/acceptance/object-storage-latest.md", "OWNMINUTES_OBJECT_STORAGE_EVIDENCE_PATH=.data/acceptance/object-storage-latest.md npm run storage:acceptance:evidence"],
    [
      "secret-management",
      "Vault Secret Management",
      ".data/acceptance/secret-management-latest.md",
      "OWNMINUTES_SECRET_EVIDENCE_PATH=.data/acceptance/secret-management-latest.md OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH=.data/acceptance/vault-transit-live-latest.json npm run secret:acceptance:evidence",
    ],
    ["payments", "Apple IAP Payments", ".data/acceptance/apple-iap-latest.md", "OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/apple-iap-latest.md npm run iap:acceptance:evidence"],
  ];

  return [
    "# OwnMinutes Launch Acceptance Evidence",
    "",
    `Launch decision: ${launchDecision}`,
    "Release commit: abc1234",
    "Reviewer: QA Smoke",
    "Evidence date: 2026-07-10",
    "Secrets leaked: no",
    "",
    ...packs
      .filter(([id]) => id !== omitPackId)
      .flatMap(([id, title, evidenceFile, command]) => {
        const override = packOverrides[id] ?? {};
        const values = {
          "Blocker ID": id,
          "Evidence file": evidenceFile,
          "Verification command": command,
          "Evidence date": "2026-07-10",
          "Reviewer": "QA Smoke",
          "Decision": "pass",
          "Secrets leaked": "no",
          "Notes": "Real private evidence reviewed.",
          ...override,
        };

        return [
          `## ${title}`,
          "",
          ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
          "",
        ];
      }),
  ].join("\n");
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-launch-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_LAUNCH_ACCEPTANCE_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-launch-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_LAUNCH_ACCEPTANCE_EVIDENCE_DRAFT_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function readFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "-----BEGIN PRIVATE KEY-----"];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/launch-acceptance-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
