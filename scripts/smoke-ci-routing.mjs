import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyChangedFiles } from "./classify-ci-changes.mjs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
assert.ok(
  workflow.includes("github.event.pull_request.head.sha || github.sha"),
  "CI concurrency must be scoped to each commit so incremental gates cannot be canceled by a later push",
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
      scenarios: 12,
      unknownPathsFailClosed: true,
      workflowChangesRunFullGate: true,
      commitScopedConcurrency: true,
    },
    null,
    2,
  ),
);
