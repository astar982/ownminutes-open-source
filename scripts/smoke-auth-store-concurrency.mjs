#!/usr/bin/env node

import fs from "fs";
import path from "path";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const workerCount = Number(process.env.AUTH_STORE_SMOKE_WORKERS || 8);
const storePath = path.join(process.cwd(), ".data", "auth", "store.json");

async function main() {
  const workers = Array.from({ length: workerCount }, (_, index) => runWorker(index));
  const results = await Promise.all(workers);
  const failed = results.filter((result) => !result.ok);
  const text = JSON.stringify(results);
  const store = readAuthStore();
  const storeText = JSON.stringify(store);
  const smokeCredentials = store.providerCredentials.filter((credential) => credential.label.startsWith("Concurrency ASR ") && credential.updatedAt.startsWith(timestamp.slice(0, 4)));
  const currentRunCredentials = store.providerCredentials.filter((credential) => results.some((result) => result.userId === credential.userId));
  const summary = {
    workerCount,
    okWorkers: results.filter((result) => result.ok).length,
    failedWorkers: failed.length,
    allRegistered: results.every((result) => result.registerOk),
    allEntitlementsOk: results.every((result) => result.entitlementsOk),
    allProviderSaved: results.every((result) => result.providerSaveOk),
    allPlanGuarded: results.every((result) => result.planUpdateOk || result.planUpdateBlocked),
    allMeOk: results.every((result) => result.meOk),
    uniqueEmails: new Set(results.map((result) => result.email)).size,
    leaksSecrets: text.includes("concurrency-secret") || text.includes("Secret Access Key") || text.includes("sk-proj"),
    storeLeaksSecrets: storeText.includes("concurrency-secret") || storeText.includes("Secret Access Key") || storeText.includes("sk-proj"),
    currentRunCredentials: currentRunCredentials.length,
    allCurrentRunSecretsV2: currentRunCredentials.every((credential) => Object.values(credential.encryptedSecrets ?? {}).every((value) => String(value).startsWith("v2."))),
    oldSmokeCredentials: smokeCredentials.length,
    invalidJsonErrors: results.filter((result) => result.error?.includes("Invalid JSON")).length,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    failed.length > 0 ||
    summary.okWorkers !== workerCount ||
    !summary.allRegistered ||
    !summary.allEntitlementsOk ||
    !summary.allProviderSaved ||
    !summary.allPlanGuarded ||
    !summary.allMeOk ||
    summary.uniqueEmails !== workerCount ||
    summary.leaksSecrets ||
    summary.storeLeaksSecrets ||
    summary.currentRunCredentials !== workerCount ||
    !summary.allCurrentRunSecretsV2 ||
    summary.invalidJsonErrors > 0
  ) {
    console.error(JSON.stringify(failed, null, 2));
    process.exitCode = 1;
  }
}

async function runWorker(index) {
  const email = `concurrency-${timestamp}-${index}@ownminutes.local`;
  const password = `OwnMinutes-${timestamp}-${index}`;
  const testIp = `198.51.${index}.${Math.floor(Math.random() * 200) + 1}`;

  try {
    const register = await postJson("/api/auth/register", {
      name: `Concurrency ${index}`,
      email,
      password,
    }, null, { extraHeaders: { "x-forwarded-for": testIp } });
    const cookie = extractCookie(register.response);
    const initial = await getJson("/api/account/entitlements", cookie);
    const provider = await postJson(
      "/api/account/provider-credentials",
      {
        providerId: "volcano-asr",
        label: `Concurrency ASR ${index}`,
        fields: { VOLCANO_ASR_APP_ID: `concurrency-app-${index}` },
        secrets: { VOLCANO_ASR_API_KEY: `concurrency-secret-${index}` },
      },
      cookie,
    );
    const afterProvider = await getJson("/api/account/entitlements", cookie);
    const plan = await postJson("/api/account/plan", { plan: index % 2 === 0 ? "plus" : "pro" }, cookie, { allowError: true });
    const me = await getJson("/api/auth/me", cookie);
    const planUpdated = plan.payload.ok === true;
    const planBlocked = plan.response.status === 402 && plan.payload.code === "simulated_billing_disabled";

    return {
      ok:
        register.payload.ok === true &&
        initial.payload.ok === true &&
        provider.payload.ok === true &&
        afterProvider.payload.entitlements?.preferredRoute === "hybrid" &&
        (planUpdated || planBlocked) &&
        me.payload.ok === true,
      email,
      registerOk: register.payload.ok === true,
      entitlementsOk: initial.payload.ok === true && afterProvider.payload.ok === true,
      providerSaveOk: provider.payload.ok === true,
      planUpdateOk: planUpdated,
      planUpdateBlocked: planBlocked,
      planUpdateStatus: plan.response.status,
      planUpdateCode: plan.payload.code,
      meOk: me.payload.ok === true,
      preferredRouteAfterProvider: afterProvider.payload.entitlements?.preferredRoute,
      plan: me.payload.user?.plan,
      userId: me.payload.user?.id,
    };
  } catch (error) {
    return {
      ok: false,
      email,
      registerOk: false,
      entitlementsOk: false,
      providerSaveOk: false,
      planUpdateOk: false,
      meOk: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readAuthStore() {
  if (!fs.existsSync(storePath)) return { providerCredentials: [] };
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
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
