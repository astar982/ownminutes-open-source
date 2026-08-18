#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const timestamp = Date.now();
const email = `provider-concurrency-${timestamp}@ownminutes.local`;
const password = `OwnMinutesConcurrency-${timestamp}`;
const secretA = `concurrent-secret-a-${timestamp}`;
const secretB = `concurrent-secret-b-${timestamp}`;

const register = await requestJson("/api/auth/register", {
  method: "POST",
  body: { name: "Provider Concurrency", email, password },
  headers: { "x-forwarded-for": `192.0.2.${(timestamp % 200) + 20}` },
});
const cookie = register.response.headers.get("set-cookie")?.split(";")[0] || "";
if (!register.response.ok || !cookie) throw new Error("Provider concurrency smoke could not create an authenticated user.");

try {
  const [saveA, saveB] = await Promise.all([
    requestJson("/api/account/provider-credentials", {
      method: "POST",
      cookie,
      body: { providerId: "concurrency-provider", fields: { concurrentFieldA: "alpha" }, secrets: { CONCURRENT_SECRET_A: secretA } },
    }),
    requestJson("/api/account/provider-credentials", {
      method: "POST",
      cookie,
      body: { providerId: "concurrency-provider", fields: { concurrentFieldB: "beta" }, secrets: { CONCURRENT_SECRET_B: secretB } },
    }),
  ]);
  const listed = await requestJson("/api/account/provider-credentials", { cookie });
  const credential = listed.payload.providerCredentials?.find((item) => item.providerId === "concurrency-provider");
  const serialized = JSON.stringify({ saveA: saveA.payload, saveB: saveB.payload, listed: listed.payload });
  const summary = {
    registerOk: true,
    concurrentSavesOk: saveA.response.ok && saveB.response.ok,
    bothFieldsPersisted:
      credential?.configuredFields?.includes("concurrentFieldA") && credential?.configuredFields?.includes("concurrentFieldB"),
    bothSecretNamesPersisted:
      credential?.configuredSecrets?.includes("CONCURRENT_SECRET_A") && credential?.configuredSecrets?.includes("CONCURRENT_SECRET_B"),
    previewsPresent:
      typeof credential?.secretPreviews?.CONCURRENT_SECRET_A === "string" && typeof credential?.secretPreviews?.CONCURRENT_SECRET_B === "string",
    plaintextAbsent: !serialized.includes(secretA) && !serialized.includes(secretB),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} finally {
  await requestJson("/api/auth/delete", { method: "DELETE", cookie, body: { confirmation: "DELETE" }, allowError: true });
}

async function requestJson(apiPath, options = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method: options.method || "GET",
    headers: {
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const text = await response.text();
  const payload = JSON.parse(text);
  if (!response.ok && !options.allowError) throw new Error(`HTTP ${response.status} from ${apiPath}: ${JSON.stringify(payload)}`);
  return { response, payload };
}
