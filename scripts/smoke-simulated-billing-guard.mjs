#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-billing-guard-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const register = await postJson("/api/auth/register", {
    name: "Billing Guard Smoke",
    email,
    password,
  }, null, { extraHeaders: { "x-forwarded-for": testIp } });
  const cookie = extractCookie(register.response);
  const initial = await getJson("/api/auth/me", cookie);
  const plan = await postJson("/api/account/plan", { plan: "plus" }, cookie, { allowError: true });
  const afterPlan = await getJson("/api/auth/me", cookie);
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });

  const summary = {
    registerOk: register.payload.ok === true,
    initialPlan: initial.payload.user?.plan,
    planBlocked: plan.response.status === 402 && plan.payload.code === "simulated_billing_disabled",
    planStatus: plan.response.status,
    planCode: plan.payload.code,
    afterPlan: afterPlan.payload.user?.plan,
    minutesAfterPlan: afterPlan.payload.usage?.officialMinutesTotal,
    deleteOk: deletePayload.ok === true,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.registerOk ||
    summary.initialPlan !== "free" ||
    !summary.planBlocked ||
    summary.afterPlan !== "free" ||
    summary.minutesAfterPlan !== 60 ||
    !summary.deleteOk
  ) {
    process.exitCode = 1;
  }
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
