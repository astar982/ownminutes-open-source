#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.target || ".");
const expectedRepository = args.repository || "";
const failures = [];
let scannedFiles = 0;

const requiredPaths = [
  "README.md",
  "LICENSE",
  "NOTICE",
  "ATTRIBUTION.md",
  "AUTHORS.md",
  "CITATION.cff",
  "GOVERNANCE.md",
  "MAINTAINERS.md",
  "TRADEMARKS.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/dependabot.yml",
];

const privateOnlyPaths = [
  "AGENTS.md",
  "CLAUDE.md",
  "COLLABORATION.md",
  "HANDOFF.md",
  "design-qa.md",
  "docs/handoff.md",
  "docs/tasks/current.md",
  "docs/repair-audit-20260730.md",
  "docs/ownminutes-open-strategy.md",
  "docs/internal",
  "scripts/create-public-snapshot.mjs",
];

const skippedDirectories = new Set([
  ".git",
  ".next",
  ".expo",
  ".data",
  "node_modules",
  "coverage",
  "output",
  "tmp",
]);

for (const path of requiredPaths) {
  if (!(await exists(join(root, path)))) failures.push(`missing required file: ${path}`);
}

for (const path of privateOnlyPaths) {
  if (await exists(join(root, path))) failures.push(`private-only path is present: ${path}`);
}

await walk(root);
await verifyMetadata();

if (failures.length > 0) {
  console.error(`Public snapshot check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public snapshot check passed: ${scannedFiles} files scanned.`);

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const relative = absolute.slice(root.length + 1);
    const metadata = await lstat(absolute);

    if (metadata.isSymbolicLink()) {
      failures.push(`symbolic links are not allowed in the public snapshot: ${relative}`);
      continue;
    }
    if (metadata.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!metadata.isFile()) continue;

    scannedFiles += 1;
    checkFilename(relative);
    if (metadata.size > 5 * 1024 * 1024) continue;

    const buffer = await readFile(absolute);
    if (buffer.includes(0)) continue;
    checkText(relative, buffer.toString("utf8"));
  }
}

function checkFilename(relative) {
  const name = basename(relative).toLowerCase();
  if (["agents.md", "claude.md", "collaboration.md", "handoff.md"].includes(name)) {
    failures.push(`internal collaboration file is present: ${relative}`);
  }
  if ((name.startsWith(".env") && name !== ".env.example") || /\.(pem|p8|p12|pfx|key|jks|keystore|mobileprovision|provisionprofile|ipa|ombak|omenc|credentials|token)$/i.test(name)) {
    failures.push(`sensitive filename is tracked: ${relative}`);
  }
}

