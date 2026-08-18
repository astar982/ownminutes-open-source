#!/usr/bin/env node

import assert from "node:assert/strict";
import { allowedAdvisories, evaluateMobileAudit, exceptionExpiresAt } from "./audit-mobile-runtime.mjs";

const beforeExpiry = Date.parse("2026-08-18T00:00:00Z");
const allowedReport = {
  vulnerabilities: {
    "image-size": {
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/image-size"],
      via: [...allowedAdvisories].map((url, index) => ({ source: 1000 + index, url })),
    },
    metro: {
      severity: "high",
      isDirect: false,
      nodes: ["node_modules/metro"],
      via: ["image-size"],
    },
    expo: {
      severity: "high",
      isDirect: true,
      nodes: ["node_modules/expo"],
      via: ["metro"],
    },
  },
};

assert.deepEqual(evaluateMobileAudit({ vulnerabilities: {} }, beforeExpiry), { clean: true, allowedPackages: [] });
assert.deepEqual(evaluateMobileAudit(allowedReport, beforeExpiry), {
  clean: false,
  allowedPackages: ["expo", "image-size", "metro"],
});

assert.throws(
  () => evaluateMobileAudit(allowedReport, exceptionExpiresAt),
  /exception expired/,
);

const extraAdvisory = structuredClone(allowedReport);
extraAdvisory.vulnerabilities["image-size"].via.push({
  source: 9999,
  url: "https://github.com/advisories/GHSA-example-new-risk",
});
assert.throws(
  () => evaluateMobileAudit(extraAdvisory, beforeExpiry),
  /outside the narrow image-size exception/,
);

const unrelatedAdvisory = structuredClone(allowedReport);
unrelatedAdvisory.vulnerabilities["unrelated-package"] = {
  severity: "critical",
  isDirect: true,
  nodes: ["node_modules/unrelated-package"],
  via: [{ source: 9998, url: "https://github.com/advisories/GHSA-unrelated-risk" }],
};
assert.throws(
  () => evaluateMobileAudit(unrelatedAdvisory, beforeExpiry),
  /outside the narrow image-size exception/,
);

const missingAdvisory = structuredClone(allowedReport);
missingAdvisory.vulnerabilities["image-size"].via.pop();
assert.throws(
  () => evaluateMobileAudit(missingAdvisory, beforeExpiry),
  /expected exception root not observed/,
);

console.log("Mobile audit exception policy smoke checks passed.");
