#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";

async function main() {
  const response = await fetch(`${baseUrl}/api/deployment/diagnostics`, { cache: "no-store" });
  const payload = await readJson(response, "/api/deployment/diagnostics");
  const healthResponse = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
  const healthPayload = await readJson(healthResponse, "/api/health");
  const diagnostics = payload.diagnostics;
  const text = JSON.stringify(payload);
  const checks = diagnostics?.checks ?? [];
  const summary = {
    ok: payload.ok === true,
    productionReady: diagnostics?.productionReady,
    checkCount: checks.length,
    hasCapabilities: Boolean(diagnostics?.capabilities && typeof diagnostics.capabilities === "object"),
    hasMissingList: Array.isArray(diagnostics?.missing),
    statusesValid: checks.every((check) => ["pass", "fail", "manual"].includes(check.status)),
    localPreviewBlocked: diagnostics?.productionReady === false,
    localLegalRoutesExist: diagnostics?.legalPages?.localRoutesExist === true,
    localPublicLegalUrlsInvalid: diagnostics?.legalPages?.publicUrlsValid === false,
    localHealthRouteExists: diagnostics?.healthCheck?.localRouteExists === true,
    localHealthPublicUrlInvalid: diagnostics?.healthCheck?.publicUrlValid === false,
    hasSampleShareUrlDiagnostic:
      diagnostics?.sampleShareUrl &&
      diagnostics.sampleShareUrl.configured === false &&
      diagnostics.sampleShareUrl.valid === true &&
      diagnostics.sampleShareUrl.host === null,
    healthApiOk: healthPayload.ok === true && healthPayload.service === "ownminutes",
    healthApiHasStorage: typeof healthPayload.checks?.storageProvider === "string",
    healthApiHasAuth: typeof healthPayload.checks?.authRepository === "string",
    noLocalhostReleaseCheck: checks.some((check) => check.id === "no-localhost-release"),
    publicLegalUrlCheck: checks.some((check) => check.id === "public-legal-urls"),
    healthCheckUrlCheck: checks.some((check) => check.id === "health-check-url"),
    sampleShareUrlCheck: checks.some((check) => check.id === "sample-share-url"),
    localHealthRouteCheck: checks.some((check) => check.id === "local-health-route" && check.status === "pass"),
    leaksSecrets:
      text.includes("APPLE_PRIVATE_KEY") ||
      text.includes("DATABASE_URL=") ||
      text.includes("OWNMINUTES_APP_SECRET=") ||
      text.includes("AKL") ||
      text.includes("sk-proj"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    summary.checkCount < 5 ||
    !summary.hasCapabilities ||
    !summary.hasMissingList ||
    !summary.statusesValid ||
    !summary.localPreviewBlocked ||
    !summary.localLegalRoutesExist ||
    !summary.localPublicLegalUrlsInvalid ||
    !summary.localHealthRouteExists ||
    !summary.localHealthPublicUrlInvalid ||
    !summary.hasSampleShareUrlDiagnostic ||
    !summary.healthApiOk ||
    !summary.healthApiHasStorage ||
    !summary.healthApiHasAuth ||
    !summary.noLocalhostReleaseCheck ||
    !summary.publicLegalUrlCheck ||
    !summary.healthCheckUrlCheck ||
    !summary.sampleShareUrlCheck ||
    !summary.localHealthRouteCheck ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

async function readJson(response, path) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
