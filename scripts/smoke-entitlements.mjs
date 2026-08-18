#!/usr/bin/env node

import { createServer } from "node:http";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `entitlement-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const arkProbeServer = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/asr/submit") {
      response.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": "20000000", "X-Api-Message": "OK" });
      response.end(JSON.stringify({ result: {} }));
      return;
    }
    if (request.method === "POST" && request.url === "/chat/completions") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => arkProbeServer.listen(0, "127.0.0.1", resolve));
  const arkProbeAddress = arkProbeServer.address();
  if (!arkProbeAddress || typeof arkProbeAddress === "string") throw new Error("Could not start Ark health fixture.");
  const arkProbeBaseUrl = `http://127.0.0.1:${arkProbeAddress.port}`;

  const register = await postJson("/api/auth/register", {
    name: "Entitlement Smoke",
    email,
    password,
  }, null, { extraHeaders: { "x-forwarded-for": testIp } });
  const cookie = extractCookie(register.response);
  const initial = await getJson("/api/account/entitlements", cookie);

  await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Entitlement ASR",
      fields: {
        VOLCANO_ASR_APP_ID: "entitlement-app-id",
        VOLCANO_ASR_MODE: "standard",
        VOLCANO_ASR_SUBMIT_URL: `${arkProbeBaseUrl}/asr/submit`,
      },
      secrets: { VOLCANO_ASR_API_KEY: "entitlement-secret-api-key" },
    },
    cookie,
  );
  const afterPartialByok = await getJson("/api/account/entitlements", cookie);
  await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-ark",
      label: "Entitlement Ark",
      fields: { ARK_CHAT_MODEL: "ep-entitlement", ARK_BASE_URL: arkProbeBaseUrl },
      secrets: { ARK_API_KEY: "entitlement-ark-secret" },
    },
    cookie,
  );
  const afterCompleteConfig = await getJson("/api/account/entitlements", cookie);
  const modeSelection = await putJson("/api/account/processing-mode", { processingMode: "byok" }, cookie);
  const afterByok = await getJson("/api/account/entitlements", cookie);

  const plan = await postJson("/api/account/plan", { plan: "plus" }, cookie, { allowError: true });
  const afterPlan = await getJson("/api/account/entitlements", cookie);
  const me = await getJson("/api/auth/me", cookie);
  const text = JSON.stringify({ initial: initial.payload, afterPartialByok: afterPartialByok.payload, afterCompleteConfig: afterCompleteConfig.payload, afterByok: afterByok.payload, afterPlan: afterPlan.payload, me: me.payload });

  const summary = {
    registerOk: register.payload.ok === true,
    initialOk: initial.payload.ok === true,
    initialCanFinalize: initial.payload.entitlements?.canFinalizeMeeting,
    initialPreferredRoute: initial.payload.entitlements?.preferredRoute,
    initialStatus: initial.payload.entitlements?.status,
    initialNextAction: initial.payload.entitlements?.nextAction?.id,
    partialByokConfigured: afterPartialByok.payload.entitlements?.byok?.configured,
    partialPreferredRouteStaysOfficial: afterPartialByok.payload.entitlements?.preferredRoute,
    partialHybridUnavailable: afterPartialByok.payload.entitlements?.routes?.some((route) => route.id === "hybrid" && !route.available),
    completeConfigDoesNotAutoSwitch: afterCompleteConfig.payload.entitlements?.preferredRoute,
    explicitByokSelectionPersisted: modeSelection.payload.processingMode === "byok" && modeSelection.payload.user?.processingMode === "byok",
    byokConfigured: afterByok.payload.entitlements?.byok?.configured,
    byokPreferredRoute: afterByok.payload.entitlements?.preferredRoute,
    byokRouteAvailable: afterByok.payload.entitlements?.routes?.some((route) => route.id === "byok" && route.available),
    planBlocked: plan.response.status === 402 && plan.payload.code === "simulated_billing_disabled",
    afterBlockedPlan: afterPlan.payload.entitlements?.plan?.id,
    afterBlockedPreferredRoute: afterPlan.payload.entitlements?.preferredRoute,
    afterBlockedQuota: afterPlan.payload.entitlements?.officialQuota?.totalMinutes,
    meHasEntitlements: me.payload.entitlements?.canFinalizeMeeting === true,
    leaksSecrets: text.includes("entitlement-secret-api-key") || text.includes("Secret Access Key") || text.includes("sk-proj"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.registerOk ||
    !summary.initialOk ||
    summary.initialCanFinalize !== true ||
    summary.initialPreferredRoute !== "official_quota" ||
    summary.initialStatus !== "attention" ||
    summary.initialNextAction !== "configure_byok" ||
    summary.partialByokConfigured !== false ||
    summary.partialPreferredRouteStaysOfficial !== "official_quota" ||
    !summary.partialHybridUnavailable ||
    summary.completeConfigDoesNotAutoSwitch !== "official_quota" ||
    !summary.explicitByokSelectionPersisted ||
    summary.byokConfigured !== true ||
    summary.byokPreferredRoute !== "byok" ||
    !summary.byokRouteAvailable ||
    !summary.planBlocked ||
    summary.afterBlockedPlan !== "free" ||
    summary.afterBlockedPreferredRoute !== "byok" ||
    summary.afterBlockedQuota !== 60 ||
    !summary.meHasEntitlements ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
  await new Promise((resolve) => arkProbeServer.close(resolve));
}

async function postJson(path, body, cookie, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, path, { allowError: options.allowError });
  return { response, payload };
}

async function getJson(path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
  });
  const payload = await readJson(response, path);
  return { response, payload };
}

async function putJson(path, body, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, path);
  return { response, payload };
}

async function readJson(response, path, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Register response did not set a session cookie.");
  return setCookie.split(";")[0];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
