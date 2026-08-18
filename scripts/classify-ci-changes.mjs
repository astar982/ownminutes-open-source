import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCUMENTATION_ROOT_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "COLLABORATION.md",
  "HANDOFF.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "design-qa.md",
]);

const ROUTING_FILES = new Set([
  "scripts/classify-ci-changes.mjs",
  "scripts/smoke-ci-routing.mjs",
]);

function normalizeChangedPath(value) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function isDocumentationPath(filePath) {
  return (
    filePath.startsWith("docs/") ||
    DOCUMENTATION_ROOT_FILES.has(filePath) ||
    filePath.endsWith(".md")
  );
}

function isDependencyPath(filePath) {
  return /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
    filePath,
  );
}

function isNativeMobilePath(filePath) {
  return filePath.startsWith("apps/mobile/") || filePath === "eas.json";
}

function isMobileContractPath(filePath) {
  return (
    isNativeMobilePath(filePath) ||
    filePath.startsWith("app-store/") ||
    /^scripts\/(?:build-ios-|check-ios-|check-mobile-|generate-mobile-|smoke-ios-|smoke-mobile-|upload-ios-)/.test(
      filePath,
    )
  );
}

function isBackendPath(filePath) {
  if (isMobileContractPath(filePath)) return false;

  return (
    filePath.startsWith("src/") ||
    filePath.startsWith("db/") ||
    filePath.startsWith("deploy/") ||
    filePath.startsWith("public/") ||
    filePath.startsWith("scripts/") ||
    filePath === "Dockerfile" ||
    /^(?:docker-compose|compose)(?:\.[^.]+)?\.ya?ml$/.test(filePath) ||
    /^(?:eslint\.config|next\.config|postcss\.config|tsconfig)(?:\.[^.]+)?(?:\.json|\.js|\.mjs|\.ts)?$/.test(
      filePath,
    ) ||
    filePath === ".env.example" ||
    (isDependencyPath(filePath) && !filePath.startsWith("apps/mobile/"))
  );
}

function isKnownLightweightPath(filePath) {
  return isDocumentationPath(filePath) || filePath.startsWith("app-store/");
}

export function classifyChangedFiles(inputFiles, { forceFull = false } = {}) {
  const files = [...new Set(inputFiles.map(normalizeChangedPath).filter(Boolean))].sort();
  const routingChanged = files.some(
    (filePath) => filePath.startsWith(".github/") || ROUTING_FILES.has(filePath),
  );
  const unknownChanged = files.some(
    (filePath) =>
      !isKnownLightweightPath(filePath) &&
      !isDependencyPath(filePath) &&
      !isMobileContractPath(filePath) &&
      !isBackendPath(filePath),
  );
  const full = forceFull || files.length === 0 || routingChanged || unknownChanged;
  const documentationOnly =
    !full && files.length > 0 && files.every(isDocumentationPath);

  if (full) {
    return {
      files,
      full: true,
      code: true,
      dependencies: true,
      mobile: true,
      mobileChecks: true,
      backend: true,
      documentationOnly: false,
      reason: forceFull
        ? "full gate requested by event"
        : files.length === 0
          ? "empty change set fell back to full gate"
          : routingChanged
            ? "CI routing changed"
            : "unknown path fell back to full gate",
    };
  }

  if (documentationOnly) {
    return {
      files,
      full: false,
      code: false,
      dependencies: false,
      mobile: false,
      mobileChecks: false,
      backend: false,
      documentationOnly: true,
      reason: "documentation-only change",
    };
  }

  const mobile = files.some(isNativeMobilePath);
  const mobileChecks = files.some(isMobileContractPath);
  const backend = files.some(isBackendPath);

  return {
    files,
    full: false,
    code: true,
    dependencies: files.some(isDependencyPath),
    mobile,
    mobileChecks,
    backend,
    documentationOnly: false,
    reason: "path-routed change",
  };
}

function parseArguments(argv) {
  const options = { filesFrom: "", output: "", forceFull: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force-full") {
      options.forceFull = true;
    } else if (argument === "--files-from") {
      options.filesFrom = argv[index + 1] ?? "";
      index += 1;
    } else if (argument === "--output") {
      options.output = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.filesFrom) throw new Error("--files-from is required");
  return options;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const fileList = await readFile(options.filesFrom, "utf8");
  const classification = classifyChangedFiles(fileList.split("\n"), options);
  const outputs = {
    full: classification.full,
    code: classification.code,
    dependencies: classification.dependencies,
    mobile: classification.mobile,
    mobile_checks: classification.mobileChecks,
    backend: classification.backend,
    docs_only: classification.documentationOnly,
    changed_count: classification.files.length,
  };

  if (options.output) {
    const outputText = Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await appendFile(options.output, `${outputText}\n`, "utf8");
  }

  process.stdout.write(
    `${JSON.stringify({ ...outputs, reason: classification.reason, files: classification.files }, null, 2)}\n`,
  );
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
