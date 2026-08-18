#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const exceptionExpiresAt = Date.parse("2026-09-30T00:00:00Z");
export const allowedAdvisories = new Set([
  "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr",
  "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq",
]);

export function evaluateMobileAudit(report, now = Date.now()) {
  const vulnerabilities = Object.entries(report.vulnerabilities || {});
  if (vulnerabilities.length === 0) return { clean: true, allowedPackages: [] };

  if (now >= exceptionExpiresAt) {
    throw new Error("The temporary image-size audit exception expired on 2026-09-30.");
  }

  const advisoryRoots = [];
  for (const [name, vulnerability] of vulnerabilities) {
    for (const via of vulnerability.via || []) {
      if (typeof via === "object" && via !== null) advisoryRoots.push({ packageName: name, vulnerability, via });
    }
  }

  const rejectedRoots = advisoryRoots.filter(({ packageName, vulnerability, via }) =>
    packageName !== "image-size" ||
    vulnerability.isDirect !== false ||
    vulnerability.nodes?.length !== 1 ||
    vulnerability.nodes[0] !== "node_modules/image-size" ||
    !allowedAdvisories.has(via.url)
  );
  const observedUrls = new Set(advisoryRoots.map(({ via }) => via.url));
  const missingAllowedRoots = [...allowedAdvisories].filter((url) => !observedUrls.has(url));

  if (rejectedRoots.length > 0 || missingAllowedRoots.length > 0 || advisoryRoots.length !== allowedAdvisories.size) {
    const details = [
      ...rejectedRoots.map(({ packageName, via }) => `${packageName}: ${via.url || via.source || "unknown advisory"}`),
      ...missingAllowedRoots.map((url) => `expected exception root not observed: ${url}`),
    ];
    throw new Error(`Mobile runtime dependency audit found an advisory outside the narrow image-size exception.\n${details.join("\n")}`);
  }

  const allowedNames = new Set(["image-size"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, vulnerability] of vulnerabilities) {
      if (allowedNames.has(name)) continue;
      const viaNames = (vulnerability.via || []).filter((via) => typeof via === "string");
      if (viaNames.some((via) => allowedNames.has(via))) {
        allowedNames.add(name);
        changed = true;
      }
    }
  }

  const unrelated = vulnerabilities.filter(([name]) => !allowedNames.has(name));
  if (unrelated.length > 0) {
    throw new Error(`Mobile runtime dependency audit contains vulnerabilities unrelated to the allowed image-size advisory roots:\n${unrelated.map(([name, vulnerability]) => `${name}: ${vulnerability.severity}`).join("\n")}`);
  }

  return { clean: false, allowedPackages: [...allowedNames].sort() };
}

function main() {
  const result = spawnSync("npm", [
    "--prefix",
    "apps/mobile",
    "audit",
    "--omit=dev",
    "--omit=optional",
    "--json",
    "--registry=https://registry.npmjs.org",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

  if (!result.stdout.trim()) throw new Error(result.stderr || "npm audit returned no JSON output");

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error("Unable to parse npm audit JSON output.");
  }

  const evaluation = evaluateMobileAudit(report);
  if (evaluation.clean) {
    console.log("Mobile runtime dependency audit passed with no vulnerabilities.");
    return;
  }

  console.warn("Temporary audit exception applied: two upstream image-size build-time DoS advisories through Expo/Metro.");
  console.warn(`Exception expires 2026-09-30; no other advisory roots were accepted (${evaluation.allowedPackages.length} propagated package reports).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
