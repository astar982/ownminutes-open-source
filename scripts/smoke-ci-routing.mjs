import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyChangedFiles } from "./classify-ci-changes.mjs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const dependabot = readFileSync(".github/dependabot.yml", "utf8");
const testflightSmoke = readFileSync("scripts/smoke-testflight-config.mjs", "utf8");

assert.ok(
  !dependabot.includes("mobile-minor-and-patch") &&
    !dependabot.includes("root-minor-and-patch") &&
    !dependabot.includes("actions-minor-and-patch"),
  "Dependabot must not group minor and patch updates together",
);
assert.ok(
  dependabot.includes("mobile-patch:") &&
    dependabot.includes("mobile-minor:") &&
    dependabot.includes("root-patch:") &&
    dependabot.includes("root-minor:"),
  "Dependabot must keep separate patch and minor groups for npm ecosystems",
);
assert.match(
  testflightSmoke,
  /\.test\(mobilePackage\.dependencies\?\.\["expo-splash-screen"\]/,
  "TestFlight smoke must accept Expo 56.0.x splash-screen patches, not a single pinned patch",
);
assert.ok(
  !testflightSmoke.includes('["expo-splash-screen"] === "'),
  "TestFlight smoke must not pin expo-splash-screen to one patch version",
);
for (const name of ["react-native", "expo", "expo-iap"]) {
  const block = dependabot.split("- dependency-name:").filter((part) => part.includes(`"${name}"`))[0] || "";
  assert.ok(
    block.includes("version-update:semver-minor"),
    `Dependabot must ignore ${name} minor updates; they break the Expo 56 / RN 0.85 mobile pin`,
  );
}
assert.ok(
  workflow.includes("github.event.pull_request.number || github.ref"),
  "CI concurrency must cancel superseded runs within the same pull request",
);
assert.ok(
  workflow.includes("ref: ${{ github.event.pull_request.base.sha || github.sha }}"),
  "the change classifier must run from trusted base-branch code",
);
assert.ok(
  workflow.includes('"repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files?per_page=100"'),
  "pull request paths must be read through the GitHub API without checking out untrusted head code",
);
assert.ok(
  !workflow.includes("PR_HEAD_SHA:"),
  "the trusted classifier must not fetch or check out a pull request head SHA",
);
assert.ok(
  workflow.includes("base branch that predates the trusted") &&
    workflow.includes('echo "full=true"'),
  "a base branch without the trusted classifier must fail closed to the full gate",
);
assert.equal(
  [...workflow.matchAll(/persist-credentials: false/g)].length,
  4,
  "every repository checkout must disable persisted Git credentials",
);

function pick(result) {
  return {
    full: result.full,
    code: result.code,
    dependencies: result.dependencies,
    mobile: result.mobile,
    mobileChecks: result.mobileChecks,
    backend: result.backend,
    documentationOnly: result.documentationOnly,
  };
}

assert.deepEqual(pick(classifyChangedFiles(["docs/handoff.md", "README.md"])), {
  full: false,
  code: false,
  dependencies: false,
  mobile: false,
  mobileChecks: false,
  backend: false,
  documentationOnly: true,
});

assert.deepEqual(pick(classifyChangedFiles(["apps/mobile/README.md"])), {
  full: false,
  code: false,
  dependencies: false,
  mobile: false,
  mobileChecks: false,
  backend: false,
  documentationOnly: true,
});

assert.deepEqual(pick(classifyChangedFiles(["apps/mobile/App.tsx"])), {
  full: false,
  code: true,
  dependencies: false,
  mobile: true,
  mobileChecks: true,
  backend: false,
  documentationOnly: false,
});

assert.deepEqual(pick(classifyChangedFiles(["apps/mobile/package-lock.json"])), {
  full: false,
  code: true,
  dependencies: true,
  mobile: true,
  mobileChecks: true,
  backend: false,
  documentationOnly: false,
});

assert.deepEqual(pick(classifyChangedFiles(["src/lib/server/auth-store.ts"])), {
  full: false,
  code: true,
  dependencies: false,
  mobile: false,
  mobileChecks: false,
  backend: true,
  documentationOnly: false,
});

assert.deepEqual(pick(classifyChangedFiles(["package-lock.json"])), {
  full: false,
  code: true,
  dependencies: true,
  mobile: false,
  mobileChecks: false,
  backend: true,
  documentationOnly: false,
});

assert.deepEqual(pick(classifyChangedFiles(["scripts/smoke-mobile-ui.mjs"])), {
  full: false,
  code: true,
  dependencies: false,
  mobile: false,
  mobileChecks: true,
  backend: false,
  documentationOnly: false,
});

for (const fullGate of [
  classifyChangedFiles([".github/workflows/ci.yml"]),
  classifyChangedFiles([".github/dependabot.yml"]),
  classifyChangedFiles(["unexpected/new-runtime.file"]),
  classifyChangedFiles([]),
  classifyChangedFiles(["docs/handoff.md"], { forceFull: true }),
]) {
  assert.deepEqual(pick(fullGate), {
    full: true,
    code: true,
    dependencies: true,
    mobile: true,
    mobileChecks: true,
    backend: true,
    documentationOnly: false,
  });
}

console.log(
  JSON.stringify(
    {
      ciRoutingVerified: true,
      dependabotPolicyVerified: true,
      scenarios: 12,
      unknownPathsFailClosed: true,
      workflowChangesRunFullGate: true,
      fullPullRequestRoutingAllowsSafeCancellation: true,
    },
    null,
    2,
  ),
);