function checkText(relative, text) {
  const fixedPatterns = [
    ["Windows user path", /[A-Za-z]:\\(?:Users|Documents)\\[^\s`"']+/g],
    ["temporary wildcard host", /\b[a-z0-9.-]+\.sslip\.io\b/gi],
    ["private organization domain", /\b[a-z0-9.-]*lvlin\.cc\b/gi],
    ["private server layout", /\/srv\/apps\/ownminutes\b/g],
  ];

  for (const [label, pattern] of fixedPatterns) {
    if (pattern.test(text)) failures.push(`${label} found in ${relative}`);
  }

  const privateIdentifiers = [
    ["P5", "RW6", "Q43", "DY"].join(""),
  ];
  for (const identifier of privateIdentifiers) {
    if (text.includes(identifier)) failures.push(`private account identifier found in ${relative}`);
  }

  const macPaths = text.match(/\/Users\/[^\s`"']+/g) || [];
  for (const path of macPaths) {
    if (!/^\/Users\/(?:example|private)(?:\/|$)/.test(path)) failures.push(`macOS user path found in ${relative}`);
  }

  if (text.includes("PRIVATE-ENCRYPTED-SECRET") && !isEncryptedMarkerPolicyFile(relative)) {
    failures.push(`private encrypted material marker found in ${relative}`);
  }

  const emails = text.match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g) || [];
  for (const email of emails) {
    const domain = email.split("@").at(-1).toLowerCase();
    if (!isAllowedEmailDomain(domain)) failures.push(`non-project email found in ${relative}: ${domain}`);
  }

  const ipv4Matches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  for (const address of ipv4Matches) {
    if (relative.endsWith(".svg")) continue;
    if (isPublicIpv4(address) && !isAllowedPublicIpv4Fixture(relative, address)) failures.push(`public IPv4 address found in ${relative}`);
  }
}

async function verifyMetadata() {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const repositoryUrl = packageJson.repository?.url || "";
  if (expectedRepository && !repositoryUrl.includes(expectedRepository)) {
    failures.push(`package repository URL does not target ${expectedRepository}`);
  }
  if (packageJson.private !== true) failures.push("root package.json must remain private to prevent accidental npm publication");

  const rootLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const mobileLock = JSON.parse(await readFile(join(root, "apps/mobile/package-lock.json"), "utf8"));
  if (rootLock.packages?.["node_modules/nanoid"]?.version !== "3.3.18") failures.push("root nanoid must resolve to 3.3.18");
  if (mobileLock.packages?.["node_modules/nanoid"]?.version !== "3.3.18") failures.push("mobile nanoid must resolve to 3.3.18");
  if (mobileLock.packages?.["node_modules/js-yaml"]?.version !== "5.2.2") failures.push("mobile js-yaml must resolve to 5.2.2");
  if (mobileLock.packages?.["node_modules/postcss"]?.version !== "8.5.25") failures.push("mobile postcss must resolve to 8.5.25");

  const notice = await readFile(join(root, "NOTICE"), "utf8");
  if (/visible attribution|可见署名/i.test(notice)) failures.push("NOTICE must not add attribution restrictions beyond Apache-2.0");

  const attribution = await readFile(join(root, "ATTRIBUTION.md"), "utf8");
  if (!attribution.includes("Wang Pengyuan") || !attribution.includes("@astar982")) {
    failures.push("ATTRIBUTION.md must identify the creator and GitHub handle");
  }
  if (expectedRepository && !attribution.includes(`https://github.com/${expectedRepository}`)) {
    failures.push(`ATTRIBUTION.md must link to https://github.com/${expectedRepository}`);
  }
  if (!/does not require[\s\S]*attribution screen/i.test(attribution) || !/hosted-only/i.test(attribution)) {
    failures.push("ATTRIBUTION.md must preserve the Apache-2.0 hosted-use boundary");
  }

  const citation = await readFile(join(root, "CITATION.cff"), "utf8");
  if (!citation.includes("family-names: Wang") || !citation.includes("given-names: Pengyuan")) {
    failures.push("CITATION.cff must identify Wang Pengyuan");
  }
  if (expectedRepository && !citation.includes(`https://github.com/${expectedRepository}`)) {
    failures.push(`CITATION.cff must link to https://github.com/${expectedRepository}`);
  }

  const codeowners = await readFile(join(root, ".github/CODEOWNERS"), "utf8");
  if (!codeowners.includes("@astar982")) failures.push("CODEOWNERS must identify @astar982");
}

function isAllowedEmailDomain(domain) {
  return domain === "example.com" || domain.endsWith(".example.com") ||
    domain === "ownminutes.app" || domain.endsWith(".ownminutes.app") ||
    domain.endsWith(".test") ||
    domain.endsWith(".example") ||
    domain.endsWith(".invalid") ||
    domain === "ark.cn-beijing.volces.com" ||
    domain === "users.noreply.github.com" ||
    domain === "github.com" ||
    domain.endsWith(".bytedance.com");
}

function isEncryptedMarkerPolicyFile(relative) {
  return new Set([
    ".dockerignore",
    "scripts/check-public-snapshot.mjs",
    "scripts/check-recording-acceptance-evidence.mjs",
    "scripts/production-like-stack.mjs",
    "scripts/smoke-container-deployment.mjs",
  ]).has(relative);
}

function isAllowedPublicIpv4Fixture(relative, address) {
  return relative === "scripts/smoke-backend-security-hardening.mjs" && address === [8, 8, 8, 8].join(".");
}

function isPublicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  return true;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target" || value === "--repository") {
      const next = argv[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      parsed[value.slice(2)] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}
