#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const IMAGE_SIZE_OVERRIDE = "npm:image-size-next@1.2.2";
export const IMAGE_SIZE_FORK_NAME = "image-size-next";
export const IMAGE_SIZE_FORK_VERSION = "1.2.2";

export function imageSizeLockSlots(lockfile) {
  return Object.entries(lockfile.packages || {}).filter(([path]) => (
    path === "node_modules/image-size" || path.endsWith("/node_modules/image-size")
  ));
}

export function assertMobileImageSizeGraph({ mobilePackage, lockfile }) {
  const metroDependsOnImageSize = Boolean(lockfile.packages?.["node_modules/metro"]?.dependencies?.["image-size"]);
  const slots = imageSizeLockSlots(lockfile);
  const override = mobilePackage.overrides?.["image-size"];

  if (!metroDependsOnImageSize) {
    if (slots.length > 0) {
      throw new Error("Metro no longer depends on image-size, but the lockfile still contains it.");
    }
    if (override) {
      throw new Error("Metro no longer depends on image-size; remove the image-size override.");
    }
    return { replaced: false };
  }

  if (override !== IMAGE_SIZE_OVERRIDE) {
    throw new Error(`Metro still depends on image-size; apps/mobile must override it to ${IMAGE_SIZE_OVERRIDE}.`);
  }
  if (slots.length === 0) {
    throw new Error("Metro depends on image-size, but the lockfile has no image-size resolution.");
  }
  for (const [path, resolved] of slots) {
    if (resolved?.name !== IMAGE_SIZE_FORK_NAME || resolved?.version !== IMAGE_SIZE_FORK_VERSION) {
      throw new Error(`Lockfile entry ${path} must resolve to ${IMAGE_SIZE_FORK_NAME}@${IMAGE_SIZE_FORK_VERSION}.`);
    }
  }
  return { replaced: true, slots: slots.map(([path]) => path).sort() };
}

export function evaluateMobileAudit(report) {
  const vulnerabilities = Object.entries(report.vulnerabilities || {});
  if (vulnerabilities.length === 0) return { clean: true };

  const details = [];
  for (const [name, vulnerability] of vulnerabilities) {
    const vias = vulnerability.via || [];
    if (vias.length === 0) {
      details.push(`${name}: ${vulnerability.severity || "unknown"}`);
      continue;
    }
    for (const via of vias) {
      if (typeof via === "object" && via !== null) {
        details.push(`${name}: ${via.url || via.source || "unknown advisory"}`);
      } else {
        details.push(`${name} via ${via}`);
      }
    }
  }

  throw new Error(`Mobile runtime dependency audit found vulnerabilities:\n${details.join("\n")}`);
}

function main() {
  const mobilePackage = JSON.parse(readFileSync("apps/mobile/package.json", "utf8"));
  const lockfile = JSON.parse(readFileSync("apps/mobile/package-lock.json", "utf8"));
  const graph = assertMobileImageSizeGraph({ mobilePackage, lockfile });

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

  evaluateMobileAudit(report);
  console.log("Mobile runtime dependency audit passed with no vulnerabilities.");
  if (graph.replaced) {
    console.log(`image-size is replaced by ${IMAGE_SIZE_FORK_NAME}@${IMAGE_SIZE_FORK_VERSION} (${graph.slots.join(", ")}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
