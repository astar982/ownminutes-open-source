#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  IMAGE_SIZE_FORK_NAME,
  IMAGE_SIZE_FORK_VERSION,
  IMAGE_SIZE_OVERRIDE,
  assertMobileImageSizeGraph,
  evaluateMobileAudit,
} from "./audit-mobile-runtime.mjs";

const mobilePackage = JSON.parse(readFileSync("apps/mobile/package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("apps/mobile/package-lock.json", "utf8"));

assert.deepEqual(evaluateMobileAudit({ vulnerabilities: {} }), { clean: true });

const leftoverImageSizeAdvisories = {
  vulnerabilities: {
    "image-size": {
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/metro/node_modules/image-size"],
      via: [
        { source: 1000, url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr" },
        { source: 1001, url: "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq" },
      ],
    },
    metro: {
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/metro"],
      via: ["image-size"],
    },
  },
};
assert.throws(
  () => evaluateMobileAudit(leftoverImageSizeAdvisories),
  /GHSA-w3rx-r6r6-pgpr/,
);
assert.throws(
  () => evaluateMobileAudit({
    vulnerabilities: {
      "unrelated-package": {
        severity: "critical",
        isDirect: true,
        nodes: ["node_modules/unrelated-package"],
        via: [{ source: 9998, url: "https://github.com/advisories/GHSA-unrelated-risk" }],
      },
    },
  }),
  /GHSA-unrelated-risk/,
);

assert.deepEqual(assertMobileImageSizeGraph({ mobilePackage, lockfile }), {
  replaced: true,
  slots: ["node_modules/metro/node_modules/image-size"],
});

const metroWithoutImageSize = structuredClone(lockfile);
delete metroWithoutImageSize.packages["node_modules/metro"].dependencies["image-size"];
delete metroWithoutImageSize.packages["node_modules/metro/node_modules/image-size"];
assert.throws(
  () => assertMobileImageSizeGraph({ mobilePackage, lockfile: metroWithoutImageSize }),
  /remove the image-size override/,
);
assert.deepEqual(
  assertMobileImageSizeGraph({
    mobilePackage: { overrides: {} },
    lockfile: metroWithoutImageSize,
  }),
  { replaced: false },
);

const missingOverride = structuredClone(mobilePackage);
delete missingOverride.overrides["image-size"];
assert.throws(
  () => assertMobileImageSizeGraph({ mobilePackage: missingOverride, lockfile }),
  /must override it/,
);

const wrongFork = structuredClone(lockfile);
wrongFork.packages["node_modules/metro/node_modules/image-size"] = {
  name: "image-size",
  version: "1.2.1",
};
assert.throws(
  () => assertMobileImageSizeGraph({ mobilePackage, lockfile: wrongFork }),
  new RegExp(`${IMAGE_SIZE_FORK_NAME}@${IMAGE_SIZE_FORK_VERSION}`),
);

assert.equal(mobilePackage.overrides["image-size"], IMAGE_SIZE_OVERRIDE);

console.log("Mobile audit policy smoke checks passed.");
